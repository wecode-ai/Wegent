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

/// `str(request.url)`: the absolute URL the source observes behind its
/// proxy — `x-forwarded-proto` scheme and the forwarded authority
/// (`x-forwarded-host`, falling back to the `Host` header), plus the
/// request target. The redirect branch only runs without `download_token`
/// or `share_token`, so the query string is at most the caller's `purpose`.
fn request_url(request: &AnonymousRequest<'_>) -> String {
    let scheme = request.forwarded_proto.unwrap_or("http");
    let host = request
        .forwarded_host
        .filter(|value| !value.is_empty())
        .or(request.host)
        .unwrap_or("localhost");
    let mut url = format!(
        "{scheme}://{host}/api/attachments/{}/download",
        request.attachment_id
    );
    if let Some(purpose) = request.purpose.filter(|value| !value.is_empty()) {
        url.push_str("?purpose=");
        url.push_str(&percent_encode(purpose));
    }
    url
}

/// `_build_content_disposition`: a latin-1-encodable filename gets a quoted
/// `filename="..."` (backslash and quote escaped); any other filename uses
/// RFC 5987 `filename*=UTF-8''<percent-encoded>`.
pub(crate) fn build_content_disposition(disposition: &str, filename: &str) -> String {
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

/// `download_purpose = "preview" if purpose == "preview" else "download"`:
/// the session method's access-purpose override (`only 'preview' is
/// honoured`).
fn session_download_purpose(purpose: Option<&str>) -> DownloadPurpose {
    if purpose == Some("preview") {
        DownloadPurpose::Preview
    } else {
        DownloadPurpose::Download
    }
}

/// `disposition=("inline" if download_purpose in ("playback", "preview") else
/// "attachment")`.
fn attachment_disposition(download_purpose: DownloadPurpose) -> &'static str {
    match download_purpose {
        DownloadPurpose::Playback | DownloadPurpose::Preview => "inline",
        DownloadPurpose::Download | DownloadPurpose::Share => "attachment",
    }
}

/// The request context the anonymous browser-redirect branch needs
/// (`request.headers.get("Accept")` and `str(request.url)`).
pub(super) struct AnonymousRequest<'a> {
    pub accept: Option<&'a str>,
    pub host: Option<&'a str>,
    pub forwarded_host: Option<&'a str>,
    pub forwarded_proto: Option<&'a str>,
    pub attachment_id: i64,
    pub purpose: Option<&'a str>,
}

/// The download endpoint's outcome: the file stream or the anonymous
/// browser-redirect `302` to the frontend login page.
pub(super) enum DownloadOutcome {
    Download(AttachmentDownload),
    LoginRedirect(brz_http_server::Redirect),
}

impl brz_http_server::IntoHttpResponse<brz_http_server::__private::kind::Direct>
    for DownloadOutcome
{
    fn into_http_response(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Download(download) => download.into_http_response(arena),
            Self::LoginRedirect(redirect) => redirect.into_http_response(arena),
        }
    }
}

/// Handler body for `GET /api/attachments/{attachment_id}/download`.
///
/// The source authenticates the request with, in order, a
/// `download_token` query parameter (method 1), a `share_token` query
/// parameter (method 2), the bearer session JWT (method 3), or the
/// anonymous browser redirect (method 4): a browser Accept header gets a
/// `302` to `{FRONTEND_URL}/login?redirect={quote(current_url)}`, anything
/// else the `401 Authentication required` body.
///
/// The resolved purpose selects both the file disposition
/// (`playback`/`preview` stream inline, everything else attaches) and the
/// argument the knowledge-document download policy checks.
#[allow(clippy::too_many_arguments)]
pub(super) async fn download_attachment(
    state: &Arc<AppState>,
    attachment_id: i64,
    download_token: Option<&str>,
    share_token: Option<&str>,
    purpose: Option<&str>,
    range_header: Option<&str>,
    user: Option<&UserRow>,
    request: &AnonymousRequest<'_>,
) -> Result<DownloadOutcome, crate::http_compat::FastApiError> {
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
            let context =
                get_attachment_context(state, attachment_id, resolved.user.users_id).await?;
            (context, resolved.purpose)
        }
        // Method 2: the public shared-task share token. The access check owns
        // the task/subtask/owner chain; a granted viewer then re-reads the
        // context directly (`get_context_optional`, no `_ensure_attachment_access`).
        None => match share_token.filter(|token| !token.is_empty()) {
            Some(token) => {
                let has_access =
                    super::share_token::validate_share_token_access(state, attachment_id, token)
                        .await?;
                if !has_access {
                    return Err(attachment_not_found());
                }
                let context =
                    match context_store::get_context_optional(&state.mysql, attachment_id).await {
                        Ok(context) => context,
                        Err(error) => {
                            tracing::error!(%error, "attachment share context lookup failed");
                            return Err(internal_error());
                        }
                    };
                let Some(context) = context else {
                    return Err(attachment_not_found());
                };
                (context, DownloadPurpose::Share)
            }
            // Method 3: the bearer session JWT (`get_current_user_optional`).
            None => {
                let Some(user) = user else {
                    // Method 4: no authentication. A browser Accept header
                    // redirects to the frontend login page; an API client
                    // gets the 401 body.
                    if request
                        .accept
                        .is_some_and(|accept| accept.contains("text/html"))
                    {
                        let current_url = request_url(request);
                        let login_url = format!(
                            "{}/login?redirect={}",
                            state.oidc_config.frontend_url,
                            percent_encode(&current_url)
                        );
                        return Ok(DownloadOutcome::LoginRedirect(
                            brz_http_server::Redirect::found(login_url),
                        ));
                    }
                    return Err(error_response(
                        StatusCode::UNAUTHORIZED,
                        "Authentication required",
                    ));
                };
                let context = get_attachment_context(state, attachment_id, user.users_id).await?;
                // `download_purpose = "preview" if purpose == "preview" else
                // "download"`: only the session method honours the override.
                let download_purpose = session_download_purpose(purpose);
                (context, download_purpose)
            }
        },
    };
    let disposition = attachment_disposition(download_purpose);

    // `_require_attachment_download_allowed(db, context, download_purpose)`:
    // the knowledge-document policy probe (`knowledge_documents` by
    // `attachment_id`, then the active `KnowledgeBase` `Kind`). A database
    // failure raises the source's unhandled 500.
    let policy_purpose = match download_purpose {
        DownloadPurpose::Playback => super::download_policy::Purpose::Playback,
        DownloadPurpose::Download => super::download_policy::Purpose::Download,
        DownloadPurpose::Share => super::download_policy::Purpose::Share,
        DownloadPurpose::Preview => super::download_policy::Purpose::Preview,
    };
    let file_extension = context.file_extension();
    match super::download_policy::require_attachment_download_allowed(
        &state.mysql,
        attachment_id,
        &context.mime_type(),
        Some(&file_extension),
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
            // `download_attachment`'s `range_header` (`Header(None, alias
            // "Range")`), forwarded by `_stream_remote_media`.
            range_header,
            reference: ExternalMediaReference::from_context(&context),
        })
        .await?
    {
        return Ok(DownloadOutcome::Download(response));
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
    Ok(DownloadOutcome::Download(AttachmentDownload::Binary(
        response,
    )))
}

/// `_get_attachment_context`: load the context
/// (`context_service.get_context_optional`), require the `attachment`
/// context type, and run `_ensure_attachment_access`; every failure is the
/// source's 404 `Attachment not found`.
///
/// The JWT-authenticated download endpoint and the attachment playback
/// endpoint share this resolution.
pub(super) async fn get_attachment_context(
    state: &Arc<AppState>,
    attachment_id: i64,
    user_id: i32,
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
        state.redis.as_ref(),
        &state.entity_resolvers,
        &context,
        user_id,
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

pub(super) fn internal_error() -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// `get_storage_backend` configuration for the `minio`/`s3` backends
/// (`ATTACHMENT_S3_*`); `None` when not configured, leaving the `mysql`
/// backend in effect.
fn minio_config_from_env() -> Option<MinioConfig> {
    MinioConfig::from_env()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `str(request.url)` behind the proxy: the forwarded scheme, the Host
    /// authority, and the request path (plus `purpose` when sent).
    #[test]
    fn request_url_uses_forwarded_scheme_and_host() {
        let request = AnonymousRequest {
            accept: None,
            host: Some("127.0.0.1:8080"),
            forwarded_host: Some("wegent.example.invalid"),
            forwarded_proto: Some("https"),
            attachment_id: 1392665,
            purpose: None,
        };
        assert_eq!(
            request_url(&request),
            "https://wegent.example.invalid/api/attachments/1392665/download"
        );
    }

    #[test]
    fn the_login_redirect_quotes_the_current_url() {
        // `quote(current_url)` with the default safe set keeps `/` and
        // escapes `:` — the recorded `Location` shape.
        let request = AnonymousRequest {
            accept: Some("text/html,application/xhtml+xml"),
            host: Some("127.0.0.1:8080"),
            forwarded_host: Some("wegent.example.invalid"),
            forwarded_proto: Some("https"),
            attachment_id: 1392665,
            purpose: None,
        };
        let current_url = request_url(&request);
        assert_eq!(
            percent_encode(&current_url),
            "https%3A//wegent.example.invalid/api/attachments/1392665/download"
        );
    }

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

    #[test]
    fn session_purpose_honours_only_the_exact_preview_override() {
        assert_eq!(
            session_download_purpose(Some("preview")),
            DownloadPurpose::Preview
        );
        assert_eq!(
            session_download_purpose(Some("playback")),
            DownloadPurpose::Download
        );
        assert_eq!(
            session_download_purpose(Some("PREVIEW")),
            DownloadPurpose::Download
        );
        assert_eq!(
            session_download_purpose(Some("")),
            DownloadPurpose::Download
        );
        assert_eq!(session_download_purpose(None), DownloadPurpose::Download);
    }

    #[test]
    fn preview_streams_inline_like_playback() {
        assert_eq!(attachment_disposition(DownloadPurpose::Preview), "inline");
        assert_eq!(attachment_disposition(DownloadPurpose::Playback), "inline");
        assert_eq!(
            attachment_disposition(DownloadPurpose::Download),
            "attachment"
        );
        assert_eq!(attachment_disposition(DownloadPurpose::Share), "attachment");
    }
}
