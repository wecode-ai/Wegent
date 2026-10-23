// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/mcp/knowledge-external/documents/{document_id}/file` — the
//! external knowledge MCP original-document download
//! (`app/mcp_server/external_knowledge_app.py::_document_file` over
//! `app/services/knowledge/external_document_access.py`).
//!
//! The mounted Starlette app is public for this route: the auth middleware
//! and the transport rate limiter both short-circuit on
//! `_is_public_or_document_file_path`, so the endpoint authenticates with a
//! short-lived download token instead of a Bearer session. Mirrors the source
//! pipeline:
//!
//! 1. `_parse_document_id` rejects a non-numeric path segment.
//! 2. `_check_download_preauth_rate_limit` — the client-IP hash and the
//!    client-IP-hash plus document budgets (`rate_limit.rs`).
//! 3. `verify_document_download_token` — `X-Wegent-Download-Token`, whose
//!    `document_id` must equal the path (`token.rs`); every failure is `401`.
//! 4. `_check_download_rate_limit` — the user plus document budget.
//! 5. `load_document_file_or_raise`:
//!    - `get_document_access_or_raise`: the document row (with the ORM's
//!      `selectin` external-source load), `KnowledgeService.get_knowledge_base`
//!      (record plus ACL chain), and the capability flags;
//!    - a second `KnowledgeService.get_knowledge_base`;
//!    - `require_document_download_allowed` unless the token is exempt;
//!    - `file_unavailable` / `unsupported_media_type` capability checks;
//!    - `context_service.get_attachment_binary_data` from the configured
//!      attachment storage backend.
//! 6. A `200` binary response with the stored media type, the RFC 5987
//!    `Content-Disposition`, and `X-Content-Type-Options: nosniff`.

mod rate_limit;
mod token;

use std::sync::Arc;

use brz_http_server::{Binary, HttpResponse, StatusCode};
use brz_mysql::{FromMysqlRow, Mysql};
use serde_json::json;

use crate::attachments::context_store::SubtaskContextRow;
use crate::attachments::minio_client::MinioConfig;
use crate::attachments::storage;
use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access::{knowledge_base_access, knowledge_base_record};
use crate::state::AppState;

use self::rate_limit::DownloadRateLimits;
use self::token::verify_document_download_token;

/// `INLINE_PREVIEW_MIME_TYPES`: the media types an `inline` disposition may
/// stream.
const INLINE_PREVIEW_MIME_TYPES: [&str; 8] = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "text/plain",
    "text/markdown",
    "text/csv",
];

/// `db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id)
/// .first()` — the full labeled projection the source statement selects; only
/// the fields this endpoint reads are decoded.
const DOCUMENT_BY_ID_QUERY: &str = "SELECT knowledge_documents.id AS knowledge_documents_id, \
     knowledge_documents.kind_id AS knowledge_documents_kind_id, \
     knowledge_documents.attachment_id AS knowledge_documents_attachment_id, \
     knowledge_documents.name AS knowledge_documents_name, \
     knowledge_documents.file_extension AS knowledge_documents_file_extension, \
     knowledge_documents.file_size AS knowledge_documents_file_size, \
     knowledge_documents.status AS knowledge_documents_status, \
     knowledge_documents.user_id AS knowledge_documents_user_id, \
     knowledge_documents.is_active AS knowledge_documents_is_active, \
     knowledge_documents.index_status AS knowledge_documents_index_status, \
     knowledge_documents.index_generation AS knowledge_documents_index_generation, \
     knowledge_documents.splitter_config AS knowledge_documents_splitter_config, \
     knowledge_documents.source_type AS knowledge_documents_source_type, \
     knowledge_documents.source_config AS knowledge_documents_source_config, \
     knowledge_documents.origin AS knowledge_documents_origin, \
     knowledge_documents.folder_id AS knowledge_documents_folder_id, \
     knowledge_documents.summary AS knowledge_documents_summary, \
     knowledge_documents.chunks AS knowledge_documents_chunks, \
     knowledge_documents.created_at AS knowledge_documents_created_at, \
     knowledge_documents.updated_at AS knowledge_documents_updated_at \
     FROM knowledge_documents \
     WHERE knowledge_documents.id = ? \n LIMIT 1";

/// The `KnowledgeDocument.external_source` relationship is declared
/// `lazy="selectin"`, so loading the document issues this child select for
/// the single row's identity (`uselist=False`).
const EXTERNAL_SOURCE_BY_DOCUMENT_QUERY: &str = "SELECT knowledge_document_external_sources.document_id, \
     knowledge_document_external_sources.kind_id, \
     knowledge_document_external_sources.external_provider, \
     knowledge_document_external_sources.external_resource_id \
     FROM knowledge_document_external_sources \n\
     WHERE knowledge_document_external_sources.document_id IN (?)";

/// `db.query(SubtaskContext).filter(SubtaskContext.id == document.attachment_id,
/// SubtaskContext.context_type == ContextType.ATTACHMENT.value).first()` —
/// the full labeled projection.
const ATTACHMENT_BY_ID_QUERY: &str = "SELECT subtask_contexts.id AS subtask_contexts_id, \
     subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
     subtask_contexts.user_id AS subtask_contexts_user_id, \
     subtask_contexts.context_type AS subtask_contexts_context_type, \
     subtask_contexts.name AS subtask_contexts_name, \
     subtask_contexts.status AS subtask_contexts_status, \
     subtask_contexts.error_message AS subtask_contexts_error_message, \
     subtask_contexts.binary_data AS subtask_contexts_binary_data, \
     subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
     subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
     subtask_contexts.text_length AS subtask_contexts_text_length, \
     subtask_contexts.type_data AS subtask_contexts_type_data, \
     subtask_contexts.created_at AS subtask_contexts_created_at, \
     subtask_contexts.updated_at AS subtask_contexts_updated_at \
     FROM subtask_contexts \
     WHERE subtask_contexts.id = ? AND subtask_contexts.context_type = 'attachment' \n LIMIT 1";

/// GET /api/mcp/knowledge-external/documents/{document_id}/file.
#[brz_http_server::get(
    "/api/mcp/knowledge-external/documents/:document_id/file",
    access = public
)]
async fn document_file(
    #[inject(state)] state: &Arc<AppState>,
    document_id: &str,
    #[header("x-wegent-download-token")] token: Option<&str>,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    // The source route uses Starlette's `{document_id:int}` converter, so a
    // non-numeric segment never reaches the handler and the mounted app
    // returns its default not-found body.
    let Some(document_id) = parse_document_id(document_id) else {
        return Err(not_found_body());
    };

    let limits = DownloadRateLimits::from_env();
    let redis = state.redis.as_ref();
    rate_limit::check_preauth(&limits, redis, &client_ip(x_forwarded_for), document_id).await?;

    let Some(payload) = token.and_then(|value| verify_document_download_token(&state.auth, value))
    else {
        return Err(invalid_download_token());
    };
    if payload.document_id != document_id {
        return Err(invalid_download_token());
    }

    rate_limit::check_download(&limits, redis, payload.user_id, document_id).await?;

    load_document_file(state, &payload).await
}

/// `GET /api/api/mcp/knowledge-external/documents/{document_id}/file`: the
/// doubled-prefix path clients send when their gateway already prefixes
/// `/api`.
///
/// The source mounts the external-knowledge MCP app at
/// `/api/mcp/knowledge-external` (`app/main.py` calls `register_mcp_apps`
/// with `settings.API_PREFIX`, and the mounted Starlette app registers
/// `/documents/{document_id:int}/file`), so the doubled `/api/api/...` path
/// matches no route and FastAPI answers its default
/// `404 {"detail":"Not Found"}` before authentication or validation. The
/// cutover routes the path to Rust to reproduce that response instead of
/// proxying to Python, which the replay environment answers with
/// `502 fallback upstream unavailable`.
#[brz_http_server::get(
    "/api/api/mcp/knowledge-external/documents/:document_id/file",
    access = public
)]
async fn doubled_prefix_document_file(document_id: &str) -> Result<(), FastApiError> {
    // No source route exists at this path, so the framework rejects the
    // request before it parses the segment or the download token.
    let _ = document_id;
    Err(not_found_body())
}

/// `load_document_file_or_raise` plus the endpoint's response construction.
async fn load_document_file(
    state: &AppState,
    payload: &token::DocumentDownloadToken,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();
    let resolvers = &state.entity_resolvers;
    let user_id = payload.user_id;

    // `get_document_access_or_raise`: the document, then `get_knowledge_base`.
    let Some(document) = load_document(mysql, payload.document_id).await? else {
        return Err(document_not_found());
    };
    load_external_sources(mysql, payload.document_id).await?;
    let Some(knowledge_base) = knowledge_base_record(mysql, document.knowledge_documents_kind_id)
        .await
        .map_err(|_| internal())?
    else {
        return Err(knowledge_base_not_found());
    };
    let has_access = knowledge_base_access(mysql, redis, resolvers, &knowledge_base, user_id)
        .await
        .map_err(|_| internal())?;
    if !has_access {
        return Err(access_denied());
    }
    let attachment = load_attachment(mysql, document.knowledge_documents_attachment_id).await?;
    let capabilities = DocumentCapabilities::build(&document, attachment);

    // `get_document_file_or_raise` re-reads the knowledge base and then applies
    // the download policy and the file capability checks. The second read is a
    // whole `KnowledgeService.get_knowledge_base`: `_get_knowledge_base_record`
    // followed by the full ACL resolution, whose verdict the source discards
    // (`knowledge_base, _ = KnowledgeService.get_knowledge_base(...)`), so the
    // ACL chain runs a second time as part of the dependency sequence.
    let Some(knowledge_base) = knowledge_base_record(mysql, document.knowledge_documents_kind_id)
        .await
        .map_err(|_| internal())?
    else {
        return Err(knowledge_base_not_found());
    };
    let _rechecked_access =
        knowledge_base_access(mysql, redis, resolvers, &knowledge_base, user_id)
            .await
            .map_err(|_| internal())?;
    if !payload.document_download_exempt {
        let configured = knowledge_base
            .kinds_json
            .project::<KnowledgeBaseDocument>()
            .unwrap_or_default()
            .spec
            .allow_document_download;
        let allowed = state
            .document_download_policy
            .original_download_allowed(mysql, &knowledge_base.kinds_namespace, configured)
            .await
            .map_err(|_| internal())?;
        if !allowed {
            return Err(download_disabled());
        }
    }
    let Some(attachment) = capabilities.attachment.as_ref() else {
        return Err(file_unavailable());
    };
    if !capabilities.downloadable {
        return Err(file_unavailable());
    }
    if payload.disposition == "inline" && !capabilities.previewable {
        return Err(unsupported_media_type());
    }

    // `context_service.get_attachment_binary_data`: the configured backend
    // (`mysql` binary_data or the MinIO/S3 object store), decrypting when the
    // stored metadata says so.
    let minio = MinioConfig::from_env();
    let bytes = match storage::get_attachment_binary_data(
        mysql,
        &state.attachment_http,
        minio.as_ref(),
        attachment,
    )
    .await
    {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(file_unavailable()),
        Err(error) => {
            tracing::error!(%error, "external document storage read failed");
            return Err(internal());
        }
    };

    let media_type = crate::attachments::content_type::content_type_value(
        capabilities.mime_type.as_deref().unwrap_or(""),
    );
    let content_disposition =
        build_content_disposition(&payload.disposition, &capabilities.file_name);

    let mut response = HttpResponse::new(Binary::new(bytes));
    response = response
        .header("content-type", media_type.as_ref())
        .map_err(|_| internal())?;
    response = response
        .header("content-disposition", &content_disposition)
        .map_err(|_| internal())?;
    response = response
        .header("x-content-type-options", "nosniff")
        .map_err(|_| internal())?;
    Ok(response)
}

/// One `knowledge_documents` row (`KnowledgeDocument`); only the fields this
/// endpoint reads are decoded from the full labeled projection.
#[derive(Debug, FromMysqlRow)]
struct KnowledgeDocumentRow {
    knowledge_documents_kind_id: i64,
    #[allow(dead_code, reason = "selected to match the source projection")]
    knowledge_documents_id: i64,
    knowledge_documents_attachment_id: i64,
    knowledge_documents_name: String,
}

/// `document_service`'s document load.
async fn load_document<M>(
    mysql: &M,
    document_id: i64,
) -> Result<Option<KnowledgeDocumentRow>, FastApiError>
where
    M: Mysql,
{
    mysql
        .fetch_optional(DOCUMENT_BY_ID_QUERY, (document_id,))
        .await
        .map_err(|_| internal())
}

/// The `selectin` load of the document's single external identity.
async fn load_external_sources<M>(mysql: &M, document_id: i64) -> Result<(), FastApiError>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct ExternalSourceRow {
        #[allow(dead_code, reason = "the select is issued for the ORM load order")]
        document_id: i64,
    }
    let _: Vec<ExternalSourceRow> = mysql
        .fetch_all(EXTERNAL_SOURCE_BY_DOCUMENT_QUERY, (document_id,))
        .await
        .map_err(|_| internal())?;
    Ok(())
}

/// `SubtaskContext` lookup for the document's attachment.
async fn load_attachment<M>(
    mysql: &M,
    attachment_id: i64,
) -> Result<Option<SubtaskContextRow>, FastApiError>
where
    M: Mysql,
{
    if attachment_id <= 0 {
        return Ok(None);
    }
    mysql
        .fetch_optional(ATTACHMENT_BY_ID_QUERY, (attachment_id,))
        .await
        .map_err(|_| internal())
}

/// `build_document_capabilities` for the fields this endpoint consumes.
struct DocumentCapabilities {
    attachment: Option<SubtaskContextRow>,
    downloadable: bool,
    previewable: bool,
    mime_type: Option<String>,
    file_name: String,
}

impl DocumentCapabilities {
    fn build(document: &KnowledgeDocumentRow, attachment: Option<SubtaskContextRow>) -> Self {
        // The attachment row is loaded with `context_type = 'attachment'`, so
        // the source's `is_attachment` is exactly "a row was found".
        let is_attachment = attachment.is_some();
        let mime_type = attachment
            .as_ref()
            .map(SubtaskContextRow::mime_type)
            .filter(|value| is_attachment && !value.is_empty());
        let file_name = match attachment.as_ref() {
            Some(row) if is_attachment && !row.original_filename().is_empty() => {
                row.original_filename()
            }
            _ => document.knowledge_documents_name.clone(),
        };
        let file_available = attachment
            .as_ref()
            .is_some_and(|row| !row.storage_key().is_empty());
        let downloadable = file_available;
        let previewable = downloadable
            && mime_type.as_deref().is_some_and(|value| {
                INLINE_PREVIEW_MIME_TYPES.contains(&value.to_lowercase().as_str())
            });
        Self {
            attachment,
            downloadable,
            previewable,
            mime_type,
            file_name,
        }
    }
}

/// The `kinds.json` projection for the core download policy's
/// `spec.allowDocumentDownload`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct KnowledgeBaseDocument {
    spec: KnowledgeBaseSpec,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct KnowledgeBaseSpec {
    #[serde(rename = "allowDocumentDownload")]
    allow_document_download: Option<bool>,
}

/// `build_content_disposition` (`external_document_access.py`): the
/// RFC 5987-compatible `filename` plus `filename*` pair built from
/// `quote(file_name or "document", safe="")`.
fn build_content_disposition(disposition: &str, file_name: &str) -> String {
    let encoded = percent_encode(if file_name.is_empty() {
        "document"
    } else {
        file_name
    });
    format!("{disposition}; filename=\"{encoded}\"; filename*=UTF-8''{encoded}")
}

/// `urllib.parse.quote(value, safe="")`: percent-encode everything outside the
/// RFC 3986 unreserved set, byte-wise over the UTF-8 encoding.
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
            out.push(HEX[(byte & 0x0F) as usize] as char);
        }
    }
    out
}

/// `_parse_document_id`: a plain decimal `{document_id:int}` segment.
fn parse_document_id(raw: &str) -> Option<i64> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>().ok()
}

/// `request.client.host` under the source's uvicorn proxy-headers middleware:
/// the rightmost `x-forwarded-for` entry after the trusted proxy hops
/// (`--forwarded-allow-ips`, `127.0.0.1` by default) are stripped from the
/// right.
fn client_ip(x_forwarded_for: Option<&str>) -> String {
    let Some(value) = x_forwarded_for else {
        return "unknown".to_string();
    };
    let mut hosts: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .collect();
    while hosts.last().is_some_and(|host| *host == "127.0.0.1") {
        hosts.pop();
    }
    hosts
        .last()
        .map_or_else(|| "unknown".to_string(), |host| (*host).to_string())
}

/// `401 {"error": "Invalid or expired download token", "code": "unauthorized"}`.
fn invalid_download_token() -> FastApiError {
    json_error(
        StatusCode::UNAUTHORIZED,
        "Invalid or expired download token",
        "unauthorized",
    )
}

/// `404 {"error": "Document not found", "code": "not_found"}`.
fn document_not_found() -> FastApiError {
    json_error(StatusCode::NOT_FOUND, "Document not found", "not_found")
}

/// `404 {"error": "Knowledge base not found", "code": "not_found"}`.
fn knowledge_base_not_found() -> FastApiError {
    json_error(
        StatusCode::NOT_FOUND,
        "Knowledge base not found",
        "not_found",
    )
}

/// `403 {"error": "Access denied to this document", "code": "forbidden"}`.
fn access_denied() -> FastApiError {
    json_error(
        StatusCode::FORBIDDEN,
        "Access denied to this document",
        "forbidden",
    )
}

/// `404 {"error": "Document file is unavailable", "code": "file_unavailable"}`.
fn file_unavailable() -> FastApiError {
    json_error(
        StatusCode::NOT_FOUND,
        "Document file is unavailable",
        "file_unavailable",
    )
}

/// `404 {"error": "Document download is disabled", "code":
/// "DOCUMENT_DOWNLOAD_DISABLED"}`: the policy error code is not one of the
/// explicit status mappings, so it keeps the endpoint's default 404.
fn download_disabled() -> FastApiError {
    json_error(
        StatusCode::NOT_FOUND,
        "Document download is disabled",
        "DOCUMENT_DOWNLOAD_DISABLED",
    )
}

/// `415 {"error": "Document file is not previewable", "code":
/// "unsupported_media_type"}`.
fn unsupported_media_type() -> FastApiError {
    json_error(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "Document file is not previewable",
        "unsupported_media_type",
    )
}

/// FastAPI's default not-found body for a request the mounted app's route does
/// not match.
fn not_found_body() -> FastApiError {
    FastApiError::json_body(StatusCode::NOT_FOUND, json!({"detail": "Not Found"}))
}

/// `500 {"detail": "Internal Server Error"}` for the source's unhandled
/// dependency failures.
fn internal() -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// The endpoint's `{"error": ..., "code": ...}` JSON body.
fn json_error(status: StatusCode, error: &str, code: &str) -> FastApiError {
    FastApiError::json_body(status, json!({"error": error, "code": code}))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The formal download stays Python-owned with its Rust handler retained.
    #[test]
    fn formal_download_keeps_python_ownership_and_rust_registration() {
        const PATH: &str = "/api/mcp/knowledge-external/documents/:document_id/file";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(
            &http::Method::GET,
            "/api/mcp/knowledge-external/documents/30830/file"
        ));
        assert!(!table.matches(
            &http::Method::POST,
            "/api/mcp/knowledge-external/documents/30830/file"
        ));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    /// The doubled-prefix cutover selects only `GET` on the nested
    /// `/api/api/...` path and the router registers its handler.
    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/api/mcp/knowledge-external/documents/:document_id/file";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(
            &http::Method::GET,
            "/api/api/mcp/knowledge-external/documents/30829/file"
        ));
        assert!(!table.matches(
            &http::Method::GET,
            "/api/mcp/knowledge-external/documents/30829/file".trim_start_matches("/api")
        ));
        assert!(!table.matches(
            &http::Method::POST,
            "/api/api/mcp/knowledge-external/documents/30829/file"
        ));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    /// The doubled-prefix probe returns FastAPI's default 404 body before it
    /// parses the document segment.
    #[tokio::test]
    async fn doubled_prefix_document_file_returns_fastapi_not_found() {
        let error = doubled_prefix_document_file("30829").await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        // FastAPI's default 404 body rendered by the shared error mapper.
        assert_eq!(error.validation_detail(), r#""Not Found""#);
    }

    #[test]
    fn parses_only_plain_decimal_document_ids() {
        assert_eq!(parse_document_id("30830"), Some(30830));
        assert_eq!(parse_document_id("030830"), Some(30830));
        assert_eq!(parse_document_id("0"), Some(0));
        assert_eq!(parse_document_id("-5"), None);
        assert_eq!(parse_document_id("abc"), None);
        assert_eq!(parse_document_id(""), None);
        assert_eq!(parse_document_id("30830/file"), None);
        assert_eq!(parse_document_id("99999999999999999999999"), None);
    }

    #[test]
    fn client_ip_uses_the_rightmost_forwarded_entry() {
        // The recorded request's header; the last entry produced the recorded
        // rate-limit key hash.
        assert_eq!(client_ip(Some("198.51.100.7, 203.0.113.9")), "203.0.113.9");
        // A trailing trusted proxy hop is stripped like uvicorn's
        // proxy-headers middleware.
        assert_eq!(client_ip(Some("198.51.100.8, 127.0.0.1")), "198.51.100.8");
        assert_eq!(client_ip(Some(" 198.51.100.8 ")), "198.51.100.8");
        assert_eq!(client_ip(None), "unknown");
        assert_eq!(client_ip(Some("")), "unknown");
        assert_eq!(client_ip(Some("127.0.0.1")), "unknown");
    }

    #[test]
    fn builds_the_recorded_content_disposition() {
        // The recorded expected `Content-Disposition` for 行为码含义.xlsx.
        assert_eq!(
            build_content_disposition("attachment", "行为码含义.xlsx"),
            "attachment; filename=\"%E8%A1%8C%E4%B8%BA%E7%A0%81%E5%90%AB%E4%B9%89.xlsx\"; \
             filename*=UTF-8''%E8%A1%8C%E4%B8%BA%E7%A0%81%E5%90%AB%E4%B9%89.xlsx"
        );
        assert_eq!(
            build_content_disposition("inline", ""),
            "inline; filename=\"document\"; filename*=UTF-8''document"
        );
    }

    #[test]
    fn percent_encodes_like_python_quote() {
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(percent_encode("行"), "%E8%A1%8C");
    }

    #[test]
    fn previewable_media_types_cover_the_source_set() {
        for mime in ["application/pdf", "image/png", "text/markdown"] {
            assert!(INLINE_PREVIEW_MIME_TYPES.contains(&mime));
        }
        assert!(
            !INLINE_PREVIEW_MIME_TYPES
                .contains(&"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        );
    }
}
