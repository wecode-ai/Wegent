// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/workspace-archives/{task_id}/restore-sandbox`.
//!
//! Mirrors `app/api/endpoints/internal/workspace_archives.py`'s
//! `restore_sandbox_workspace`: load the active task (`_get_active_task`,
//! 404 `Task not found` when absent) and restore its sandbox workspace from
//! the stored archive. The router carries no authentication dependency, so
//! the route is public at the application layer, matching the source.
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::Json;
use serde::Serialize;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::service;

/// The `validation_exception_handler` detail line.
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// `SandboxArchiveRequest` (`workspace_archives.py`): `executor_name` is
/// required, `executor_namespace` defaults to the empty string.
#[derive(Debug)]
struct SandboxArchiveRequest {
    executor_name: String,
    executor_namespace: String,
}

impl SandboxArchiveRequest {
    /// Validate a decoded JSON body the way pydantic validates
    /// `SandboxArchiveRequest` before the endpoint runs. Unknown keys are
    /// ignored.
    fn from_value(value: Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = value else {
            return Err(validation_error(
                vec!["body"],
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                value,
            ));
        };
        let executor_name = match object.get("executor_name") {
            Some(Value::String(name)) => name.clone(),
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "executor_name"],
                    "string_type",
                    "Input should be a valid string",
                    other.clone(),
                ));
            }
            None => {
                return Err(validation_error(
                    vec!["body", "executor_name"],
                    "missing",
                    "Field required",
                    Value::Null,
                ));
            }
        };
        let executor_namespace = match object.get("executor_namespace") {
            None => String::new(),
            Some(Value::String(namespace)) => namespace.clone(),
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "executor_namespace"],
                    "string_type",
                    "Input should be a valid string",
                    other.clone(),
                ));
            }
        };
        Ok(Self {
            executor_name,
            executor_namespace,
        })
    }
}

/// `SandboxRestoreResponse` (`workspace_archives.py`): the restore outcome and
/// the echoed task id, in the source model's field order. `success` reports the
/// request was accepted and `skipped` the no-archive fast path.
#[derive(Debug, Serialize)]
struct SandboxRestoreResponse {
    success: bool,
    task_id: i64,
    skipped: bool,
}

/// `POST /api/internal/workspace-archives/{task_id}/restore-sandbox`.
#[brz_http_server::post(
    "/api/internal/workspace-archives/:task_id/restore-sandbox",
    access = public
)]
async fn restore_sandbox(
    #[inject(state)] state: &Arc<AppState>,
    task_id: i64,
    body: Value,
) -> Result<SandboxRestoreResponse, FastApiError> {
    let request = SandboxArchiveRequest::from_value(body)?;
    restore_sandbox_workspace(state, task_id, request).await
}

/// Handler body, separated from body extraction for tests.
async fn restore_sandbox_workspace(
    state: &AppState,
    task_id: i64,
    request: SandboxArchiveRequest,
) -> Result<SandboxRestoreResponse, FastApiError> {
    // `_get_active_task`: no owner filter, so the id's own active task.
    let task = state
        .task_store
        .get_active_task_any_owner(task_id)
        .await
        .map_err(internal_error)?;
    let Some(task) = task else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Task not found",
        ));
    };
    let task_json = task
        .get_required::<Json<Value>>("json")
        .map_err(internal_error)?
        .0;

    // `archive_service.restore_workspace(..., runtime_type="sandbox")`; the
    // endpoint acknowledges either way, and only reports whether it skipped.
    let restored = service::restore_workspace(
        state,
        task_id,
        &task_json,
        &request.executor_name,
        &request.executor_namespace,
    )
    .await;
    restore_response(task_id, restored, &task_json)
}

/// The source endpoint's decision after `restore_workspace` returns: an
/// acknowledged restore, the no-archive skip, or a 409 when a stored archive
/// exists but no restore happened.
///
/// ```python
/// if restored:
///     return SandboxRestoreResponse(success=True, task_id=task_id)
/// status = (task.json or {}).get("status") or {}
/// archive = status.get("archive") or {}
/// if not archive.get("storageKey"):
///     return SandboxRestoreResponse(success=True, task_id=task_id, skipped=True)
/// raise HTTPException(status_code=409, detail="sandbox_archive_restore_failed")
/// ```
fn restore_response(
    task_id: i64,
    restored: bool,
    task_json: &Value,
) -> Result<SandboxRestoreResponse, FastApiError> {
    if restored {
        return Ok(SandboxRestoreResponse {
            success: true,
            task_id,
            skipped: false,
        });
    }
    // A falsy `storageKey` ("", JSON null, a missing field) means the task has
    // no stored archive to restore, so the endpoint reports a skip.
    if !stored_archive_key_is_truthy(task_json)? {
        return Ok(SandboxRestoreResponse {
            success: true,
            task_id,
            skipped: true,
        });
    }
    Err(FastApiError::detail(
        StatusCode::CONFLICT,
        "sandbox_archive_restore_failed",
    ))
}

/// `status.get("archive") or {}` -> `archive.get("storageKey")` evaluated for
/// Python truthiness, as the endpoint re-reads the descriptor from `task.json`.
///
/// A falsy value stands in for `{}`, so an absent, empty, or `null`
/// `status`/`archive` has no storage key. A truthy non-object raises
/// `AttributeError` in the source, which the application's `Exception` handler
/// renders as the 500 body.
fn stored_archive_key_is_truthy(task_json: &Value) -> Result<bool, FastApiError> {
    let Some(task) = object_or_empty(task_json)? else {
        return Ok(false);
    };
    let Some(status) = field_or_empty(task, "status")? else {
        return Ok(false);
    };
    let Some(archive) = field_or_empty(status, "archive")? else {
        return Ok(false);
    };
    Ok(archive
        .get("storageKey")
        .is_some_and(brz_json::adapters::python_truthy))
}

/// `object.get(key) or {}`: the object at `key`, or `None` when the key is
/// absent or its value is falsy. A truthy non-object raises the source's
/// `AttributeError`.
fn field_or_empty<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<&'a serde_json::Map<String, Value>>, FastApiError> {
    object.get(key).map_or(Ok(None), object_or_empty)
}

/// `value or {}`: a falsy value becomes an empty object; a truthy non-object
/// is the source's `AttributeError`.
fn object_or_empty(value: &Value) -> Result<Option<&serde_json::Map<String, Value>>, FastApiError> {
    match value {
        Value::Object(object) => Ok((!object.is_empty()).then_some(object)),
        value if brz_json::adapters::python_truthy(value) => Err(FastApiError::unhandled()),
        _ => Ok(None),
    }
}

/// An unwrapped dependency failure renders the application's
/// `python_exception_handler` body.
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "workspace archive dependency failure");
    FastApiError::unhandled()
}

/// `{"error_code":422,"detail":"Request parameter validation failed","errors":[...]}`
/// — the source `validation_exception_handler` body.
fn validation_error(location: Vec<&str>, kind: &str, message: &str, input: Value) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({
            "error_code": 422,
            "detail": VALIDATION_FAILED,
            "errors": [
                {"type": kind, "loc": location, "msg": message, "input": input},
            ],
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_request_and_ignores_unknown_keys() {
        let request = SandboxArchiveRequest::from_value(json!({
            "executor_name": "wegent-task-x",
            "executor_namespace": "",
            "extra": 1,
        }))
        .unwrap();
        assert_eq!(request.executor_name, "wegent-task-x");
        assert_eq!(request.executor_namespace, "");
    }

    #[test]
    fn defaults_the_namespace_when_absent() {
        let request = SandboxArchiveRequest::from_value(json!({"executor_name": "x"})).unwrap();
        assert_eq!(request.executor_namespace, "");
    }

    #[test]
    fn rejects_a_missing_name_and_wrong_types() {
        assert!(SandboxArchiveRequest::from_value(json!({})).is_err());
        assert!(SandboxArchiveRequest::from_value(json!({"executor_name": 1})).is_err());
        assert!(
            SandboxArchiveRequest::from_value(
                json!({"executor_name": "x", "executor_namespace": null})
            )
            .is_err()
        );
        assert!(SandboxArchiveRequest::from_value(json!([])).is_err());
    }

    #[test]
    fn response_serializes_the_source_field_order() {
        let body = SandboxRestoreResponse {
            success: true,
            task_id: 228_011_223_960_243,
            skipped: true,
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"success":true,"task_id":228011223960243,"skipped":true}"#
        );
    }

    /// `SandboxRestoreResponse.skipped` defaults to `False`, and FastAPI
    /// serializes model defaults, so the restored path still emits the field.
    #[test]
    fn a_restored_task_acknowledges_without_the_skip_marker() {
        let response = restore_response(228_011_223_960_243, true, &json!({"status": {}})).unwrap();
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"success":true,"task_id":228011223960243,"skipped":false}"#
        );
    }

    /// The recorded skip path: no stored archive, so the endpoint answers 200
    /// with `success` and `skipped` both true (the recorded body is
    /// `{"success":true,"task_id":228011223960243,"skipped":true}`).
    #[test]
    fn a_task_without_a_stored_archive_is_skipped() {
        for task_json in [
            json!({}),
            json!({"status": null}),
            json!({"status": {}}),
            json!({"status": {"archive": null}}),
            json!({"status": {"archive": {}}}),
            json!({"status": {"archive": {"storageKey": null}}}),
            json!({"status": {"archive": {"storageKey": ""}}}),
            json!({"status": {"archive": {"storageKey": false}}}),
            json!({"status": []}),
            json!({"status": 0}),
        ] {
            let response = restore_response(7, false, &task_json).unwrap();
            assert!(response.success, "{task_json}");
            assert!(response.skipped, "{task_json}");
        }
    }

    /// A stored archive that failed to restore is the source's 409 with the
    /// `sandbox_archive_restore_failed` detail, not a skip.
    #[test]
    fn a_stored_archive_that_did_not_restore_conflicts() {
        let error = restore_response(
            7,
            false,
            &json!({"status": {"archive": {"storageKey": "workspace-archives/7/a.tar.gz"}}}),
        )
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::CONFLICT);
        assert_eq!(
            error.validation_detail(),
            "\"sandbox_archive_restore_failed\""
        );
    }

    /// A truthy non-object `status` or `archive` is the source's
    /// `AttributeError`, rendered by the application's `Exception` handler.
    #[test]
    fn a_non_object_descriptor_is_an_unhandled_failure() {
        for task_json in [
            json!({"status": "not an object"}),
            json!({"status": {"archive": "not an object"}}),
            json!({"status": [1]}),
            json!({"status": 1}),
        ] {
            let error = restore_response(7, false, &task_json).unwrap_err();
            assert_eq!(
                error.status(),
                StatusCode::INTERNAL_SERVER_ERROR,
                "{task_json}"
            );
        }
    }

    #[test]
    fn validation_body_uses_the_application_handler_shape() {
        let error = validation_error(
            vec!["body", "executor_name"],
            "missing",
            "Field required",
            Value::Null,
        );
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        // `validation_detail` returns the raw JSON of the `detail` field; the
        // custom handler body carries the fixed detail line plus `errors`.
        assert_eq!(
            error.validation_detail(),
            format!("\"{VALIDATION_FAILED}\"")
        );
    }

    /// The cutover is real only when the route table selects the pattern the
    /// handler registers. `config/routes.toml` lists
    /// `/api/internal/workspace-archives/:task_id/restore-sandbox`, and the
    /// template must not answer the sibling `/archive` or `/archive-sandbox`
    /// methods.
    #[test]
    fn route_table_selects_the_registered_restore_sandbox_handler() {
        const PATH: &str = "/api/internal/workspace-archives/:task_id/restore-sandbox";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        const URI: &str = "/api/internal/workspace-archives/913144407018301/restore-sandbox";

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(table.matches(&http::Method::POST, URI));
        assert!(!table.matches(&http::Method::GET, URI));
        assert!(!table.matches(
            &http::Method::POST,
            "/api/internal/workspace-archives/913144407018301/archive"
        ));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
}
