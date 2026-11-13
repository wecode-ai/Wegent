// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` `chat:cancel` and `chat:guide`.
//!
//! Sources: `app/api/ws/chat_namespace.py::on_chat_cancel` /
//! `on_chat_guide`, `app/services/chat/operations/cancel.py` (`is_stream_alive`,
//! `finalize_stuck_cancellation`), `app/services/execution/dispatcher.py::cancel`,
//! and `app/services/chat/guidance_queue.py`.
//!
//! `chat:cancel`'s device branch (`executor_name` = `device-<id>`) emits
//! `task:cancel` to the device room; the Chat-shell branch sets the Redis
//! cancellation flag. Other shells send the cancellation to executor-manager.
//!

use std::sync::Arc;

use brz_json::OpaqueJson;
use brz_mysql::{Json, MysqlTransaction as _};
use brz_socket_io::{ClientError, Reply};
use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value, json};

use crate::json_compat::python_json_value;
use crate::socketio::chat_session::ChatSession;
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::{EXECUTOR_NAMESPACE, SocketRuntime};
use crate::state::AppState;
use crate::task_store::task_update_timestamp;

use super::chat_support::{access_denied, error_ack, expired, internal_error};

/// `CANCEL_KEY_PREFIX`.
pub(crate) fn cancel_key(subtask_id: i64) -> String {
    format!("chat:cancel:{subtask_id}")
}
/// `CANCEL_FLAG_TTL`.
const CANCEL_FLAG_TTL: u64 = 300;
/// `settings.CANCELLING_STUCK_TIMEOUT_SECONDS`.
const CANCELLING_STUCK_TIMEOUT_SECONDS: i64 = 1800;
/// `DEFAULT_GUIDANCE_QUEUE_TTL_SECONDS`.
const GUIDANCE_QUEUE_TTL_SECONDS: u64 = 60 * 60 * 24;
/// `_TASK_FINAL_STATES`.
const TASK_FINAL_STATES: [&str; 4] = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"];

/// `on_chat_cancel`.
pub(crate) async fn cancel(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let Some(subtask_id) = data.get("subtask_id").and_then(python_integer) else {
        return Ok(Reply::payload(error_ack(
            "Invalid payload: subtask_id: Input should be a valid integer",
        )));
    };
    if let Some(pending) = expired(session, state, runtime, socket_id) {
        return Ok(Reply::payload(pending.await));
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(error_ack("Not authenticated")));
    }
    let info = match subtask_for_cancel(state, subtask_id).await? {
        Some(info) => info,
        None => return Ok(Reply::payload(error_ack("Subtask not found"))),
    };
    if !matches!(info.status.as_str(), "PENDING" | "RUNNING") {
        return Ok(Reply::payload(error_ack(&format!(
            "Cannot cancel subtask in {} state",
            info.status
        ))));
    }
    let device_id = info
        .executor_name
        .as_deref()
        .and_then(|name| name.strip_prefix("device-"));
    let shell_type = data
        .get("shell_type")
        .and_then(Value::as_str)
        .unwrap_or("Chat");
    if device_id.is_none()
        && shell_type != "Chat"
        && let Some(ack) = access_denied(state, session, info.task_id, "chat:cancel").await?
    {
        return Ok(Reply::payload(ack));
    }
    mark_cancelling(state, info.task_id).await?;
    let delivered = deliver_cancel(
        state, runtime, user_id, &info, subtask_id, device_id, shell_type,
    )
    .await?;
    if !stream_alive(state, info.task_id, subtask_id).await {
        let finalized = finalize_stuck_cancellation(state, info.task_id).await?;
        if let Some(finalized) = finalized {
            if let Some(redis) = state.redis.as_ref() {
                use crate::internal_callback::completion::{
                    Completion, publish_task_completed_for_owner,
                };
                let ctx = Completion {
                    app: Some(state),
                    mysql: &state.mysql,
                    redis,
                    tables: crate::internal_callback::tables(state),
                    executor_manager: &state.executor_manager,
                };
                for &subtask_id in &finalized {
                    publish_task_completed_for_owner(
                        &ctx,
                        info.task_id,
                        subtask_id,
                        user_id,
                        "CANCELLED",
                        None,
                        None,
                    )
                    .await;
                    // A runtime that never received the turn cannot send a terminal callback.
                    use crate::internal_callback::{
                        emitter,
                        event::{EventType, ExecutionEvent},
                        session,
                    };
                    let event = ExecutionEvent::new(EventType::Cancelled, info.task_id, subtask_id);
                    if let Err(error) =
                        session::publish_callback_event(redis, subtask_id, &event).await
                    {
                        tracing::warn!(subtask_id, %error, "local cancellation callback failed");
                    }
                    if let Err(error) = emitter::emit_terminal_frames(
                        redis,
                        &event,
                        Some(user_id),
                        &Value::Null,
                        None,
                    )
                    .await
                    {
                        tracing::warn!(subtask_id, %error, "local cancellation notification failed");
                    }
                }
            }
            tracing::info!(
                task_id = info.task_id,
                subtask_id,
                ?finalized,
                "chat:cancel finalized locally (stream runtime gone)"
            );
            return Ok(Reply::payload(json!({"success": true, "finalized": true})));
        }
    }
    if !delivered {
        tracing::error!(
            subtask_id,
            "chat:cancel Runtime did not acknowledge cancellation"
        );
        return Ok(Reply::payload(error_ack(
            "Runtime did not acknowledge cancellation",
        )));
    }
    Ok(Reply::payload(json!({"success": true})))
}

/// One subtask's cancel-relevant fields (`_get_subtask_for_cancel`).
struct CancelInfo {
    task_id: i64,
    status: String,
    executor_name: Option<String>,
}

/// `_get_subtask_for_cancel`.
///
/// `subtask_store.get_by_id` shares the sharded full-row lookup with
/// `get_basic_by_id`, including the legacy-id migration probe; the typed row
/// carries `executor_name` for the device cancel route.
async fn subtask_for_cancel(
    state: &AppState,
    subtask_id: i64,
) -> Result<Option<CancelInfo>, ClientError> {
    let row = state
        .task_store
        .streaming_subtask_by_id(subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, subtask_id, "chat:cancel subtask read failed");
            internal_error()
        })?;
    Ok(row.map(|row| CancelInfo {
        task_id: row.task_id,
        status: row.status,
        executor_name: row.executor_name,
    }))
}

/// `_mark_task_and_board_cancelling`: persist the CANCELLING intent only.
async fn mark_cancelling(state: &AppState, task_id: i64) -> Result<(), ClientError> {
    let Some(task) = state
        .task_store
        .get_regular_active_task(task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "chat:cancel task read failed");
            internal_error()
        })?
    else {
        return Ok(());
    };
    let Some(json) = task
        .get::<Json<OpaqueJson>>("json")
        .ok()
        .flatten()
        .map(|json| json.0.to_value())
    else {
        return Ok(());
    };
    let mut json = json;
    if let Some(status) = json.get_mut("status").and_then(Value::as_object_mut) {
        status.insert("status".into(), Value::String("CANCELLING".into()));
        status.insert("errorMessage".into(), Value::String(String::new()));
        status.insert("updatedAt".into(), Value::String(local_isoformat()));
        status.insert("completedAt".into(), Value::Null);
    }
    let owner = task
        .get::<i32>("user_id")
        .map_err(|error| {
            tracing::error!(%error, task_id, "chat:cancel owner decode failed");
            internal_error()
        })?
        .unwrap_or_default();
    state
        .task_store
        .update_task_json(
            task_id,
            i64::from(owner),
            &python_json_value(&json),
            &task_update_timestamp(),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "chat:cancel task update failed");
            internal_error()
        })?;
    Ok(())
}

/// `ExecutionDispatcher.cancel` for the migrated routing branches.
async fn deliver_cancel(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    user_id: i64,
    info: &CancelInfo,
    subtask_id: i64,
    device_id: Option<&str>,
    shell_type: &str,
) -> Result<bool, ClientError> {
    if let Some(device_id) = device_id {
        let room = format!("device:{user_id}:{device_id}");
        let payload = json!({"task_id": info.task_id, "subtask_id": subtask_id});
        if let Err(error) = runtime.emitters().task_cancel(&room, &payload).await {
            tracing::warn!(%error, "task:cancel local delivery failed");
        }
        publish_room_event(state, "task:cancel", &payload, EXECUTOR_NAMESPACE, &room).await;
        return Ok(true);
    }
    if shell_type == "Chat" {
        let Some(redis) = state.redis.as_ref() else {
            return Ok(false);
        };
        use brz_redis::Redis as _;
        let key = cancel_key(subtask_id);
        return match redis.set_ex(key.as_str(), CANCEL_FLAG_TTL, "true").await {
            Ok(()) => Ok(true),
            Err(error) => {
                tracing::error!(%error, subtask_id, "SSE cancel flag write failed");
                Ok(false)
            }
        };
    }
    match state
        .executor_manager
        .cancel_subtask(info.task_id, subtask_id, info.executor_name.as_deref())
        .await
    {
        Ok(delivered) => Ok(delivered),
        Err(error) => {
            tracing::warn!(%error, subtask_id, "chat:cancel executor-manager request failed");
            Ok(false)
        }
    }
}

/// `is_stream_alive`: a fresh streaming-status document owned by the subtask.
async fn stream_alive(state: &AppState, task_id: i64, subtask_id: i64) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        return false;
    };
    let Some(status) = super::chat_events::task_streaming_status(redis, task_id).await else {
        return false;
    };
    if status.get("subtask_id").and_then(python_integer) != Some(subtask_id) {
        return false;
    }
    let Some(last_activity) = status.get("last_activity_at").and_then(Value::as_str) else {
        return false;
    };
    let Ok(last_activity) = chrono::DateTime::parse_from_rfc3339(last_activity) else {
        return false;
    };
    let idle = Utc::now().signed_duration_since(last_activity.with_timezone(&Utc));
    idle.num_seconds() <= CANCELLING_STUCK_TIMEOUT_SECONDS
}

/// `finalize_stuck_cancellation`: mark the stuck assistant subtasks and the
/// task CANCELLED, returning the finalized ids; `None` when the task is absent
/// and `Some([])` when it is already terminal.
async fn finalize_stuck_cancellation(
    state: &AppState,
    task_id: i64,
) -> Result<Option<Vec<i64>>, ClientError> {
    let Some(task) = state
        .task_store
        .get_regular_active_task(task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "cancel finalize task read failed");
            internal_error()
        })?
    else {
        // `finalize_stuck_cancellation`: a missing task returns an empty list,
        // which still counts as a local finalization.
        return Ok(Some(Vec::new()));
    };
    let Some(json) = task
        .get::<Json<OpaqueJson>>("json")
        .ok()
        .flatten()
        .map(|json| json.0.to_value())
    else {
        return Ok(Some(Vec::new()));
    };
    let status = json
        .get("status")
        .and_then(|status| status.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if TASK_FINAL_STATES.contains(&status) {
        return Ok(Some(Vec::new()));
    }
    let owner = task
        .get::<i32>("user_id")
        .map_err(|error| {
            tracing::error!(%error, task_id, "cancel finalize owner decode failed");
            internal_error()
        })?
        .unwrap_or_default();
    let listing = crate::task_detail_api::repository::list_subtasks_by_task(
        &*state.task_store,
        task_id,
        i64::from(owner),
        true,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, task_id, "cancel finalize subtask read failed");
        internal_error()
    })?;
    let stuck: Vec<i64> = listing
        .subtasks
        .into_iter()
        .filter(|subtask| {
            subtask.role == "ASSISTANT" && matches!(subtask.status.as_str(), "PENDING" | "RUNNING")
        })
        .map(|subtask| subtask.id)
        .collect();
    let tables = state
        .task_store
        .message_edit_tables(task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "cancel finalize table lookup failed");
            internal_error()
        })?;
    let mut cancelled = json.clone();
    if let Some(status) = cancelled.get_mut("status").and_then(Value::as_object_mut) {
        status.insert("status".into(), Value::String("CANCELLED".into()));
        status.insert("errorMessage".into(), Value::String(String::new()));
        status.insert("updatedAt".into(), Value::String(local_isoformat()));
        status.insert("completedAt".into(), Value::String(local_isoformat()));
    }
    let subtasks = tables.subtasks.clone();
    let task_json = python_json_value(&cancelled);
    state
        .mysql
        .with_transaction(async |transaction| {
            for subtask_id in &stuck {
                let statement = format!(
                    "UPDATE {subtasks} SET status=?, progress=?, result=?, updated_at=?, \
                     completed_at=? WHERE {subtasks}.id = ?"
                );
                let now = local_isoformat();
                let result = python_json_value(&json!({"value": ""}));
                transaction
                    .execute(
                        &statement,
                        (
                            "CANCELLED".to_string(),
                            100_i64,
                            result,
                            now.clone(),
                            now,
                            *subtask_id,
                        ),
                    )
                    .await?;
            }
            transaction
                .execute(
                    &format!(
                        "UPDATE {t} SET json=?, updated_at=? WHERE {t}.id = ?",
                        t = tables.tasks
                    ),
                    (task_json.clone(), task_update_timestamp(), task_id),
                )
                .await?;
            Ok(())
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, "cancel finalize commit failed");
            internal_error()
        })?;
    tracing::warn!(task_id, ?stuck, "finalized stuck cancellation locally");
    Ok(Some(stuck))
}

/// `on_chat_guide`.
pub(crate) async fn guide(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let Some(payload) = GuidePayload::parse(&data) else {
        return Ok(Reply::payload(guide_ack(None, Some("Invalid payload"))));
    };
    if let Some(pending) = expired(session, state, runtime, socket_id) {
        return Ok(Reply::payload(pending.await));
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(guide_ack(None, Some("Not authenticated"))));
    }
    if let Err(ack) = guide_authorize(state, session, &payload).await? {
        return Ok(Reply::payload(ack));
    }
    let item = match enqueue_guidance(state, user_id, &payload).await {
        Ok(item) => item,
        Err(error) => {
            tracing::error!(?error, "chat:guide enqueue failed");
            return Err(internal_error());
        }
    };
    emit_guidance_queued(state, runtime, payload.task_id, &item).await;
    let guidance_id = item
        .get("guidance_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(Reply::payload(guide_ack(Some(guidance_id), None)))
}

/// `ChatGuidePayload`.
struct GuidePayload {
    task_id: i64,
    subtask_id: i64,
    team_id: i64,
    message: String,
    client_guidance_id: Option<String>,
}

impl GuidePayload {
    fn parse(data: &Value) -> Option<Self> {
        Some(Self {
            task_id: data.get("task_id").and_then(python_integer)?,
            subtask_id: data.get("subtask_id").and_then(python_integer)?,
            team_id: data.get("team_id").and_then(python_integer)?,
            message: data
                .get("message")
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())?
                .to_string(),
            client_guidance_id: data
                .get("client_guidance_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
}

/// `ChatGuideAck` (`guidance_id`, `error`).
fn guide_ack(guidance_id: Option<String>, error: Option<&str>) -> Value {
    json!({
        "guidance_id": guidance_id.map_or(Value::Null, Value::String),
        "error": error.map_or(Value::Null, |error| Value::String(error.to_string())),
    })
}

/// `on_chat_guide`'s task/team/subtask guards.
async fn guide_authorize(
    state: &AppState,
    session: &ChatSession,
    payload: &GuidePayload,
) -> Result<Result<(), Value>, ClientError> {
    // `on_chat_guide`'s own access branch (`chat_namespace.py:419-420`) answers
    // with `ChatGuideAck(error="Task not found or access denied")`, unlike the
    // shared `{"error": "Access denied"}` used by the other chat events.
    match super::chat_task_join::can_access_task(state, session.user_id(), payload.task_id).await {
        Ok(true) => {}
        Ok(false) => {
            return Ok(Err(guide_ack(
                None,
                Some("Task not found or access denied"),
            )));
        }
        Err(error) => {
            tracing::error!(%error, task_id = payload.task_id, "chat:guide access read failed");
            return Err(internal_error());
        }
    }
    let Some(team) =
        crate::responses::create::resolution::team_by_id(&state.mysql, payload.team_id)
            .await
            .map_err(|error| {
                tracing::error!(%error, "chat:guide team read failed");
                internal_error()
            })?
    else {
        return Ok(Err(guide_ack(None, Some("Team not found"))));
    };
    let shell_type = team_first_bot_shell_type(state, &team)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "chat:guide shell resolution failed");
            internal_error()
        })?;
    if shell_type != "Chat" {
        return Ok(Err(guide_ack(
            None,
            Some("Guidance is only supported for Chat Shell tasks"),
        )));
    }
    let subtask = state
        .task_store
        .get_subtask(payload.subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "chat:guide subtask read failed");
            internal_error()
        })?;
    let matching = subtask.is_some_and(|row| {
        row.get::<i64>("task_id").ok().flatten() == Some(payload.task_id)
            && row.get::<i64>("team_id").ok().flatten() == Some(payload.team_id)
    });
    if !matching {
        return Ok(Err(guide_ack(None, Some("Subtask not found"))));
    }
    Ok(Ok(()))
}

/// `get_team_first_bot_shell_type`.
async fn team_first_bot_shell_type(
    state: &AppState,
    team: &crate::responses::create::resolution::KindRow,
) -> Result<String, brz_mysql::MysqlError> {
    let members = team
        .json
        .0
        .get("spec")
        .and_then(|spec| spec.get("members"))
        .and_then(Value::as_array);
    let Some(bot_ref) = members
        .and_then(|members| members.first())
        .and_then(|member| member.get("botRef"))
    else {
        return Ok(String::new());
    };
    let Some(bot_name) = bot_ref.get("name").and_then(Value::as_str) else {
        return Ok(String::new());
    };
    let bot_namespace = bot_ref
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let statement = format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.kind = 'Bot' AND kinds.name = ? \
         AND kinds.namespace = ? AND kinds.user_id = ? AND kinds.is_active IS true \n LIMIT 1",
        crate::responses::create::resolution::KIND_COLUMNS
    );
    let bot: Option<crate::responses::create::resolution::KindRow> = state
        .mysql
        .fetch_optional(statement, (bot_name, bot_namespace, team.user_id))
        .await?;
    let Some(bot) = bot else {
        return Ok(String::new());
    };
    let shell_ref = bot.json.0.get("spec").and_then(|spec| spec.get("shellRef"));
    let Some(shell_ref) = shell_ref else {
        return Ok(String::new());
    };
    let shell_name = shell_ref.get("name").and_then(Value::as_str).unwrap_or("");
    let shell_namespace = shell_ref
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let shell = crate::responses::create::shell::resolve_shell(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        team.user_id,
        shell_name,
        shell_namespace,
    )
    .await?;
    Ok(shell
        .and_then(|shell| {
            shell
                .json
                .0
                .get("spec")
                .and_then(|spec| spec.get("shellType").or_else(|| spec.get("runtime")))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default())
}

/// `GuidanceQueue.enqueue` (`chat:guidance:{task_id}:{subtask_id}`).
async fn enqueue_guidance(
    state: &AppState,
    user_id: i64,
    payload: &GuidePayload,
) -> Result<Value, String> {
    let Some(redis) = state.redis.as_ref() else {
        return Err("Redis unavailable".to_string());
    };
    let guidance_id = payload
        .client_guidance_id
        .clone()
        .unwrap_or_else(|| format!("guidance-{}", uuid_hex()));
    let mut item = Map::new();
    item.insert("task_id".into(), Value::from(payload.task_id));
    item.insert("subtask_id".into(), Value::from(payload.subtask_id));
    item.insert("team_id".into(), Value::from(payload.team_id));
    item.insert("user_id".into(), Value::from(user_id));
    item.insert("guidance_id".into(), Value::String(guidance_id));
    item.insert("message".into(), Value::String(payload.message.clone()));
    item.insert("created_at".into(), Value::String(utc_isoformat()));
    let item = Value::Object(item);
    let key = format!("chat:guidance:{}:{}", payload.task_id, payload.subtask_id);
    use brz_redis::Redis as _;
    redis
        .rpush(key.as_str(), [python_json_value(&item)])
        .await
        .map_err(|error| error.to_string())?;
    redis
        .expire(key.as_str(), GUIDANCE_QUEUE_TTL_SECONDS)
        .await
        .map_err(|error| error.to_string())?;
    Ok(item)
}

/// `self.emit(CHAT_GUIDANCE_QUEUED, item_data, room=f"task:{task_id}")`.
async fn emit_guidance_queued(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    task_id: i64,
    item: &Value,
) {
    let room = format!("task:{task_id}");
    if let Err(error) = runtime.emitters().chat_guidance_queued(&room, item).await {
        tracing::warn!(%error, "chat:guidance_queued local delivery failed");
    }
    publish_room_event(
        state,
        "chat:guidance_queued",
        item,
        crate::socketio::runtime::CHAT_NAMESPACE,
        &room,
    )
    .await;
}

/// Python's lax `int` coercion for JSON scalars.
fn python_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.fract() == 0.0)
                .map(|value| value as i64)
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// `datetime.now().isoformat()` (naive local time).
fn local_isoformat() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

/// `datetime.now(timezone.utc).isoformat()`.
fn utc_isoformat() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

/// `uuid.uuid4().hex`.
fn uuid_hex() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guidance_ack_keeps_both_keys() {
        assert_eq!(
            guide_ack(Some("g-1".into()), None),
            json!({"guidance_id": "g-1", "error": null})
        );
        assert_eq!(
            guide_ack(None, Some("Team not found")),
            json!({"guidance_id": null, "error": "Team not found"})
        );
    }

    #[test]
    fn utc_isoformat_uses_the_source_offset_shape() {
        let value = utc_isoformat();
        assert!(value.ends_with("+00:00"), "{value}");
        assert_eq!(value.len(), "2026-11-09T05:13:09.614130+00:00".len());
    }

    #[test]
    fn guidance_ids_follow_the_source_prefix() {
        let id = uuid_hex();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
