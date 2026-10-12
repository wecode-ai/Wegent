// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task delete: `DELETE /api/tasks/{task_id}` and `DELETE /api/tasks/bulk`.
//!
//! Mirrors `TaskKindsService.delete_task` /
//! `bulk_delete_tasks`
//! (`app/services/adapters/task_kinds/operations.py`): resolve the active or
//! archived task, fall back to the group-chat member-leave path, clean up the
//! executor/sandbox runtime, close device sessions, mark the subtasks
//! `DELETE`, and soft-delete the task.

use brz_http_server::StatusCode;
use brz_mysql::FromMysqlRow;
use serde_json::Value;

use crate::json_compat::python_json_value;
use tracing::{info, warn};

use super::socketio;
use crate::executor_manager::SandboxLookup;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_store::task_update_timestamp;

/// `_handle_member_leave`'s approved-member probe.
const APPROVED_MEMBER_QUERY: &str = "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
     WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? \
     AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
     AND resource_members.status = 'approved' \n LIMIT 1";

/// `_handle_member_leave`'s membership rejection.
const REJECT_MEMBER_QUERY: &str = "UPDATE resource_members SET status='rejected', reviewed_at=? \
     WHERE resource_members.id = ?";

/// The task fields the delete path reads from its first row.
struct TaskRow {
    user_id: i64,
    json: Value,
}

fn decode_task_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<TaskRow> {
    Ok(TaskRow {
        user_id: row.get_required("user_id")?,
        json: row.get_required::<brz_mysql::Json<Value>>("json")?.0,
    })
}

/// The subtask executor fields the cleanup targets are derived from.
pub(super) struct SubtaskExecutorRow {
    pub(super) executor_namespace: Option<String>,
    pub(super) executor_name: Option<String>,
    pub(super) executor_deleted_at: i8,
}

fn decode_subtask_executor(
    row: &brz_mysql::MysqlRow,
) -> brz_mysql::MysqlResult<SubtaskExecutorRow> {
    Ok(SubtaskExecutorRow {
        executor_namespace: row.get("executor_namespace")?,
        executor_name: row.get("executor_name")?,
        executor_deleted_at: row.get::<i8>("executor_deleted_at")?.unwrap_or(0),
    })
}

/// `task_kinds_service.delete_task` at the route's boundaries.
pub(crate) async fn delete_task(
    state: &AppState,
    user_id: i64,
    task_id: i64,
    client_origin: &str,
) -> Result<(), FastApiError> {
    let origin = Some(client_origin);
    let task = match state
        .task_store
        .get_active_or_archived_task(task_id, origin)
        .await
        .map_err(|error| internal(&error))?
    {
        Some(row) => decode_task_row(&row).map_err(|error| internal(&error))?,
        None => {
            // No active/archived row: the source falls through to the
            // member-leave path, which either rejects membership (200 no-op)
            // or raises 404.
            return handle_member_leave(state, task_id, user_id, origin).await;
        }
    };

    if task.user_id != user_id {
        return handle_member_leave(state, task_id, user_id, origin).await;
    }

    cleanup_executor_runtime(state, task_id, user_id, task.user_id).await?;

    let updated_at = task_update_timestamp();
    state
        .task_store
        .mark_task_subtasks_deleted(task_id, task.user_id, &updated_at)
        .await
        .map_err(|error| internal(&error))?;

    let payload = mark_task_deleted_payload(&task.json);
    state
        .task_store
        .soft_delete_task(task_id, task.user_id, &payload, &updated_at)
        .await
        .map_err(|error| internal(&error))?;

    // `db.commit()`: one commit at the end of `delete_task`.
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| internal(&error))?;
    Ok(())
}

/// `bulk_delete_tasks`: delete every id, swallowing per-id failures.
pub(crate) async fn bulk_delete_tasks(
    state: &AppState,
    user_id: i64,
    task_ids: &[i64],
    client_origin: &str,
) -> Result<i64, FastApiError> {
    let mut count = 0i64;
    for &task_id in task_ids {
        match delete_task(state, user_id, task_id, client_origin).await {
            Ok(()) => count += 1,
            Err(error) => {
                warn!(%task_id, ?error, "bulk_delete_tasks: failed to delete task");
                // The source rolls back the failed iteration and continues.
                let _ = state.mysql.execute("ROLLBACK", ()).await;
            }
        }
    }
    Ok(count)
}

/// `_handle_member_leave`: an approved member leaving a group chat is
/// rejected; anyone else gets the source 404.
async fn handle_member_leave(
    state: &AppState,
    task_id: i64,
    user_id: i64,
    client_origin: Option<&str>,
) -> Result<(), FastApiError> {
    if state
        .task_store
        .get_active_task_for_origin(task_id, client_origin)
        .await
        .map_err(|error| internal(&error))?
        .is_none()
    {
        return Err(not_found());
    }

    let member: Option<MemberId> = state
        .mysql
        .fetch_optional(APPROVED_MEMBER_QUERY, (task_id, user_id.to_string()))
        .await
        .map_err(|error| internal(&error))?;
    let Some(member) = member else {
        return Err(not_found());
    };

    let reviewed_at = task_update_timestamp();
    state
        .mysql
        .execute(
            REJECT_MEMBER_QUERY,
            (reviewed_at, member.resource_members_id),
        )
        .await
        .map_err(|error| internal(&error))?;
    // `_handle_member_leave` commits its own change.
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| internal(&error))?;
    // Returning without deleting still yields the route's 200 body.
    Ok(())
}

#[derive(FromMysqlRow)]
struct MemberId {
    resource_members_id: i64,
}

/// The source's cleanup targets: `unique_executor_keys` and `device_ids`, both
/// collected into `set`s, so a subtask that repeats an executor contributes one
/// target. Order follows first appearance.
pub(super) fn collect_cleanup_targets(
    subtasks: Vec<SubtaskExecutorRow>,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut executor_keys: Vec<(String, String)> = Vec::new();
    let mut device_ids: Vec<String> = Vec::new();
    for subtask in subtasks {
        let Some(name) = subtask.executor_name.filter(|name| !name.is_empty()) else {
            continue;
        };
        if subtask.executor_deleted_at != 0 {
            continue;
        }
        if let Some(device_id) = name.strip_prefix("device-") {
            if !device_ids.iter().any(|existing| existing == device_id) {
                device_ids.push(device_id.to_owned());
            }
        } else {
            let key = (subtask.executor_namespace.unwrap_or_default(), name);
            if !executor_keys.iter().any(|existing| existing == &key) {
                executor_keys.push(key);
            }
        }
    }
    (executor_keys, device_ids)
}

/// The runtime cleanup the delete performs before the database writes:
/// sandbox lookup, sandbox/executor deletion, and device session close.
async fn cleanup_executor_runtime(
    state: &AppState,
    task_id: i64,
    requesting_user_id: i64,
    owner_user_id: i64,
) -> Result<(), FastApiError> {
    let rows = state
        .task_store
        .list_subtasks_by_task_unfiltered(task_id, owner_user_id)
        .await
        .map_err(|error| internal(&error))?;

    let mut decoded = Vec::with_capacity(rows.len());
    for row in &rows {
        decoded.push(decode_subtask_executor(row).map_err(|error| internal(&error))?);
    }
    let (executor_keys, device_ids) = collect_cleanup_targets(decoded);

    let sandbox_id = task_id.to_string();
    let cleanup_mode = match state.executor_manager.get_sandbox(&sandbox_id).await {
        SandboxLookup::Found => "sandbox",
        SandboxLookup::NotFound => "executor",
        SandboxLookup::Failed => "fallback",
    };

    if cleanup_mode == "sandbox" || cleanup_mode == "fallback" {
        let (deleted, error) = state.executor_manager.delete_sandbox(&sandbox_id).await;
        if deleted {
            info!(%task_id, "[delete_task] sandbox runtime cleanup succeeded");
        } else {
            info!(%task_id, ?error, "[delete_task] sandbox runtime cleanup skipped");
        }
    }

    if cleanup_mode == "executor" || cleanup_mode == "fallback" {
        let mut executor_cleanup_succeeded = false;
        for (namespace, name) in &executor_keys {
            match state
                .executor_manager
                .delete_executor_task(name, namespace)
                .await
            {
                Ok(()) => executor_cleanup_succeeded = true,
                Err(error) => {
                    warn!(%task_id, namespace, name, %error, "[delete_task] executor delete failed");
                }
            }
        }
        if !executor_cleanup_succeeded && device_ids.is_empty() {
            let _ = state
                .executor_manager
                .cleanup_sandbox_by_task(task_id)
                .await;
        }
    }

    if let Some(redis) = state.redis.as_ref() {
        for device_id in &device_ids {
            if let Err(error) =
                socketio::publish_close_session(redis, requesting_user_id, device_id, task_id).await
            {
                warn!(%task_id, device_id, %error, "[delete_task] close-session publish failed");
            }
        }
    }
    Ok(())
}

/// `mark_task_deleted_payload` (`app/services/task_status.py`): deep copy the
/// task JSON, set `status.status = "DELETE"` and
/// `status.updatedAt = datetime.now().isoformat()`.
pub(super) fn mark_task_deleted_payload(task_json: &Value) -> String {
    let mut payload = task_json.clone();
    if !payload.is_object() {
        payload = Value::Object(Default::default());
    }
    if !payload.get("status").is_some_and(Value::is_object)
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("status".to_owned(), Value::Object(Default::default()));
    }
    if let Some(status) = payload.get_mut("status").and_then(Value::as_object_mut) {
        status.insert("status".to_owned(), Value::String("DELETE".to_owned()));
        status.insert("updatedAt".to_owned(), Value::String(now_isoformat()));
    }
    python_json_value(&payload)
}

/// `datetime.now().isoformat()` (naive local time, microsecond precision).
fn now_isoformat() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

fn not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Task not found")
}

fn internal(error: &impl std::fmt::Display) -> FastApiError {
    warn!(%error, "[delete_task] database error");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
