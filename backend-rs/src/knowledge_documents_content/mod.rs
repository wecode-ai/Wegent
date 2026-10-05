// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge/documents/{document_id}/content` — paginated raw
//! document content read
//! (`app.api_endpoints.knowledge_open.get_document_content_open`).
//!
//! Source pipeline (baseline case set
//! `api-knowledge-documents-wildcard-content`, request
//! `/api/knowledge/documents/41418/content?limit=100000&offset=200000`,
//! personal API key):
//!
//! 1. `security.get_auth_context` — API key by SHA-256 hash, `last_used_at`
//!    UPDATE + COMMIT, ORM reload by primary key, then the deployment
//!    `userReader` (`user:v2:data:{user_id}` on a cache hit, SQL on a miss);
//! 2. `KnowledgeOrchestrator.read_document_content` —
//!    `_get_document_with_access_or_raise` (document, `selectin` external
//!    sources, knowledge-base Kind, then the full ACL chain of
//!    `resolve_knowledge_base_permission`: restricted-analyst batch
//!    resolution, direct KB membership, organization/group/entity sources);
//! 3. `document_read_service.read_documents` — bulk document load, external
//!    sources, attachment `subtask_contexts`, then offset/limit pagination
//!    of the extracted text (character positions, like Python slicing).

pub mod access;
pub mod auth;
pub mod group_membership;
pub mod reader;

use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response};
use serde::Serialize;

use crate::state::AppState;

/// `MAX_DOCUMENT_READ_LIMIT` (`app.services.knowledge.orchestrator`).
const MAX_DOCUMENT_READ_LIMIT: i64 = 100_000;

/// The response schema (`DocumentContentReadResponse`); field order matches
/// the pydantic model's serialization order.
#[derive(Debug, Serialize)]
struct DocumentContentReadResponse {
    document_id: i64,
    name: String,
    content: String,
    total_length: i64,
    offset: i64,
    returned_length: i64,
    has_more: bool,
    kb_id: i64,
    index_status: String,
    source_media_type: Option<String>,
}

/// A mapped source failure carrying the HTTP status and `detail` message.
#[derive(Debug)]
pub struct ApiFailure {
    status: StatusCode,
    detail: String,
}

impl ApiFailure {
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }

    pub(crate) fn detail(&self) -> &str {
        &self.detail
    }

    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, detail)
    }

    /// `_raise_open_knowledge_http_error`: "not found" -> 404,
    /// "access denied"/"permission" -> 403, otherwise 400.
    pub fn from_value_error(message: &str) -> Self {
        let lower = message.to_ascii_lowercase();
        if lower.contains("not found") {
            Self::new(StatusCode::NOT_FOUND, message)
        } else if lower.contains("access denied") || lower.contains("permission") {
            Self::new(StatusCode::FORBIDDEN, message)
        } else {
            Self::new(StatusCode::BAD_REQUEST, message)
        }
    }
}

impl IntoHttpError for ApiFailure {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        crate::http_compat::FastApiError::detail(self.status, self.detail).into_http_error(arena)
    }
}

/// One pydantic-v2 validation error entry: `{type, loc, msg, input}`. Field
/// order and types mirror the recorded 422 bodies; `loc` is the two-element
/// `[scope, field]` path and `input` is the raw query value.
#[derive(Debug, Serialize)]
struct ValidationItem {
    #[serde(rename = "type")]
    error_type: String,
    loc: [String; 2],
    msg: String,
    input: String,
}

/// FastAPI-style 422 validation error body for one query/path parameter.
fn validation_error(loc: [&str; 2], error_type: &str, msg: &str, input: &str) -> FastApiValidation {
    FastApiValidation {
        body: vec![ValidationItem {
            error_type: error_type.to_string(),
            loc: [loc[0].to_string(), loc[1].to_string()],
            msg: msg.to_string(),
            input: input.to_string(),
        }],
    }
}

/// A 422 validation failure with FastAPI's array `detail` body.
#[derive(Debug)]
struct FastApiValidation {
    body: Vec<ValidationItem>,
}

impl FastApiValidation {
    /// The mapped status code.
    #[cfg(test)]
    fn status(&self) -> StatusCode {
        StatusCode::UNPROCESSABLE_ENTITY
    }
}

impl IntoHttpError for FastApiValidation {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        crate::http_compat::FastApiError::validation(
            serde_json::to_value(self.body).unwrap_or(serde_json::json!([])),
        )
        .into_http_error(arena)
    }
}

/// Parse the `offset`/`limit` query parameters with the source `Query`
/// constraints (`offset >= 0`, `1 <= limit <= 100000`, both integers).
/// Query values arrive URL-decoded from the framework binding.
fn parse_paging(
    offset_raw: Option<&str>,
    limit_raw: Option<&str>,
) -> Result<(i64, i64), FastApiValidation> {
    let offset = match offset_raw {
        None => None,
        Some(value) => Some(parse_int(value, "offset")?),
    };
    let limit = match limit_raw {
        None => None,
        Some(value) => Some(parse_int(value, "limit")?),
    };
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(MAX_DOCUMENT_READ_LIMIT);
    if offset < 0 {
        return Err(validation_error(
            ["query", "offset"],
            "greater_than_equal",
            "Input should be greater than or equal to 0",
            &offset.to_string(),
        ));
    }
    if !(1..=MAX_DOCUMENT_READ_LIMIT).contains(&limit) {
        return Err(validation_error(
            ["query", "limit"],
            "less_than_equal",
            &format!("Input should be less than or equal to {MAX_DOCUMENT_READ_LIMIT}"),
            &limit.to_string(),
        ));
    }
    Ok((offset, limit))
}

fn parse_int(value: &str, field: &str) -> Result<i64, FastApiValidation> {
    value.parse().map_err(|_| {
        validation_error(
            ["query", field],
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            value,
        )
    })
}

/// GET /api/knowledge/documents/{document_id}/content: the knowledge-documents
/// free function, injecting the process-lifetime application state. The
/// endpoint declares `response_model=DocumentContentReadResponse`, so FastAPI
/// renders the model through its default `JSONResponse` and announces
/// `application/json`; returning the typed value keeps that media type
/// (a raw `HttpResponse<Binary>` body would announce
/// `application/octet-stream`).
#[allow(clippy::too_many_arguments)]
#[brz_http_server::get("/api/knowledge/documents/:document_id/content")]
async fn get_document_content(
    #[inject(state)] state: &Arc<AppState>,
    document_id: &str,
    offset: Option<String>,
    limit: Option<String>,
    #[auth] user: auth::KnowledgeUser,
) -> Result<DocumentContentReadResponse, KnowledgeError> {
    document_content(
        state,
        document_id,
        offset.as_deref(),
        limit.as_deref(),
        &user,
    )
    .await
}

/// One of the endpoint's failure shapes: 422 validation or a mapped
/// `ApiFailure`.
enum KnowledgeError {
    Validation(FastApiValidation),
    Failure(ApiFailure),
}

impl From<FastApiValidation> for KnowledgeError {
    fn from(error: FastApiValidation) -> Self {
        Self::Validation(error)
    }
}

impl From<ApiFailure> for KnowledgeError {
    fn from(error: ApiFailure) -> Self {
        Self::Failure(error)
    }
}

impl IntoHttpError for KnowledgeError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        match self {
            Self::Validation(error) => error.into_http_error(arena),
            Self::Failure(error) => error.into_http_error(arena),
        }
    }
}

/// Handler body for `GET /api/knowledge/documents/{document_id}/content`.
#[allow(clippy::too_many_arguments)]
async fn document_content(
    state: &Arc<AppState>,
    document_id: &str,
    offset_raw: Option<&str>,
    limit_raw: Option<&str>,
    user: &auth::KnowledgeUser,
) -> Result<DocumentContentReadResponse, KnowledgeError> {
    // FastAPI validates the path and query parameters before the endpoint
    // body runs; invalid values surface as 422 without dependency traffic.
    let Ok(document_id) = document_id.parse::<i64>() else {
        return Err(validation_error(
            ["path", "document_id"],
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            document_id,
        )
        .into());
    };
    let (offset, limit) = parse_paging(offset_raw, limit_raw)?;

    Ok(read_document_content(state, user.id, document_id, offset, limit).await?)
}

/// `KnowledgeOrchestrator.read_document_content` after authentication:
/// document load with access validation, then the paginated reader.
async fn read_document_content(
    state: &AppState,
    user_id: i64,
    document_id: i64,
    offset: i64,
    limit: i64,
) -> Result<DocumentContentReadResponse, ApiFailure> {
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `_get_document_with_access_or_raise`: document by id (the `selectin`
    // external-source load follows immediately), then the knowledge base
    // and its ACL chain.
    let document = reader::document_by_id(mysql, document_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let Some(document) = document else {
        return Err(ApiFailure::from_value_error("Document not found"));
    };

    let kb = access::knowledge_base_record(mysql, document.knowledge_documents_kind_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let Some(kb) = kb else {
        return Err(ApiFailure::from_value_error("Knowledge base not found"));
    };

    let has_access =
        access::knowledge_base_access(mysql, redis, &state.entity_resolvers, &kb, user_id).await?;
    if !has_access {
        return Err(ApiFailure::from_value_error(
            "Access denied to this document",
        ));
    }

    // `_assert_external_document_previewable`: reject external placeholders
    // without stored content.
    if document.knowledge_documents_source_type == "external"
        && document.knowledge_documents_attachment_id <= 0
    {
        return Err(ApiFailure::from_value_error(
            "Document content is not ready for preview",
        ));
    }

    // `document_read_service.read_documents` for the single document with
    // its knowledge-base scope.
    let documents = reader::documents_by_ids(mysql, &[document_id])
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let Some(result) = documents
        .into_iter()
        .find(|row| row.knowledge_documents_id == document_id)
    else {
        return Err(ApiFailure::from_value_error("Document not found"));
    };

    // Attachment contexts: the original attachment plus the optional
    // converted attachment from `source_config.converted_attachment_id`.
    let converted_id = document.converted_attachment_id();
    let mut attachment_ids: Vec<i64> = Vec::new();
    if result.knowledge_documents_attachment_id > 0 {
        attachment_ids.push(result.knowledge_documents_attachment_id);
    }
    if let Some(converted_id) = converted_id
        && !attachment_ids.contains(&converted_id)
    {
        attachment_ids.push(converted_id);
    }
    let attachments = reader::attachment_contexts(mysql, &attachment_ids)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let attachment = attachments
        .iter()
        .find(|row| row.subtask_contexts_id == result.knowledge_documents_attachment_id);
    let converted_attachment =
        converted_id.and_then(|id| attachments.iter().find(|row| row.subtask_contexts_id == id));

    // `_build_document_result`: prefer converted content, fall back to the
    // original attachment's extracted text.
    let source_attachment = converted_attachment.or(attachment);
    let (content, total_length, actual_start, returned_length, has_more) = reader::page_content(
        source_attachment
            .map(|row| row.extracted_text())
            .unwrap_or_default(),
        offset,
        limit,
    );

    // An external document with no stored text is not previewable (total
    // length, not page length, decides).
    if document.knowledge_documents_source_type == "external" && total_length == 0 {
        return Err(ApiFailure::from_value_error(
            "Document content is not ready for preview",
        ));
    }

    Ok(DocumentContentReadResponse {
        document_id: result.knowledge_documents_id,
        name: result.knowledge_documents_name,
        content,
        total_length,
        offset: actual_start,
        returned_length,
        has_more,
        kb_id: result.knowledge_documents_kind_id,
        index_status: document.knowledge_documents_index_status,
        source_media_type: reader::source_media_type(attachment),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_error_mapping_matches_source() {
        assert_eq!(
            ApiFailure::from_value_error("Document not found").status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            ApiFailure::from_value_error("Knowledge base not found").status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            ApiFailure::from_value_error("Access denied to this document").status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            ApiFailure::from_value_error("Document content is not ready for preview").status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn paging_validation_rejects_out_of_range() {
        assert_eq!(
            parse_paging(Some("-1"), Some("5")).err().unwrap().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert!(parse_paging(None, Some("100001")).is_err());
        assert!(parse_paging(None, Some("0")).is_err());
        assert!(parse_paging(Some("abc"), None).is_err());
    }

    #[test]
    fn paging_defaults_match_source() {
        assert_eq!(
            parse_paging(None, None).unwrap(),
            (0, MAX_DOCUMENT_READ_LIMIT)
        );
        assert_eq!(
            parse_paging(Some("200000"), Some("100000")).unwrap(),
            (200_000, 100_000)
        );
    }

    #[test]
    fn response_field_order_matches_schema() {
        let response = DocumentContentReadResponse {
            document_id: 35918,
            name: "n".to_string(),
            content: "c".to_string(),
            total_length: 3,
            offset: 0,
            returned_length: 1,
            has_more: true,
            kb_id: 210837,
            index_status: "success".to_string(),
            source_media_type: None,
        };
        let body = serde_json::to_string(&response).unwrap();
        assert!(body.starts_with(
            r#"{"document_id":35918,"name":"n","content":"c","total_length":3,"offset":0,"#
        ));
        assert!(
            body.ends_with(r#""kb_id":210837,"index_status":"success","source_media_type":null}"#)
        );
    }

    /// A dedicated test group (separate from the crate's real `http_apis`
    /// group) so the probe's route does not collide with the real handler's
    /// registration.
    mod probe {
        brz_http_server::registry!(group = knowledge_content_probe, dependencies());
    }

    /// Renders the endpoint's success value through its return shape over a
    /// real socket. The source declares
    /// `response_model=DocumentContentReadResponse`, so FastAPI announces
    /// `application/json`; a raw `HttpResponse<Binary>` body would announce
    /// `application/octet-stream` instead.
    #[brz_http_server::get(
        "/api/knowledge/documents/:document_id/content",
        group = probe::knowledge_content_probe,
        access = public
    )]
    async fn get_document_content_probe(
        document_id: &str,
    ) -> Result<DocumentContentReadResponse, KnowledgeError> {
        let document_id = document_id.parse::<i64>().expect("numeric document id");
        Ok(DocumentContentReadResponse {
            document_id,
            name: "n".to_string(),
            content: "c".to_string(),
            total_length: 3,
            offset: 0,
            returned_length: 1,
            has_more: false,
            kb_id: 210837,
            index_status: "success".to_string(),
            source_media_type: None,
        })
    }

    /// Serves the probe route on a real socket so the status, headers, and
    /// body are asserted exactly as the runtime renders them.
    async fn serve_content(document_id: &str) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        use tokio::net::TcpStream;

        let handler = brz_http_server::handlers!(; group = probe::knowledge_content_probe)
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
                    "GET /api/knowledge/documents/{document_id}/content HTTP/1.1\r\n\
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
        let raw = serve_content("41418").await;
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
            body.starts_with(r#"{"document_id":41418,"name":"n","#),
            "{body}"
        );
    }
}
