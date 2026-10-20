// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/internal/attachments/{attachment_id}/download` — internal
//! attachment binary download for the converter service
//! (`app/api/endpoints/internal/attachments.py:download_attachment`, router
//! prefix `/attachments` mounted under `/internal` with API_PREFIX `/api`).
//!
//! Pipeline (the recorded dependency topology):
//! 1. `verify_internal_service_token` (the router-level `Depends`): the
//!    bearer check against `INTERNAL_SERVICE_TOKEN`, no database access.
//! 2. The `subtask_contexts` row by id restricted to the `attachment`
//!    context type (404 `Attachment not found` when absent).
//! 3. `context_service.get_attachment_binary_data`: read the bytes from the
//!    configured storage backend (MinIO HEAD bucket probe plus GET object
//!    for the `minio`/`s3` backends), decrypting when `is_encrypted` is set;
//!    `None` renders 404 `Attachment has no binary data`.
//! 4. The raw bytes as `application/octet-stream` with the RFC 5987
//!    `Content-Disposition` (the same percent-encoded name in both the
//!    `filename` fallback and the `filename*` parameter).
//!
//! Unlike the user-facing `GET /api/attachments/{id}/download`, this endpoint
//! has no user session, no access chain, and no download policy: the
//! internal-service token is the only authorization.
use brz_http_server::{Binary, HttpResponse, StatusCode};

use crate::attachments::context_store::SubtaskContextRow;
use crate::attachments::minio_client::MinioConfig;
use crate::attachments::storage;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

/// 404 `{"detail": ...}` body used by the source `HTTPException`s.
fn not_found(detail: &str) -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

/// The application's `python_exception_handler` body: the source route has no
/// try/except, so every dependency failure it does not convert into an
/// `HTTPException` renders this unhandled 500.
fn internal_unhandled() -> FastApiError {
    FastApiError::unhandled()
}

/// Maps a response-header construction failure to a 500.
fn header_error(error: brz_http_server::HeaderBlockError) -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// The `Content-Disposition` of `download_attachment`: the RFC 5987 encoded
/// filename appears in both the quoted ASCII fallback and the `filename*`
/// parameter, unlike `_build_content_disposition` which quotes latin-1 names
/// verbatim.
fn build_content_disposition(filename: &str) -> String {
    let encoded = percent_encode(filename);
    format!("attachment; filename=\"{encoded}\"; filename*=UTF-8''{encoded}")
}

/// `urllib.parse.quote(raw_name, safe="")`: percent-encode every byte except
/// the RFC 3986 unreserved characters.
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

/// The `subtask_contexts` lookup of `download_attachment`: one row by id
/// restricted to the attachment context type, rendered with the source's
/// labeled projection (the replay matcher requires that exact statement).
fn attachment_context_query(attachment_id: i64) -> String {
    format!(
        "SELECT {columns} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.id = {attachment_id} \
         AND subtask_contexts.context_type = '{CONTEXT_TYPE_ATTACHMENT}' \n LIMIT 1",
        columns = crate::task_store::subtask_context_columns()
    )
}

/// GET /api/internal/attachments/{attachment_id}/download: the internal
/// download free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/internal/attachments/:attachment_id/download")]
async fn download_attachment(
    #[inject(state)] state: &AppState,
    attachment_id: i64,
    #[auth] _service: crate::internal_auth::InternalService,
) -> Result<HttpResponse<Binary>, FastApiError> {
    download_attachment_value(state, attachment_id).await
}

/// Handler body for `GET /api/internal/attachments/{attachment_id}/download`.
async fn download_attachment_value(
    state: &AppState,
    attachment_id: i64,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let context: Option<SubtaskContextRow> = state
        .mysql
        .fetch_optional(attachment_context_query(attachment_id).as_str(), ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "internal attachment context lookup failed");
            internal_unhandled()
        })?;
    let context = context.ok_or_else(|| not_found("Attachment not found"))?;

    // `context_service.get_attachment_binary_data`: resolve the bytes from
    // the configured backend; `None` (no storage key, missing object) is the
    // source's 404 "Attachment has no binary data".
    let minio = MinioConfig::from_env();
    let bytes = storage::get_attachment_binary_data(
        &state.mysql,
        &state.attachment_http,
        minio.as_ref(),
        &context,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "internal attachment storage read failed");
        internal_unhandled()
    })?
    .ok_or_else(|| not_found("Attachment has no binary data"))?;

    let content_disposition = build_content_disposition(&context.original_filename());
    HttpResponse::new(Binary::new(bytes))
        .header("content-type", "application/octet-stream")
        .map_err(header_error)?
        .header("content-disposition", &content_disposition)
        .map_err(header_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_encodes_the_filename_into_both_parameters() {
        // The recorded Content-Disposition of attachment 1392099.
        assert_eq!(
            build_content_disposition("营销复盘2026H1标准.pdf"),
            "attachment; filename=\"%E8%90%A5%E9%94%80%E5%A4%8D%E7%9B%982026H1%E6%A0%87%E5%87%86\
             .pdf\"; filename*=UTF-8''%E8%90%A5%E9%94%80%E5%A4%8D%E7%9B%982026H1%E6%A0%87%E5%87%86.pdf"
        );
    }

    #[test]
    fn disposition_encodes_reserved_ascii_bytes() {
        // The recorded Content-Disposition of attachment 1392101: `+` and
        // the CJK name are both percent-encoded, `9`, `.`, and `pdf` stay.
        assert_eq!(
            build_content_disposition("9+月上旬营销号实验室进展和优化方向.pdf"),
            "attachment; filename=\"9%2B%E6%9C%88%E4%B8%8A%E6%97%AC%E8%90%A5%E9%94%80%E5%8F%B7\
             %E5%AE%9E%E9%AA%8C%E5%AE%A4%E8%BF%9B%E5%B1%95%E5%92%8C%E4%BC%98%E5%8C%96%E6%96%B9\
             %E5%90%91.pdf\"; filename*=UTF-8''9%2B%E6%9C%88%E4%B8%8A%E6%97%AC%E8%90%A5%E9%94%80\
             %E5%8F%B7%E5%AE%9E%E9%AA%8C%E5%AE%A4%E8%BF%9B%E5%B1%95%E5%92%8C%E4%BC%98%E5%8C%96\
             %E6%96%B9%E5%90%91.pdf"
        );
        assert_eq!(
            build_content_disposition("a b.txt"),
            "attachment; filename=\"a%20b.txt\"; filename*=UTF-8''a%20b.txt"
        );
    }

    #[test]
    fn ascii_filenames_are_still_percent_encoded() {
        // Unlike `_build_content_disposition`, the internal endpoint encodes
        // even a plain ASCII name in both parameters.
        assert_eq!(
            build_content_disposition("report.pdf"),
            "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf"
        );
    }

    #[test]
    fn context_query_matches_the_recorded_statement() {
        let sql = attachment_context_query(1392099);
        assert!(
            sql.starts_with(
                "SELECT subtask_contexts.id AS subtask_contexts_id, \
                 subtask_contexts.subtask_id AS subtask_contexts_subtask_id, "
            ),
            "the projection keeps the source's labeled column order"
        );
        assert_eq!(
            sql,
            format!(
                "SELECT {columns} \nFROM subtask_contexts \n\
                 WHERE subtask_contexts.id = 1392099 \
                 AND subtask_contexts.context_type = 'attachment' \n LIMIT 1",
                columns = crate::task_store::subtask_context_columns()
            )
        );
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(!table.matches(
            &http::Method::GET,
            "/api/internal/attachments/1392099/download"
        ));
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| {
                    route.path == "/api/internal/attachments/:attachment_id/download"
                        && route.methods & GET != 0
                });
        assert!(
            registered,
            "GET /api/internal/attachments/:attachment_id/download must be registered"
        );
    }
}
