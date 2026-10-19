// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/web-scraper/create-document`
//! (`app.api.endpoints.web_scraper.create_web_document`), which delegates to
//! `KnowledgeOrchestrator.create_web_document`.
//!
//! Source pipeline (request body
//! `{"url": ..., "knowledge_base_id": ..., "folder_id": 0}`, session JWT):
//!
//! 1. `security.get_current_user` — `sub` claim, `users` row by `user_name`;
//! 2. `KnowledgeService.get_knowledge_base` — `_get_knowledge_base_record`
//!    (`is_active = true`), then the ACL chain of
//!    `resolve_knowledge_base_permission`, then
//!    `meets_direct_access_requirement`;
//! 3. `KnowledgeService.can_manage_knowledge_base_documents` — the KB is
//!    reloaded with `is_active IS true`, the ACL chain re-resolves, and the
//!    creator-or-Developer policy decides;
//! 4. `WebScraperService.scrape_url` (see [`crate::web_scraper`]).
//!
//! A failed scrape returns HTTP 200 with
//! `{"success": false, "document": null, "error_code": ..., "error_message": ...}`.
//! The three pre-scrape failures raise `ValueError`, which the source app's
//! `Exception` handler renders as `500 {"error_code": 500, "detail":
//! "Internal server error"}`.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access;
use crate::state::AppState;

/// `WebDocumentCreateRequest` (`app.api.endpoints.web_scraper`), pydantic's
/// defaults applied: `name` nullable, `folder_id` `ge=0` with default 0.
#[derive(Debug, PartialEq, Eq)]
struct WebDocumentCreateRequest {
    url: String,
    knowledge_base_id: i64,
    name: Option<String>,
    folder_id: i64,
}

/// `WebDocumentCreateResponse`; field order matches the pydantic model.
#[derive(Debug, Serialize)]
struct WebDocumentCreateResponse {
    success: bool,
    document: Option<Value>,
    error_code: Option<&'static str>,
    error_message: Option<String>,
}

/// POST /api/web-scraper/create-document.
#[brz_http_server::post("/api/web-scraper/create-document")]
async fn create_web_document(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: crate::auth::SessionUser,
    body: Value,
) -> Result<WebDocumentCreateResponse, FastApiError> {
    // FastAPI resolves the `get_current_user` dependency (run by the SDK
    // before body binding) and then validates the body; a validation failure
    // renders 422 without the KB dependency traffic.
    let request = parse_request(&body)?;
    create_document(state, i64::from(user.id), &request).await
}

/// `KnowledgeOrchestrator.create_web_document` for the scrape-failure branch.
async fn create_document(
    state: &AppState,
    user_id: i64,
    request: &WebDocumentCreateRequest,
) -> Result<WebDocumentCreateResponse, FastApiError> {
    // `KnowledgeService.get_knowledge_base`: the KB row, the ACL chain, and
    // the direct-access requirement. A missing KB, denied access, or a
    // missing manage permission raises `ValueError` in the source, and any
    // dependency failure propagates unhandled; the application's `Exception`
    // handler renders both as the same 500 body.
    let Some(knowledge_base) =
        access::knowledge_base_record(&state.mysql, request.knowledge_base_id)
            .await
            .map_err(|_| FastApiError::unhandled())?
    else {
        return Err(FastApiError::unhandled());
    };
    let has_access = access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &knowledge_base,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    if !has_access {
        return Err(FastApiError::unhandled());
    }
    let can_manage = access::can_manage_knowledge_base_documents(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        request.knowledge_base_id,
        user_id,
    )
    .await
    .map_err(|_| FastApiError::unhandled())?;
    if !can_manage {
        return Err(FastApiError::unhandled());
    }

    // The scrape result drives the response. The success branch creates an
    // attachment, a knowledge document, and an indexing task; that flow is
    // outside this batch and unreachable in the deployed runtime (the
    // crawler workspace cannot be created), so `document` stays null here.
    let outcome = crate::web_scraper::scrape_url(&request.url).await;
    Ok(WebDocumentCreateResponse {
        success: outcome.success,
        document: None,
        error_code: outcome.error_code,
        error_message: outcome.error_message,
    })
}

/// `WebDocumentCreateRequest` body validation. Unknown keys are ignored, like
/// pydantic's default model configuration.
fn parse_request(body: &Value) -> Result<WebDocumentCreateRequest, FastApiError> {
    let Value::Object(object) = body else {
        return Err(FastApiError::validation(json!([{
            "type": "model_attributes_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
            "input": body,
        }])));
    };

    let url = match object.get("url") {
        None => return Err(field_error("missing", "Field required", "url", body)),
        Some(Value::String(value)) if value.is_empty() => {
            return Err(FastApiError::validation(json!([{
                "type": "string_too_short",
                "loc": ["body", "url"],
                "msg": "String should have at least 1 character",
                "input": value,
                "ctx": {"min_length": 1},
            }])));
        }
        Some(Value::String(value)) => value.clone(),
        Some(other) => {
            return Err(field_error(
                "string_type",
                "Input should be a valid string",
                "url",
                other,
            ));
        }
    };

    let knowledge_base_id = match object.get("knowledge_base_id") {
        None => {
            return Err(field_error(
                "missing",
                "Field required",
                "knowledge_base_id",
                body,
            ));
        }
        Some(value) => int_value(value).ok_or_else(|| int_error("knowledge_base_id", value))?,
    };

    let name = match object.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(other) => {
            return Err(field_error(
                "string_type",
                "Input should be a valid string",
                "name",
                other,
            ));
        }
    };

    // `folder_id: int = Field(0, ge=0)`: only an absent member takes the
    // default; a present `null` is a type error.
    let folder_id = match object.get("folder_id") {
        None => 0,
        Some(value) => {
            let folder_id = int_value(value).ok_or_else(|| int_error("folder_id", value))?;
            if folder_id < 0 {
                return Err(FastApiError::validation(json!([{
                    "type": "greater_than_equal",
                    "loc": ["body", "folder_id"],
                    "msg": "Input should be greater than or equal to 0",
                    "input": value,
                    "ctx": {"ge": 0},
                }])));
            }
            folder_id
        }
    };

    Ok(WebDocumentCreateRequest {
        url,
        knowledge_base_id,
        name,
        folder_id,
    })
}

/// One FastAPI body-validation error entry.
fn field_error(kind: &str, message: &str, field: &str, input: &Value) -> FastApiError {
    FastApiError::validation(json!([{
        "type": kind,
        "loc": ["body", field],
        "msg": message,
        "input": input,
    }]))
}

/// Pydantic's int coercion failure, split by input shape: numeric strings
/// report a parse failure, integral-float failures a fractional-part error,
/// and every other shape a type error.
fn int_error(field: &str, value: &Value) -> FastApiError {
    match value {
        Value::String(_) => field_error(
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            field,
            value,
        ),
        Value::Number(number) if number.as_f64().is_some_and(|value| value.fract() != 0.0) => {
            field_error(
                "int_from_float",
                "Input should be a valid integer, got a number with a fractional part",
                field,
                value,
            )
        }
        _ => field_error("int_type", "Input should be a valid integer", field, value),
    }
}

/// Pydantic's lax integer coercion for a JSON body: integers, integral
/// floats, and numeric strings.
fn int_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number.as_f64().and_then(|value| {
                // Only exact integral floats inside the i64 range coerce;
                // an out-of-range or fractional float is a validation error.
                let in_range =
                    (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&value);
                (value.fract() == 0.0 && in_range).then_some(value as i64)
            })
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    fn parse(body: Value) -> Result<WebDocumentCreateRequest, FastApiError> {
        parse_request(&body)
    }

    #[test]
    fn a_full_body_parses_with_the_source_defaults() {
        assert_eq!(
            parse(json!({
                "url": "https://example.test/page",
                "knowledge_base_id": 42,
                "folder_id": 0,
            }))
            .unwrap(),
            WebDocumentCreateRequest {
                url: "https://example.test/page".to_string(),
                knowledge_base_id: 42,
                name: None,
                folder_id: 0,
            }
        );
        assert_eq!(
            parse(json!({
                "url": "https://example.test/page",
                "knowledge_base_id": "42",
                "name": "Doc",
            }))
            .unwrap(),
            WebDocumentCreateRequest {
                url: "https://example.test/page".to_string(),
                knowledge_base_id: 42,
                name: Some("Doc".to_string()),
                folder_id: 0,
            }
        );
    }

    #[test]
    fn missing_and_mistyped_fields_render_fastapi_validation_errors() {
        for body in [
            json!({"knowledge_base_id": 1}),
            json!({"url": 1, "knowledge_base_id": 1}),
            json!({"url": "https://example.test", "knowledge_base_id": "x"}),
            json!({"url": "https://example.test", "knowledge_base_id": 1, "name": 2}),
        ] {
            let error = parse(body).expect_err("body must be rejected");
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert!(error.validation_detail().contains("\"loc\""));
        }
        assert!(parse(json!({"url": "", "knowledge_base_id": 1})).is_err());
        assert!(
            parse(json!({"url": "https://x", "knowledge_base_id": 1, "folder_id": -1})).is_err()
        );
        // A present `null` is a type error for the non-optional `folder_id`,
        // while `name` is `Optional[str]` and accepts it.
        assert!(
            parse(json!({"url": "https://x", "knowledge_base_id": 1, "folder_id": null})).is_err()
        );
        assert_eq!(
            parse(json!({"url": "https://x", "knowledge_base_id": 1, "name": null}))
                .unwrap()
                .name,
            None
        );
        assert!(parse(json!(["not", "an", "object"])).is_err());
    }

    #[test]
    fn integer_coercion_reports_the_pydantic_error_kind() {
        let detail = |body: Value| {
            parse(body)
                .expect_err("integer must be rejected")
                .validation_detail()
        };
        assert!(
            detail(json!({"url": "https://x", "knowledge_base_id": "abc"}))
                .contains("\"int_parsing\"")
        );
        assert!(
            detail(json!({"url": "https://x", "knowledge_base_id": 1.5}))
                .contains("\"int_from_float\"")
        );
        assert!(
            detail(json!({"url": "https://x", "knowledge_base_id": true})).contains("\"int_type\"")
        );
        // Integral floats and numeric strings coerce like pydantic's lax mode.
        assert_eq!(
            parse(json!({"url": "https://x", "knowledge_base_id": 42.0}))
                .unwrap()
                .knowledge_base_id,
            42
        );
    }

    #[test]
    fn the_response_serializes_null_document_and_error_fields() {
        let response = WebDocumentCreateResponse {
            success: false,
            document: None,
            error_code: Some("FETCH_FAILED"),
            error_message: Some("Failed".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"success":false,"document":null,"error_code":"FETCH_FAILED","error_message":"Failed"}"#
        );
    }

    /// The create-document route is registered exactly once in the public
    /// route group, so the gateway serves it from Rust instead of forwarding
    /// it to the Python fallback.
    #[test]
    fn create_document_is_registered_in_the_public_group() {
        let paths: Vec<_> = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
        .filter(|path| *path == "/api/web-scraper/create-document")
        .collect();
        assert_eq!(paths, ["/api/web-scraper/create-document"]);
    }
}
