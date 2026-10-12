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
/// the echoed task id, in the source model's field order.
#[derive(Debug, Serialize)]
struct SandboxRestoreResponse {
    success: bool,
    task_id: i64,
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
    // endpoint reports only whether a restore happened.
    let restored = service::restore_workspace(
        state,
        task_id,
        &task_json,
        &request.executor_name,
        &request.executor_namespace,
    )
    .await;
    Ok(SandboxRestoreResponse {
        success: restored,
        task_id,
    })
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
            success: false,
            task_id: 204_921_479_781_245,
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"success":false,"task_id":204921479781245}"#
        );
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
}
