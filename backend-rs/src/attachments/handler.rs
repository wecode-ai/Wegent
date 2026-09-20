// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/{attachment_id}/download`.

use std::borrow::Cow;
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_http_server::{Binary, HttpResponse};

use super::auth::get_current_user_optional;
use super::context_store::{self, SubtaskContextRow};
use super::minio_client::MinioConfig;
use super::storage;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

/// Source `ATTACHMENT_STREAM_CHUNK_SIZE` (1 MiB). The target returns the
/// buffered bytes in one body; the chunk size bounds the streaming loop in
/// the source and is not observable in the response.
#[allow(dead_code)]
const ATTACHMENT_STREAM_CHUNK_SIZE: usize = 1024 * 1024;

/// Image extensions (`ContextService.IMAGE_EXTENSIONS`).
const IMAGE_EXTENSIONS: [&str; 6] = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

/// Video extensions (`DocumentParser.VIDEO_EXTENSIONS`).
const VIDEO_EXTENSIONS: [&str; 6] = [".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"];

/// 404 `{"detail": "Attachment not found"}`.
fn attachment_not_found() -> crate::http_compat::FastApiError {
    error_response(StatusCode::NOT_FOUND, "Attachment not found")
}

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

/// `_build_content_disposition`: ASCII filenames get a quoted
/// `filename="..."` (backslash and quote escaped); non-ASCII filenames use
/// RFC 5987 `filename*=UTF-8''<percent-encoded>`.
fn build_content_disposition(filename: &str) -> String {
    if filename.is_ascii() {
        let escaped = filename.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("attachment; filename=\"{escaped}\"");
    }
    format!("attachment; filename*=UTF-8''{}", percent_encode(filename))
}

/// RFC 3986 percent-encoding with no safe characters (`quote(filename,
/// safe="")`).
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

/// `ContextService.is_video_context`.
#[allow(dead_code)]
fn is_video_context(context: &SubtaskContextRow) -> bool {
    let extension = context.file_extension().to_lowercase();
    context.context_type == CONTEXT_TYPE_ATTACHMENT
        && VIDEO_EXTENSIONS.contains(&extension.as_str())
}

#[allow(dead_code)]
fn is_image_context(context: &SubtaskContextRow) -> bool {
    let extension = context.file_extension().to_lowercase();
    context.context_type == CONTEXT_TYPE_ATTACHMENT
        && IMAGE_EXTENSIONS.contains(&extension.as_str())
}

/// Handler body for `GET /api/attachments/{attachment_id}/download`
/// (JWT method; the recorded authentication path).
pub(super) async fn download_attachment(
    state: &Arc<AppState>,
    attachment_id: i64,
    authorization: Option<&str>,
) -> Result<HttpResponse<Binary>, crate::http_compat::FastApiError> {
    // `get_current_user_optional` then `_get_attachment_context` +
    // `_ensure_attachment_access` (404 on every failure mode).
    let user = match get_current_user_optional(&state.auth, &state.mysql, authorization).await {
        Ok(user) => user,
        Err(error) => {
            tracing::error!(%error, "attachment download user lookup failed");
            return Err(internal_error());
        }
    };
    let Some(user) = user else {
        // No authentication provided: the source falls back to share tokens
        // and browser redirects; without either, 401.
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        ));
    };

    let context = match context_store::get_context_optional(&state.mysql, attachment_id).await {
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
        &state.mysql,
        state.task_policy,
        &context,
        &user,
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

    // `_require_attachment_download_allowed(db, context, "download")`: the
    // knowledge-document policy probe (`knowledge_documents` by
    // `attachment_id`, then the active `KnowledgeBase` `Kind`). A database
    // failure raises the source's unhandled 500.
    match super::download_policy::require_attachment_download_allowed(
        &state.mysql,
        attachment_id,
        &context.mime_type(),
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
            tracing::error!(%error, "attachment storage refetch failed");
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
            tracing::error!(%error, "attachment storage read failed");
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

/// Maps a response-header construction failure to a 500 (a malformed stored
/// filename or media type; not an expected client-visible failure).
fn attachment_header_error(
    error: brz_http_server::HeaderBlockError,
) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn storage_failure() -> crate::http_compat::FastApiError {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to retrieve attachment data",
    )
}

fn internal_error() -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// `get_storage_backend` configuration for the `minio`/`s3` backends
/// (`ATTACHMENT_S3_*`); `None` when not configured, leaving the `mysql`
/// backend in effect. Like every source `settings.*` read, the values come
/// from the process environment or the source-compatible `/app/.env` dotenv
/// file (`app/core/config.py` `Settings`, `env_file=".env"`).
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
            build_content_disposition("report.pdf"),
            "attachment; filename=\"report.pdf\""
        );
        assert_eq!(
            build_content_disposition("a\"b\\c.txt"),
            "attachment; filename=\"a\\\"b\\\\c.txt\""
        );
    }

    #[test]
    fn non_ascii_filenames_use_rfc5987() {
        // Non-ASCII filenames use the RFC 5987 form.
        assert_eq!(
            build_content_disposition("示例项目思维导图_清晰版.png"),
            concat!(
                "attachment; filename*=UTF-8''",
                "%E7%A4%BA%E4%BE%8B%E9%A1%B9%E7%9B%AE",
                "%E6%80%9D%E7%BB%B4%E5%AF%BC%E5%9B%BE_%E6%B8%85%E6%99%B0%E7%89%88.png"
            )
        );
    }

    #[test]
    fn percent_encodes_like_python_quote() {
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a-b.c_d~e"), "a-b.c_d~e");
    }
}
