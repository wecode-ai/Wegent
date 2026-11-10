// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/{kb_id}/documents/{doc_id}/detail`
//! (`app.api.endpoints.knowledge.get_document_detail`, mounted at the
//! `/knowledge-bases` prefix).
//!
//! Source pipeline:
//!
//! 1. `security.get_current_user` — bearer JWT, then the user by name;
//! 2. `_validate_knowledge_base_access_or_raise` — the KB `Kind` record and
//!    its full ACL chain (`KnowledgeService.get_knowledge_base`). A missing
//!    KB is `404 "Knowledge base not found"`; a denied KB is
//!    `403 "Access denied to this knowledge base"`;
//! 3. the KB-scoped document load
//!    (`db.query(KnowledgeDocument).filter(id == doc_id, kind_id == kb_id)`);
//!    a miss is `404 "Document not found in the specified knowledge base"`;
//! 4. `KnowledgeOrchestrator.get_document_detail`:
//!    `_get_document_with_access_or_raise` (document by id, then the KB ACL
//!    chain), then `read_document_content` for `include_content` and
//!    `SummaryService.get_document_summary` for `include_summary`.
//!
//! A `ValueError` raised by the orchestrator maps through
//! `_raise_document_detail_http_error`: "not found" -> 404,
//! "access denied"/"permission" -> 403, otherwise 400.
use brz_http_server::StatusCode;
use serde::Serialize;

use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access::{knowledge_base_access, knowledge_base_record};
use crate::knowledge_documents_content::reader::{document_by_id, document_by_id_and_kind};
use crate::knowledge_documents_content::{parse_paging_fastapi, read_document_content};
use crate::state::AppState;
use brz_json::OpaqueJson;

/// GET /api/knowledge-bases/{kb_id}/documents/{doc_id}/detail.
#[allow(clippy::too_many_arguments)]
#[brz_http_server::get("/api/knowledge-bases/:kb_id/documents/:doc_id/detail")]
async fn get_document_detail(
    #[inject(state)] state: &AppState,
    kb_id: &str,
    doc_id: &str,
    include_content: Option<String>,
    include_summary: Option<String>,
    offset: Option<String>,
    limit: Option<String>,
    #[auth] current_user: crate::auth::SessionUser,
) -> Result<DocumentDetailResponse, DetailError> {
    document_detail(
        state,
        kb_id,
        doc_id,
        include_content.as_deref(),
        include_summary.as_deref(),
        offset.as_deref(),
        limit.as_deref(),
        &current_user,
    )
    .await
}

/// `DocumentDetailResponse` in the pydantic model's declaration order.
#[derive(Debug, Serialize)]
struct DocumentDetailResponse {
    document_id: i64,
    content: Option<String>,
    content_length: Option<i64>,
    truncated: Option<bool>,
    summary: Option<serde_json::Value>,
}

/// The endpoint's failure shape: a mapped FastAPI-style error.
#[derive(Debug)]
struct DetailError(FastApiError);

impl From<FastApiError> for DetailError {
    fn from(error: FastApiError) -> Self {
        Self(error)
    }
}

impl brz_http_server::IntoHttpError for DetailError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        self.0.into_http_error(arena)
    }
}

/// FastAPI-style 422 for an unparsable integer path parameter.
fn path_validation_error(field: &str, value: &str) -> FastApiError {
    FastApiError::validation([serde_json::json!({
        "type": "int_parsing",
        "loc": ["path", field],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    })])
}

/// FastAPI boolean query parsing (pydantic v2 accepted literals), returning
/// the 422 `bool_parsing` error for any other value.
fn parse_bool(raw: Option<&str>, field: &str) -> Result<bool, FastApiError> {
    let Some(value) = raw else {
        return Ok(true);
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "y" | "t" => Ok(true),
        "false" | "0" | "no" | "off" | "n" | "f" => Ok(false),
        _ => Err(FastApiError::validation([serde_json::json!({
            "type": "bool_parsing",
            "loc": ["query", field],
            "msg": "Input should be a valid boolean, unable to interpret input",
            "input": value,
        })])),
    }
}

/// `_raise_document_detail_http_error`: "not found" -> 404,
/// "access denied"/"permission" -> 403, otherwise 400.
fn value_error(message: &str) -> FastApiError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("not found") {
        FastApiError::detail(StatusCode::NOT_FOUND, message)
    } else if lower.contains("access denied") || lower.contains("permission") {
        FastApiError::detail(StatusCode::FORBIDDEN, message)
    } else {
        FastApiError::detail(StatusCode::BAD_REQUEST, message)
    }
}

fn internal_error(message: &str) -> FastApiError {
    tracing::error!(message, "knowledge document detail dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// Handler body for `GET /api/knowledge-bases/{kb_id}/documents/{doc_id}/detail`.
#[allow(clippy::too_many_arguments)]
async fn document_detail(
    state: &AppState,
    kb_id: &str,
    doc_id: &str,
    include_content: Option<&str>,
    include_summary: Option<&str>,
    offset_raw: Option<&str>,
    limit_raw: Option<&str>,
    user: &crate::auth::SessionUser,
) -> Result<DocumentDetailResponse, DetailError> {
    // FastAPI binds and validates every path and query parameter before the
    // endpoint body runs.
    let kb_id = kb_id
        .parse::<i64>()
        .map_err(|_| path_validation_error("kb_id", kb_id))?;
    let doc_id = doc_id
        .parse::<i64>()
        .map_err(|_| path_validation_error("doc_id", doc_id))?;
    let include_content = parse_bool(include_content, "include_content")?;
    let include_summary = parse_bool(include_summary, "include_summary")?;
    let (offset, limit) = parse_paging_fastapi(offset_raw, limit_raw)?;

    let user_id = i64::from(user.id);
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `_validate_knowledge_base_access_or_raise`.
    let Some(kb) = knowledge_base_record(mysql, kb_id)
        .await
        .map_err(|error| internal_error(&error.to_string()))?
    else {
        return Err(value_error("Knowledge base not found").into());
    };
    let kb_access = knowledge_base_access(mysql, redis, &state.entity_resolvers, &kb, user_id)
        .await
        .map_err(|error| DetailError(error.into_fastapi_error()))?;
    if !kb_access {
        return Err(value_error("Access denied to this knowledge base").into());
    }

    // `db.query(KnowledgeDocument).filter(id == doc_id, kind_id == kb_id)`.
    let kb_document = document_by_id_and_kind(mysql, doc_id, kb_id)
        .await
        .map_err(|error| internal_error(&error.to_string()))?;
    if kb_document.is_none() {
        return Err(value_error("Document not found in the specified knowledge base").into());
    }

    // `KnowledgeOrchestrator.get_document_detail`:
    // `_get_document_with_access_or_raise` (the result is discarded after the
    // access validation, exactly like the source).
    let Some(document) = document_by_id(mysql, doc_id)
        .await
        .map_err(|error| internal_error(&error.to_string()))?
    else {
        return Err(value_error("Document not found").into());
    };
    let Some(document_kb) = knowledge_base_record(mysql, document.knowledge_documents_kind_id)
        .await
        .map_err(|error| internal_error(&error.to_string()))?
    else {
        return Err(value_error("Knowledge base not found").into());
    };
    let document_access =
        knowledge_base_access(mysql, redis, &state.entity_resolvers, &document_kb, user_id)
            .await
            .map_err(|error| DetailError(error.into_fastapi_error()))?;
    if !document_access {
        return Err(value_error("Access denied to this document").into());
    }

    let mut content = None;
    let mut content_length = None;
    let mut truncated = None;
    if include_content {
        let paged = read_document_content(state, user_id, doc_id, offset, limit)
            .await
            .map_err(|error| DetailError(error.into_fastapi_error()))?;
        let (page_content, total_length, is_truncated) = paged.into_detail_parts();
        content = Some(page_content);
        content_length = Some(total_length);
        truncated = Some(is_truncated);
    }

    let mut summary = None;
    if include_summary {
        // `SummaryService.get_document_summary`.
        let summary_document = document_by_id(mysql, doc_id)
            .await
            .map_err(|error| internal_error(&error.to_string()))?;
        summary = render_document_summary(
            summary_document
                .as_ref()
                .and_then(|row| row.knowledge_documents_summary.as_ref())
                .map(|json| &json.0),
        );
    }

    Ok(DocumentDetailResponse {
        document_id: doc_id,
        content,
        content_length,
        truncated,
        summary,
    })
}

/// `SummaryService.get_document_summary`: `None` when the document is missing
/// or its stored `summary` is falsy, otherwise `DocumentSummary(**stored)`
/// rendered through `model_dump()`.
///
/// The pydantic model fills a default for every declared field (`status`
/// defaults to `"pending"`) and, with `extra="allow"`, keeps any additional
/// stored keys after the declared ones. `meta_info` is a nested model with the
/// same extra-key policy.
fn render_document_summary(summary: Option<&OpaqueJson>) -> Option<serde_json::Value> {
    let raw = summary?;
    if raw.is_null() {
        return None;
    }
    let serde_json::Value::Object(stored) = raw.to_value() else {
        return None;
    };
    if stored.is_empty() {
        // `not document.summary`.
        return None;
    }

    const DECLARED: [&str; 8] = [
        "short_summary",
        "long_summary",
        "topics",
        "meta_info",
        "status",
        "error",
        "task_id",
        "updated_at",
    ];
    let mut out = serde_json::Map::new();
    for field in DECLARED {
        let value = match field {
            "meta_info" => render_meta_info(stored.get("meta_info")),
            "status" => stored
                .get("status")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::String("pending".to_string())),
            _ => stored
                .get(field)
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        };
        out.insert(field.to_string(), value);
    }
    for (key, value) in &stored {
        if !DECLARED.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    Some(serde_json::Value::Object(out))
}

/// `DocumentSummaryMetaInfo`: `None` for an absent or null `meta_info`,
/// otherwise an object with `author`/`source`/`type` defaults and any extra
/// stored keys.
fn render_meta_info(meta_info: Option<&serde_json::Value>) -> serde_json::Value {
    match meta_info {
        Some(serde_json::Value::Object(stored)) => {
            let mut out = serde_json::Map::new();
            for field in ["author", "source", "type"] {
                out.insert(
                    field.to_string(),
                    stored
                        .get(field)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            for (key, value) in stored {
                if !matches!(key.as_str(), "author" | "source" | "type") {
                    out.insert(key.clone(), value.clone());
                }
            }
            serde_json::Value::Object(out)
        }
        _ => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_error_mapping_matches_source() {
        assert_eq!(
            value_error("Document not found").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            value_error("Knowledge base not found").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            value_error("Access denied to this document").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            value_error("Document content is not ready for preview").status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn boolean_query_parsing_matches_pydantic() {
        assert!(parse_bool(None, "include_content").unwrap());
        assert!(parse_bool(Some("true"), "x").unwrap());
        assert!(!parse_bool(Some("False"), "x").unwrap());
        assert!(!parse_bool(Some("0"), "x").unwrap());
        assert!(parse_bool(Some("on"), "x").unwrap());
        assert_eq!(
            parse_bool(Some("bogus"), "x").err().unwrap().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn response_field_order_matches_schema() {
        let response = DocumentDetailResponse {
            document_id: 22222,
            content: Some("c".to_string()),
            content_length: Some(3),
            truncated: Some(false),
            summary: None,
        };
        let body = serde_json::to_string(&response).unwrap();
        assert_eq!(
            body,
            r#"{"document_id":22222,"content":"c","content_length":3,"truncated":false,"summary":null}"#
        );
    }

    #[test]
    fn null_and_empty_summaries_render_as_none() {
        assert!(render_document_summary(None).is_none());
        assert!(
            render_document_summary(Some(&OpaqueJson::from(serde_json::json!(null)))).is_none()
        );
        assert!(render_document_summary(Some(&OpaqueJson::from(serde_json::json!({})))).is_none());
    }

    #[test]
    fn stored_summary_fills_declared_defaults_and_keeps_extras() {
        let stored = serde_json::json!({
            "short_summary": "s",
            "meta_info": {"author": "a", "extra": 1},
            "status": "completed",
            "custom": 7
        });
        let rendered = render_document_summary(Some(&OpaqueJson::from(stored))).unwrap();
        assert_eq!(
            rendered,
            serde_json::json!({
                "short_summary": "s",
                "long_summary": null,
                "topics": null,
                "meta_info": {"author": "a", "source": null, "type": null, "extra": 1},
                "status": "completed",
                "error": null,
                "task_id": null,
                "updated_at": null,
                "custom": 7
            })
        );
    }

    #[test]
    fn stored_summary_without_status_defaults_to_pending() {
        let stored = serde_json::json!({"short_summary": "s"});
        let rendered = render_document_summary(Some(&OpaqueJson::from(stored))).unwrap();
        assert_eq!(rendered["status"], serde_json::json!("pending"));
    }
}
