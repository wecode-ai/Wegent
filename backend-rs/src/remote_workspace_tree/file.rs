// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/remote-workspace/file`.
//!
//! Mirrors source `app/api/endpoints/adapter/tasks.py::get_remote_workspace_file`
//! and `app/services/remote_workspace_service.py::RemoteWorkspaceService.stream_file`.
//!
//! Request flow (source-ordered):
//! 1. `get_current_user_from_query_or_header`: the bearer JWT (or `?token=`
//!    fallback) loads the user with the direct MySQL `users` query.
//! 2. `_get_sandbox_payload`: GET
//!    `{EXECUTOR_MANAGER_URL}/executor-manager/sandboxes/{task_id}`.
//! 3. `_resolve_root_path` + `normalize_and_validate_workspace_path`.
//! 4. `_get_task_detail`: load the task, verify access, resolve workspace,
//!    team, fork lineage/subtasks/contexts, group-chat members.
//! 5. When the sandbox is running: GET `{sandbox_base_url}/files?path=...`
//!    with the 130 s file timeout; otherwise `_ensure_sandbox_available`
//!    then the executor-manager workspace/file endpoint.
//! 6. Size guard (50 MB) then a `StreamingResponse` with the upstream
//!    `Content-Type` and the built `Content-Disposition`.
use std::sync::Arc;

use brz_http::Client as HttpClient;
use brz_http_server::{Binary, HttpResponse, StatusCode};
use brz_mysql::Mysql;
use brz_redis::Redis;
use serde_json::json;

use super::auth;
use super::config::Config;
use super::error::ApiError;
use super::executor_binding;
use super::kinds::KindStore;
use super::task_detail;
use crate::headers::OwnedHeaders;

/// `REMOTE_WORKSPACE_FILE_TIMEOUT_SECONDS`: the file download client timeout
/// (130 s), longer than the 5 s default of the other workspace calls.
const FILE_TIMEOUT_SECONDS: std::time::Duration = std::time::Duration::from_secs(130);

/// `MAX_DOWNLOAD_FILE_SIZE` (50 MB): larger downloads raise 413.
const MAX_DOWNLOAD_FILE_SIZE: usize = 50 * 1024 * 1024;

/// GET /api/tasks/{task_id}/remote-workspace/file: the remote-workspace file
/// free function, injecting the tree group's process-lifetime dependency
/// state. Mirrors `get_remote_workspace_file` in source
/// `app/api/endpoints/adapter/tasks.py` (mounted at `/api/tasks`).
#[brz_http_server::get(
    "/api/tasks/:task_id/remote-workspace/file",
    group = remote_workspace_tree
)]
async fn get_remote_workspace_file(
    #[inject(rwt)] state: &crate::startup::TreeState,
    task_id: u64,
    #[header] authorization: Option<&str>,
    path: Option<String>,
    disposition: Option<String>,
    token: Option<String>,
) -> Result<HttpResponse<Binary>, ApiError> {
    // FastAPI `Query(...)` validation runs before the handler body: `path`
    // is required and `disposition` must match `^(inline|attachment)$`.
    let path = path.ok_or_else(|| validation_error("path", "missing", "Field required", ""))?;
    let disposition = match disposition.as_deref() {
        None => {
            return Err(validation_error(
                "disposition",
                "missing",
                "Field required",
                "",
            ));
        }
        Some("inline") | Some("attachment") => disposition.unwrap(),
        Some(other) => {
            return Err(validation_error(
                "disposition",
                "string_pattern_mismatch",
                "String should match pattern '^(inline|attachment)$'",
                other,
            ));
        }
    };

    stream_file(
        &state.clone(),
        task_id,
        authorization,
        token.as_deref(),
        &path,
        &disposition,
    )
    .await
}

/// FastAPI-style 422 validation-error array body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::to_string(&json!([{
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": input,
        }]))
        .unwrap_or_else(|_| "[{\"msg\":\"Field required\"}]".to_owned()),
    )
}

/// The handler body for `GET /api/tasks/{task_id}/remote-workspace/file`.
async fn stream_file(
    deps: &Arc<super::handler::Deps<impl Mysql, impl Redis>>,
    task_id: u64,
    authorization: Option<&str>,
    token_query: Option<&str>,
    path: &str,
    disposition: &str,
) -> Result<HttpResponse<Binary>, ApiError> {
    // 1. `get_current_user_from_query_or_header`: the Authorization header
    //    first, then the `?token=` query parameter. Unlike the tree endpoint
    //    this uses the OAuth2 bearer scheme extraction (a non-Bearer header
    //    value is no credential at all), and the fallback query parameter
    //    supplies the raw token.
    let headers = OwnedHeaders::from_pairs([("authorization", authorization)]);
    let auth = auth::authenticate_with_query_fallback(
        &deps.mysql,
        &deps.config.jwt_decode_keys,
        &deps.config.jwt_algorithm,
        &headers.view(),
        token_query,
    )
    .await?;
    let kinds = KindStore {
        mysql: &deps.mysql,
        redis: deps.kinds_redis.as_ref(),
    };
    let erp = crate::teams::group_membership::ErpContext {
        erp: deps.erp.as_ref(),
        redis: deps.redis.as_ref(),
    };

    // 2-3. `_get_sandbox_payload` + `_resolve_root_path` + path validation.
    let sandbox_payload =
        super::handler::get_sandbox_payload(&deps.http, &deps.config, task_id).await;
    let root_path = super::handler::resolve_root_path(task_id, &sandbox_payload);
    let normalized_path =
        super::handler::normalize_and_validate_workspace_path(Some(path), &root_path)?;

    // 4. `_get_task_detail`: the response consumes only the access-control
    //    outcome, but the call sequence reproduces the recorded traffic.
    let _task = task_detail::load_task_detail(
        &deps.mysql,
        deps.redis.as_ref(),
        &erp,
        &kinds,
        task_id,
        auth.user_id,
    )
    .await?;

    // 5. Download: the sandbox runtime when available, else the executor
    //    manager through `_ensure_sandbox_available`.
    let (content, content_type) = if super::handler::is_sandbox_available(&sandbox_payload) {
        let sandbox_base_url = sandbox_payload
            .as_ref()
            .and_then(|payload| payload.base_url.as_deref())
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_owned();
        download_file_via_sandbox(&deps.http, &sandbox_base_url, &normalized_path).await?
    } else {
        let detail = task_detail::load_task_detail(
            &deps.mysql,
            deps.redis.as_ref(),
            &erp,
            &kinds,
            task_id,
            auth.user_id,
        )
        .await?;
        let binding = {
            let subtasks = &detail.subtasks;
            executor_binding::ensure_sandbox_available(subtasks).await?
        };
        let sandbox_payload =
            super::handler::get_sandbox_payload(&deps.http, &deps.config, task_id).await;
        let executor_name = if super::handler::is_sandbox_available(&sandbox_payload) {
            // `_resolve_workspace_base_url` resolved the sandbox runtime;
            // `_download_file` still passes the executor name (the source
            // `_ensure_sandbox_available` return value) to the manager call.
            binding.as_ref().map(|(name, _)| name.clone())
        } else {
            match binding.as_ref() {
                Some((name, namespace)) => {
                    let base_url = executor_binding::resolve_executor_base_url(
                        &deps.http,
                        &deps.config,
                        name,
                        if namespace.is_empty() {
                            None
                        } else {
                            Some(namespace)
                        },
                    )
                    .await;
                    if base_url.is_none() {
                        return Err(ApiError::conflict("Remote workspace is unavailable"));
                    }
                    Some(name.clone())
                }
                None => return Err(ApiError::conflict("Remote workspace is unavailable")),
            }
        };
        download_file_via_manager(
            &deps.http,
            &deps.config,
            task_id,
            executor_name.as_deref(),
            &normalized_path,
        )
        .await?
    };

    // 6. Size guard and the streaming response.
    if content.0.len() > MAX_DOWNLOAD_FILE_SIZE {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "File exceeds maximum download size of {} MB",
                MAX_DOWNLOAD_FILE_SIZE / (1024 * 1024)
            ),
        ));
    }

    let filename = download_filename(&normalized_path, content_type.as_deref());
    let content_disposition = build_content_disposition(disposition, &filename);
    let media_type = content_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    let response = HttpResponse::new(Binary::new(content.0))
        .status(StatusCode::OK)
        .header("content-type", media_type)
        .map_err(header_error)?
        .header("content-disposition", &content_disposition)
        .map_err(header_error)?;
    Ok(response)
}

/// Maps a response-header construction failure to a 500 (a non-ASCII or
/// invalid header value cannot occur for the source's escaped filenames, so
/// the branch is unreachable in practice but keeps the builder total).
fn header_error(error: brz_http_server::HeaderBlockError) -> ApiError {
    ApiError::internal(error.to_string())
}

/// `_download_filename`: `posixpath.basename(path) or "download"`, with a
/// `.zip` suffix appended for zip content types when the name lacks it.
fn download_filename(path: &str, content_type: Option<&str>) -> String {
    let filename = basename(path);
    let filename = if filename.is_empty() {
        "download".to_owned()
    } else {
        filename
    };
    let media_type = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(
        media_type.as_str(),
        "application/zip" | "application/x-zip-compressed"
    ) && !filename.to_ascii_lowercase().ends_with(".zip")
    {
        format!("{filename}.zip")
    } else {
        filename
    }
}

/// `posixpath.basename`.
fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// `_build_content_disposition`: a latin-1-encodable filename is quoted with
/// `\` and `"` escaped; anything else uses RFC 5987
/// `filename*=UTF-8''<percent-encoded>`.
fn build_content_disposition(disposition: &str, filename: &str) -> String {
    if filename.is_ascii() {
        let escaped = filename.replace('\\', "\\\\").replace('"', "\\\"");
        format!(r#"{disposition}; filename="{escaped}""#)
    } else {
        format!(
            "{disposition}; filename*=UTF-8''{}",
            percent_encode(filename)
        )
    }
}

/// `urllib.parse.quote(filename)` with the default safe `/`.
fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// `_download_file_via_sandbox`: GET `{base}/files?path={path}` with the
/// 130 s file timeout. Errors map exactly like the source: transport -> 503
/// "Failed to fetch remote file", 404 -> "File not found", other non-2xx ->
/// 502 "Remote file request failed".
async fn download_file_via_sandbox(
    http: &HttpClient,
    base_url: &str,
    path: &str,
) -> Result<(brz_http_server::Binary, Option<String>), ApiError> {
    let url = format!("{base_url}/files");
    let response = http
        .get(&url)
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox file build failed");
            error
        })
        .ok()
        .ok_or_else(|| ApiError::service_unavailable("Failed to fetch remote file"))?
        .timeout(FILE_TIMEOUT_SECONDS)
        .query(&[("path", path)])
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] sandbox file request failed");
            ApiError::service_unavailable("Failed to fetch remote file")
        })?;
    file_response(response, &url).await
}

/// `_download_file`: GET `{manager}/executor-manager/executor/workspace/file`
/// with `task_id`, `path`, and `executor_name` (when resolved). Same error
/// mapping as the sandbox variant.
async fn download_file_via_manager(
    http: &HttpClient,
    config: &Config,
    task_id: u64,
    executor_name: Option<&str>,
    path: &str,
) -> Result<(brz_http_server::Binary, Option<String>), ApiError> {
    let url = format!(
        "{}/executor-manager/executor/workspace/file",
        config.executor_manager_url
    );
    let builder = http
        .get(&url)
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] file build failed");
            error
        })
        .ok()
        .ok_or_else(|| ApiError::service_unavailable("Failed to fetch remote file"))?;
    let builder = builder.timeout(FILE_TIMEOUT_SECONDS);
    let builder = match executor_name {
        Some(name) => builder.query(&[
            ("task_id", task_id.to_string()),
            ("path", path.to_owned()),
            ("executor_name", name.to_owned()),
        ]),
        None => builder.query(&[("task_id", task_id.to_string()), ("path", path.to_owned())]),
    };
    let response = builder.send().await.map_err(|error| {
        tracing::warn!(%error, url = %url, "[remote_workspace] file request failed");
        ApiError::service_unavailable("Failed to fetch remote file")
    })?;
    file_response(response, &url).await
}

/// Shared `_download_file_via_sandbox`/`_download_file` response handling:
/// 404 -> "File not found", >= 400 -> 502 "Remote file request failed",
/// otherwise the body bytes and `Content-Type` header.
async fn file_response(
    response: brz_http::Response,
    url: &str,
) -> Result<(brz_http_server::Binary, Option<String>), ApiError> {
    let status = response.status().as_u16();
    if status == 404 {
        return Err(ApiError::not_found("File not found"));
    }
    if status >= 400 {
        return Err(ApiError::bad_gateway("Remote file request failed"));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.bytes().await.map_err(|error| {
        tracing::warn!(%error, url = %url, "[remote_workspace] file body read failed");
        ApiError::bad_gateway("Remote file request failed")
    })?;
    Ok((Binary::new(body), content_type))
}

/// Validation-detail carrier for the 422 body: the FastAPI validation-error
/// array serialized as the JSON `detail` string.
#[cfg(test)]
struct ApiErrorDetail<'a> {
    kind: &'a str,
    field: &'a str,
    message: &'a str,
    input: &'a str,
}

#[cfg(test)]
impl ApiErrorDetail<'_> {
    fn to_json_string(&self) -> String {
        let Self {
            kind,
            field,
            message,
            input,
        } = self;
        json!([{
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": input,
        }])
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_body_serializes_fastapi_array() {
        let detail = ApiErrorDetail {
            kind: "missing",
            field: "path",
            message: "Field required",
            input: "",
        };
        let value: serde_json::Value = serde_json::from_str(&detail.to_json_string()).unwrap();
        assert_eq!(value[0]["type"], "missing");
        assert_eq!(value[0]["loc"][0], "query");
        assert_eq!(value[0]["loc"][1], "path");
    }

    #[test]
    fn validation_error_builds_the_fastapi_detail_array() {
        let error = validation_error(
            "disposition",
            "string_pattern_mismatch",
            "String should match pattern '^(inline|attachment)$'",
            "other",
        );
        // The 422 body is `{"detail": [ ... ]}`; the detail payload parses
        // as the FastAPI validation-error array.
        let detail = crate::remote_workspace_tree::error::detail_of(&error);
        assert_eq!(detail[0]["type"], "string_pattern_mismatch");
        assert_eq!(detail[0]["loc"][1], "disposition");
        assert_eq!(
            detail[0]["msg"],
            "String should match pattern '^(inline|attachment)$'"
        );
    }

    #[test]
    fn filename_from_path() {
        assert_eq!(download_filename("/home/user/a.png", None), "a.png");
        assert_eq!(download_filename("/", None), "download");
    }

    #[test]
    fn zip_content_appends_extension() {
        assert_eq!(
            download_filename("/home/user/report", Some("application/zip")),
            "report.zip"
        );
        assert_eq!(
            download_filename(
                "/home/user/report.ZIP",
                Some("application/x-zip-compressed")
            ),
            "report.ZIP"
        );
        assert_eq!(
            download_filename("/home/user/report", Some("text/plain")),
            "report"
        );
    }

    #[test]
    fn ascii_disposition_is_quoted() {
        assert_eq!(
            build_content_disposition("attachment", "02_color.png"),
            r#"attachment; filename="02_color.png""#
        );
        assert_eq!(
            build_content_disposition("inline", "a\"b\\c"),
            r#"inline; filename="a\"b\\c""#
        );
    }

    #[test]
    fn non_ascii_disposition_uses_rfc5987() {
        // `quote` keeps `/` unescaped by default; other bytes are
        // percent-encoded (Python's uppercase hex).
        assert_eq!(
            build_content_disposition("attachment", "示例.txt"),
            "attachment; filename*=UTF-8''%E7%A4%BA%E4%BE%8B.txt"
        );
        assert_eq!(percent_encode("a b/c"), "a%20b/c");
    }
}
