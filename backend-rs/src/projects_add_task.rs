// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/projects/{project_id}/tasks` — add a task to one of the caller's
//! projects (`app.api.endpoints.projects.add_task_to_project_endpoint` ->
//! `app.services.project_service.add_task_to_project`).
//!
//! The source verifies the active project, loads the owned active task, then
//! links the task to the project and rewrites its CRD JSON with the
//! `metadata.labels.projectId` label. The recorded dependency stream is the
//! project read, the owned-task read (`get_task_by_states` with the project's
//! `client_origin`), and the single flushed update plus commit.
use std::sync::Arc;

use brz_http_server::{Response, StatusCode};
use brz_mysql::Json;
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::state::AppState;

use super::{
    ProjectTaskItem, decode_task_row, find_active_project, parse_client_origin, task_item,
};

/// `AddTaskToProjectResponse` (`app.schemas.project`): the fixed success
/// message and the added task's projection, in the source model's field order.
#[derive(Debug, serde::Serialize)]
struct AddTaskToProjectResponse {
    message: String,
    project_task: ProjectTaskItem,
}

/// `_with_task_project_label(task, project_id)`: set
/// `metadata.labels.projectId` to the decimal project id (`str(project_id)`),
/// or drop it for a falsy id, preserving the order of every surviving key.
pub(super) fn with_task_project_label(
    task_json: &serde_json::Value,
    project_id: i64,
) -> serde_json::Value {
    let mut root = match task_json {
        serde_json::Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    let mut metadata = match root.get("metadata") {
        Some(serde_json::Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    let mut labels = match metadata.get("labels") {
        Some(serde_json::Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    if project_id != 0 {
        labels.insert(
            "projectId".to_string(),
            serde_json::Value::String(project_id.to_string()),
        );
    } else {
        labels.remove("projectId");
    }
    metadata.insert("labels".to_string(), serde_json::Value::Object(labels));
    root.insert("metadata".to_string(), serde_json::Value::Object(metadata));
    serde_json::Value::Object(root)
}

/// `ProjectTaskCreate` (`app.schemas.project`) body validation: the single
/// required field is `task_id`; pydantic ignores unknown keys. FastAPI
/// validates the body before the endpoint runs, so a missing or mistyped
/// `task_id` renders a 422 without dependency traffic.
pub(super) fn parse_project_task_create(body: &serde_json::Value) -> Result<i64, FastApiError> {
    let serde_json::Value::Object(object) = body else {
        return Err(FastApiError::validation(json!([
            {
                "type": "model_attributes_type",
                "loc": ["body"],
                "msg": "Input should be a valid dictionary or object to extract fields from",
                "input": body,
            }
        ])));
    };
    match object.get("task_id") {
        None => Err(body_int_error("missing", "Field required", body)),
        Some(value) => value
            .as_i64()
            .ok_or_else(|| body_int_error("int_parsing", "Input should be a valid integer", value)),
    }
}

/// One FastAPI body-validation error entry for `task_id`.
fn body_int_error(kind: &str, message: &str, input: &serde_json::Value) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["body", "task_id"],
            "msg": message,
            "input": input,
        }
    ]))
}

/// `add_task_to_project_endpoint` (`POST /api/projects/{project_id}/tasks`).
///
/// Adds a task to one of the caller's active projects: it verifies the
/// project, loads the owned active task, then links the task to the project
/// and labels it. The response is the fixed message plus the task projection.
#[brz_http_server::post("/api/projects/:project_id/tasks")]
pub(super) async fn add_task_to_project(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    project_id: i64,
    client_origin: Option<String>,
    body: serde_json::Value,
) -> Result<Response, FastApiError> {
    // FastAPI validates the query parameter and the body before the endpoint
    // body runs; either failure surfaces as 422 without dependency traffic.
    let client_origin = parse_client_origin(client_origin.as_deref())?;
    let task_id = parse_project_task_create(&body)?;
    add_project_task(state, &current_user, project_id, task_id, &client_origin).await
}

/// Handler body for `POST /api/projects/{project_id}/tasks`.
async fn add_project_task(
    state: &Arc<AppState>,
    user: &crate::auth::SessionUser,
    project_id: i64,
    task_id: i64,
    client_origin: &str,
) -> Result<Response, FastApiError> {
    let user_id = i64::from(user.id);

    // `_get_active_project`: a missing project is a 404 before any task read.
    find_active_project(state, project_id, user_id, client_origin).await?;

    // `task_store.get_task_by_states(states=[STATE_ACTIVE], user_id=...,
    // client_origin=...)`: the owned active task, or 404.
    let task = state
        .task_store
        .get_owned_active_task(task_id, user_id, Some(client_origin))
        .await
        .map_err(add_task_error)?;
    let Some(task) = task else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Task not found",
        ));
    };

    // `update_fields(project_id=...)` then
    // `update_json(_with_task_project_label(task, project_id))`: one committed
    // update that links the task and rewrites its CRD JSON with the project
    // label.
    let task_json = task
        .get_required::<Json<serde_json::Value>>("json")
        .map_err(add_task_error)?;
    let payload = with_task_project_label(&task_json.0, project_id);
    let updated_at = chrono::Local::now().naive_local();
    state
        .task_store
        .set_task_project_and_json(
            task_id,
            project_id,
            user_id,
            &python_json_value(&payload),
            updated_at,
        )
        .await
        .map_err(add_task_error)?;

    // `db.refresh(task)`: the source re-reads the stored row after the
    // committed update and projects the response from it, so `project_task`
    // (including `updated_at`) reflects the persisted value rather than the
    // request-time write. The store re-reads the same physical shard the write
    // targeted; a missing row falls back to the loaded one.
    let refreshed = state
        .task_store
        .refresh_task(task_id, user_id)
        .await
        .map_err(add_task_error)?;
    let row = match refreshed {
        Some(row) => decode_task_row(&row).map_err(add_task_error)?,
        None => decode_task_row(&task).map_err(add_task_error)?,
    };
    let project_task = task_item(&row, project_id);

    let body = serde_json::to_vec(&AddTaskToProjectResponse {
        message: "Task added to project successfully".to_string(),
        project_task,
    })
    .map_err(|_| FastApiError::internal())?;
    Ok(Response::owned_bytes(StatusCode::CREATED, body).content_type("application/json"))
}

/// `add_task_to_project_endpoint`'s dependency failure: the source wraps any
/// exception as `500 {"detail": "Failed to add task to project: <error>"}`.
fn add_task_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "add task to project dependency failure");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Failed to add task to project: {error}"),
    )
}
