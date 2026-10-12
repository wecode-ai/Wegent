// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/knowledge-bases/{knowledge_base_id}/documents/external-import-status`
//! (`app.api.endpoints.knowledge.get_external_document_import_statuses` ->
//! `ExternalDocumentImportService.get_import_statuses`).
//!
//! The endpoint returns the index status of the caller's existing copies of a
//! bounded set of provider-scoped external resources, without fetching
//! provider content or queuing work. Source pipeline:
//!
//! 1. `security.get_current_user` — the active user by session name;
//! 2. `ExternalDocumentImportService._validate_provider_context` — resolve the
//!    provider adapter, then `KnowledgeService.get_knowledge_base`
//!    (`_get_knowledge_base_record` + the full ACL chain) and
//!    `can_manage_knowledge_base_documents` (the KB re-loaded with
//!    `is_active IS true`, then the ACL chain again);
//! 3. the status query joining `knowledge_documents` to
//!    `knowledge_document_external_sources` filtered by the knowledge base,
//!    the provider id, and the requested resource ids.
//!
//! `ExternalDocumentImportError` maps to `HTTPException(status_code, detail)`;
//! every other failure is an unhandled 500.
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql};
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access::{
    can_manage_knowledge_base_documents, knowledge_base_access, knowledge_base_record,
    quote_literal,
};
use crate::state::AppState;
use brz_json::OpaqueJson;

/// `ExternalDocumentStatusRequest.provider` constraints.
const MAX_PROVIDER_LENGTH: usize = 32;
/// Each `ExternalDocumentStatusRequest.external_resource_ids` item constraint.
const MAX_RESOURCE_ID_LENGTH: usize = 255;
/// `ExternalDocumentStatusRequest.external_resource_ids` list bound.
const MAX_RESOURCE_IDS: usize = 500;

/// `get_external_document_provider` resolves exactly these adapters (the
/// DingTalk adapter is registered eagerly; Wiki and Xiaoxin lazily).
const SUPPORTED_PROVIDERS: [&str; 3] = ["dingtalk", "wiki", "xiaoxin"];

/// POST /api/knowledge-bases/:knowledge_base_id/documents/external-import-status:
/// the knowledge-bases free function, injecting the process-lifetime
/// application state.
#[brz_http_server::post("/api/knowledge-bases/:knowledge_base_id/documents/external-import-status")]
async fn external_import_status_route(
    #[inject(state)] state: &Arc<AppState>,
    knowledge_base_id: &str,
    #[auth] current_user: crate::auth::SessionUser,
    body: Value,
) -> Result<OpaqueJson, FastApiError> {
    // FastAPI validates the path parameter and the body before the endpoint
    // body runs; either failure surfaces as 422 without dependency traffic.
    let knowledge_base_id = knowledge_base_id
        .parse::<i64>()
        .map_err(|_| path_int_error(knowledge_base_id))?;
    let request = parse_status_request(&body)?;
    external_import_status(state, knowledge_base_id, &current_user, &request).await
}

/// The validated `ExternalDocumentStatusRequest`.
#[derive(Debug)]
struct StatusRequest {
    /// The raw `provider` value, used verbatim in the unsupported-provider
    /// error and normalized for the lookup.
    provider: String,
    external_resource_ids: Vec<String>,
}

/// `ExternalDocumentStatusRequest` body validation (pydantic-v2 semantics for
/// the fields this endpoint declares; unknown keys are ignored).
fn parse_status_request(body: &Value) -> Result<StatusRequest, FastApiError> {
    let Value::Object(object) = body else {
        return Err(FastApiError::validation(json!([{
            "type": "model_attributes_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
            "input": body,
        }])));
    };

    let provider = match object.get("provider") {
        None => return Err(missing_field("provider", body)),
        Some(value) => {
            let text = value
                .as_str()
                .ok_or_else(|| string_type_error(&["body", "provider"], value))?;
            if text.is_empty() {
                return Err(string_too_short(&["body", "provider"], 1, value));
            }
            if text.chars().count() > MAX_PROVIDER_LENGTH {
                return Err(string_too_long(
                    &["body", "provider"],
                    MAX_PROVIDER_LENGTH,
                    value,
                ));
            }
            text.to_string()
        }
    };

    let external_resource_ids = match object.get("external_resource_ids") {
        None => return Err(missing_field("external_resource_ids", body)),
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return Err(list_too_short(&["body", "external_resource_ids"], 1, body));
            }
            if items.len() > MAX_RESOURCE_IDS {
                return Err(list_too_long(
                    &["body", "external_resource_ids"],
                    MAX_RESOURCE_IDS,
                    items.len(),
                    body,
                ));
            }
            let mut ids = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let index = index.to_string();
                let loc = ["body", "external_resource_ids", index.as_str()];
                let text = item.as_str().ok_or_else(|| string_type_error(&loc, item))?;
                if text.is_empty() {
                    return Err(string_too_short(&loc, 1, item));
                }
                if text.chars().count() > MAX_RESOURCE_ID_LENGTH {
                    return Err(string_too_long(&loc, MAX_RESOURCE_ID_LENGTH, item));
                }
                ids.push(text.to_string());
            }
            ids
        }
        Some(value) => return Err(list_type_error(&["body", "external_resource_ids"], value)),
    };

    Ok(StatusRequest {
        provider,
        external_resource_ids,
    })
}

/// FastAPI-style 422 for an unparsable path parameter.
fn path_int_error(value: &str) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "int_parsing",
        "loc": ["path", "knowledge_base_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    }]))
}

fn missing_field(field: &str, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "missing",
        "loc": ["body", field],
        "msg": "Field required",
        "input": input,
    }]))
}

fn string_type_error(loc: &[&str], input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "string_type",
        "loc": loc,
        "msg": "Input should be a valid string",
        "input": input,
    }]))
}

fn string_too_short(loc: &[&str], limit: usize, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "string_too_short",
        "loc": loc,
        "ctx": {"min_length": limit},
        "msg": format!("String should have at least {limit} character"),
        "input": input,
    }]))
}

fn string_too_long(loc: &[&str], limit: usize, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "string_too_long",
        "loc": loc,
        "ctx": {"max_length": limit},
        "msg": format!("String should have at most {limit} characters"),
        "input": input,
    }]))
}

fn list_type_error(loc: &[&str], input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "list_type",
        "loc": loc,
        "msg": "Input should be a valid list",
        "input": input,
    }]))
}

fn list_too_short(loc: &[&str], limit: usize, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "too_short",
        "loc": loc,
        "ctx": {"min_length": limit},
        "msg": format!("List should have at least {limit} item after validation, not 0"),
        "input": input,
    }]))
}

fn list_too_long(loc: &[&str], limit: usize, actual: usize, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": "too_long",
        "loc": loc,
        "ctx": {"max_length": limit},
        "msg": format!("List should have at most {limit} items after validation, not {actual}"),
        "input": input,
    }]))
}

/// `ExternalDocumentImportService.get_import_statuses` after authentication.
async fn external_import_status(
    state: &AppState,
    knowledge_base_id: i64,
    user: &crate::auth::SessionUser,
    request: &StatusRequest,
) -> Result<OpaqueJson, FastApiError> {
    let user_id = i64::from(user.id);
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `_validate_provider_context`: the provider adapter is resolved first;
    // the normalized id is what the status query filters on.
    let provider_id = request.provider.trim().to_lowercase();
    if !SUPPORTED_PROVIDERS.contains(&provider_id.as_str()) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!(
                "Unsupported external document provider: {}",
                request.provider
            ),
        ));
    }

    // `KnowledgeService.get_knowledge_base`: record, then the ACL chain; a
    // missing record or denied access is the endpoint's 404.
    let Some(kb) = knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Err(knowledge_base_not_found());
    };
    let has_access = knowledge_base_access(mysql, redis, &state.entity_resolvers, &kb, user_id)
        .await
        .map_err(|_| FastApiError::unhandled())?;
    if !has_access {
        return Err(knowledge_base_not_found());
    }

    // `KnowledgeService.can_manage_knowledge_base_documents`.
    let can_manage = can_manage_knowledge_base_documents(
        mysql,
        redis,
        &state.entity_resolvers,
        knowledge_base_id,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    if !can_manage {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "You do not have permission to add documents to this knowledge base",
        ));
    }

    // The status query (`db.query(...).join(...).filter(...)`).
    let rows = status_rows(
        mysql,
        knowledge_base_id,
        &provider_id,
        &request.external_resource_ids,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    Ok(status_body(rows))
}

/// `{resource_id: index_status for resource_id, index_status in rows}` — a
/// JSON object keyed by the external resource id. An empty result stays an
/// empty object (`{}`), matching the recorded 200 body.
fn status_body(rows: Vec<StatusRow>) -> OpaqueJson {
    let mut body = Map::with_capacity(rows.len());
    for row in rows {
        body.insert(
            row.external_resource_id,
            Value::String(row.knowledge_documents_index_status),
        );
    }
    OpaqueJson::from_serializable(body)
}

/// `HTTPException(404, "Knowledge base not found or access denied")`.
fn knowledge_base_not_found() -> FastApiError {
    FastApiError::detail(
        StatusCode::NOT_FOUND,
        "Knowledge base not found or access denied",
    )
}

/// One `knowledge_document_external_sources.external_resource_id` /
/// `knowledge_documents.index_status` pair.
#[derive(Debug, FromMysqlRow)]
struct StatusRow {
    #[mysql(rename = "knowledge_document_external_sources_external_resource_id")]
    external_resource_id: String,
    #[mysql(rename = "knowledge_documents_index_status")]
    knowledge_documents_index_status: String,
}

/// The SQLAlchemy-labeled status projection: an inner join of the document and
/// its external source, scoped to the knowledge base, provider, and requested
/// resource ids.
fn status_query_sql(
    knowledge_base_id: i64,
    provider_id: &str,
    external_resource_ids: &[String],
) -> String {
    let ids = external_resource_ids
        .iter()
        .map(|id| quote_literal(id))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT knowledge_document_external_sources.external_resource_id AS \
         knowledge_document_external_sources_external_resource_id, \
         knowledge_documents.index_status AS knowledge_documents_index_status \n\
         FROM knowledge_documents INNER JOIN knowledge_document_external_sources \
         ON knowledge_documents.id = knowledge_document_external_sources.document_id \n\
         WHERE knowledge_document_external_sources.kind_id = {knowledge_base_id} \
         AND knowledge_document_external_sources.external_provider = {} \
         AND knowledge_document_external_sources.external_resource_id IN ({ids})",
        quote_literal(provider_id)
    )
}

async fn status_rows<M>(
    mysql: &M,
    knowledge_base_id: i64,
    provider_id: &str,
    external_resource_ids: &[String],
) -> brz_mysql::MysqlResult<Vec<StatusRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &status_query_sql(knowledge_base_id, provider_id, external_resource_ids),
            (),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> Value {
        json!({"provider": "dingtalk", "external_resource_ids": ["a", "b"]})
    }

    #[test]
    fn accepts_the_recorded_request_shape() {
        let request = parse_status_request(&valid_body()).expect("valid body");
        assert_eq!(request.provider, "dingtalk");
        assert_eq!(request.external_resource_ids, vec!["a", "b"]);
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let mut body = valid_body();
        body["extra"] = json!(1);
        assert!(parse_status_request(&body).is_ok());
    }

    #[test]
    fn non_object_body_is_422() {
        let error = parse_status_request(&json!([1, 2])).expect_err("non-object body");
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.validation_detail().contains("model_attributes_type"));
    }

    #[test]
    fn missing_provider_and_ids_are_422() {
        assert!(
            parse_status_request(&json!({"external_resource_ids": ["a"]}))
                .expect_err("missing provider")
                .validation_detail()
                .contains("\"missing\"")
        );
        assert!(
            parse_status_request(&json!({"provider": "dingtalk"}))
                .expect_err("missing ids")
                .validation_detail()
                .contains("external_resource_ids")
        );
    }

    #[test]
    fn provider_bounds_are_enforced() {
        let too_short = json!({"provider": "", "external_resource_ids": ["a"]});
        assert!(
            parse_status_request(&too_short)
                .expect_err("empty provider")
                .validation_detail()
                .contains("string_too_short")
        );
        let too_long = json!({"provider": "x".repeat(33), "external_resource_ids": ["a"]});
        assert!(
            parse_status_request(&too_long)
                .expect_err("long provider")
                .validation_detail()
                .contains("string_too_long")
        );
    }

    #[test]
    fn resource_id_list_bounds_are_enforced() {
        let empty = json!({"provider": "dingtalk", "external_resource_ids": []});
        assert!(
            parse_status_request(&empty)
                .expect_err("empty list")
                .validation_detail()
                .contains("too_short")
        );
        let not_a_list = json!({"provider": "dingtalk", "external_resource_ids": "a"});
        assert!(
            parse_status_request(&not_a_list)
                .expect_err("non-list")
                .validation_detail()
                .contains("list_type")
        );
        let bad_item = json!({"provider": "dingtalk", "external_resource_ids": [""]});
        assert!(
            parse_status_request(&bad_item)
                .expect_err("empty item")
                .validation_detail()
                .contains("string_too_short")
        );
    }

    #[test]
    fn status_query_matches_the_recorded_template() {
        let sql = status_query_sql(1500569, "dingtalk", &["a".to_string(), "b".to_string()]);
        assert_eq!(
            sql,
            "SELECT knowledge_document_external_sources.external_resource_id AS \
             knowledge_document_external_sources_external_resource_id, \
             knowledge_documents.index_status AS knowledge_documents_index_status \n\
             FROM knowledge_documents INNER JOIN knowledge_document_external_sources \
             ON knowledge_documents.id = knowledge_document_external_sources.document_id \n\
             WHERE knowledge_document_external_sources.kind_id = 1500569 \
             AND knowledge_document_external_sources.external_provider = 'dingtalk' \
             AND knowledge_document_external_sources.external_resource_id IN ('a', 'b')"
        );
    }

    #[test]
    fn unsupported_provider_message_uses_the_raw_value() {
        let body = json!({"provider": "  Unknown ", "external_resource_ids": ["a"]});
        let request = parse_status_request(&body).expect("valid shape");
        let normalized = request.provider.trim().to_lowercase();
        assert_eq!(normalized, "unknown");
        assert!(!SUPPORTED_PROVIDERS.contains(&normalized.as_str()));
    }

    #[test]
    fn empty_status_result_renders_as_an_empty_object() {
        assert_eq!(
            serde_json::to_string(&status_body(Vec::new())).unwrap(),
            "{}"
        );
    }

    #[test]
    fn status_result_maps_resource_ids_to_index_status() {
        let rows = vec![
            StatusRow {
                external_resource_id: "a".to_string(),
                knowledge_documents_index_status: "success".to_string(),
            },
            StatusRow {
                external_resource_id: "b".to_string(),
                knowledge_documents_index_status: "indexing".to_string(),
            },
        ];
        assert_eq!(
            serde_json::to_string(&status_body(rows)).unwrap(),
            r#"{"a":"success","b":"indexing"}"#
        );
    }
}
