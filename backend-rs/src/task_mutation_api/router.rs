// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Routes for the task mutation endpoints
//! (`app/api/endpoints/adapter/tasks.py`).

use brz_http_server::StatusCode;

use super::delete_task;
use super::models::{
    TaskArchiveBatchResponse, TaskBulkDeleteRequest, TaskDeleted, TaskInDbResponse, TaskUpdateBody,
};
use super::update_task;
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `DELETE /api/tasks/bulk`: soft delete up to 50 owned tasks.
#[brz_http_server::delete("/api/tasks/bulk")]
async fn bulk_delete_tasks_route(
    #[inject(state)] state: &AppState,
    body: TaskBulkDeleteRequest,
    client_origin: Option<String>,
    #[auth] current_user: SessionUser,
) -> Result<TaskArchiveBatchResponse, FastApiError> {
    let origin = validated_origin(client_origin.as_deref())?;
    body.validate()
        .map_err(|detail| FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, detail))?;
    let count =
        delete_task::bulk_delete_tasks(state, i64::from(current_user.id), &body.task_ids, &origin)
            .await?;
    Ok(TaskArchiveBatchResponse {
        message: "Tasks deleted successfully",
        count,
    })
}

/// `DELETE /api/tasks/{task_id}`: delete one owned or archived task.
#[brz_http_server::delete("/api/tasks/:task_id")]
async fn delete_task_route(
    #[inject(state)] state: &AppState,
    task_id: i64,
    client_origin: Option<String>,
    #[auth] current_user: SessionUser,
) -> Result<TaskDeleted, FastApiError> {
    let origin = validated_origin(client_origin.as_deref())?;
    delete_task::delete_task(state, i64::from(current_user.id), task_id, &origin).await?;
    Ok(TaskDeleted::new())
}

/// `PUT /api/tasks/{task_id}`: update an owned active task.
#[brz_http_server::put("/api/tasks/:task_id")]
async fn update_task_route(
    #[inject(state)] state: &AppState,
    task_id: i64,
    body: TaskUpdateBody,
    client_origin: Option<String>,
    #[auth] current_user: SessionUser,
) -> Result<TaskInDbResponse, FastApiError> {
    let origin = validated_origin(client_origin.as_deref())?;
    update_task::update_task(state, i64::from(current_user.id), task_id, &origin, &body).await
}

/// `ClientOriginQuery`: `^(frontend|wework)$`, defaulting to `frontend`.
fn validated_origin(client_origin: Option<&str>) -> Result<String, FastApiError> {
    match client_origin {
        None | Some("frontend") => Ok("frontend".to_owned()),
        Some("wework") => Ok("wework".to_owned()),
        Some(_) => Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Request parameter validation failed",
        )),
    }
}
