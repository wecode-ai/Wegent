// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` control events: `history:sync`, `chat:resume`, `skill:response`,
//! `task:close-session`.
//!
//! Sources: `app/api/ws/chat_namespace.py` (`on_history_sync`, `on_chat_resume`,
//! `on_skill_response`, `on_task_close_session`) and their services:
//! `task_fork_history_resolver.resolve_for_task`,
//! `session_manager.get_streaming_content`/`get_context_metrics`, the
//! chat_shell `PendingRequestRegistry`, and `device_service.get_device_online_info`
//! surface used by the close-session room.

use std::sync::Arc;

use brz_redis::RedisBytes;
use brz_socket_io::{ClientError, Reply};
use serde_json::{Value, json};

use crate::internal_callback::session as chat_streaming;
use crate::request_sql::{RouteKey, fetch_optional_as};
use crate::socketio::chat_session::ChatSession;
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::{CHAT_NAMESPACE, EXECUTOR_NAMESPACE, SocketRuntime};
use crate::sql_support::StatementArg;
use crate::state::AppState;
use crate::task_detail_api::assembly::extract_display_prompt;
use crate::task_detail_api::repository::{get_task_owner_for_caller, list_subtasks_by_task};

use super::chat_support::{access_denied, error_ack, internal_error};

/// `on_history_sync`.
pub(crate) async fn history_sync(
    state: &AppState,
    session: &ChatSession,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let Some(task_id) = data.get("task_id").and_then(Value::as_i64) else {
        return Ok(Reply::payload(error_ack(
            "Invalid payload: task_id: Input should be a valid integer",
        )));
    };
    let Some(after_message_id) = data.get("after_message_id").and_then(Value::as_i64) else {
        return Ok(Reply::payload(error_ack(
            "Invalid payload: after_message_id: Input should be a valid integer",
        )));
    };
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(error_ack("Not authenticated")));
    }
    if let Some(ack) = access_denied(state, session, task_id, "history:sync").await? {
        return Ok(Reply::payload(ack));
    }
    match history_messages(state, user_id, task_id, after_message_id).await {
        Ok(messages) => Ok(Reply::payload(json!({ "messages": messages }))),
        Err(error) => {
            tracing::error!(%error, task_id, "history:sync message load failed");
            Err(internal_error())
        }
    }
}

/// `_fetch_history_messages`: the current task's ordered subtasks after the
/// cursor, rendered in the source's history-message shape.
async fn history_messages(
    state: &AppState,
    user_id: i64,
    task_id: i64,
    after_message_id: i64,
) -> Result<Vec<Value>, String> {
    let owner_id = get_task_owner_for_caller(state, task_id, user_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Task {task_id} not found while resolving fork history"))?;
    let listing = list_subtasks_by_task(&*state.task_store, task_id, owner_id, true)
        .await
        .map_err(|error| error.to_string())?;
    Ok(listing
        .subtasks
        .into_iter()
        .filter(|subtask| subtask.message_id > after_message_id)
        .map(|subtask| {
            let content = if subtask.role == "USER" {
                extract_display_prompt(subtask.prompt.as_deref()).map_or(Value::Null, Value::String)
            } else {
                let content = subtask.result.as_ref().map_or_else(String::new, |result| {
                    result
                        .to_value()
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                });
                Value::String(content)
            };
            json!({
                "subtask_id": subtask.id,
                "message_id": subtask.message_id,
                "role": subtask.role,
                "content": content,
                "status": subtask.status,
                "created_at": crate::loop_tasks::item_response::isoformat(subtask.created_at),
            })
        })
        .collect())
}

/// `on_chat_resume`.
pub(crate) async fn resume(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let (Some(task_id), Some(subtask_id)) = (
        data.get("task_id").and_then(Value::as_i64),
        data.get("subtask_id").and_then(Value::as_i64),
    ) else {
        return Ok(Reply::payload(error_ack("Invalid payload")));
    };
    let offset = data.get("offset").and_then(Value::as_i64).unwrap_or(0);
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(error_ack("Not authenticated")));
    }
    if let Some(ack) = access_denied(state, session, task_id, "chat:resume").await? {
        return Ok(Reply::payload(ack));
    }
    if !subtask_belongs_to_task(state, subtask_id, task_id).await? {
        return Ok(Reply::payload(error_ack("Access denied")));
    }
    emit_cached_suffix(state, runtime, socket_id, subtask_id, offset).await;
    Ok(Reply::payload(json!({"success": true})).join(format!("task:{task_id}")))
}

/// `_subtask_belongs_to_task`.
async fn subtask_belongs_to_task(
    state: &AppState,
    subtask_id: i64,
    task_id: i64,
) -> Result<bool, ClientError> {
    // `get_basic_by_id`: the typed streaming lookup resolves the physical shard
    // and the legacy-ID migration branch, so the decoded `task_id` is the
    // authoritative owner no matter which table supplied the row.
    let row = state
        .task_store
        .streaming_subtask_by_id(subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, subtask_id, "chat:resume subtask read failed");
            internal_error()
        })?;
    Ok(row.is_some_and(|row| row.task_id == task_id))
}

/// `on_chat_resume`'s cached-content and metrics emissions.
async fn emit_cached_suffix(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    socket_id: &str,
    subtask_id: i64,
    offset: i64,
) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let cached = chat_streaming::get_streaming_content(redis, subtask_id).await;
    if let Some(cached) = cached {
        let length = cached.chars().count() as i64;
        if offset < length {
            let remaining: String = cached
                .chars()
                .skip(usize::try_from(offset.max(0)).unwrap_or(usize::MAX))
                .collect();
            let payload = json!({
                "subtask_id": subtask_id,
                "content": remaining,
                "offset": offset,
            });
            emit_to_socket(state, runtime, "chat:chunk", socket_id, &payload).await;
        }
    }
    if let Some(metrics) = chat_streaming::get_context_metrics(redis, subtask_id)
        .await
        .filter(|metrics| metrics.as_object().is_some_and(|map| !map.is_empty()))
    {
        emit_to_socket(state, runtime, "chat:status_updated", socket_id, &metrics).await;
    }
}

/// Deliver one `self.emit(..., to=sid)` frame locally and through the adapter.
pub(crate) async fn emit_to_socket(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    event: &str,
    socket_id: &str,
    payload: &Value,
) {
    let local = match event {
        "chat:chunk" => runtime.emitters().chat_chunk(socket_id, payload).await,
        "chat:status_updated" => {
            runtime
                .emitters()
                .chat_status_updated(socket_id, payload)
                .await
        }
        _ => return,
    };
    if let Err(error) = local {
        tracing::warn!(%error, event, "chat event local delivery failed");
    }
    publish_room_event(state, event, payload, CHAT_NAMESPACE, socket_id).await;
}

/// `on_skill_response`.
///
/// Builds the source's complete `{"success", "result", "error"}` document and
/// resolves the process-local pending request exactly once. A response with no
/// waiting skill keeps the source's `No pending request found` error branch;
/// the registry's success branch is reachable only for a co-located skill that
/// registered the request.
pub(crate) async fn skill_response(data: Value) -> Result<Reply<Value>, ClientError> {
    let request_id = data
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let Some(request_id) = request_id else {
        return Ok(Reply::payload(error_ack("Missing request_id")));
    };
    let skill_name = data.get("skill_name").and_then(Value::as_str).unwrap_or("");
    let action = data.get("action").and_then(Value::as_str).unwrap_or("");
    tracing::info!(request_id, skill_name, action, "skill:response received");
    let complete_result = json!({
        "success": data.get("success").and_then(Value::as_bool).unwrap_or(false),
        "result": data.get("result").cloned().unwrap_or(Value::Null),
        "error": data.get("error").cloned().unwrap_or(Value::Null),
    });
    if crate::socketio::skill_registry::resolve(request_id, complete_result) {
        tracing::info!(request_id, "skill:response resolved request");
        Ok(Reply::payload(json!({"success": true})))
    } else {
        tracing::warn!(request_id, "skill:response could not resolve request");
        Ok(Reply::payload(error_ack("No pending request found")))
    }
}

/// `on_task_close_session`.
pub(crate) async fn close_session(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    if let Some(pending) = super::chat_support::expired(session, state, runtime, socket_id) {
        return Ok(Reply::payload(pending.await));
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(error_ack("Not authenticated")));
    }
    let Some(task_id) = data
        .get("task_id")
        .and_then(Value::as_i64)
        .filter(|task_id| *task_id != 0)
    else {
        return Ok(Reply::payload(error_ack("Missing task_id")));
    };
    let device = match device_info_for_close_session(state, task_id, user_id).await? {
        Ok(device) => device,
        Err(ack) => return Ok(Reply::payload(ack)),
    };
    let room = format!("device:{}:{}", device.owner_user_id, device.device_id);
    let payload = json!({ "task_id": task_id });
    if let Err(error) = runtime.emitters().task_close_session(&room, &payload).await {
        tracing::warn!(%error, task_id, "task:close-session local delivery failed");
    }
    publish_room_event(
        state,
        "task:close-session",
        &payload,
        EXECUTOR_NAMESPACE,
        &room,
    )
    .await;
    tracing::info!(task_id, room, "task:close-session delivered");
    Ok(Reply::payload(json!({"success": true})))
}

/// The device a close-session request addresses.
struct CloseSessionDevice {
    device_id: String,
    owner_user_id: i64,
}

/// `_get_device_info_for_close_session`.
async fn device_info_for_close_session(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<Result<CloseSessionDevice, Value>, ClientError> {
    let task = state
        .task_store
        .get_regular_active_task(task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "task:close-session task read failed");
            internal_error()
        })?;
    let Some(task) = task else {
        return Ok(Err(error_ack("Task not found")));
    };
    let owner_user_id = task
        .get::<i32>("user_id")
        .map_err(|error| {
            tracing::error!(%error, task_id, "task:close-session owner decode failed");
            internal_error()
        })?
        .map(i64::from)
        .ok_or_else(internal_error)?;
    let is_owner = owner_user_id == user_id;
    let is_member = if is_owner {
        true
    } else {
        crate::task_detail_api::repository::is_approved_member(&state.mysql, task_id, user_id)
            .await
            .map_err(|error| {
                tracing::error!(%error, task_id, "task:close-session membership read failed");
                internal_error()
            })?
    };
    if !is_member {
        return Ok(Err(error_ack("Access denied")));
    }
    let Some(executor_name) = latest_device_executor(state, task_id, owner_user_id).await? else {
        return Ok(Err(error_ack("No device executor found for this task")));
    };
    let Some(device_id) = executor_name.strip_prefix("device-") else {
        return Ok(Err(error_ack("No device executor found for this task")));
    };
    Ok(Ok(CloseSessionDevice {
        device_id: device_id.to_string(),
        owner_user_id,
    }))
}

/// `subtask_store.get_latest_device_executor_for_task`: the newest subtask of
/// the task whose `executor_name` carries the `device-` prefix.
async fn latest_device_executor(
    state: &AppState,
    task_id: i64,
    owner_user_id: i64,
) -> Result<Option<String>, ClientError> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        #[mysql(rename = "executor_name")]
        executor_name: Option<String>,
    }
    let tables = state
        .task_store
        .message_edit_tables(task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "task:close-session table lookup failed");
            internal_error()
        })?;
    let statement = format!(
        "SELECT subtasks.executor_name AS executor_name \nFROM `{}` AS subtasks \n\
         WHERE subtasks.task_id = ? AND subtasks.user_id = ? \
         AND subtasks.executor_name LIKE 'device-%' \n\
         ORDER BY subtasks.id DESC \n LIMIT 1",
        tables.subtasks
    );
    let mut handle = &state.mysql;
    let row: Option<Row> = fetch_optional_as(
        &mut handle,
        RouteKey::None,
        &statement,
        vec![StatementArg::Int(task_id), StatementArg::Int(owner_user_id)],
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, task_id, "task:close-session executor read failed");
        internal_error()
    })?;
    Ok(row.and_then(|row| row.executor_name))
}

/// `session_manager.get_task_streaming_status`'s raw document (`is_stream_alive`).
pub(crate) async fn task_streaming_status<R: brz_redis::Redis>(
    redis: &R,
    task_id: i64,
) -> Option<Value> {
    let key = format!("chat:task_streaming:{task_id}");
    let bytes = redis
        .get::<_, RedisBytes>(key.as_str())
        .await
        .ok()
        .flatten()?;
    serde_json::from_slice(bytes.as_ref()).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn history_messages_render_the_source_shape() {
        // The source renders `created_at` with `isoformat()` and keeps a null
        // prompt as JSON null.
        let value = crate::loop_tasks::item_response::isoformat(
            chrono::NaiveDate::from_ymd_opt(2026, 11, 9)
                .unwrap()
                .and_hms_opt(12, 31, 59),
        );
        assert_eq!(value.as_deref(), Some("2026-11-09T12:31:59"));
    }
}
