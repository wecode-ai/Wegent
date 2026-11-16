// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` `runtime.tasks.accept` and `runtime.tasks.updated`.
//!
//! Sources: `app/api/ws/device_namespace.py::on_runtime_tasks_accept` /
//! `on_runtime_task_updated`,
//! `app/services/loop_item_executions/device_pull.py::acknowledge_execution`,
//! and `app/services/project_chat/service.py`'s runtime projection.
//!
//! `runtime.tasks.accept` verifies the execution's Runtime identity and then
//! records acceptance or rejection. `runtime.tasks.updated` skips non-terminal
//! watcher updates and projects a terminal update into the project chat before
//! the (unported) IM notification fan-out.

use std::sync::Arc;

use brz_mysql::MysqlTransaction as _;
use brz_socket_io::ClientError;
use serde_json::{Value, json};

use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::device_runtime_event::{
    PROJECT_CHAT_CREATED_EVENT, RUNTIME_NAMESPACE, project_chat_room,
};
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::runtime_projection::{self, RuntimeIdentity};
use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

use super::chat_support::internal_error;

/// `RUNTIME_TASK_TERMINAL_STATUSES`, normalized.
const TERMINAL_STATUSES: [&str; 9] = [
    "done",
    "complete",
    "completed",
    "success",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
];
/// `RUNTIME_TASK_NON_REPLY_TERMINAL_STATUSES`, normalized.
const NON_REPLY_TERMINAL_STATUSES: [&str; 4] = ["failed", "error", "cancelled", "canceled"];
/// Statuses that already acknowledged a claimed acceptance.
const ACCEPTED_STATUSES: [&str; 5] = [
    "running",
    "cancel_requested",
    "completed",
    "failed",
    "cancelled",
];

/// `on_runtime_tasks_accept`.
pub(crate) async fn accept(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    let user_id = snapshot.user_id;
    let device_id = snapshot
        .device
        .device_id
        .clone()
        .or_else(|| snapshot.device.reported_device_id.clone())
        .unwrap_or_default();
    let runtime_instance_id = snapshot
        .device
        .runtime_instance_id
        .clone()
        .unwrap_or_default();
    if user_id == 0 || device_id.is_empty() || runtime_instance_id.is_empty() {
        return Ok(status_error("Device is not registered"));
    }
    let Some(payload) = data.as_object() else {
        return Ok(status_error("Invalid acceptance payload"));
    };
    let Some(execution_id) = payload.get("execution_id").and_then(python_int) else {
        return Ok(status_error("execution_id is required"));
    };
    let Some(runtime_task_id) = payload
        .get("runtime_task_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(status_error("runtime_task_id is required"));
    };
    let accepted = payload.get("accepted").is_some_and(python_truthy);
    let error = payload.get("error").and_then(Value::as_str);

    let Some(row) = execution_identity(state, execution_id).await? else {
        return Ok(identity_mismatch());
    };
    if row.executor_owner_user_id != user_id
        || row.runtime_device_id != device_id
        || row.runtime_instance_id != runtime_instance_id
        || row.runtime_task_id != runtime_task_id
    {
        return Ok(identity_mismatch());
    }
    if accepted {
        if row.status != "claimed" {
            return Ok(json!({"success": ACCEPTED_STATUSES.contains(&row.status.as_str())}));
        }
        return accept_claimed(state, runtime, &row).await;
    }
    reject_claimed(state, &row, error).await
}

/// One `loop_item_executions` identity row.
struct ExecutionRow {
    id: i64,
    executor_owner_user_id: i64,
    runtime_device_id: String,
    runtime_instance_id: String,
    runtime_task_id: String,
    status: String,
    version: i64,
}

/// `db.get(LoopItemExecution, execution_id)`.
async fn execution_identity(
    state: &AppState,
    execution_id: i64,
) -> Result<Option<ExecutionRow>, ClientError> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        id: i64,
        executor_owner_user_id: i64,
        runtime_device_id: String,
        runtime_instance_id: String,
        runtime_task_id: String,
        status: String,
        version: i64,
    }
    let row: Option<Row> = state
        .mysql
        .fetch_optional(
            "SELECT id, executor_owner_user_id, runtime_device_id, runtime_instance_id, \
             runtime_task_id, status, version FROM loop_item_executions WHERE id = ?",
            (execution_id,),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, execution_id, "runtime.tasks.accept identity read failed");
            internal_error()
        })?;
    Ok(row.map(|row| ExecutionRow {
        id: row.id,
        executor_owner_user_id: row.executor_owner_user_id,
        runtime_device_id: row.runtime_device_id,
        runtime_instance_id: row.runtime_instance_id,
        runtime_task_id: row.runtime_task_id,
        status: row.status,
        version: row.version,
    }))
}

/// Record Runtime acceptance. The first running event promotes the execution
/// to running. The pending project-chat activity is committed with the ACK.
async fn accept_claimed(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    row: &ExecutionRow,
) -> Result<Value, ClientError> {
    let now = chrono::Utc::now().naive_utc();
    let expires_at =
        now + chrono::Duration::seconds(super::execution_aggregate::DEFAULT_LEASE_SECONDS);
    let (accepted, activity) = state
        .mysql
        .with_transaction(async |transaction| {
            let updated = transaction
                .execute(
                    "UPDATE loop_item_executions SET \
                     start_requested_at=CASE WHEN start_requested_at IS NULL \
                         OR start_requested_at <= '1970-01-01 00:00:01' THEN ? ELSE start_requested_at END, \
                     observed_state='accepted', sync_state='in_sync', error_message='', termination_reason='', \
                     observed_at=?, heartbeat_at=?, lease_expires_at=?, version=version+1, updated_at=? \
                     WHERE id=? AND status='claimed' AND version=?",
                    (now, now, now, expires_at, now, row.id, row.version),
                )
                .await?;
            if updated.rows_affected != 1 {
                return Ok((false, None));
            }
            let activity = runtime_projection::open_accepted_activity(transaction, row.id, false).await?;
            Ok((true, activity))
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, execution_id = row.id, "runtime task accept failed");
            internal_error()
        })?;
    if let Some(activity) = activity {
        emit_project_message(state, runtime, &activity).await;
    }
    Ok(json!({"success": accepted}))
}

/// `loop_item_execution_service.fail(requeue=False)` for an Executor rejection.
async fn reject_claimed(
    state: &AppState,
    row: &ExecutionRow,
    error: Option<&str>,
) -> Result<Value, ClientError> {
    let message = error
        .filter(|value| !value.is_empty())
        .unwrap_or("Executor rejected runtime task creation");
    let now = utc_now();
    let executed = state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .execute(
                    "UPDATE loop_item_executions SET status='failed', error_message=?, \
                     execution_note='runtime_start_rejected', \
                     termination_reason='runtime_start_rejected', completed_at=?, version=?, \
                     updated_at=? WHERE id = ? AND version = ?",
                    (
                        message.to_string(),
                        now.clone(),
                        row.version + 1,
                        now.clone(),
                        row.id,
                        row.version,
                    ),
                )
                .await
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, execution_id = row.id, "runtime task rejection failed");
            internal_error()
        })?;
    Ok(json!({"success": executed.rows_affected > 0}))
}

/// `on_runtime_task_updated`.
pub(crate) async fn updated(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    data: &Value,
) -> Result<Value, ClientError> {
    let user_id = snapshot.user_id;
    let device_id = snapshot
        .device
        .device_id
        .clone()
        .or_else(|| snapshot.device.reported_device_id.clone())
        .unwrap_or_default();
    if user_id == 0 {
        return Ok(json!({"error": "Device not authenticated"}));
    }
    let local_task_id = ["localTaskId", "local_task_id"]
        .into_iter()
        .filter_map(|key| data.get(key).and_then(Value::as_str))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    if device_id.is_empty() || local_task_id.is_empty() {
        return Ok(json!({"error": "Invalid runtime task update payload"}));
    }
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("updated");
    let normalized = normalize_status(status);
    if !TERMINAL_STATUSES.contains(&normalized.as_str()) {
        tracing::info!(
            user_id,
            device_id,
            local_task_id,
            status,
            "runtime task update skipped as non-terminal"
        );
        return Ok(json!({"success": true, "notified": 0, "skipped": "non_terminal"}));
    }
    let content = data.get("content").and_then(Value::as_str).unwrap_or("");
    let event_name = if NON_REPLY_TERMINAL_STATUSES.contains(&normalized.as_str()) {
        "runtime.task.failed"
    } else {
        "runtime.task.completed"
    };
    project_terminal_update(
        state,
        runtime,
        user_id,
        &device_id,
        &local_task_id,
        status,
        content,
        event_name,
    )
    .await;
    // `im_notification_dispatcher.send_runtime_task_update_for_user` has no
    // Rust port yet; the durable project-chat projection above is preserved.
    Ok(json!({"success": true, "notified": 0}))
}

/// `_project_chat_runtime_event_sync` + the project-chat emit for a terminal
/// watcher update.
#[allow(clippy::too_many_arguments)]
async fn project_terminal_update(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    user_id: i64,
    device_id: &str,
    local_task_id: &str,
    status: &str,
    content: &str,
    event_name: &str,
) {
    let envelope = json!({
        "event": event_name,
        "payload": {
            "taskId": local_task_id,
            "localTaskId": local_task_id,
            "deviceId": device_id,
            "device_id": device_id,
            "status": status,
            "data": {"status": status, "value": content},
        },
    });
    let Some(identity) = RuntimeIdentity::parse(&envelope) else {
        return;
    };
    match runtime_projection::project(state, runtime, user_id, device_id, &identity).await {
        Ok(Some(projected)) => emit_project_message(state, runtime, &projected.message).await,
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, device_id, "runtime task terminal projection failed");
        }
    }
}

/// `emit(PROJECT_CHAT_CREATED_EVENT, message, room=project_chat_room(...))`.
async fn emit_project_message(state: &AppState, runtime: &Arc<SocketRuntime>, message: &Value) {
    let project_id = message
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let task_id = message.get("taskId").and_then(Value::as_str);
    let room = project_chat_room(project_id, task_id);
    if let Err(error) = runtime
        .emitters()
        .project_chat_message(&room, false, message)
        .await
    {
        tracing::warn!(%error, room, "project chat terminal local delivery failed");
    }
    publish_room_event(
        state,
        PROJECT_CHAT_CREATED_EVENT,
        message,
        RUNTIME_NAMESPACE,
        &room,
    )
    .await;
}

/// `_normalize_runtime_task_status`.
fn normalize_status(status: &str) -> String {
    status.trim().replace(['_', '-'], "").to_lowercase()
}

/// Python `int(value)` for the acceptance id.
fn python_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.trunc() as i64)),
        Value::String(text) => text.trim().parse().ok(),
        Value::Bool(value) => Some(i64::from(*value)),
        _ => None,
    }
}

/// Python truthiness for the acceptance flag.
fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn status_error(message: &str) -> Value {
    json!({"success": false, "error": message})
}

fn identity_mismatch() -> Value {
    status_error("Execution identity mismatch")
}

/// `datetime.now(timezone.utc).replace(tzinfo=None)` at second precision.
fn utc_now() -> String {
    chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}
