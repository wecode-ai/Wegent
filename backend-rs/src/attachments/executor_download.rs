// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/{attachment_id}/executor-download`
//! (`app/api/endpoints/adapter/attachments.py:executor_download_attachment`).
//!
//! The Executor downloads attachments to the workspace through this
//! endpoint. Unlike `download_attachment` (which the browser path uses),
//! authentication is the flexible `get_current_user_jwt_apikey_tasktoken`
//! dependency (JWT session, personal API key, or task token; the recorded
//! cases carry a task token and resolve the `users` row by id), and
//! ownership is enforced directly by `context_service.get_context_optional`
//! with `user_id` — no `_ensure_attachment_access` task/member chain.
//!
//! Recorded pipeline:
//! 1. `get_current_user_jwt_apikey_tasktoken`: `users` SELECT by id.
//! 2. `get_context_optional(user_id=...)`: `subtask_contexts` SELECT
//!    filtered by `id AND user_id`; miss or `context_type != 'attachment'`
//!    -> 404 `Attachment not found`.
//! 3. `application media download policy` (`external account`-stored video ->
//!    400).
//!    (`_require_attachment_download_allowed` runs before it — see
//!    `download_policy.rs`.)
//! 4. `_stream_stored_attachment`: re-fetch the context by id alone (a
//!    second `subtask_contexts` SELECT), read the bytes from the configured
//!    backend (MinIO HEAD bucket + GET object for the `minio`/`s3`
//!    backends), and return them with `Content-Disposition`,
//!    `Content-Length`, and `X-Accel-Buffering: no`.
use std::borrow::Cow;
use std::sync::Arc;

use brz_http_server::{Binary, HttpResponse, StatusCode};

use super::context_store;
use super::minio_client::MinioConfig;
use super::storage;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

fn error_response(status: StatusCode, detail: &str) -> FastApiError {
    FastApiError::detail(status, detail)
}

fn attachment_not_found() -> FastApiError {
    error_response(StatusCode::NOT_FOUND, "Attachment not found")
}

fn storage_failure() -> FastApiError {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to retrieve attachment data",
    )
}

fn internal_error() -> FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// `_build_content_disposition` (shared with the download handler): ASCII
/// filenames get a quoted `filename="..."`; non-ASCII filenames use RFC
/// 5987 `filename*=UTF-8''<percent-encoded>`.
fn build_content_disposition(filename: &str) -> String {
    if filename.is_ascii() {
        let escaped = filename.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("attachment; filename=\"{escaped}\"");
    }
    format!("attachment; filename*=UTF-8''{}", percent_encode(filename))
}

/// RFC 3986 percent-encoding with no safe characters.
fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
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

/// Handler body for `GET /api/attachments/{attachment_id}/executor-download`.
pub(super) async fn executor_download(
    state: &Arc<AppState>,
    attachment_id: i64,
    authorization: Option<&str>,
    x_api_key: Option<&str>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    // `security.get_current_user_jwt_apikey_tasktoken`.
    let headers = crate::headers::OwnedHeaders::from_pairs([
        ("authorization", authorization),
        ("x-api-key", x_api_key),
    ]);
    let user = crate::attachments_task_all::auth::get_current_user(
        &state.auth,
        &state.mysql,
        &headers.view(),
    )
    .await
    .map_err(FastApiError::from)?;

    // `get_context_optional(user_id=...)`: ownership-checked lookup.
    let context =
        match context_store::get_context_optional_with_user(&state.mysql, attachment_id, user.id)
            .await
        {
            Ok(context) => context,
            Err(error) => {
                tracing::error!(%error, "executor-download context lookup failed");
                return Err(internal_error());
            }
        };
    let Some(context) = context else {
        return Err(attachment_not_found());
    };
    if context.context_type != CONTEXT_TYPE_ATTACHMENT {
        return Err(attachment_not_found());
    }

    // `_require_attachment_download_allowed(db, context, "executor")`: the
    // knowledge-document policy probe (`knowledge_documents` by
    // `attachment_id`, then the active `KnowledgeBase` `Kind`). A database
    // failure raises the source's unhandled 500.
    match super::download_policy::require_attachment_download_allowed(
        &state.mysql,
        attachment_id,
        &context.mime_type(),
        super::download_policy::Purpose::Executor,
    )
    .await
    {
        Ok(None) => {}
        Ok(Some(error)) => return Err(error),
        Err(error) => {
            tracing::error!(%error, "executor-download policy check failed");
            return Err(internal_error());
        }
    }

    // `application media download policy`.
    if state.media_policy.download_unsupported(
        &context.context_type,
        &context.file_extension(),
        &context.storage_backend(),
    ) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Video attachments are stored externally and cannot be downloaded \
             through this endpoint",
        ));
    }

    // `_stream_stored_attachment`: re-fetch the context in the storage
    // worker, then load the bytes from the configured backend.
    let stored = match context_store::get_context_optional(&state.mysql, attachment_id).await {
        Ok(stored) => stored,
        Err(error) => {
            tracing::error!(%error, "executor-download storage refetch failed");
            return Err(storage_failure());
        }
    };
    let Some(stored) = stored else {
        return Err(storage_failure());
    };
    let minio = minio_config_from_env();
    let bytes = match storage::get_attachment_binary_data(
        &state.mysql,
        &state.attachment_http,
        minio.as_ref(),
        &stored,
    )
    .await
    {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(storage_failure()),
        Err(error) => {
            tracing::error!(%error, "executor-download storage read failed");
            return Err(storage_failure());
        }
    };

    let media_type = stored.mime_type();
    let media_type = if media_type.is_empty() {
        Cow::Borrowed("application/octet-stream")
    } else {
        Cow::Owned(media_type)
    };
    let filename = stored.original_filename();
    let content_disposition = build_content_disposition(&filename);

    let mut response = HttpResponse::new(Binary::new(bytes));
    response = response
        .header("content-type", media_type.as_ref())
        .map_err(attachment_header_error)?;
    response = response
        .header("content-disposition", &content_disposition)
        .map_err(attachment_header_error)?;
    response = response
        .header("x-accel-buffering", "no")
        .map_err(attachment_header_error)?;
    Ok(response)
}

/// Maps a response-header construction failure to a 500.
fn attachment_header_error(error: brz_http_server::HeaderBlockError) -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// `get_storage_backend` configuration for the `minio`/`s3` backends
/// (`ATTACHMENT_S3_*`); `None` when not configured, leaving the `mysql`
/// backend in effect.
fn minio_config_from_env() -> Option<MinioConfig> {
    let endpoint = crate::config::env_or_dotenv("ATTACHMENT_S3_ENDPOINT").unwrap_or_default();
    let access_key = crate::config::env_or_dotenv("ATTACHMENT_S3_ACCESS_KEY").unwrap_or_default();
    let secret_key = crate::config::env_or_dotenv("ATTACHMENT_S3_SECRET_KEY").unwrap_or_default();
    if endpoint.is_empty() || access_key.is_empty() || secret_key.is_empty() {
        return None;
    }
    Some(MinioConfig {
        endpoint,
        access_key,
        secret_key,
        bucket: crate::config::env_or_dotenv("ATTACHMENT_S3_BUCKET")
            .unwrap_or_else(|| "attachments".to_string()),
        region: crate::config::env_or_dotenv("ATTACHMENT_S3_REGION")
            .unwrap_or_else(|| "us-east-1".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_filenames_use_quoted_disposition() {
        assert_eq!(
            build_content_disposition("herdr-linux-x86_64-v0.8.2.zip"),
            "attachment; filename=\"herdr-linux-x86_64-v0.8.2.zip\""
        );
    }

    #[test]
    fn non_ascii_filenames_use_rfc5987() {
        // The recorded Content-Disposition for attachment 1272696.
        assert_eq!(
            build_content_disposition("0901示例.txt"),
            "attachment; filename*=UTF-8''0901%E7%A4%BA%E4%BE%8B.txt"
        );
    }
}
