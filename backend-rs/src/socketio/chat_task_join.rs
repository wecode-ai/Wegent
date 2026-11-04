// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` `task:join`.
//!
//! Source: `app/api/ws/chat_namespace.py::on_task_join` with
//! `_check_token_expiry`/`_handle_token_expired`,
//! `app/services/chat/access/permissions.py::can_access_task` and
//! `get_active_streaming`, `_fetch_subtasks_for_task_join`, and the
//! `session_manager` streaming reads.
//!
//! The full-sync branch reuses the task-detail projection; the incremental
//! branch rebuilds the source's narrower dict from the same subtask/context
//! primitives. Streaming uses the shared chat storage keys.

use std::collections::HashSet;
use std::sync::Arc;

use brz_redis::Redis as _;
use brz_socket_io::{ClientError, Reply};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::internal_callback::session as chat_streaming;
use crate::state::AppState;
use crate::task_detail_api::assembly::{
    build_task_detail, extract_display_prompt, sanitize_client_payload,
};
use crate::task_detail_api::repository::{
    ContextRow, accessible_task_ids, get_accessible_task_owner, is_approved_member,
    list_subtasks_by_task,
};
use crate::task_detail_api::views::{context_brief, conversation_task_id};

use super::chat_session::ChatSession;
use super::device_lifecycle::publish_room_event;
use super::runtime::{CHAT_NAMESPACE, SocketRuntime};

/// `TASK_ROOM_PREFIX`.
const TASK_ROOM_PREFIX: &str = "task:";
/// `WEWORK_TASK_ROOM_PREFIX`.
const WEWORK_TASK_ROOM_PREFIX: &str = "wework:task:";

/// `_ACTIVE_STREAMING_SUBTASK_STATUSES` values.
const ACTIVE_STREAMING_STATUSES: [&str; 2] = ["PENDING", "RUNNING"];

/// `TaskJoinPayload`.
struct JoinPayload {
    task_id: i64,
    after_message_id: Option<i64>,
}

impl JoinPayload {
    fn parse(data: &Value) -> Result<Self, String> {
        let object = data
            .as_object()
            .ok_or_else(|| "value is not a valid dict".to_string())?;
        let task_id = object
            .get("task_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "task_id: Input should be a valid integer".to_string())?;
        let after_message_id =
            match object.get("after_message_id") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_i64().ok_or_else(|| {
                    "after_message_id: Input should be a valid integer".to_string()
                })?),
            };
        Ok(Self {
            task_id,
            after_message_id,
        })
    }
}

#[derive(Serialize)]
struct ErrorAck<'a> {
    error: &'a str,
}

fn error_ack(message: &str) -> Value {
    serde_json::to_value(ErrorAck { error: message }).expect("a string serializes")
}

/// `_handle_token_expired`'s emitted payload.
#[derive(Serialize)]
struct AuthError<'a> {
    error: &'a str,
    code: &'a str,
}

/// `task:join`'s streaming block.
#[derive(Serialize)]
struct StreamingInfo {
    subtask_id: i64,
    offset: usize,
    cached_content: String,
    blocks: Vec<Map<String, Value>>,
    started_at: Option<String>,
    last_activity_at: Option<String>,
}

#[derive(Serialize)]
struct StreamingAck {
    streaming: StreamingInfo,
    status_updated: Value,
    subtasks: Value,
}

#[derive(Serialize)]
struct IdleAck {
    streaming: Option<StreamingInfo>,
    subtasks: Value,
}

/// One active stream resolved by `get_active_streaming`.
struct ActiveStreaming {
    subtask_id: i64,
    started_at: Option<String>,
    last_activity_at: Option<String>,
}

/// `on_task_join`.
pub async fn join_task(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let payload = match JoinPayload::parse(&data) {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(Reply::payload(error_ack(&format!(
                "Invalid payload: {error}"
            ))));
        }
    };
    if session.token_expired(chrono::Utc::now().timestamp()) {
        emit_auth_error(state, runtime, socket_id).await;
        return Ok(Reply::payload(error_ack("Token expired")));
    }
    let user_id = session.user_id();
    match can_access_task(state, user_id, payload.task_id).await {
        Ok(true) => {}
        Ok(false) => {
            tracing::warn!(
                user_id,
                task_id = payload.task_id,
                "task:join access denied"
            );
            return Ok(Reply::payload(error_ack("Access denied")));
        }
        Err(error) => {
            tracing::error!(%error, user_id, task_id = payload.task_id, "task:join access read failed");
            return Err(ClientError::new("INTERNAL", "Internal server error"));
        }
    }

    let room = if session.is_wework() {
        format!("{WEWORK_TASK_ROOM_PREFIX}{}", payload.task_id)
    } else {
        format!("{TASK_ROOM_PREFIX}{}", payload.task_id)
    };
    let subtasks = fetch_subtasks(state, user_id, payload.task_id, payload.after_message_id).await;
    let streaming = match get_active_streaming(state, payload.task_id).await {
        Ok(streaming) => streaming,
        Err(error) => {
            tracing::error!(%error, user_id, task_id = payload.task_id, "task:join streaming read failed");
            return Err(ClientError::new("INTERNAL", "Internal server error"));
        }
    };

    let ack = match streaming {
        Some(active) => {
            let subtask_id = active.subtask_id;
            let cached_content = match state.redis.as_ref() {
                Some(redis) => chat_streaming::get_streaming_content(redis, subtask_id)
                    .await
                    .unwrap_or_default(),
                None => String::new(),
            };
            let blocks = match state.redis.as_ref() {
                Some(redis) => chat_streaming::get_blocks(redis, subtask_id).await,
                None => Vec::new(),
            };
            let context_metrics = match state.redis.as_ref() {
                Some(redis) => chat_streaming::get_context_metrics(redis, subtask_id).await,
                None => None,
            };
            if let Some(metrics) = context_metrics.as_ref().filter(|m| is_truthy(m)) {
                emit_status_updated(state, runtime, socket_id, metrics).await;
            }
            let offset = cached_content.chars().count();
            serde_json::to_value(StreamingAck {
                streaming: StreamingInfo {
                    subtask_id,
                    offset,
                    cached_content,
                    blocks,
                    started_at: active.started_at,
                    last_activity_at: active.last_activity_at,
                },
                status_updated: context_metrics.unwrap_or(Value::Null),
                subtasks,
            })
            .expect("a task:join acknowledgement serializes")
        }
        None => serde_json::to_value(IdleAck {
            streaming: None,
            subtasks,
        })
        .expect("a task:join acknowledgement serializes"),
    };
    Ok(Reply::payload(ack).join(room))
}

/// `can_access_task` -> `task_access_store.is_member`.
async fn can_access_task(
    state: &AppState,
    user_id: i64,
    task_id: i64,
) -> Result<bool, brz_mysql::MysqlError> {
    let Some(row) = state.task_store.get_accessible_task(task_id).await? else {
        return Ok(false);
    };
    if row.get_required::<i64>("user_id")? == user_id {
        return Ok(true);
    }
    is_approved_member(&state.mysql, task_id, user_id).await
}

/// `_handle_token_expired`: emit `auth_error` to the socket.
async fn emit_auth_error(state: &AppState, runtime: &Arc<SocketRuntime>, socket_id: &str) {
    let payload = serde_json::to_value(AuthError {
        error: "Token expired",
        code: "TOKEN_EXPIRED",
    })
    .expect("auth error serializes");
    if let Err(error) = runtime
        .emitters()
        .chat_auth_error(socket_id, &payload)
        .await
    {
        tracing::warn!(%error, "auth_error local delivery failed");
    }
    publish_room_event(state, "auth_error", &payload, CHAT_NAMESPACE, socket_id).await;
}

/// `self.emit(CHAT_STATUS_UPDATED, cached_context_metrics, to=sid)`.
async fn emit_status_updated(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    socket_id: &str,
    metrics: &Value,
) {
    if let Err(error) = runtime
        .emitters()
        .chat_status_updated(socket_id, metrics)
        .await
    {
        tracing::warn!(%error, "chat:status_updated local delivery failed");
    }
    publish_room_event(
        state,
        "chat:status_updated",
        metrics,
        CHAT_NAMESPACE,
        socket_id,
    )
    .await;
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `_fetch_subtasks_for_task_join`: `None` on a failed load, which the source
/// logs and still acknowledges.
async fn fetch_subtasks(
    state: &AppState,
    user_id: i64,
    task_id: i64,
    after_message_id: Option<i64>,
) -> Value {
    let result = match after_message_id {
        None => full_sync_subtasks(state, user_id, task_id).await,
        Some(cursor) => incremental_subtasks(state, user_id, task_id, cursor).await,
    };
    subtask_value_on_failure(result, user_id, task_id)
}

/// The source catches a failed subtask load, logs it, and still acknowledges
/// with `subtasks: null`; `on_task_join` then reads and emits streaming state
/// as usual, so a failed load never short-circuits the acknowledgement.
fn subtask_value_on_failure(result: Result<Value, String>, user_id: i64, task_id: i64) -> Value {
    match result {
        Ok(subtasks) => subtasks,
        Err(error) => {
            tracing::error!(%error, user_id, task_id, "task:join subtask load failed");
            Value::Null
        }
    }
}

/// Full sync: `task_kinds_service.get_task_detail(...).get("subtasks")`.
async fn full_sync_subtasks(state: &AppState, user_id: i64, task_id: i64) -> Result<Value, String> {
    let outcome = build_task_detail(state, task_id, user_id, None)
        .await
        .map_err(|error| error.to_string())?;
    let body = serde_json::to_value(outcome.body).map_err(|error| error.to_string())?;
    Ok(body.get("subtasks").cloned().unwrap_or(Value::Null))
}

/// Incremental sync: `resolve_for_task(after_message_id=cursor)` over the
/// current task's ordered subtasks, then the source's narrower dict shape.
async fn incremental_subtasks(
    state: &AppState,
    user_id: i64,
    task_id: i64,
    cursor: i64,
) -> Result<Value, String> {
    let owner_id = get_accessible_task_owner(&*state.task_store, task_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Task not found".to_string())?;
    let listing = list_subtasks_by_task(&*state.task_store, task_id, owner_id)
        .await
        .map_err(|error| error.to_string())?;
    let rows: Vec<_> = listing
        .subtasks
        .into_iter()
        .filter(|subtask| subtask.message_id > cursor)
        .collect();
    let contexts = listing.contexts.unwrap_or_default();
    let accessible = accessible_conversation_tasks(state, user_id, &contexts).await?;
    let mut output = Vec::with_capacity(rows.len());
    for subtask in rows {
        let subtask_contexts: Vec<&ContextRow> = contexts
            .iter()
            .filter(|context| context.subtask_contexts_subtask_id == subtask.id)
            .filter(|context| {
                conversation_task_id(context).is_none_or(|task_id| accessible.contains(&task_id))
            })
            .collect();
        let mut document = Map::new();
        document.insert("id".into(), json!(subtask.id));
        document.insert("message_id".into(), json!(subtask.message_id));
        document.insert("role".into(), Value::String(subtask.role.clone()));
        document.insert(
            "prompt".into(),
            serde_json::to_value(extract_display_prompt(subtask.prompt.as_deref()))
                .unwrap_or(Value::Null),
        );
        document.insert(
            "result".into(),
            subtask
                .result
                .as_ref()
                .map(|result| sanitize_client_payload(result.to_value()))
                .unwrap_or(Value::Null),
        );
        document.insert("status".into(), Value::String(subtask.status.clone()));
        document.insert("progress".into(), json!(subtask.progress));
        document.insert("created_at".into(), optional_isoformat(subtask.created_at));
        document.insert("updated_at".into(), optional_isoformat(subtask.updated_at));
        document.insert(
            "completed_at".into(),
            optional_isoformat(subtask.completed_at),
        );
        let briefs = subtask_contexts
            .iter()
            .map(|context| {
                let brief = context_brief(context)?;
                serde_json::to_value(brief).map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        document.insert("contexts".into(), Value::Array(briefs));
        document.insert(
            "sender".into(),
            sender_document(state, &subtask.role, subtask.sender_user_id).await?,
        );
        output.push(Value::Object(document));
    }
    Ok(Value::Array(output))
}

/// `filter_conversation_contexts_for_viewer`: the referenced conversation
/// tasks the viewer may open.
async fn accessible_conversation_tasks(
    state: &AppState,
    user_id: i64,
    contexts: &[ContextRow],
) -> Result<HashSet<i64>, String> {
    let referenced: Vec<i64> = contexts.iter().filter_map(conversation_task_id).collect();
    if referenced.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(accessible_task_ids(&state.mysql, &referenced, user_id)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect())
}

/// `db.query(User).filter(User.id == st.user_id).first()`: the sender fields
/// the incremental dict consumes.
const USER_SENDER_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name FROM users WHERE users.id = ? LIMIT 1";

/// `sender` for a USER subtask: `{user_id, user_name, avatar}`.
async fn sender_document(
    state: &AppState,
    role: &str,
    sender_user_id: Option<i64>,
) -> Result<Value, String> {
    if role != "USER" {
        return Ok(Value::Null);
    }
    let Some(user_id) = sender_user_id else {
        return Ok(Value::Null);
    };
    let row = state
        .mysql
        .fetch_optional::<_, _, brz_mysql::MysqlRow>(USER_SENDER_QUERY, (user_id,))
        .await
        .map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let name: String = row
        .get_required("users_user_name")
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "user_id": user_id,
        "user_name": name,
        // The User model has no avatar column; the source would raise on
        // `user.avatar` here, which its caller logs as a failed subtask load.
        "avatar": Value::Null,
    }))
}

fn optional_isoformat(value: Option<chrono::NaiveDateTime>) -> Value {
    match value {
        Some(value) => Value::String(
            crate::loop_tasks::item_response::isoformat(Some(value)).unwrap_or_default(),
        ),
        None => Value::Null,
    }
}

/// `get_active_streaming`.
async fn get_active_streaming(
    state: &AppState,
    task_id: i64,
) -> Result<Option<ActiveStreaming>, brz_mysql::MysqlError> {
    let Some(redis) = state.redis.as_ref() else {
        return latest_running_streaming(state, task_id).await;
    };
    let status_key = format!("chat:task_streaming:{task_id}");
    let status: Option<Value> = match redis
        .get::<_, brz_redis::RedisBytes>(status_key.as_str())
        .await
    {
        Ok(Some(bytes)) => serde_json::from_slice(bytes.as_ref()).ok(),
        Ok(None) => None,
        Err(error) => {
            tracing::error!(%error, task_id, "error getting task streaming status");
            None
        }
    };
    let Some(status) = status.filter(Value::is_object) else {
        return latest_running_streaming(state, task_id).await;
    };
    let Some(subtask_id) = status.get("subtask_id").and_then(integer_value) else {
        clear_task_streaming_status(redis, task_id).await;
        return latest_running_streaming(state, task_id).await;
    };
    if !streaming_subtask_active(state, task_id, subtask_id).await? {
        if let Err(error) =
            chat_streaming::cleanup_streaming_state(redis, subtask_id, Some(task_id)).await
        {
            tracing::warn!(%error, subtask_id, "stale streaming state cleanup failed");
        }
        return latest_running_streaming(state, task_id).await;
    }
    // The source also reads the cached streaming content on this valid-cache
    // path, only to log its length. The value is unused, but the read itself
    // is observable, so keep it before the handler's own content read.
    let _ = chat_streaming::get_streaming_content(redis, subtask_id).await;
    Ok(Some(ActiveStreaming {
        subtask_id,
        started_at: normalize_streaming_timestamp(status.get("started_at")),
        last_activity_at: normalize_streaming_timestamp(status.get("last_activity_at")),
    }))
}

/// `int(raw)` for the stored `subtask_id` (number or numeric string).
fn integer_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// `_is_streaming_subtask_active`: the cached subtask must still belong to the
/// task and be PENDING or RUNNING.
async fn streaming_subtask_active(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
) -> Result<bool, brz_mysql::MysqlError> {
    // The deployment's store owns table routing: a sharded deployment reads
    // the subtask's own shard instead of the base table
    // (`subtask_model_for_subtask_id`).
    let row = state.task_store.streaming_subtask_by_id(subtask_id).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    if row.task_id != task_id {
        return Ok(false);
    }
    Ok(ACTIVE_STREAMING_STATUSES
        .iter()
        .any(|active| row.status.eq_ignore_ascii_case(active)))
}

/// `clear_task_streaming_status`.
async fn clear_task_streaming_status<R: brz_redis::Redis>(redis: &R, task_id: i64) {
    if let Err(error) = chat_streaming::clear_task_streaming_status(redis, task_id).await {
        tracing::warn!(%error, task_id, "clear task streaming status failed");
    }
}

/// `_get_active_streaming_from_db`: latest running assistant subtask.
async fn latest_running_streaming(
    state: &AppState,
    task_id: i64,
) -> Result<Option<ActiveStreaming>, brz_mysql::MysqlError> {
    // `get_latest_running_assistant_by_task` through the deployment's store, so
    // a sharded deployment routes the task id to its own subtask shard.
    let row = state
        .task_store
        .latest_running_assistant_subtask(task_id)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(ActiveStreaming {
        subtask_id: row.id,
        started_at: row.created_at.map(database_datetime_isoformat),
        last_activity_at: None,
    }))
}

/// `_serialize_database_datetime`: naive values are session-local UTC+8.
fn database_datetime_isoformat(value: chrono::NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        format!("{base}+08:00")
    } else {
        format!(
            "{base}.{:06}+08:00",
            value.and_utc().timestamp_subsec_micros()
        )
    }
}

/// `_normalize_streaming_timestamp`: only timezone-aware strings survive, and
/// the value is rendered in UTC.
fn normalize_streaming_timestamp(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?;
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    let utc = parsed.with_timezone(&chrono::Utc);
    let base = utc.format("%Y-%m-%dT%H:%M:%S").to_string();
    Some(if utc.timestamp_subsec_nanos() == 0 {
        format!("{base}+00:00")
    } else {
        format!("{base}.{:06}+00:00", utc.timestamp_subsec_micros())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_requires_an_integer_task_id() {
        assert!(JoinPayload::parse(&json!({})).is_err());
        assert!(JoinPayload::parse(&json!({"task_id": "x"})).is_err());
        let payload = JoinPayload::parse(&json!({"task_id": 7, "after_message_id": null})).unwrap();
        assert_eq!(payload.task_id, 7);
        assert_eq!(payload.after_message_id, None);
        let cursor = JoinPayload::parse(&json!({"task_id": 7, "after_message_id": 3})).unwrap();
        assert_eq!(cursor.after_message_id, Some(3));
    }

    #[test]
    fn streaming_timestamps_require_an_offset_and_render_utc() {
        assert_eq!(
            normalize_streaming_timestamp(Some(&json!("2026-09-07T14:18:13.884704+08:00"))),
            Some("2026-09-07T06:18:13.884704+00:00".to_string())
        );
        assert_eq!(
            normalize_streaming_timestamp(Some(&json!("2026-09-07T06:18:13"))),
            None
        );
        assert_eq!(normalize_streaming_timestamp(Some(&json!(7))), None);
    }

    /// A failed full-sync load leaves `subtasks` null, and the idle
    /// acknowledgement still carries the streaming field the source reads
    /// after the load (`{streaming: null, subtasks: null}`).
    #[test]
    fn failed_subtask_load_acknowledges_null_and_keeps_streaming() {
        let subtasks =
            subtask_value_on_failure(Err("context_type: unknown enum member".to_string()), 1, 7);
        assert!(subtasks.is_null());
        let ack = serde_json::to_value(IdleAck {
            streaming: None,
            subtasks,
        })
        .unwrap();
        assert_eq!(ack, json!({"streaming": null, "subtasks": null}));
    }

    #[test]
    fn database_datetimes_render_the_session_offset() {
        let value = chrono::NaiveDateTime::parse_from_str(
            "2026-10-28T22:13:07.184896",
            "%Y-%m-%dT%H:%M:%S%.f",
        )
        .unwrap();
        assert_eq!(
            database_datetime_isoformat(value),
            "2026-10-28T22:13:07.184896+08:00"
        );
    }
}
