// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` dynamic Responses API events.
//!
//! Source: `DeviceNamespace._handle_responses_api_event`
//! (`app/api/ws/device_namespace.py:2810`) and
//! `LocalTaskResponsesHandler` (`app/api/ws/local_task_responses.py`). The
//! namespace forwards every Responses API event (`response.*`, `error`,
//! `image_generation.*`, or any payload carrying a task identity) through the
//! same machinery as the internal callback: the shared event parser,
//! `StatusUpdatingEmitter`/`WebSocketResultEmitter`, the callback channel
//! publish, IM channel forwarding and `TaskCompletedEvent`.
//!
//! Two branches exist:
//!
//! * a device-local task (`local_task_id`) is translated into the `/chat`
//!   stream frames addressed to the owner's user room;
//! * an ordered task event (`task_id` + `subtask_id`) runs under the subtask's
//!   lock, beginning with the execution write-back whose database awaits are
//!   part of the order.
//!
//! The socket entry only owns classification, ordering and the tuple shape;
//! everything else reuses the production modules.

use serde_json::{Map, Value, json};

use crate::internal_callback::channel;
use crate::internal_callback::completion;
use crate::internal_callback::emitter::{self, StatusUpdatingEmitter};
use crate::internal_callback::parser;
use crate::internal_callback::session::publish_callback_event;
use crate::socketio::device_heartbeat;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::runtime_projection::{self, RuntimeIdentity};
use crate::socketio::session::SessionSnapshot;
use crate::state::AppState;

/// `/chat` result-event room for a wework task (`get_wework_task_room`).
const WEWORK_TASK_ROOM_PREFIX: &str = "wework:task:";
/// `MAX_RUNTIME_SUBTASK_ID`.
const MAX_RUNTIME_SUBTASK_ID: i64 = 2_147_483_647;
/// `uuid.NAMESPACE_URL`.
const UUID_NAMESPACE_URL: [u8; 16] = [
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
];

/// Resolve the same stream identity used for persistence and live projection.
pub(super) fn response_subtask_id(input: &Value, snapshot: &SessionSnapshot) -> Option<i64> {
    let object = input.as_object()?;
    let device_id = snapshot.device.device_id.as_deref()?;
    if let Some(local_task_id) = local_task_identity(object) {
        return Some(runtime_subtask_id(object, device_id, local_task_id));
    }
    integer(object, "subtask_id").filter(|id| *id != 0)
}

fn local_task_identity(object: &Map<String, Value>) -> Option<&str> {
    object
        .get("local_task_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `_handle_responses_api_event`.
pub(crate) async fn handle(
    state: &AppState,
    runtime: &SocketRuntime,
    snapshot: &SessionSnapshot,
    event_name: &str,
    data: Value,
) -> Value {
    let Some(device_id) = snapshot.device.device_id.clone() else {
        return json!({"error": "Not authenticated or not registered"});
    };
    let Value::Object(object) = data else {
        return json!({"error": "Invalid event data format"});
    };
    let user_id = snapshot.user_id;
    let task_id = integer(&object, "task_id");
    let subtask_id = integer(&object, "subtask_id");
    let message_id = integer(&object, "message_id");
    let event_data = object.get("data").cloned().unwrap_or_else(|| json!({}));
    let Some(local_task_id) = local_task_identity(&object) else {
        // `if not task_id or not subtask_id`: zero is falsy in the Source.
        let (Some(task_id), Some(subtask_id)) = (
            task_id.filter(|id| *id != 0),
            subtask_id.filter(|id| *id != 0),
        ) else {
            return json!({"error": "Missing task_id or subtask_id"});
        };
        return ordered(
            state,
            runtime,
            user_id,
            &device_id,
            task_id,
            subtask_id,
            message_id,
            event_name,
            &object,
            &event_data,
        )
        .await;
    };

    // The Source writes the execution event back before the local-task branch.
    if let Some(task_id) = task_id.filter(|task_id| *task_id != 0) {
        write_back(
            state, runtime, user_id, &device_id, task_id, event_name, &object,
        )
        .await;
    }
    // `event_data if isinstance(event_data, dict) else {}`.
    let local_event_data = if event_data.is_object() {
        event_data.clone()
    } else {
        json!({})
    };
    local_task(
        state,
        user_id,
        &device_id,
        event_name,
        &object,
        &local_event_data,
        message_id,
        local_task_id,
    )
    .await
}

/// The ordered (`task_id` + `subtask_id`) branch.
#[allow(clippy::too_many_arguments)]
async fn ordered(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    task_id: i64,
    subtask_id: i64,
    message_id: Option<i64>,
    event_name: &str,
    data: &Map<String, Value>,
    event_data: &Value,
) -> Value {
    let outcome = process_remote_event(
        state, runtime, user_id, device_id, task_id, subtask_id, message_id, event_name, data,
        event_data,
    )
    .await;
    match outcome {
        Ok(()) => json!({"success": true}),
        Err(error) => {
            tracing::error!(
                subtask_id,
                event = event_name,
                %error,
                "Responses API event failed"
            );
            json!({"error": error})
        }
    }
}

/// Write back, forward and persist one task event within its receive-order turn.
#[allow(clippy::too_many_arguments)]
async fn process_remote_event(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    task_id: i64,
    subtask_id: i64,
    message_id: Option<i64>,
    event_name: &str,
    data: &Map<String, Value>,
    event_data: &Value,
) -> Result<(), String> {
    write_back(
        state, runtime, user_id, device_id, task_id, event_name, data,
    )
    .await;

    let payload = response_api_payload(data, device_id);
    emit_response_api_event(
        state,
        event_name,
        payload,
        &format!("{WEWORK_TASK_ROOM_PREFIX}{task_id}"),
    )
    .await?;

    let parsed = parser::shared().parse(task_id, subtask_id, message_id, event_name, event_data);
    let Some(mut event) = parsed.map_err(|error| error.0)? else {
        return Ok(());
    };
    emit_event_chain(state, user_id, &mut event).await?;

    let Some(redis) = state.redis.as_ref() else {
        return Ok(());
    };
    if let Err(error) = publish_callback_event(redis, subtask_id, &event).await {
        tracing::warn!(%error, subtask_id, "Responses callback event publish failed");
    }
    channel::forward_event_to_channel_callbacks(redis, task_id, &event).await;

    if is_terminal(&event.event_type) {
        publish_task_completed(
            state, runtime, user_id, device_id, task_id, subtask_id, &event,
        )
        .await;
    }
    Ok(())
}

/// `_execution_runtime_event_sync` through the shared projection.
async fn write_back(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    task_id: i64,
    event_name: &str,
    data: &Map<String, Value>,
) {
    let payload = Value::Object(data.clone());
    let identity = RuntimeIdentity {
        event_name,
        runtime_task_id: task_id.to_string(),
        payload: &payload,
    };
    runtime_projection::write_back_execution_event(state, runtime, user_id, device_id, &identity)
        .await;
}

/// `StatusUpdatingEmitter` wrapping `WebSocketResultEmitter`, including the
/// terminal collection/persistence/`TaskCompletedEvent` step.
async fn emit_event_chain(
    state: &AppState,
    user_id: i64,
    event: &mut crate::internal_callback::event::ExecutionEvent,
) -> Result<(), String> {
    let Some(redis) = state.redis.as_ref() else {
        return Ok(());
    };
    let status = completion::terminal_status(&event.event_type);
    let mut emitter = StatusUpdatingEmitter::new(redis.to_owned(), event.task_id, event.subtask_id);
    if status.is_none() {
        emitter
            .emit(event)
            .await
            .map_err(|error| error.to_string())?;
    }
    emitter.close().await;
    let Some(status) = status else {
        return Ok(());
    };

    let ctx = completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    let final_result = completion::complete_terminal_event(
        &ctx,
        event.task_id,
        event.subtask_id,
        status,
        event.result.as_ref(),
        event.error.as_deref(),
        event.error_code.as_deref(),
        None,
        None,
    )
    .await;
    if let Some(result) = final_result {
        event.result = Some(result);
    }
    let result = event
        .result
        .clone()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let contexts = if status == "COMPLETED" {
        Some(
            crate::responses::create::contexts::context_briefs(&state.mysql, event.subtask_id)
                .await
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    emitter::emit_terminal_frames(redis, event, Some(user_id), &result, contexts.as_ref())
        .await
        .map_err(|error| error.to_string())
}

/// `DeviceNamespace._publish_task_completed_event` plus the slot broadcast.
async fn publish_task_completed(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    task_id: i64,
    subtask_id: i64,
    event: &crate::internal_callback::event::ExecutionEvent,
) {
    let (status, result, error) = match event.event_type.as_str() {
        "done" => ("COMPLETED", event.result.as_ref(), None),
        "error" => (
            "FAILED",
            None,
            Some(event.error.as_deref().unwrap_or("Unknown error")),
        ),
        _ => ("CANCELLED", None, None),
    };
    if let Some(redis) = state.redis.as_ref() {
        let ctx = completion::Completion {
            app: Some(state),
            mysql: &state.mysql,
            redis,
            tables: crate::internal_callback::tables(state),
            executor_manager: &state.executor_manager,
        };
        completion::publish_task_completed_for_owner(
            &ctx, task_id, subtask_id, user_id, status, result, error,
        )
        .await;
    }
    device_heartbeat::broadcast_slot_update(state, runtime, user_id, device_id).await;
}

/// `emit_response_api_event`: the raw Responses event on the `/chat` namespace.
async fn emit_response_api_event(
    state: &AppState,
    event_name: &str,
    payload: Value,
    room: &str,
) -> Result<(), String> {
    let Some(redis) = state.redis.as_ref() else {
        return Ok(());
    };
    crate::internal_callback::publish_emit_in_room(redis, event_name, room, payload)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// `response_api_payload`: the frame data plus the receiving device id.
fn response_api_payload(data: &Map<String, Value>, device_id: &str) -> Value {
    let mut payload = data.clone();
    payload.insert("device_id".into(), Value::String(device_id.to_string()));
    Value::Object(payload)
}

/// The device-local task branch: `LocalTaskResponsesHandler.handle`.
#[allow(clippy::too_many_arguments)]
async fn local_task(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    event_name: &str,
    data: &Map<String, Value>,
    event_data: &Value,
    message_id: Option<i64>,
    local_task_id: &str,
) -> Value {
    let subtask_id = runtime_subtask_id(data, device_id, local_task_id);
    let outcome = process_local_event(
        state,
        user_id,
        device_id,
        event_name,
        data,
        event_data,
        message_id,
        local_task_id,
        subtask_id,
    )
    .await;
    match outcome {
        Ok(()) => json!({"success": true}),
        Err(error) => {
            tracing::error!(
                subtask_id,
                event = event_name,
                %error,
                "local-task Responses API event failed"
            );
            json!({"error": error})
        }
    }
}

/// Forward one local-task event within its receive-order turn.
#[allow(clippy::too_many_arguments)]
async fn process_local_event(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    event_name: &str,
    data: &Map<String, Value>,
    event_data: &Value,
    message_id: Option<i64>,
    local_task_id: &str,
    subtask_id: i64,
) -> Result<(), String> {
    let source = data
        .get("source")
        .filter(|value| value.is_object())
        .cloned();
    let payload =
        local_task_response_payload(data, device_id, local_task_id, subtask_id, message_id);
    emit_response_api_event(
        state,
        event_name,
        payload,
        &format!("wework:user:{user_id}"),
    )
    .await?;

    let Some(event) = local_execution_event(event_name, event_data, subtask_id, message_id)? else {
        return Ok(());
    };
    emit_local_execution_event(
        state,
        user_id,
        device_id,
        local_task_id,
        data.get("runtime"),
        &event,
    )
    .await?;
    forward_local_task_callbacks(state, device_id, local_task_id, source.as_ref(), &event).await;
    Ok(())
}

/// `LocalTaskResponsesHandler.execution_event`.
pub(super) fn local_execution_event(
    event_name: &str,
    event_data: &Value,
    subtask_id: i64,
    message_id: Option<i64>,
) -> Result<Option<crate::internal_callback::event::ExecutionEvent>, String> {
    use crate::internal_callback::event::{EventType, ExecutionEvent};

    if event_name == "response.created" {
        let mut event = ExecutionEvent::new(EventType::Start, 0, subtask_id);
        event.data.insert(
            "shell_type".into(),
            Value::String(
                event_data
                    .get("shell_type")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Codex")
                    .to_string(),
            ),
        );
        event.message_id = message_id;
        return Ok(Some(event));
    }
    parser::shared()
        .parse(0, subtask_id, message_id, event_name, event_data)
        .map_err(|error| error.0)
}

/// `LocalTaskResponsesHandler.emit_execution_event`.
async fn emit_local_execution_event(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    local_task_id: &str,
    runtime: Option<&Value>,
    event: &crate::internal_callback::event::ExecutionEvent,
) -> Result<(), String> {
    let base = local_chat_payload(
        device_id,
        local_task_id,
        runtime.cloned().unwrap_or(Value::Null),
        event,
    );
    let Some((name, payload)) = local_chat_frame(event, base) else {
        return Ok(());
    };
    let Some(redis) = state.redis.as_ref() else {
        return Ok(());
    };
    crate::internal_callback::publish_emit_in_room(
        redis,
        name,
        &format!("user:{user_id}"),
        Value::Object(payload),
    )
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// `emit_execution_event`'s frame switch: the `/chat` event name and payload.
fn local_chat_frame(
    event: &crate::internal_callback::event::ExecutionEvent,
    base: Map<String, Value>,
) -> Option<(&'static str, Map<String, Value>)> {
    let mut payload = base;
    match event.event_type.as_str() {
        "start" => {
            payload.insert(
                "shell_type".into(),
                Value::String(
                    event
                        .data
                        .get("shell_type")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("Codex")
                        .to_string(),
                ),
            );
            Some(("chat:start", payload))
        }
        "chunk" => {
            payload.insert("content".into(), Value::String(event.content.clone()));
            payload.insert("offset".into(), json!(event.offset));
            if let Some(result) = event.result.as_ref() {
                payload.insert("result".into(), result.clone());
            }
            if let Some(block_id) = event.data.get("block_id").filter(|value| !value.is_null()) {
                payload.insert("block_id".into(), block_id.clone());
            }
            if let Some(block_offset) = event
                .data
                .get("block_offset")
                .filter(|value| !value.is_null())
            {
                payload.insert("block_offset".into(), block_offset.clone());
            }
            Some(("chat:chunk", payload))
        }
        "thinking" => {
            payload.insert("content".into(), json!(""));
            payload.insert("offset".into(), json!(event.offset));
            payload.insert("result".into(), json!({"reasoning_chunk": event.content}));
            Some(("chat:chunk", payload))
        }
        "done" => {
            payload.insert("offset".into(), json!(event.offset));
            payload.insert(
                "result".into(),
                event.result.clone().unwrap_or_else(|| json!({})),
            );
            Some(("chat:done", payload))
        }
        "error" => {
            payload.insert(
                "error".into(),
                Value::String(
                    event
                        .error
                        .clone()
                        .unwrap_or_else(|| "Unknown error".to_string()),
                ),
            );
            if let Some(error_code) = event.error_code.as_ref() {
                payload.insert("type".into(), Value::String(error_code.clone()));
            }
            Some(("chat:error", payload))
        }
        "cancelled" => Some(("chat:cancelled", payload)),
        "tool_start" => {
            payload.insert("block".into(), Value::Object(local_tool_block(event)));
            Some(("chat:block_created", payload))
        }
        "tool_argument_delta" | "tool_argument_done" | "tool_result" => {
            local_tool_update_payload(&payload, event).map(|update| ("chat:block_updated", update))
        }
        "block_created" => event
            .data
            .get("block")
            .filter(|block| block.is_object())
            .map(|block| {
                payload.insert("block".into(), block.clone());
                ("chat:block_created", payload)
            }),
        "block_updated" => {
            let block_id = event.data.get("block_id")?;
            let updates = event
                .data
                .get("updates")
                .filter(|value| value.is_object())?;
            payload.insert("block_id".into(), Value::String(block_id.to_string()));
            if let Value::Object(updates) = updates {
                for (key, value) in updates {
                    payload.insert(key.clone(), value.clone());
                }
            }
            Some(("chat:block_updated", payload))
        }
        _ => None,
    }
}

/// `local_task_chat_payload`.
fn local_chat_payload(
    device_id: &str,
    local_task_id: &str,
    runtime: Value,
    event: &crate::internal_callback::event::ExecutionEvent,
) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("subtask_id".into(), json!(event.subtask_id));
    payload.insert("device_id".into(), Value::String(device_id.to_string()));
    payload.insert(
        "local_task_id".into(),
        Value::String(local_task_id.to_string()),
    );
    payload.insert("runtime".into(), runtime);
    if let Some(message_id) = event.message_id {
        payload.insert("message_id".into(), json!(message_id));
    }
    payload
}

/// `local_task_tool_block`.
fn local_tool_block(event: &crate::internal_callback::event::ExecutionEvent) -> Map<String, Value> {
    let mut block = crate::internal_callback::session::create_tool_block(
        event.tool_use_id.as_deref().unwrap_or_default(),
        event.tool_name.as_deref().unwrap_or_default(),
        event.tool_input.as_ref(),
        event.data.get("display_name").and_then(Value::as_str),
        event.data.get("tool_protocol").and_then(Value::as_str),
        event.data.get("server_label").and_then(Value::as_str),
    );
    if event.data.get("argument_status").and_then(Value::as_str) == Some("streaming") {
        block.insert(
            "status".into(),
            Value::String("generating_arguments".into()),
        );
        block.insert("argument_status".into(), Value::String("streaming".into()));
    }
    block
}

/// `local_task_tool_update_payload`.
fn local_tool_update_payload(
    base: &Map<String, Value>,
    event: &crate::internal_callback::event::ExecutionEvent,
) -> Option<Map<String, Value>> {
    let tool_use_id = event
        .tool_use_id
        .as_deref()
        .filter(|value| !value.is_empty())?;
    let mut payload = base.clone();
    payload.insert("block_id".into(), Value::String(tool_use_id.to_string()));
    if let Some(tool_input) = event.tool_input.as_ref() {
        payload.insert("tool_input".into(), tool_input.clone());
    }
    match event.event_type.as_str() {
        "tool_argument_delta" => {
            payload.insert("status".into(), json!("generating_arguments"));
        }
        "tool_argument_done" => {
            payload.insert("status".into(), json!("pending"));
        }
        "tool_result" => {
            let failed = matches!(
                event.data.get("status").and_then(Value::as_str),
                Some("error" | "failed")
            );
            payload.insert(
                "status".into(),
                json!(if failed { "error" } else { "done" }),
            );
            if let Some(tool_output) = event.tool_output.as_ref() {
                payload.insert("tool_output".into(), tool_output.clone());
            }
        }
        _ => return None,
    }
    Some(payload)
}

/// `LocalTaskResponsesHandler.forward_channel_callbacks`.
///
/// Only IM-originated local tasks forward, subject to channel freshness checks.
pub(super) async fn forward_local_task_callbacks(
    state: &AppState,
    device_id: &str,
    local_task_id: &str,
    source: Option<&Value>,
    event: &crate::internal_callback::event::ExecutionEvent,
) {
    if source
        .and_then(|source| source.get("source"))
        .and_then(Value::as_str)
        != Some("im")
    {
        return;
    }
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let source = source.cloned().unwrap_or(Value::Null);
    let task_key = channel::runtime_local_task_callback_key(device_id, local_task_id);
    let channel_name = source
        .get("channel_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if let Some(channel) = channel::get_service_by_name(channel_name)
        && !channel::accepts_runtime_source(redis, channel, &task_key, &source).await
    {
        tracing::info!(task_key, "skipping stale IM runtime event");
        return;
    }
    let card = crate::internal_callback::dingtalk_card::DingTalkCardTransport::from_process(state);
    let delivery = channel::RuntimeChannelDelivery {
        state,
        redis,
        card: &card,
        source_message_id: source
            .get("message_id")
            .filter(|value| crate::json_compat::python_truthy(value))
            .map(crate::json_compat::python_str),
    };
    if is_terminal(&event.event_type) {
        channel::handle_task_completed(
            redis,
            &delivery,
            &task_key,
            event.subtask_id,
            local_task_terminal_status(&event.event_type),
            event.result.as_ref(),
            event.error.as_deref(),
        )
        .await;
        return;
    }
    channel::forward_event_to_channel_callbacks_for_key(
        redis,
        &delivery,
        &task_key,
        event.subtask_id,
        event,
    )
    .await;
}

/// `local_task_terminal_status`.
fn local_task_terminal_status(event_type: &str) -> &'static str {
    match event_type {
        "error" => "FAILED",
        "cancelled" => "CANCELLED",
        _ => "COMPLETED",
    }
}

/// `local_task_response_payload`.
fn local_task_response_payload(
    data: &Map<String, Value>,
    device_id: &str,
    local_task_id: &str,
    subtask_id: i64,
    message_id: Option<i64>,
) -> Value {
    let mut payload = data.clone();
    let task_id = match payload.get("task_id") {
        Some(value) if truthy(value) => value.clone(),
        _ => json!(0),
    };
    payload.insert("task_id".into(), task_id);
    payload.insert("subtask_id".into(), json!(subtask_id));
    payload.insert("device_id".into(), Value::String(device_id.to_string()));
    payload.insert(
        "local_task_id".into(),
        Value::String(local_task_id.to_string()),
    );
    if let Some(message_id) = message_id {
        payload.insert("message_id".into(), json!(message_id));
    }
    Value::Object(payload)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

/// `runtime_subtask_id`: the explicit subtask, else the stable uuid5 fallback.
pub(super) fn runtime_subtask_id(
    data: &Map<String, Value>,
    device_id: &str,
    local_task_id: &str,
) -> i64 {
    if let Some(subtask_id) = integer(data, "subtask_id").filter(|value| *value > 0) {
        return subtask_id;
    }
    let runtime_key = format!("{device_id}:{local_task_id}");
    let modulus = u128::from(MAX_RUNTIME_SUBTASK_ID as u64 - 1);
    (uuid5_url_int(&runtime_key) % modulus + 1) as i64
}

/// `uuid.uuid5(uuid.NAMESPACE_URL, name).int`.
fn uuid5_url_int(name: &str) -> u128 {
    use sha1::{Digest, Sha1};

    let mut hasher = Sha1::new();
    hasher.update(UUID_NAMESPACE_URL);
    hasher.update(name.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    u128::from_be_bytes(bytes)
}

fn is_terminal(event_type: &str) -> bool {
    matches!(event_type, "done" | "error" | "cancelled")
}

fn integer(object: &Map<String, Value>, key: &str) -> Option<i64> {
    match object.get(key)? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_subtask_id_falls_back_to_the_source_uuid5() {
        // Python: (uuid.uuid5(uuid.NAMESPACE_URL, "dev:local").int % 2147483646) + 1.
        let expected = {
            let value = uuid5_url_int("dev:local");
            (value % 2_147_483_646u128 + 1) as i64
        };
        let data = Map::new();
        assert_eq!(runtime_subtask_id(&data, "dev", "local"), expected);

        let mut explicit = Map::new();
        explicit.insert("subtask_id".into(), json!(42));
        assert_eq!(runtime_subtask_id(&explicit, "dev", "local"), 42);
    }

    #[test]
    fn the_local_task_response_payload_keeps_the_source_key_order() {
        let mut data = Map::new();
        data.insert("event_type".into(), json!("response.output_text.delta"));
        data.insert("data".into(), json!({"type": "response.output_text.delta"}));
        data.insert("local_task_id".into(), json!("local"));
        data.insert("message_id".into(), json!(2));
        let payload = local_task_response_payload(&data, "dev", "local", 7, Some(2));
        let keys: Vec<&str> = payload
            .as_object()
            .expect("payload")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "event_type",
                "data",
                "local_task_id",
                "message_id",
                "task_id",
                "subtask_id",
                "device_id"
            ]
        );
        assert_eq!(payload["task_id"], json!(0));
        assert_eq!(payload["subtask_id"], json!(7));
        assert_eq!(payload["device_id"], json!("dev"));
    }

    #[test]
    fn the_raw_response_event_carries_the_device_id_exactly_once() {
        // Recording 20261109094939, case 28a1bfc5: the raw emit payload is the
        // frame data plus the receiving device id at the end.
        let data = match json!({
            "event_type": "response.output_text.delta",
            "task_id": 21_577_915_845_411i64,
            "subtask_id": 21_577_915_845_414i64,
            "message_id": 2,
            "data": {
                "type": "response.output_text.delta",
                "item_id": "msg_61ad84848bf541b8935037d2f1afadc7",
                "output_index": 0,
                "content_index": 0,
                "delta": "recording-ok",
                "offset": 0
            }
        }) {
            Value::Object(object) => object,
            other => panic!("object: {other}"),
        };
        let payload = response_api_payload(&data, "socket-recording-ebfb47d1-49a");
        assert_eq!(
            payload,
            json!({
                "event_type": "response.output_text.delta",
                "task_id": 21_577_915_845_411i64,
                "subtask_id": 21_577_915_845_414i64,
                "message_id": 2,
                "data": {
                    "type": "response.output_text.delta",
                    "item_id": "msg_61ad84848bf541b8935037d2f1afadc7",
                    "output_index": 0,
                    "content_index": 0,
                    "delta": "recording-ok",
                    "offset": 0
                },
                "device_id": "socket-recording-ebfb47d1-49a"
            })
        );
    }

    #[test]
    fn a_local_tool_result_carries_the_source_status_and_output() {
        use crate::internal_callback::event::{EventType, ExecutionEvent};

        let mut event = ExecutionEvent::new(EventType::ToolResult, 0, 7);
        event.tool_use_id = Some("tool-1".into());
        event.tool_output = Some(json!("done"));
        event.data.insert("status".into(), json!("failed"));
        let base = Map::new();
        let payload = local_tool_update_payload(&base, &event).expect("payload");
        assert_eq!(payload["block_id"], json!("tool-1"));
        assert_eq!(payload["status"], json!("error"));
        assert_eq!(payload["tool_output"], json!("done"));
    }

    #[test]
    fn a_local_chunk_frame_matches_the_source_shape() {
        use crate::internal_callback::event::{EventType, ExecutionEvent};

        let mut event = ExecutionEvent::new(EventType::Chunk, 0, 7);
        event.content = "recording-ok".into();
        event.message_id = Some(2);
        let base = local_chat_payload("dev", "local", Value::Null, &event);
        let (name, payload) = local_chat_frame(&event, base).expect("frame");
        assert_eq!(name, "chat:chunk");
        assert_eq!(
            Value::Object(payload),
            json!({
                "subtask_id": 7,
                "device_id": "dev",
                "local_task_id": "local",
                "runtime": null,
                "message_id": 2,
                "content": "recording-ok",
                "offset": 0,
            })
        );
    }

    #[test]
    fn a_local_response_created_is_the_source_start_frame() {
        let event = local_execution_event(
            "response.created",
            &json!({"type": "response.created"}),
            9,
            None,
        )
        .expect("event")
        .expect("start");
        assert_eq!(event.event_type, "start");
        assert_eq!(event.task_id, 0);
        assert_eq!(event.subtask_id, 9);
        assert_eq!(event.data.get("shell_type"), Some(&json!("Codex")));
    }
}
