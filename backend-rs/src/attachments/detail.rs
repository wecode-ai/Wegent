// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Attachment detail and credential routes:
//! `GET /api/attachments/{attachment_id}` — attachment detail
//! (`app/api/endpoints/adapter/attachments.py:get_attachment`);
//! `GET /api/attachments/{attachment_id}/executor-download`,
//! `GET /api/attachments/{attachment_id}/download`,
//! `GET /api/attachments/download/shared`, and
//! `POST /api/attachments/{attachment_id}/download-token`.
//!
//! JWT method (the recorded path): `get_current_user_optional` then
//! `_get_attachment_context` (`get_context_optional` SELECT, 404 when absent
//! or not the `attachment` context type, `_ensure_attachment_access`) and
//! `AttachmentDetailResponse.from_context` (a pure row projection; no
//! further dependency calls). The recorded cases use the JWT method; the
//! share-token method is the public shared-task branch: `share_token.rs`
//! validates the task/subtask/owner chain and a granted viewer re-reads the
//! context directly (no `_ensure_attachment_access`), exactly like the
//! playback and download endpoints. The download-token route uses the
//! required `get_current_user`, the same context/access check, and the
//! knowledge-document download policy before minting its token.
use std::sync::Arc;

use brz_http_server::{Response, StatusCode};

use super::auth::{AttachmentUser, UserRow};
use super::context_store::{self};
use super::detail_response::AttachmentDetailResponse;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

fn attachment_not_found() -> crate::http_compat::FastApiError {
    error_response(StatusCode::NOT_FOUND, "Attachment not found")
}

fn internal_error() -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// Handler body for `GET /api/attachments/{attachment_id}`.
async fn attachment_detail(
    state: &Arc<AppState>,
    attachment_id: i64,
    share_token: Option<&str>,
    user: Option<&UserRow>,
) -> Result<AttachmentDetailResponse, crate::http_compat::FastApiError> {
    // A present `share_token` selects the public shared-task method; an empty
    // parameter is falsy in the source and falls through to the session JWT.
    let context = match share_token.filter(|token| !token.is_empty()) {
        Some(token) => {
            // Method 1: the share-token viewer. `_validate_share_token_access`
            // owns the task/subtask/owner chain; a denied token renders the
            // endpoint's 403 (not the download endpoint's 404).
            let has_access =
                super::share_token::validate_share_token_access(state, attachment_id, token)
                    .await?;
            if !has_access {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Share token access denied",
                ));
            }
            // The granted viewer re-reads the context directly; the source
            // does not re-check the `attachment` context type here.
            match context_store::get_context_optional(&state.mysql, attachment_id).await {
                Ok(Some(context)) => context,
                Ok(None) => return Err(attachment_not_found()),
                Err(error) => {
                    tracing::error!(%error, "attachment share context lookup failed");
                    return Err(internal_error());
                }
            }
        }
        // Method 2: the bearer session JWT (`get_current_user_optional`).
        None => match user {
            Some(user) => {
                let context =
                    match context_store::get_context_optional(&state.mysql, attachment_id).await {
                        Ok(context) => context,
                        Err(error) => {
                            tracing::error!(%error, "attachment context lookup failed");
                            return Err(internal_error());
                        }
                    };
                let Some(context) = context else {
                    return Err(attachment_not_found());
                };
                if context.context_type != CONTEXT_TYPE_ATTACHMENT {
                    return Err(attachment_not_found());
                }
                let has_access = match context_store::ensure_attachment_access(
                    &*state.task_store,
                    &state.mysql,
                    state.redis.as_ref(),
                    &state.entity_resolvers,
                    &context,
                    user.users_id,
                )
                .await
                {
                    Ok(access) => access,
                    Err(error) => {
                        tracing::error!(%error, "attachment access check failed");
                        return Err(internal_error());
                    }
                };
                if !has_access {
                    return Err(attachment_not_found());
                }
                context
            }
            // No authentication provided.
            None => {
                return Err(error_response(
                    StatusCode::UNAUTHORIZED,
                    "Authentication required",
                ));
            }
        },
    };

    // The endpoint declares `response_model=AttachmentDetailResponse`, so
    // FastAPI renders the model through its default `JSONResponse` and
    // announces `application/json`; returning the typed value keeps that media
    // type (a raw `HttpResponse<Binary>` body would announce
    // `application/octet-stream`).
    Ok(AttachmentDetailResponse::from_context(&context))
}

/// GET /api/attachments/{attachment_id}: the attachment detail free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/attachments/:attachment_id", access = optional)]
async fn get_attachment(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    share_token: Option<String>,
    #[auth] user: Option<AttachmentUser>,
) -> Result<AttachmentDetailResponse, crate::http_compat::FastApiError> {
    attachment_detail(
        state,
        attachment_id,
        share_token.as_deref(),
        user.as_deref(),
    )
    .await
}

/// GET /api/attachments/{attachment_id}/executor-download.
#[brz_http_server::get("/api/attachments/:attachment_id/executor-download")]
async fn executor_download_attachment(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    #[auth] user: crate::attachments_task_all::auth::AuthenticatedUser,
) -> Result<super::external_media::AttachmentDownload, crate::http_compat::FastApiError> {
    super::executor_download::executor_download(state, attachment_id, &user).await
}

/// GET /api/attachments/{attachment_id}/download.
#[allow(clippy::too_many_arguments)]
#[brz_http_server::get("/api/attachments/:attachment_id/download", access = optional)]
async fn download(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    download_token: Option<String>,
    share_token: Option<String>,
    purpose: Option<String>,
    #[header("range")] range: Option<&str>,
    #[header("accept")] accept: Option<&str>,
    #[header("host")] host: Option<&str>,
    #[header("x-forwarded-host")] forwarded_host: Option<&str>,
    #[header("x-forwarded-proto")] forwarded_proto: Option<&str>,
    #[auth] user: Option<AttachmentUser>,
) -> Result<super::handler::DownloadOutcome, crate::http_compat::FastApiError> {
    let request = super::handler::AnonymousRequest {
        accept,
        host,
        forwarded_host,
        forwarded_proto,
        attachment_id,
        purpose: purpose.as_deref(),
    };
    super::handler::download_attachment(
        state,
        attachment_id,
        download_token.as_deref(),
        share_token.as_deref(),
        purpose.as_deref(),
        range,
        user.as_deref(),
        &request,
    )
    .await
}

/// GET /api/attachments/{attachment_id}/playback.
#[brz_http_server::get("/api/attachments/:attachment_id/playback", access = optional)]
async fn get_attachment_playback(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    share_token: Option<String>,
    #[auth] user: Option<AttachmentUser>,
) -> Result<super::playback::AttachmentPlaybackResponse, crate::http_compat::FastApiError> {
    super::playback::attachment_playback(
        state,
        attachment_id,
        share_token.as_deref(),
        user.as_deref(),
    )
    .await
}

/// GET /api/attachments/download/shared: the public share-link download
/// (`public_download_attachment`). The static route outranks the
/// `:attachment_id` captures (three literal segments vs. one).
#[brz_http_server::get("/api/attachments/download/shared", access = public)]
async fn download_shared(
    #[inject(state)] state: &Arc<AppState>,
    token: String,
    #[header("range")] range: Option<&str>,
) -> Result<super::external_media::AttachmentDownload, crate::http_compat::FastApiError> {
    super::shared_download::public_download_attachment(state, &token, range).await
}

/// The download-token response body (`{"download_token": ..., "expires_in": 300}`),
/// serialized in the source dict's key order.
#[derive(serde::Serialize)]
struct DownloadTokenResponse {
    download_token: String,
    expires_in: i64,
}

/// POST /api/attachments/{attachment_id}/download-token
/// (`create_attachment_download_token`): a required session JWT
/// (`get_current_user`), the attachment context/access check, and the
/// knowledge-document download policy, then a short-lived HS256 token bound
/// to the attachment and issuing user.
#[brz_http_server::post("/api/attachments/:attachment_id/download-token")]
async fn create_attachment_download_token(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    #[auth] user: crate::auth::SessionUser,
) -> Result<Response, crate::http_compat::FastApiError> {
    let context = super::handler::get_attachment_context(state, attachment_id, user.id).await?;

    // `_require_attachment_download_allowed(db, context, "download")`.
    let file_extension = context.file_extension();
    match super::download_policy::require_attachment_download_allowed(
        &state.mysql,
        attachment_id,
        &context.mime_type(),
        Some(&file_extension),
        super::download_policy::Purpose::Download,
    )
    .await
    {
        Ok(None) => {}
        Ok(Some(error)) => return Err(error),
        Err(error) => {
            tracing::error!(%error, "attachment download policy check failed");
            return Err(internal_error());
        }
    }

    let download_token = super::download_token::create_download_token(
        &state.auth,
        attachment_id,
        user.id,
        &user.user_name,
        super::download_token::DOWNLOAD_PURPOSE,
    )
    .ok_or_else(internal_error)?;
    let body = serde_json::to_string(&DownloadTokenResponse {
        download_token,
        expires_in: super::download_token::DOWNLOAD_TOKEN_EXPIRE_SECONDS,
    })
    .map_err(|_| internal_error())?;
    Ok(Response::owned_bytes(StatusCode::OK, body).content_type("application/json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::context_store::SubtaskContextRow;
    use brz_mysql::Json;
    use chrono::NaiveDateTime;
    use serde_json::Value;
    use serde_json::json;

    /// Serialize the detail body in the source field order with `null` for
    /// absent values.
    fn render(context: &SubtaskContextRow) -> String {
        serde_json::to_string(&AttachmentDetailResponse::from_context(context))
            .expect("attachment response serializes")
    }

    fn context_row(context_type: &str, type_data: Value) -> SubtaskContextRow {
        SubtaskContextRow {
            id: 1281270,
            subtask_id: 521168511716528,
            user_id: 3792,
            context_type: context_type.to_string(),
            name: "SKILL_example-record.md".to_string(),
            status: "ready".to_string(),
            error_message: Some(String::new()),
            binary_data: Vec::new(),
            image_base64: None,
            extracted_text: None,
            text_length: 9985,
            type_data: Some(Json(type_data.into())),
            created_at: NaiveDateTime::parse_from_str("2026-09-06 21:00:00", "%Y-%m-%d %H:%M:%S")
                .ok(),
            updated_at: None,
        }
    }

    /// The download-token body keeps the source dict's key order so the
    /// recorded `{"download_token": ..., "expires_in": 300}` shape matches.
    #[test]
    fn download_token_response_keeps_source_key_order() {
        let body = serde_json::to_string(&DownloadTokenResponse {
            download_token: "tok".to_string(),
            expires_in: 300,
        })
        .expect("serializes");
        assert_eq!(body, "{\"download_token\":\"tok\",\"expires_in\":300}");
    }

    #[test]
    fn renders_expected_response_shape() {
        let context = context_row(
            "attachment",
            json!({
                "original_filename": "SKILL_example-record.md",
                "file_size": 23703,
                "mime_type": "text/markdown",
                "file_extension": ".md",
                "is_encrypted": false,
            }),
        );
        let rendered = render(&context);
        let value: Value = serde_json::from_str(&rendered).expect("valid json");
        assert_eq!(value["id"], 1281270);
        assert_eq!(value["filename"], "SKILL_example-record.md");
        assert_eq!(value["file_size"], 23703);
        assert_eq!(value["mime_type"], "text/markdown");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["file_extension"], ".md");
        assert_eq!(value["text_length"], 9985);
        assert_eq!(value["error_message"], "");
        assert!(value["error_code"].is_null());
        assert!(value["truncation_info"].is_null());
        assert_eq!(value["created_at"], "2026-09-06T21:00:00");
        assert!(value["external_media_type"].is_null());
        assert!(value["text_count"].is_null());
        assert!(value["video_count"].is_null());
        assert!(value["image_count"].is_null());
        assert!(value["comment_count"].is_null());
        assert!(value["fetched_comment_count"].is_null());
        assert!(value["site"].is_null());
        assert!(value["source_url"].is_null());
        assert!(value["cover_url"].is_null());
        assert_eq!(value["subtask_id"], 521168511716528i64);
    }

    #[test]
    fn external_web_content_attachments_carry_display_fields() {
        let context = context_row(
            "attachment",
            json!({
                "source": "external_web_content",
                "external_media_type": "text",
                "site": "example.net",
                "external_source_url": "https://example.net/a",
            }),
        );
        let rendered = render(&context);
        let value: Value = serde_json::from_str(&rendered).expect("valid json");
        assert_eq!(value["external_media_type"], "text");
        assert_eq!(value["text_count"], 1);
        assert_eq!(value["site"], "example.net");
        assert_eq!(value["source_url"], "https://example.net/a");
    }

    #[test]
    fn zero_subtask_id_maps_to_null() {
        let mut context = context_row("attachment", json!({}));
        context.subtask_id = 0;
        let rendered = render(&context);
        let value: Value = serde_json::from_str(&rendered).expect("valid json");
        assert!(value["subtask_id"].is_null());
    }

    /// The cutover and the handler registration must agree. The hybrid
    /// gateway forwards unselected paths to Python, whose Replay upstream is
    /// unavailable (`502 fallback upstream unavailable`), so a missing route
    /// entry reproduces the recorded failure instead of the detail body.
    #[test]
    fn selected_route_is_registered_in_the_shared_group() {
        const PATH: &str = "/api/attachments/:attachment_id";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::load_routes_config(&file).unwrap();
        assert!(
            config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must be selected for Rust"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(table.matches(&http::Method::GET, "/api/attachments/1385519"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    /// A dedicated test group (separate from the crate's real `http_apis`
    /// group) so the probe's route does not collide with the real handler's
    /// registration.
    mod probe {
        brz_http_server::registry!(group = attachment_detail_probe, dependencies());
    }

    /// Renders the endpoint's success value through its return shape over a
    /// real socket. The source declares
    /// `response_model=AttachmentDetailResponse`, so FastAPI renders the model
    /// through its default `JSONResponse` and announces `application/json`; a
    /// raw `HttpResponse<Binary>` body would announce
    /// `application/octet-stream` instead.
    #[brz_http_server::get(
        "/api/attachments/:attachment_id",
        group = probe::attachment_detail_probe,
        access = public
    )]
    async fn get_attachment_probe(
        attachment_id: i64,
    ) -> Result<AttachmentDetailResponse, crate::http_compat::FastApiError> {
        let mut context = context_row(
            "attachment",
            json!({
                "original_filename": "SKILL_example-record.md",
                "file_size": 23703,
                "mime_type": "text/markdown",
                "file_extension": ".md",
            }),
        );
        context.id = attachment_id;
        Ok(AttachmentDetailResponse::from_context(&context))
    }

    /// Serves the probe route on a real socket so the status, headers, and body
    /// are asserted exactly as the runtime renders them.
    async fn serve_detail(attachment_id: i64) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        use tokio::net::TcpStream;

        let handler = brz_http_server::handlers!(; group = probe::attachment_detail_probe)
            .expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(
                format!(
                    "GET /api/attachments/{attachment_id} HTTP/1.1\r\n\
                     Host: localhost\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn success_response_announces_application_json() {
        let raw = serve_detail(1281270).await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        let content_type = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
            .expect("content-type header");
        assert_eq!(
            content_type["content-type:".len()..].trim(),
            "application/json",
            "{raw}"
        );
        let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        assert!(
            body.starts_with(r#"{"id":1281270,"filename":"SKILL_example-record.md","#),
            "{body}"
        );
    }
}
