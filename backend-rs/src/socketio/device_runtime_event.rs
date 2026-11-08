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

use crate::json_compat::{python_json_compact, python_json_value, python_str, python_truthy};
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
    user_id: i64,
    device_id: &str,
    logical_device_id: &str,
    data: &Map<String, Value>,
) -> Result<Value, crate::BoxError> {
    let envelope = working_envelope(data, logical_device_id);
    if let Some(identity) = RuntimeIdentity::parse(&envelope)
        && let Some(projected) =
            runtime_projection::project(state, user_id, device_id, &identity).await?
    {
        emit_project_chat(state, runtime, &projected).await;
    }
    // `sio.emit` delivers to local sockets first (`_handle_emit`) and then
    // publishes through the Redis adapter.
    if let Err(error) = runtime.emitters().runtime_event(user_id, &envelope).await {
        tracing::warn!(%error, user_id, "runtime:event local delivery failed");
    }
    publish_room_event(
        state,
        RUNTIME_EVENT,
        &envelope,
        RUNTIME_NAMESPACE,
        &runtime_user_room(user_id),
    )
    .await;
    publish_live(state, user_id, device_id, &envelope).await;
    forward_channel_event(&envelope);
    notify_runtime_event(&envelope);
    Ok(accepted())
}

/// `sio.emit(PROJECT_CHAT_* , message, room=project_chat_room(...))`.
async fn emit_project_chat(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
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
fn forward_channel_event(envelope: &Value) {
    let Some(payload) = envelope.get("payload") else {
        return;
    };
    let source = payload.get("source");
    if source.is_none_or(|source| source.get("source").and_then(Value::as_str) != Some("im")) {
        return;
    }
    let task_id = payload.get("taskId").and_then(Value::as_str);
    tracing::warn!(task_id, "IM runtime event forwarding is not ported");
}

/// `_notify_runtime_event`: best-effort IM delivery for terminal events.
fn notify_runtime_event(envelope: &Value) {
    let Some(payload) = envelope.get("payload") else {
        return;
    };
    let source = payload.get("source");
    if source.is_some_and(|source| source.get("source").and_then(Value::as_str) == Some("im")) {
        return;
    }
    let has_task = payload
        .get("taskId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let event_type = payload.get("event_type").and_then(Value::as_str);
    let Some(event_type) = event_type.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    if !has_task || !TERMINAL_EVENT_TYPES.contains(&event_type) {
        return;
    }
    let task_id = payload.get("taskId").and_then(Value::as_str);
    tracing::warn!(
        task_id,
        event_type,
        "Terminal Runtime event IM notification is not ported"
    );
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
}
