// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/{attachment_id}/download`.

use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_http_server::{Binary, HttpResponse};

use super::auth::UserRow;
use super::context_store::{self, SubtaskContextRow};
use super::download_token::{self, DownloadPurpose};
use super::external_media::{AttachmentDownload, ExternalMediaReference};
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

/// 401 `{"detail": "Invalid download token"}`: one outcome for every
/// download-token decode, claim, and user failure.
fn invalid_download_token() -> crate::http_compat::FastApiError {
    error_response(StatusCode::UNAUTHORIZED, "Invalid download token")
}

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

/// `_build_content_disposition`: a latin-1-encodable filename gets a quoted
/// `filename="..."` (backslash and quote escaped); any other filename uses
/// RFC 5987 `filename*=UTF-8''<percent-encoded>`.
fn build_content_disposition(disposition: &str, filename: &str) -> String {
    if is_latin1(filename) {
        let escaped = filename.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("{disposition}; filename=\"{escaped}\"");
    }
    format!(
        "{disposition}; filename*=UTF-8''{}",
        percent_encode(filename)
    )
}

/// `filename.encode("latin-1")` succeeding: every code point fits one byte,
/// so the quoted form carries the name verbatim.
fn is_latin1(value: &str) -> bool {
    value.chars().all(|character| (character as u32) <= 0xFF)
}

/// `urllib.parse.quote(filename)` with its default safe set: unreserved
/// characters plus `/`.
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

/// Handler body for `GET /api/attachments/{attachment_id}/download`.
///
/// The source authenticates the request with, in order, a
/// `download_token` query parameter (method 1), a `share_token` query
/// parameter (method 2), the bearer session JWT (method 3), or the
/// anonymous browser redirect (method 4). Methods 1 and 3 are implemented;
/// a request carrying neither falls through to the source's non-browser
/// outcome, `401 Authentication required`.
///
/// The resolved purpose selects both the file disposition
/// (`playback`/`preview` stream inline, everything else attaches) and the
/// argument the knowledge-document download policy checks.
pub(super) async fn download_attachment(
    state: &Arc<AppState>,
    attachment_id: i64,
    download_token: Option<&str>,
    user: Option<&UserRow>,
) -> Result<AttachmentDownload, crate::http_compat::FastApiError> {
    // The source tests `if download_token:` first, so an empty parameter is
    // treated as absent and the session credential applies instead.
    let (context, download_purpose) = match download_token.filter(|token| !token.is_empty()) {
        // Method 1: the short-lived browser-native download token. Its user
        // lookup precedes the context read, unlike the session method where
        // the credential is already resolved.
        Some(token) => {
            let resolved = match download_token::resolve_user_from_download_token(
                &state.auth,
                &state.mysql,
                attachment_id,
                token,
            )
            .await
            {
                Ok(Some(resolved)) => resolved,
                Ok(None) => return Err(invalid_download_token()),
                Err(error) => {
                    tracing::error!(%error, "attachment download token lookup failed");
                    return Err(internal_error());
                }
            };
            let context = get_attachment_context(state, attachment_id, &resolved.user).await?;
            (context, resolved.purpose)
        }
        // Method 3: the bearer session JWT (`get_current_user_optional`).
        None => {
            let Some(user) = user else {
                // No authentication provided: the source falls back to share
                // tokens and browser redirects; without either, 401.
                return Err(error_response(
                    StatusCode::UNAUTHORIZED,
                    "Authentication required",
                ));
            };
            let context = get_attachment_context(state, attachment_id, user).await?;
            (context, DownloadPurpose::Download)
        }
    };
    let disposition = match download_purpose {
        DownloadPurpose::Playback => "inline",
        DownloadPurpose::Download => "attachment",
    };

    // `_require_attachment_download_allowed(db, context, download_purpose)`:
    // the knowledge-document policy probe (`knowledge_documents` by
    // `attachment_id`, then the active `KnowledgeBase` `Kind`). A database
    // failure raises the source's unhandled 500.
    let policy_purpose = match download_purpose {
        DownloadPurpose::Playback => super::download_policy::Purpose::Playback,
        DownloadPurpose::Download => super::download_policy::Purpose::Download,
    };
    match super::download_policy::require_attachment_download_allowed(
        &state.mysql,
        attachment_id,
        &context.mime_type(),
        policy_purpose,
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

    // `_stream_external_attachment(context, range_header, disposition)`: the
    // application-owned playback resolvers decide whether the attachment is
    // served from external media before the external-media policy and the stored
    // bytes (`external_media.rs`). The open-source deployment registers no
    // resolvers, so the stage resolves nothing and ordinary attachments keep
    // their local-bytes path; the internal deployment's resolver chain relays
    // the media and reproduces the source's unhandled 500 when its transport
    // fails.
    if let Some(response) = state
        .external_media
        .stream_external_attachment(super::external_media::ExternalMediaRequest {
            attachment_id,
            user_id: context.user_id.into(),
            original_filename: &context.original_filename(),
            reference: ExternalMediaReference::from_context(&context),
        })
        .await?
    {
        return Ok(response);
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

    let mime_type = stored.mime_type();
    let media_type = super::content_type::content_type_value(&mime_type);
    let filename = stored.original_filename();
    let content_disposition = build_content_disposition(disposition, &filename);

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
    Ok(AttachmentDownload::Binary(response))
}

/// `_get_attachment_context`: load the context
/// (`context_service.get_context_optional`), require the `attachment`
/// context type, and run `_ensure_attachment_access`; every failure is the
/// source's 404 `Attachment not found`.
async fn get_attachment_context(
    state: &Arc<AppState>,
    attachment_id: i64,
    user: &UserRow,
) -> Result<SubtaskContextRow, crate::http_compat::FastApiError> {
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
        &*state.task_store,
        &state.mysql,
        &context,
        user,
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
    Ok(context)
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
            build_content_disposition("attachment", "report.pdf"),
            "attachment; filename=\"report.pdf\""
        );
        assert_eq!(
            build_content_disposition("attachment", "a\"b\\c.txt"),
            "attachment; filename=\"a\\\"b\\\\c.txt\""
        );
        assert_eq!(
            build_content_disposition("inline", "report.pdf"),
            "inline; filename=\"report.pdf\""
        );
    }

    /// The source quotes any name that `encode("latin-1")` accepts, not only
    /// ASCII ones, so a codepoint up to U+00FF keeps the verbatim form.
    #[test]
    fn latin1_filenames_use_quoted_disposition() {
        assert_eq!(
            build_content_disposition("attachment", "caf\u{e9}.pdf"),
            "attachment; filename=\"caf\u{e9}.pdf\""
        );
        assert_eq!(
            build_content_disposition("attachment", "na\u{ef}ve \u{ff}.txt"),
            "attachment; filename=\"na\u{ef}ve \u{ff}.txt\""
        );
    }

    #[test]
    fn non_ascii_filenames_use_rfc5987() {
        // Beyond latin-1, the name uses the RFC 5987 form.
        assert_eq!(
            build_content_disposition("attachment", "示例项目思维导图_清晰版.png"),
            concat!(
                "attachment; filename*=UTF-8''",
                "%E7%A4%BA%E4%BE%8B%E9%A1%B9%E7%9B%AE",
                "%E6%80%9D%E7%BB%B4%E5%AF%BC%E5%9B%BE_%E6%B8%85%E6%99%B0%E7%89%88.png"
            )
        );
    }

    /// `urllib.parse.quote` keeps `/` safe by default, so a path-like
    /// filename survives without escaping that separator.
    #[test]
    fn percent_encodes_like_python_quote() {
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a-b.c_d~e"), "a-b.c_d~e");
        assert_eq!(percent_encode("a b/示例"), "a%20b/%E7%A4%BA%E4%BE%8B");
    }

    #[test]
    fn latin1_check_spans_exactly_one_byte() {
        assert!(is_latin1("report.pdf"));
        assert!(is_latin1("\u{e9}"));
        assert!(!is_latin1("\u{100}"));
        assert!(!is_latin1("示例"));
    }
}
