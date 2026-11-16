// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` `runtime:event`: project the durable half and relay the
//! envelope to Wework Runtime subscribers.
//!
//! Source: `app/api/ws/device_namespace.py::on_runtime_event` ->
//! `_forward_runtime_event`, plus `_project_chat_runtime_event_sync` and the
//! `loop_item_execution_service`/`project_chat_service` projection it calls,
//! `app/services/wework_api/events.py::publish_runtime_event` and
//! `LocalTaskResponsesHandler.forward_runtime_event_to_channels`.
//!
//! A native Runtime event has no callback: the executor sends the envelope and
//! the relay answers nothing. Everything observable happens through the
//! database writes and the Redis publishes.

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::json_compat::{
    python_json_compact, python_json_value, python_str, python_strip, python_truthy,
};
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::runtime_projection::{self, Projected, RuntimeIdentity};
use crate::state::AppState;

/// `WEWORK_RUNTIME_NAMESPACE`.
pub const RUNTIME_NAMESPACE: &str = "/wework-runtime";
/// `WEWORK_RUNTIME_EVENT`, the relay event name.
pub const RUNTIME_EVENT: &str = "runtime:event";
/// `PROJECT_CHAT_CREATED_EVENT`.
pub const PROJECT_CHAT_CREATED_EVENT: &str = "wework:project_chat:message:created";
/// `wework:loop_item:changed` (`loop_item_events.LOOP_ITEM_CHANGED_EVENT`).
pub const LOOP_ITEM_CHANGED_EVENT: &str = "wework:loop_item:changed";
/// `PROJECT_CHAT_AGENT_CHUNK_EVENT`.
pub const PROJECT_CHAT_AGENT_CHUNK_EVENT: &str = "wework:project_chat:agent:chunk";
/// `WEWORK_RUNTIME_USER_ROOM_PREFIX`.
const RUNTIME_USER_ROOM_PREFIX: &str = "wework-runtime:user:";
/// `app.services.wework_api.events.channel` prefix.
const LIVE_CHANNEL_PREFIX: &str = "wework-api:live:";
/// `RUNTIME_TERMINAL_EVENT_TYPES`: the only event names that settle a turn.
pub const TERMINAL_EVENT_TYPES: [&str; 4] = [
    "response.completed",
    "response.failed",
    "response.incomplete",
    "error",
];

/// `on_runtime_event`'s reply when the connection has no device session.
#[must_use]
pub fn unauthenticated() -> Value {
    json!({"error": "Device not authenticated"})
}

/// `on_runtime_event`'s reply for a non-mapping event.
#[must_use]
pub fn invalid_payload() -> Value {
    json!({"error": "Invalid runtime event payload"})
}

/// `_forward_runtime_event`'s success reply.
fn accepted() -> Value {
    json!({"success": true})
}

/// `wework_runtime_user_room(user_id)`.
#[must_use]
pub fn runtime_user_room(user_id: i64) -> String {
    format!("{RUNTIME_USER_ROOM_PREFIX}{user_id}")
}

/// `project_chat_room(project_id, task_id)`.
#[must_use]
pub fn project_chat_room(project_id: &str, task_id: Option<&str>) -> String {
    match task_id.filter(|value| !value.is_empty()) {
        Some(task_id) => format!("wework-project-chat:task:{project_id}:{task_id}"),
        None => format!("wework-project-chat:project:{project_id}"),
    }
}

/// `app.services.wework_api.events.channel`: the per-Task live fanout channel.
#[must_use]
pub fn live_channel(user_id: i64, device_id: &str, task_id: &str) -> String {
    let identity = python_json_compact(&json!([user_id, device_id, task_id]));
    let digest = Sha256::digest(identity.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{LIVE_CHANNEL_PREFIX}{hex}")
}

/// `_forward_runtime_event`'s envelope: the client mapping with `payload`
/// replaced by its nested mapping plus the logical device identity.
#[must_use]
pub fn working_envelope(data: &Map<String, Value>, logical_device_id: &str) -> Value {
    let mut envelope = data.clone();
    envelope.remove("appRemoteTaskAccessEnabled");
    match envelope.get("payload") {
        Some(Value::Object(nested)) => {
            let mut nested = nested.clone();
            nested.insert("deviceId".into(), Value::String(logical_device_id.into()));
            nested.insert("device_id".into(), Value::String(logical_device_id.into()));
            envelope.insert("payload".into(), Value::Object(nested));
        }
        _ => {
            envelope.insert(
                "payload".into(),
                json!({
                    "deviceId": logical_device_id,
                    "device_id": logical_device_id,
                }),
            );
        }
    }
    Value::Object(envelope)
}
/// `_forward_runtime_event`: project, relay to the Runtime namespace room,
/// publish on the Task live channel, then run the IM-only side effects.
pub async fn forward(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
    session: &super::session::SessionSnapshot,
    data: &Map<String, Value>,
) -> Result<Value, crate::BoxError> {
    let user_id = session.user_id;
    let device_id = session
        .device
        .device_id
        .as_deref()
        .expect("registered device");
    let logical_device_id = session
        .device
        .logical_device_id
        .as_deref()
        .unwrap_or(device_id);
    let personal_allowed = super::runtime_rpc_policy::personal_events_allowed(
        session.device.device_type == Some(super::device::DeviceType::App),
        data.get("appRemoteTaskAccessEnabled"),
    );
    let envelope = working_envelope(data, logical_device_id);
    log_terminal_relay(&envelope, user_id, device_id, "received");
    let project_message = project_event(state, runtime, user_id, device_id, &envelope).await?;
    let relay_envelope = if session.device.device_type == Some(super::device::DeviceType::App) {
        working_envelope(envelope.as_object().expect("event object"), device_id)
    } else {
        envelope.clone()
    };
    if personal_allowed || project_message {
        relay_runtime_event(state, runtime, user_id, &relay_envelope).await;
    }
    if personal_allowed {
        publish_live(state, user_id, device_id, &relay_envelope).await;
    }
    forward_channel_event(state, logical_device_id, &envelope).await;
    notify_runtime_event(state, user_id, logical_device_id, &envelope).await;
    log_terminal_relay(&envelope, user_id, device_id, "forwarded");
    Ok(accepted())
}

async fn project_event(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
    user_id: i64,
    device_id: &str,
    envelope: &Value,
) -> Result<bool, crate::BoxError> {
    if let Some(identity) = RuntimeIdentity::parse(envelope)
        && let Some(projected) =
            runtime_projection::project(state, runtime, user_id, device_id, &identity).await?
    {
        let project_message = python_truthy(&projected.message);
        if let Some((activity, allow_review)) = &projected.terminal_activity {
            match crate::background_jobs::robot::project_runtime_completion(
                &state.mysql,
                activity,
                *allow_review,
            )
            .await
            {
                Ok(true) => {
                    super::project_chat_snapshot::publish_item_change(
                        state,
                        runtime,
                        &activity.task_id,
                        0,
                    )
                    .await;
                }
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    %error,
                    item_id = activity.task_id,
                    "Runtime activity completion projection failed"
                ),
            }
        }
        emit_project_chat(state, runtime, &projected).await;
        return Ok(project_message);
    }
    Ok(false)
}

async fn relay_runtime_event(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
    user_id: i64,
    envelope: &Value,
) {
    // `sio.emit` delivers to local sockets first (`_handle_emit`) and then
    // publishes through the Redis adapter.
    if let Err(error) = runtime.emitters().runtime_event(user_id, envelope).await {
        tracing::warn!(%error, user_id, "runtime:event local delivery failed");
    }
    publish_room_event(
        state,
        RUNTIME_EVENT,
        envelope,
        RUNTIME_NAMESPACE,
        &runtime_user_room(user_id),
    )
    .await;
}

fn log_terminal_relay(envelope: &Value, user_id: i64, device_id: &str, phase: &str) {
    let Some(event) = envelope["event"]
        .as_str()
        .filter(|event| TERMINAL_EVENT_TYPES.contains(event))
    else {
        return;
    };
    tracing::info!(
        user_id,
        device_id,
        event,
        phase,
        task_id = envelope["payload"]["taskId"].as_str().unwrap_or_default(),
        event_seq = envelope["payload"]["eventSeq"].as_u64(),
        "runtime terminal relay"
    );
}

/// `sio.emit(PROJECT_CHAT_* , message, room=project_chat_room(...))`.
pub(super) async fn emit_project_chat(
    state: &AppState,
    runtime: &SocketRuntime,
    projected: &Projected,
) {
    let message = &projected.message;
    let project_id = message
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let task_id = message.get("taskId").and_then(Value::as_str);
    let room = project_chat_room(project_id, task_id);
    let event = if projected.delta {
        PROJECT_CHAT_AGENT_CHUNK_EVENT
    } else {
        PROJECT_CHAT_CREATED_EVENT
    };
    if let Err(error) = runtime
        .emitters()
        .project_chat_message(&room, projected.delta, message)
        .await
    {
        tracing::warn!(%error, room, "project chat local delivery failed");
    }
    publish_room_event(state, event, message, RUNTIME_NAMESPACE, &room).await;
}

/// `publish_runtime_event`: the Task-addressed live channel publish.
async fn publish_live(state: &AppState, user_id: i64, device_id: &str, envelope: &Value) {
    let payload = envelope.get("payload").unwrap_or(&Value::Null);
    let task_id = truthy_task_id(payload.get("taskId")).or_else(|| {
        payload
            .get("data")
            .and_then(|data| data.get("taskId"))
            .and_then(|value| truthy_task_id(Some(value)))
    });
    let Some(task_id) = task_id else {
        return;
    };
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    use brz_redis::Redis as _;
    let channel = live_channel(user_id, device_id, &task_id);
    let message = python_json_value(envelope);
    if let Err(error) = redis.publish(channel.as_str(), message).await {
        tracing::error!(%error, user_id, channel, "Runtime live publish failed");
    }
}

/// `payload.get("taskId") or ...` followed by `str(task_id)`.
/// Python truthiness decides both the `or` fallback and the publish: `0`,
/// `0.0`, `False`, `""` and `None` neither publish on their own nor block the
/// `data.taskId` fallback.
fn truthy_task_id(value: Option<&Value>) -> Option<String> {
    value.filter(|value| python_truthy(value)).map(python_str)
}

/// `LocalTaskResponsesHandler.forward_runtime_event_to_channels`: IM channel
/// callbacks only, and only for an `im` source envelope.
async fn forward_channel_event(state: &AppState, device_id: &str, envelope: &Value) {
    use super::device_responses::{
        forward_local_task_callbacks, local_execution_event, runtime_subtask_id,
    };
    use crate::internal_callback::event::{EventType, ExecutionEvent};

    let Some(payload) = envelope.get("payload").and_then(Value::as_object) else {
        return;
    };
    let source = payload.get("source");
    if source.is_none_or(|source| source.get("source").and_then(Value::as_str) != Some("im")) {
        return;
    }
    let task_id = stripped_field(payload, "taskId");
    let event_type = stripped_field(payload, "event_type");
    if task_id.is_empty() || event_type.is_empty() {
        return;
    }
    let subtask_id = runtime_subtask_id(payload, device_id, &task_id);
    let event_data = payload
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let event = if let Some(terminal) = terminal_event(&event_type, &event_data) {
        let kind = match terminal.status {
            "COMPLETED" => EventType::Done,
            "CANCELLED" => EventType::Cancelled,
            _ => EventType::Error,
        };
        let mut event = ExecutionEvent::new(kind, 0, subtask_id);
        if terminal.status == "COMPLETED" {
            event.result = Some(terminal.result);
        } else {
            event.error = Some(terminal.content);
        }
        event
    } else {
        match local_execution_event(&event_type, &Value::Object(event_data), subtask_id, None) {
            Ok(Some(event)) => event,
            Ok(None) => return,
            Err(_) => {
                tracing::warn!(event_type, "Invalid IM Runtime execution event");
                return;
            }
        }
    };
    forward_local_task_callbacks(state, device_id, &task_id, source, &event).await;
}

/// Best-effort notification for terminal events from non-IM Runtime turns.
async fn notify_runtime_event(state: &AppState, user_id: i64, device_id: &str, envelope: &Value) {
    let Some(payload) = envelope.get("payload").and_then(Value::as_object) else {
        return;
    };
    let Some(plan) = notification_plan(user_id, device_id, payload) else {
        return;
    };
    if let Err(error) =
        runtime_im_notification::deliver(state, user_id, device_id, payload, &plan).await
    {
        tracing::warn!(%error, user_id, device_id, local_task_id = plan.local_task_id,
            event_type = plan.event_type, "Runtime event IM delivery failed");
    }
}

#[path = "device_runtime_im_notification.rs"]
mod runtime_im_notification;

/// `RUNTIME_VALUE_ORIGINS`: the `valueOrigin` values the runtime terminal event
/// keeps.
const RUNTIME_VALUE_ORIGINS: [&str; 3] = ["final", "process_fallback", "empty"];

/// The terminal event `_notify_runtime_event` is about to notify for.
#[derive(Debug, PartialEq, Eq)]
struct NotificationPlan {
    local_task_id: String,
    event_type: String,
    status: &'static str,
    content: String,
    waiting_for_user_input: bool,
}

/// `_notify_runtime_event`'s guards, in source order: a non-`im` source, a
/// non-empty `taskId`, a terminal `event_type`, a terminal event, and a reply
/// that is neither empty nor merely waiting for user input. Anything else
/// issues no IM notification — and therefore no settings read.
fn notification_plan(
    user_id: i64,
    device_id: &str,
    payload: &Map<String, Value>,
) -> Option<NotificationPlan> {
    if payload
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("source"))
        .and_then(Value::as_str)
        == Some("im")
    {
        return None;
    }

    let local_task_id = stripped_field(payload, "taskId");
    let event_type = stripped_field(payload, "event_type");
    if local_task_id.is_empty()
        || event_type.is_empty()
        || !TERMINAL_EVENT_TYPES.contains(&event_type.as_str())
    {
        return None;
    }

    let event_data = payload
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let event = terminal_event(&event_type, &event_data)?;
    let waiting_for_user_input = waits_for_user_input(&event_data, payload, &event.result);
    if event.status == "COMPLETED"
        && python_strip(&event.content).is_empty()
        && !waiting_for_user_input
    {
        tracing::info!(
            user_id,
            device_id,
            local_task_id,
            event_type,
            "Skipped empty Runtime reply"
        );
        return None;
    }

    Some(NotificationPlan {
        local_task_id,
        event_type,
        status: event.status,
        content: event.content,
        waiting_for_user_input,
    })
}

/// `str(payload.get(key) or "").strip()`.
fn stripped_field(payload: &Map<String, Value>, key: &str) -> String {
    payload
        .get(key)
        .filter(|value| python_truthy(value))
        .map(python_str)
        .map(|value| python_strip(&value))
        .unwrap_or_default()
}

/// The subset of `ExecutionEvent` `_notify_runtime_event` reads: the terminal
/// status, the reply text, and the result mapping `_waits_for_user_input`
/// scans.
#[derive(Debug)]
struct TerminalEvent {
    status: &'static str,
    content: String,
    result: Value,
}

/// `runtime_terminal_event(...) or self.execution_event(...)`.
fn terminal_event(event_type: &str, event_data: &Map<String, Value>) -> Option<TerminalEvent> {
    match event_type {
        "response.completed" => Some(completed_event(event_data)),
        "response.failed" => Some(error_event(event_data, "FAILED")),
        "response.incomplete" => Some(error_event(event_data, "CANCELLED")),
        // `runtime_terminal_event` declines a bare `error`; the shared parser
        // then builds an ERROR event from `data.message`.
        "error" => Some(TerminalEvent {
            status: "FAILED",
            content: match event_data.get("message") {
                Some(value) if python_truthy(value) => python_str(value),
                Some(_) => String::new(),
                None => "Unknown error".to_owned(),
            },
            result: Value::Object(Map::new()),
        }),
        _ => None,
    }
}

/// `runtime_terminal_event` for `response.completed`, falling back to the
/// shared parser's `response.completed` branch when `data.value` is absent.
fn completed_event(event_data: &Map<String, Value>) -> TerminalEvent {
    if event_data.contains_key("value") {
        let value = event_data
            .get("value")
            .filter(|value| python_truthy(value))
            .map(python_str)
            .unwrap_or_default();
        let mut result = Map::new();
        result.insert("value".into(), Value::String(value.clone()));
        if let Some(origin) = event_data.get("valueOrigin").and_then(Value::as_str)
            && RUNTIME_VALUE_ORIGINS.contains(&origin)
        {
            result.insert("value_origin".into(), Value::String(origin.to_owned()));
        }
        for field in ["stop_reason", "silent_exit", "silent_exit_reason"] {
            if let Some(field_value) = event_data.get(field) {
                result.insert(field.to_owned(), field_value.clone());
            }
        }
        return TerminalEvent {
            status: "COMPLETED",
            content: value,
            result: Value::Object(result),
        };
    }

    // `execution_event` -> `ResponsesAPIEventParser.parse`:
    // `extract_completed_result(data.get("response", {}))`.
    let result = completed_response_result(event_data.get("response").and_then(Value::as_object));
    let content = result
        .get("value")
        .filter(|value| python_truthy(value))
        .map(python_str)
        .unwrap_or_default();
    TerminalEvent {
        status: "COMPLETED",
        content,
        result: Value::Object(result),
    }
}

/// The `extract_completed_result` fields this path reads: the concatenated
/// output text and the waiting marker.
fn completed_response_result(response: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut value = String::new();
    if let Some(output) = response
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)
    {
        for item in output {
            let Some(content) = item
                .as_object()
                .and_then(|item| item.get("content"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for block in content {
                let Some(block) = block.as_object() else {
                    continue;
                };
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.is_empty() {
                    continue;
                }
                let included = match block.get("type") {
                    None | Some(Value::Null) => true,
                    Some(Value::String(kind)) => kind == "output_text" || kind == "text",
                    Some(_) => false,
                };
                if included {
                    value.push_str(text);
                }
            }
        }
    }

    let mut result = Map::new();
    result.insert("value".into(), Value::String(value));
    if let Some(reason) = response.and_then(|response| response.get("silent_exit_reason")) {
        result.insert("silent_exit_reason".into(), reason.clone());
    }
    result
}

/// `runtime_terminal_event` for `response.failed` / `response.incomplete`:
/// `event.error` is the nested error message, or the Responses API response's
/// error message.
fn error_event(event_data: &Map<String, Value>, status: &'static str) -> TerminalEvent {
    let error = match event_data.get("error") {
        Some(error) if error.is_object() => Some(error),
        _ => event_data
            .get("response")
            .and_then(Value::as_object)
            .and_then(|response| response.get("error")),
    };
    let content = error
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .filter(|message| python_truthy(message))
        .map(python_str)
        .unwrap_or_default();
    TerminalEvent {
        status,
        content,
        result: Value::Object(Map::new()),
    }
}

/// `_waits_for_user_input(*payloads)`: any mapping — the event data, the
/// envelope payload, or the parsed result — carrying the marker directly or
/// under its nested `response`.
fn waits_for_user_input(
    event_data: &Map<String, Value>,
    payload: &Map<String, Value>,
    result: &Value,
) -> bool {
    let marker = Some("waiting_for_user_input");
    for candidate in [Some(event_data), Some(payload), result.as_object()] {
        let Some(candidate) = candidate else {
            continue;
        };
        if candidate.get("silent_exit_reason").and_then(Value::as_str) == marker {
            return true;
        }
        if candidate
            .get("response")
            .and_then(Value::as_object)
            .and_then(|response| response.get("silent_exit_reason"))
            .and_then(Value::as_str)
            == marker
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_live_channel_hashes_the_python_identity() {
        assert_eq!(
            live_channel(
                3246,
                "d30dc060-a1e9-40d6-bbfe-9cecf790f04d",
                "runtime-958444342"
            ),
            "wework-api:live:316423e8c73ddf248bbecdc44406d17004a081eb8a299c299a5453636fb9a656"
        );
    }

    #[test]
    fn the_relay_room_is_user_addressed() {
        assert_eq!(runtime_user_room(3246), "wework-runtime:user:3246");
        assert_eq!(
            project_chat_room("project-1", Some("issue-1")),
            "wework-project-chat:task:project-1:issue-1"
        );
        assert_eq!(
            project_chat_room("project-1", None),
            "wework-project-chat:project:project-1"
        );
    }

    #[test]
    fn the_envelope_injects_the_logical_device_identity() {
        let data = json!({
            "event": "response.block.created",
            "payload": {"taskId": "runtime-1", "data": {"kind": "text"}},
            "type": "event"
        });
        let envelope = working_envelope(data.as_object().unwrap(), "logical-7");
        let nested = envelope.get("payload").unwrap().as_object().unwrap();
        assert_eq!(nested.get("deviceId").unwrap(), "logical-7");
        assert_eq!(nested.get("device_id").unwrap(), "logical-7");
        assert_eq!(nested.get("taskId").unwrap(), "runtime-1");
        assert_eq!(envelope.get("type").unwrap(), "event");
    }

    #[test]
    fn a_missing_nested_payload_becomes_the_device_identity() {
        let data = json!({"event": "x"});
        let envelope = working_envelope(data.as_object().unwrap(), "logical-7");
        assert_eq!(
            envelope.get("payload").unwrap(),
            &json!({"deviceId": "logical-7", "device_id": "logical-7"})
        );
    }

    #[test]
    fn consent_markers_stay_private_and_app_readers_get_the_record_route() {
        let data = json!({
            "event": "response.output_text.delta",
            "appRemoteTaskAccessEnabled": true,
            "payload": {"taskId": "task-1", "deviceId": "reported-id"}
        });
        let persisted = working_envelope(data.as_object().unwrap(), "logical-id");
        let relayed = working_envelope(persisted.as_object().unwrap(), "app-record-72");
        assert!(relayed.get("appRemoteTaskAccessEnabled").is_none());
        assert_eq!(persisted["payload"]["deviceId"], "logical-id");
        assert_eq!(relayed["payload"]["deviceId"], "app-record-72");
        assert_eq!(relayed["payload"]["device_id"], "app-record-72");
        assert_eq!(relayed["payload"]["taskId"], "task-1");
    }

    #[test]
    fn the_identity_prefers_the_camel_case_task_id() {
        let envelope = json!({
            "event": "response.block.created",
            "payload": {"taskId": "runtime-1", "localTaskId": "runtime-2"}
        });
        let identity = RuntimeIdentity::parse(&envelope).expect("identity");
        assert_eq!(identity.runtime_task_id, "runtime-1");
        assert_eq!(identity.event_name, "response.block.created");
    }

    #[test]
    fn a_zero_task_id_falls_back_to_the_nested_value() {
        let payload = json!({"taskId": 0, "data": {"taskId": "fallback"}});
        let selected = truthy_task_id(payload.get("taskId")).or_else(|| {
            payload
                .get("data")
                .and_then(|data| data.get("taskId"))
                .and_then(|value| truthy_task_id(Some(value)))
        });
        assert_eq!(selected.as_deref(), Some("fallback"));
    }

    #[test]
    fn a_falsy_task_id_without_fallback_publishes_nothing() {
        assert_eq!(truthy_task_id(Some(&json!(0))), None);
        assert_eq!(truthy_task_id(Some(&json!(0.0))), None);
        assert_eq!(truthy_task_id(Some(&json!(false))), None);
        assert_eq!(truthy_task_id(Some(&json!(""))), None);
        assert_eq!(truthy_task_id(Some(&Value::Null)), None);
        assert_eq!(truthy_task_id(None), None);
    }

    #[test]
    fn a_string_task_id_is_published_unchanged() {
        assert_eq!(
            truthy_task_id(Some(&json!("runtime-1"))),
            Some("runtime-1".into())
        );
        assert_eq!(truthy_task_id(Some(&json!(7))), Some("7".into()));
    }

    #[test]
    fn terminal_event_names_match_the_source_set() {
        assert!(TERMINAL_EVENT_TYPES.contains(&"response.completed"));
        assert!(!TERMINAL_EVENT_TYPES.contains(&"response.block.created"));
        assert!(!TERMINAL_EVENT_TYPES.contains(&"thread/tokenUsage/updated"));
    }

    fn plan(value: Value) -> Option<NotificationPlan> {
        notification_plan(273, "device-a", value.as_object().expect("payload object"))
    }

    #[test]
    fn an_im_sourced_event_is_never_notified() {
        let outcome = plan(json!({
            "taskId": "runtime-1",
            "event_type": "response.completed",
            "source": {"source": "im"},
            "data": {"value": "done"},
        }));
        assert!(outcome.is_none());
    }

    #[test]
    fn a_notification_requires_a_task_and_a_terminal_type() {
        assert!(
            plan(json!({
                "event_type": "response.completed",
                "data": {"value": "done"},
            }))
            .is_none()
        );
        assert!(
            plan(json!({
                "taskId": "   ",
                "event_type": "response.completed",
                "data": {"value": "done"},
            }))
            .is_none()
        );
        assert!(
            plan(json!({
                "taskId": "runtime-1",
                "event_type": "response.block.created",
                "data": {"value": "done"},
            }))
            .is_none()
        );
        assert!(
            plan(json!({
                "taskId": "runtime-1",
                "event_type": "",
                "data": {"value": "done"},
            }))
            .is_none()
        );
    }

    #[test]
    fn a_completed_reply_becomes_a_notification_plan() {
        let outcome = plan(json!({
            "taskId": "  runtime-1  ",
            "event_type": "response.completed",
            "data": {"value": "done", "valueOrigin": "final"},
        }))
        .expect("plan");
        assert_eq!(outcome.local_task_id, "runtime-1");
        assert_eq!(outcome.event_type, "response.completed");
        assert_eq!(outcome.status, "COMPLETED");
        assert_eq!(outcome.content, "done");
    }

    #[test]
    fn an_empty_completed_reply_is_skipped() {
        // `data.value` present but empty: the source's `COMPLETED` reply with
        // no content and no waiting marker returns before any IM settings read.
        assert!(
            plan(json!({
                "taskId": "runtime-1",
                "event_type": "response.completed",
                "data": {"value": ""},
            }))
            .is_none()
        );
        // No `data.value` and no parsable response object.
        assert!(
            plan(json!({
                "taskId": "runtime-1",
                "event_type": "response.completed",
                "data": {},
            }))
            .is_none()
        );
    }

    #[test]
    fn a_completed_reply_without_value_reads_the_response_output() {
        let outcome = plan(json!({
            "taskId": "runtime-1",
            "event_type": "response.completed",
            "data": {"response": {"output": [{"content": [
                {"type": "output_text", "text": "hel"},
                {"type": "reasoning", "text": "ignored"},
                {"text": "lo"},
            ]}]}},
        }))
        .expect("plan");
        assert_eq!(outcome.status, "COMPLETED");
        assert_eq!(outcome.content, "hello");
    }

    #[test]
    fn an_empty_reply_waiting_for_user_input_is_notified() {
        let direct = plan(json!({
            "taskId": "runtime-1",
            "event_type": "response.completed",
            "data": {"value": "", "silent_exit_reason": "waiting_for_user_input"},
        }))
        .expect("plan");
        assert_eq!(direct.status, "COMPLETED");
        assert_eq!(direct.content, "");

        let nested = plan(json!({
            "taskId": "runtime-1",
            "event_type": "response.completed",
            "data": {"response": {"silent_exit_reason": "waiting_for_user_input"}},
        }))
        .expect("plan");
        assert_eq!(nested.status, "COMPLETED");
        assert_eq!(nested.content, "");
    }

    #[test]
    fn an_error_event_uses_the_message_as_content() {
        let outcome = plan(json!({
            "taskId": "runtime-1",
            "event_type": "error",
            "data": {"message": "boom"},
        }))
        .expect("plan");
        assert_eq!(outcome.status, "FAILED");
        assert_eq!(outcome.content, "boom");

        let defaulted = plan(json!({
            "taskId": "runtime-1",
            "event_type": "error",
            "data": {},
        }))
        .expect("plan");
        assert_eq!(defaulted.content, "Unknown error");
    }

    #[test]
    fn failed_and_incomplete_events_use_the_error_message() {
        let failed = plan(json!({
            "taskId": "runtime-1",
            "event_type": "response.failed",
            "data": {"error": {"message": "bad"}},
        }))
        .expect("plan");
        assert_eq!(failed.status, "FAILED");
        assert_eq!(failed.content, "bad");

        let incomplete = plan(json!({
            "taskId": "runtime-1",
            "event_type": "response.incomplete",
            "data": {"response": {"error": {"message": "cut"}}},
        }))
        .expect("plan");
        assert_eq!(incomplete.status, "CANCELLED");
        assert_eq!(incomplete.content, "cut");
    }
}
