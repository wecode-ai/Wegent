// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/subtasks/{subtask_id}/edit`
//! (`app/api/endpoints/subtasks.py:edit_user_message`).
//!
//! Source pipeline:
//! 1. `security.get_current_user` — the JWT session plus the `users` row (the
//!    platform authenticator);
//! 2. `subtask_store.get_by_id` — the full subtask projection and its
//!    `subqueryload(Subtask.contexts)` batch read (the rows are unused, but the
//!    dependency topology includes them);
//! 3. ownership (`user_id != current user` is 404 `Message not found`) and
//!    role (`role != USER` is 400 `Only user messages can be edited`);
//! 4. `task_access_store.is_group_chat` — the accessible active-task read;
//!    a group chat is 400 `Edit not supported in group chat`;
//! 5. `subtask_store.has_running_assistant` — 400
//!    `Cannot edit while AI is generating a response`;
//! 6. the write transaction (`TaskStore::commit_message_edit`):
//!    `task_store.get_by_id_for_update` (404 `Task not found`),
//!    `get_latest_assistant_executor_from`, `delete_from_message_id` with the
//!    context cleanup, the executor label handoff, and `db.commit()`;
//! 7. `_after_commit` publishes the task-run metrics of every deleted
//!    assistant subtask;
//! 8. `MessageEditResponse`.
use std::sync::Arc;

use brz_mysql::{FromMysqlCol, Json, MysqlError, MysqlRow};
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{Value, json};

use crate::auth::SessionUser;
use crate::chat_repository::ChatHistoryRepository;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_store::{MessageEditCommit, subtask_column_index};
use brz_http_server::StatusCode;

/// `SubtaskRole.USER` — the only editable role.
const USER_ROLE: &str = "USER";
/// `SubtaskRole.ASSISTANT` — the only role whose deletion publishes metrics.
const ASSISTANT_ROLE: &str = "ASSISTANT";

/// `MessageEditRequest` (`app/schemas/subtask.py`): one required, non-empty
/// `new_content` string.
#[derive(Debug)]
struct MessageEditRequest {
    new_content: String,
}

/// `MessageEditResponse`: field order is the model's declaration order.
#[derive(Debug, Serialize)]
pub(crate) struct MessageEditResponse {
    success: bool,
    subtask_id: i64,
    message_id: i64,
    deleted_count: i64,
    new_content: String,
}

/// POST /api/subtasks/:subtask_id/edit: the endpoint free function.
#[brz_http_server::post("/api/subtasks/:subtask_id/edit")]
async fn edit_user_message(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: SessionUser,
    subtask_id: i64,
    body: Value,
) -> Result<MessageEditResponse, FastApiError> {
    // FastAPI validates the body before the endpoint runs.
    let request = parse_message_edit_request(&body)?;
    edit_user_message_inner(state, &current_user, subtask_id, request).await
}

/// Handler body for `POST /api/subtasks/{subtask_id}/edit`.
async fn edit_user_message_inner(
    state: &AppState,
    current_user: &SessionUser,
    subtask_id: i64,
    request: MessageEditRequest,
) -> Result<MessageEditResponse, FastApiError> {
    let user_id = i64::from(current_user.0.id);

    // `subtask_store.get_by_id`: the full row plus `subqueryload(contexts)`.
    let subtask = state
        .task_store
        .get_subtask(subtask_id)
        .await
        .map_err(dependency_error)?
        .ok_or_else(message_not_found)?;
    let _contexts = ChatHistoryRepository::new(&state.mysql, &*state.task_store)
        .list_contexts_by_subtask_ids(&[subtask_id])
        .await
        .map_err(dependency_error)?;

    let owner_id: i64 = subtask_column(&subtask, "user_id")?;
    if owner_id != user_id {
        return Err(message_not_found());
    }
    let role: String = subtask_column(&subtask, "role")?;
    if role != USER_ROLE {
        return Err(bad_request("Only user messages can be edited"));
    }
    let task_id: i64 = subtask_column(&subtask, "task_id")?;
    let message_id: i64 = subtask_column(&subtask, "message_id")?;

    // `task_access_store.is_group_chat`: an inaccessible task is not a group
    // chat, so only the accessible row is inspected.
    let task = state
        .task_store
        .get_accessible_task(task_id)
        .await
        .map_err(dependency_error)?;
    if is_group_chat(task.as_ref()).map_err(dependency_error)? {
        return Err(bad_request("Edit not supported in group chat"));
    }

    // `subtask_store.has_running_assistant`.
    if state
        .task_store
        .has_running_assistant(task_id)
        .await
        .map_err(dependency_error)?
    {
        return Err(bad_request("Cannot edit while AI is generating a response"));
    }

    // The source's locked transaction: executor capture, deletion, the executor
    // label handoff, then `db.commit()`. The store resolves the physical tables
    // first and the transaction runs on the application service's own pool.
    let tables = state
        .task_store
        .message_edit_tables(task_id)
        .await
        .map_err(dependency_error)?;
    let deleted_rows = match crate::task_store::commit_message_edit(
        &state.mysql,
        &tables,
        task_id,
        message_id,
        user_id,
    )
    .await
    .map_err(dependency_error)?
    {
        MessageEditCommit::TaskNotFound => {
            return Err(FastApiError::detail(
                StatusCode::NOT_FOUND,
                "Task not found",
            ));
        }
        MessageEditCommit::Deleted(rows) => rows,
    };
    let deleted_count = i64::try_from(deleted_rows.len()).unwrap_or(i64::MAX);

    publish_task_run_metrics(state, &deleted_rows).await;

    Ok(MessageEditResponse {
        success: true,
        subtask_id,
        message_id,
        deleted_count,
        new_content: request.new_content,
    })
}

/// `task_access_store.is_group_chat`: the group-chat column, then the CRD
/// `spec.is_group_chat` fallback. A missing task is not a group chat.
fn is_group_chat(task: Option<&MysqlRow>) -> brz_mysql::MysqlResult<bool> {
    let Some(task) = task else {
        return Ok(false);
    };
    if task.get_required::<i8>("is_group_chat")? != 0 {
        return Ok(true);
    }
    let task_json: Option<Json<Value>> = task.get("json")?;
    let Some(task_json) = task_json else {
        return Ok(false);
    };
    let Value::Object(task_json) = task_json.0 else {
        return Ok(false);
    };
    let Some(Value::Object(spec)) = task_json.get("spec") else {
        return Ok(false);
    };
    Ok(spec
        .get("is_group_chat")
        .is_some_and(crate::task_store::python_truthy))
}

/// `TaskRunMetricHooks._after_commit`: every deleted assistant subtask
/// publishes its current (deleted) state. The store failure is swallowed like
/// the source's listener, so a Redis error never changes the committed result.
async fn publish_task_run_metrics(state: &AppState, rows: &[MysqlRow]) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let now = chrono::Local::now().naive_local();
    let mut events = Vec::new();
    for row in rows {
        let Ok(role) = subtask_column::<String>(row, "role") else {
            continue;
        };
        if role != ASSISTANT_ROLE {
            continue;
        }
        let Ok(created_at) = subtask_column::<Option<NaiveDateTime>>(row, "created_at") else {
            continue;
        };
        let Some(created_at) = created_at else {
            continue;
        };
        let Ok(subtask_id) = subtask_column::<i64>(row, "id") else {
            continue;
        };
        let error_message = subtask_column::<Option<String>>(row, "error_message")
            .ok()
            .flatten();
        let result = subtask_column::<Option<Json<Value>>>(row, "result")
            .ok()
            .flatten()
            .map(|json| json.0);
        events.push(crate::task_run_metrics::SubtaskMetricEvent {
            subtask_id,
            created_at,
            // The source publishes a deleted subtask with `status=DELETE`.
            failed: false,
            state_changed_at: now,
            message: crate::task_run_metrics::failure_message(
                error_message.as_deref(),
                result.as_ref(),
            ),
            record_total: false,
            sync_failure: true,
        });
    }
    if events.is_empty() {
        return;
    }
    if let Err(error) = crate::task_run_metrics::record_events(redis, &events).await {
        tracing::warn!(%error, "task run metrics publish failed");
    }
}

/// Decode one column of the subtask projection positionally. The projection
/// aliases every column with the deployment's resolved physical table name,
/// which a caller cannot know, so look the column up by its mapper position.
fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> Result<T, FastApiError> {
    let index = subtask_column_index(column).ok_or_else(FastApiError::unhandled)?;
    row.get_at(index).map_err(dependency_error)
}

/// `HTTPException(404, "Message not found")`.
fn message_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Message not found")
}

/// `HTTPException(400, detail)`.
fn bad_request(detail: &str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, detail)
}

/// The source's unhandled dependency failure renders through the app's
/// `Exception` handler (`app/core/exceptions.py`).
fn dependency_error(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "subtask edit dependency failure");
    FastApiError::unhandled()
}

/// `MessageEditRequest` validation (pydantic v2): a required `new_content`
/// string with `min_length=1`.
fn parse_message_edit_request(body: &Value) -> Result<MessageEditRequest, FastApiError> {
    let Value::Object(object) = body else {
        return Err(FastApiError::validation(json!([
            {
                "type": "model_attributes_type",
                "loc": ["body"],
                "msg": "Input should be a valid dictionary or object to extract fields from",
                "input": body,
            }
        ])));
    };
    let Some(value) = object.get("new_content") else {
        return Err(FastApiError::validation(json!([
            {
                "type": "missing",
                "loc": ["body", "new_content"],
                "msg": "Field required",
                "input": body,
            }
        ])));
    };
    let Value::String(new_content) = value else {
        return Err(FastApiError::validation(json!([
            {
                "type": "string_type",
                "loc": ["body", "new_content"],
                "msg": "Input should be a valid string",
                "input": value,
            }
        ])));
    };
    if new_content.is_empty() {
        return Err(FastApiError::validation(json!([
            {
                "type": "string_too_short",
                "loc": ["body", "new_content"],
                "msg": "String should have at least 1 character",
                "input": new_content,
            }
        ])));
    }
    Ok(MessageEditRequest {
        new_content: new_content.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_new_content_is_rejected() {
        let error = parse_message_edit_request(&json!({})).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn empty_new_content_is_rejected() {
        let error = parse_message_edit_request(&json!({ "new_content": "" })).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn non_string_new_content_is_rejected() {
        let error = parse_message_edit_request(&json!({ "new_content": 1 })).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn non_object_body_is_rejected() {
        let error = parse_message_edit_request(&json!(["new_content"])).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn valid_request_keeps_the_content() {
        let request = parse_message_edit_request(&json!({ "new_content": "你好" })).unwrap();
        assert_eq!(request.new_content, "你好");
    }

    /// The edit route is registered exactly once in the public group. Before
    /// this handler the gateway answered the recorded request with FastAPI's
    /// default 404, because the route table already selected it for Rust.
    #[test]
    fn edit_message_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .filter(|path| *path == "/api/subtasks/:subtask_id/edit")
            .collect();
        assert_eq!(paths, ["/api/subtasks/:subtask_id/edit"]);
    }
}
