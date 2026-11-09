// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework Responses create branch
//! (`app/api/endpoints/openapi_responses.py:498-500` handing off to
//! `app/api/endpoints/wework_api.py` and `app/services/wework_api/**`).
//!
//! Stage 1 covers request discrimination, the `WeworkResponseCreate` schema,
//! the `resp_`/`conv_` identity handles, model selection over the Wework model
//! catalog, and the new-conversation `runtime.tasks.create` dispatch with the
//! `queued` snapshot. Existing-conversation send/live projection is stage 2.
use base64::Engine as _;
use brz_http_server::{Bytes, StatusCode};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::seam::{self, BodyStream};
use crate::background_jobs::project::runtime_rpc;
use crate::http_compat::FastApiError;
use crate::responses::auth::DeferredResponsesUser;
use crate::responses::rate_limit::{self, RateLimit};
use crate::state::AppState;

use models::{ModelSelection, model_selection};
use runtime::{
    create_payload, ensure_device_online, ensure_owned_device, find_conversation, merged_selection,
    runtime_task_title, send_message,
};

/// `is_wework_response_id`: native Wework ids encode a JSON array, whose
/// base64url prefix is always `Wy`.
const WEWORK_RESPONSE_ID_PREFIX: &str = "resp_Wy";

/// `_runtime_execution_ids`'s lower bound (`10_000_000_000_000`).
const RUNTIME_EXECUTION_ID_BASE: i64 = 10_000_000_000_000;
/// `_runtime_execution_ids`'s span (`8_000_000_000_000`).
const RUNTIME_EXECUTION_ID_SPAN: u64 = 8_000_000_000_000;

/// `response_execution_type`: a request whose `execution.type` is `wework`, or
/// that continues a native conversation, takes the Wework branch.
pub(crate) fn is_wework_request(body: &Value) -> bool {
    if !body.is_object() {
        return false;
    }
    if body
        .get("conversation")
        .is_some_and(|value| !value.is_null())
    {
        return true;
    }
    if body
        .get("previous_response_id")
        .and_then(Value::as_str)
        .is_some_and(|identifier| identifier.starts_with(WEWORK_RESPONSE_ID_PREFIX))
    {
        return true;
    }
    body.get("execution")
        .and_then(|execution| execution.get("type"))
        .and_then(Value::as_str)
        == Some("wework")
}

/// `current_api_user`'s rejection (`wework_api.py:35-42`): a missing, invalid,
/// non-personal, expired or owner-inactive key is the same `401`.
fn second_auth_required() -> FastApiError {
    FastApiError::detail(
        StatusCode::UNAUTHORIZED,
        "A valid personal Wegent API key is required",
    )
}

/// `WeworkExecution` (`app/schemas/wework_api.py`), `extra="forbid"`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WeworkExecution {
    #[serde(rename = "type")]
    execution_type: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(rename = "model_type", default)]
    model_type: Option<String>,
    #[serde(rename = "model_options", default)]
    model_options: Map<String, Value>,
}

/// `WeworkResponseCreate`, `extra="forbid"`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WeworkResponseCreate {
    model: String,
    input: Value,
    #[serde(default)]
    conversation: Option<String>,
    #[serde(default)]
    previous_response_id: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::legacy_boolean")]
    stream: bool,
    #[serde(default, deserialize_with = "brz_json::adapters::legacy_boolean")]
    background: bool,
    #[serde(default)]
    execution: Option<WeworkExecution>,
}

impl WeworkResponseCreate {
    /// `WeworkResponseCreate.input_text`.
    fn input_text(&self) -> String {
        match &self.input {
            Value::String(text) => text.clone(),
            Value::Array(messages) => messages
                .iter()
                .map(|message| match message.get("content") {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        }
    }

    /// `WeworkResponseCreate.validate_intent`.
    fn validate_intent(&self) -> Result<(), FastApiError> {
        if self.input_text().trim().is_empty() {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "input must contain user text",
            ));
        }
        if self.conversation.is_some() && self.previous_response_id.is_some() {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "conversation and previous_response_id are mutually exclusive",
            ));
        }
        let has_device = self
            .execution
            .as_ref()
            .and_then(|execution| execution.device_id.as_deref())
            .is_some();
        let has_title = self
            .execution
            .as_ref()
            .and_then(|execution| execution.title.as_deref())
            .is_some();
        if self.conversation.is_none() && self.previous_response_id.is_none() {
            if !has_device {
                return Err(FastApiError::detail(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "execution.device_id is required for a new conversation",
                ));
            }
        } else if has_device || has_title {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "device_id and title can only be set on a new conversation",
            ));
        }
        Ok(())
    }
}

/// `_encode`: `<prefix>` + base64url(JSON array) without padding.
fn encode_identity(prefix: &str, parts: &[&str]) -> String {
    let payload = serde_json::to_vec(parts).expect("JSON arrays of strings serialize");
    format!(
        "{prefix}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
    )
}

/// `conversation_id`.
fn conversation_id(device_id: &str, task_id: &str) -> String {
    encode_identity("conv_", &[device_id, task_id])
}

/// A `uuid.uuid4()`-shaped identifier (lowercase, dashed).
fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

/// The selected cloud model (`RuntimeModelSelection`).
/// `_runtime_execution_ids`: one base id and its successor.
fn decode_identity(
    identifier: &str,
    prefix: &str,
    count: usize,
) -> Result<Vec<String>, FastApiError> {
    let invalid = || FastApiError::detail(StatusCode::BAD_REQUEST, "Invalid Wework resource ID");
    if !identifier.starts_with(prefix) || identifier.len() > 8192 {
        return Err(invalid());
    }
    let value = &identifier[prefix.len()..];
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid())?;
    let parts: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if parts.len() != count {
        return Err(invalid());
    }
    parts
        .into_iter()
        .map(|part| {
            part.as_str()
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .ok_or_else(invalid)
        })
        .collect()
}

/// `conversation_address`: `conv_` `[device_id, task_id]`.
fn conversation_address(identifier: &str) -> Result<(String, String), FastApiError> {
    let parts = decode_identity(identifier, "conv_", 2)?;
    Ok((parts[0].clone(), parts[1].clone()))
}

/// `ResponseIdentity.parse`: `resp_` `[device_id, task_id, message_id]`.
fn response_identity(identifier: &str) -> Result<(String, String, String), FastApiError> {
    let parts = decode_identity(identifier, "resp_", 3)?;
    Ok((parts[0].clone(), parts[1].clone(), parts[2].clone()))
}

/// `events.channel`: `wework-api:live:` + sha256(json([user, device, task])).
fn live_channel(user_id: i64, device_id: &str, task_id: &str) -> String {
    use sha2::{Digest as _, Sha256};
    let identity = serde_json::to_vec(&json!([user_id, device_id, task_id]))
        .expect("identity JSON serializes");
    let digest = Sha256::digest(identity);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("wework-api:live:{hex}")
}

fn message_item(snapshot: &mut Value) -> &mut Value {
    if !snapshot["output"].is_array() {
        snapshot["output"] = json!([]);
    }
    let item_id = format!("msg_{}", snapshot["id"].as_str().unwrap_or_default());
    let output = snapshot["output"].as_array_mut().expect("output array");
    if let Some(index) = output
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
    {
        return &mut output[index];
    }
    output.push(json!({
        "id": item_id,
        "type": "message",
        "role": "assistant",
        "status": "in_progress",
        "content": [{"type": "output_text", "text": "", "annotations": []}],
    }));
    let index = output.len() - 1;
    &mut output[index]
}

fn append_delta(snapshot: &mut Value, delta: &str) {
    let item_id = format!("msg_{}", snapshot["id"].as_str().unwrap_or_default());
    let item = message_item(snapshot);
    let _ = item_id;
    if let Some(text) = item["content"][0]["text"].as_str() {
        let combined = format!("{text}{delta}");
        item["content"][0]["text"] = Value::String(combined);
    }
}

fn set_text(snapshot: &mut Value, text: &str) {
    let item = message_item(snapshot);
    item["content"][0]["text"] = Value::String(text.to_string());
}

/// `projection.terminal`: settle the snapshot and every in-progress item.
fn finish_snapshot(snapshot: &mut Value, status: &str, error: Option<Value>) {
    snapshot["status"] = json!(status);
    snapshot["error"] = error.unwrap_or(Value::Null);
    snapshot["is_latest"] = json!(true);
    if let Some(items) = snapshot["output"].as_array_mut() {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("message")
                && item.get("status").and_then(Value::as_str) == Some("in_progress")
            {
                item["status"] = json!(if status == "completed" {
                    "completed"
                } else {
                    "incomplete"
                });
            }
        }
    }
}

/// `project_chat_service._project_chat_terminal_status`: normalize a runtime
/// event/settle status to the durable terminal state.
fn native_terminal_status(event: &str, payload: &Value, data: &Value) -> Option<&'static str> {
    const CANCELLED_EVENTS: [&str; 5] = [
        "cancelled",
        "canceled",
        "runtime.task.cancelled",
        "runtime_task.cancelled",
        "runtime.tasks.cancelled",
    ];
    const COMPLETED_EVENTS: [&str; 9] = [
        "response.completed",
        "chat:done",
        "done",
        "task.done",
        "turn.done",
        "turn.completed",
        "runtime.task.completed",
        "runtime_task.completed",
        "runtime.tasks.completed",
    ];
    const FAILED_EVENTS: [&str; 10] = [
        "response.failed",
        "response.incomplete",
        "error",
        "chat:error",
        "failed",
        "task.failed",
        "turn.failed",
        "runtime.task.failed",
        "runtime_task.failed",
        "runtime.tasks.failed",
    ];
    const CANCELLED_STATUSES: [&str; 2] = ["cancelled", "canceled"];
    const COMPLETED_STATUSES: [&str; 5] = ["completed", "done", "succeeded", "success", "idle"];
    const FAILED_STATUSES: [&str; 3] = ["failed", "failure", "error"];
    if CANCELLED_EVENTS.contains(&event) {
        return Some("cancelled");
    }
    let status = data
        .get("status")
        .or_else(|| data.get("taskStatus"))
        .or_else(|| data.get("task_status"))
        .or_else(|| payload.get("status"))
        .and_then(Value::as_str);
    let normalized = status.map(|value| value.trim().replace(['_', '-'], "").to_lowercase());
    if normalized
        .as_deref()
        .is_some_and(|value| CANCELLED_STATUSES.contains(&value))
    {
        return Some("cancelled");
    }
    if COMPLETED_EVENTS.contains(&event) {
        return Some("completed");
    }
    if FAILED_EVENTS.contains(&event) {
        return Some("failed");
    }
    if let Some(value) = normalized.as_deref() {
        if COMPLETED_STATUSES.contains(&value) {
            return Some("completed");
        }
        if FAILED_STATUSES.contains(&value) {
            return Some("failed");
        }
    }
    None
}

/// `_project_output_item`'s `ResponseOutputItem` validation: illegal items are
/// ignored rather than projected.
fn valid_output_item(item: &Value) -> Option<Map<String, Value>> {
    let object = item.as_object()?;
    let item_type = object.get("type")?.as_str()?;
    object.get("id")?.as_str()?;
    if item_type == "message" {
        object.get("role")?.as_str()?;
        object.get("content")?.as_array()?;
    }
    Some(object.clone())
}

/// `_project_output_item`: message items feed the stable text item; other
/// items are upserted by id.
fn project_output_item(snapshot: &mut Value, name: &str, data: &Value) {
    let Some(item) = data.get("item").and_then(valid_output_item) else {
        return;
    };
    if item.get("type").and_then(Value::as_str) == Some("message") {
        if name.ends_with(".done")
            && let Some(content) = item.get("content")
        {
            message_item(snapshot)["content"] = content.clone();
        }
        return;
    }
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !snapshot["output"].is_array() {
        snapshot["output"] = json!([]);
    }
    let output = snapshot["output"].as_array_mut().expect("output array");
    if let Some(index) = output
        .iter()
        .position(|existing| existing.get("id").and_then(Value::as_str) == Some(item_id.as_str()))
    {
        output[index] = Value::Object(item);
    } else {
        output.push(Value::Object(item));
    }
}

/// `projection` error normalization: `{code, message}`.
fn normalize_error(error: Option<&Value>) -> Option<Value> {
    let error = error?;
    Some(match error {
        Value::Object(object) => {
            let message = object
                .get("message")
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string())
                })
                .unwrap_or_else(|| "Runtime execution failed".to_string());
            json!({
                "code": object.get("code").and_then(Value::as_str).unwrap_or("runtime_error"),
                "message": message,
            })
        }
        other => json!({
            "code": "runtime_error",
            "message": other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string()),
        }),
    })
}

/// `projection.project`: the allow-listed event subset the runtime emits.
fn project_envelope(snapshot: &mut Value, envelope: &Value) -> bool {
    const ALLOWED: [&str; 7] = [
        "response.created",
        "response.in_progress",
        "response.output_text.delta",
        "response.output_text.done",
        "response.output_item.added",
        "response.output_item.done",
        "response.incomplete",
    ];
    const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "incomplete"];
    if snapshot["status"]
        .as_str()
        .is_some_and(|status| TERMINAL.contains(&status))
    {
        return false;
    }
    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
    let data = payload.get("data").cloned().unwrap_or_else(|| json!({}));
    let mut name = envelope
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| payload.get("event_type").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let native = native_terminal_status(&name, &payload, &data);
    if let Some(status) = native {
        if name != "response.incomplete" || status == "cancelled" {
            name = match status {
                "completed" => "response.completed",
                "failed" => "response.failed",
                _ => "response.incomplete",
            }
            .to_string();
        }
    } else if !ALLOWED.contains(&name.as_str()) {
        return false;
    }
    if snapshot["status"].as_str() == Some("queued") {
        snapshot["status"] = json!("in_progress");
    }
    match name.as_str() {
        "response.output_text.delta" => {
            if let Some(delta) = data.get("delta").and_then(Value::as_str)
                && !delta.is_empty()
            {
                append_delta(snapshot, delta);
            }
            false
        }
        "response.output_text.done" => {
            if let Some(text) = data
                .get("text")
                .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                .or_else(|| {
                    data.get("value")
                        .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                })
                .or_else(|| data.get("output_text"))
                .and_then(Value::as_str)
            {
                set_text(snapshot, text);
            }
            false
        }
        "response.output_item.added" | "response.output_item.done" => {
            project_output_item(snapshot, &name, &data);
            false
        }
        "response.completed" | "response.failed" | "response.incomplete" | "error" => {
            let final_response = data.get("response").cloned().unwrap_or_else(|| json!({}));
            if let Some(value) = data.get("value").and_then(Value::as_str) {
                set_text(snapshot, value);
            }
            if snapshot["output"]
                .as_array()
                .is_none_or(|items| items.is_empty())
                && let Some(items) = final_response.get("output").and_then(Value::as_array)
            {
                for item in items {
                    project_output_item(
                        snapshot,
                        "response.output_item.done",
                        &json!({"item": item}),
                    );
                }
            }
            let mut status = match name.as_str() {
                "response.completed" => "completed",
                "response.incomplete" => "incomplete",
                _ => "failed",
            };
            let cancelled_hint = data
                .get("status")
                .or_else(|| final_response.get("status"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_lowercase())
                .is_some_and(|value| value == "cancelled" || value == "canceled");
            if name == "response.incomplete"
                && (native == Some("cancelled")
                    || snapshot
                        .get("cancellation_requested")
                        .and_then(Value::as_bool)
                        == Some(true)
                    || cancelled_hint)
            {
                status = "cancelled";
            }
            let error = data.get("error").or_else(|| final_response.get("error"));
            finish_snapshot(snapshot, status, normalize_error(error));
            true
        }
        _ => false,
    }
}

/// `_matches`: the envelope belongs to this response turn.
fn envelope_matches(
    envelope: &Value,
    task_id: &str,
    client_id: &str,
    runtime_turn_id: &mut Option<String>,
) -> bool {
    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    let task = payload
        .get("taskId")
        .or_else(|| data.get("taskId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if task != task_id {
        return false;
    }
    let turn_id = payload
        .get("subtaskId")
        .or_else(|| payload.get("subtask_id"))
        .or_else(|| data.get("subtaskId"))
        .or_else(|| data.get("subtask_id"))
        .and_then(Value::as_str);
    if let (Some(turn_id), Some(known)) = (turn_id, runtime_turn_id.as_deref())
        && turn_id != known
    {
        return false;
    }
    let client = payload
        .get("clientUserMessageId")
        .or_else(|| payload.get("client_user_message_id"))
        .or_else(|| data.get("clientUserMessageId"))
        .or_else(|| data.get("client_user_message_id"))
        .and_then(Value::as_str);
    if let Some(client) = client {
        if client != client_id {
            return false;
        }
        if let Some(turn_id) = turn_id {
            *runtime_turn_id = Some(turn_id.to_string());
        }
        return true;
    }
    turn_id.is_some() && turn_id == runtime_turn_id.as_deref()
}

/// `projection._message`: the stable assistant text item plus its
/// `output_item.added` / `content_part.added` events on first creation.
fn message_with_events(snapshot: &mut Value, events: &mut Vec<Value>) -> usize {
    let item_id = format!("msg_{}", snapshot["id"].as_str().unwrap_or_default());
    if let Some(items) = snapshot["output"].as_array()
        && let Some(index) = items.iter().position(|item| {
            item.get("id").and_then(Value::as_str) == Some(item_id.as_str())
                && item.get("type").and_then(Value::as_str) == Some("message")
        })
    {
        return index;
    }
    let item = json!({
        "id": item_id,
        "type": "message",
        "role": "assistant",
        "status": "in_progress",
        "content": [{"type": "output_text", "text": "", "annotations": []}],
    });
    let index = snapshot["output"].as_array().map(Vec::len).unwrap_or(0);
    if !snapshot["output"].is_array() {
        snapshot["output"] = json!([]);
    }
    snapshot["output"]
        .as_array_mut()
        .expect("the output array was just ensured")
        .push(item.clone());
    let mut added = item.clone();
    added["content"] = json!([]);
    events.push(json!({
        "type": "response.output_item.added",
        "output_index": index,
        "item": added,
    }));
    events.push(json!({
        "type": "response.content_part.added",
        "item_id": item_id,
        "output_index": index,
        "content_index": 0,
        "part": item["content"][0].clone(),
    }));
    index
}

/// `projection._finish_messages`: close every in-progress text item and emit
/// its `output_text.done` / `content_part.done` / `output_item.done` events.
fn finish_messages_events(snapshot: &mut Value, events: &mut Vec<Value>) {
    let completed = snapshot["status"].as_str() == Some("completed");
    let Some(items) = snapshot["output"].as_array_mut() else {
        return;
    };
    for (index, item) in items.iter_mut().enumerate() {
        if item.get("type").and_then(Value::as_str) != Some("message")
            || item.get("status").and_then(Value::as_str) != Some("in_progress")
        {
            continue;
        }
        item["status"] = json!(if completed { "completed" } else { "incomplete" });
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(parts) = item["content"].as_array() {
            for (content_index, part) in parts.iter().enumerate() {
                if part.get("type").and_then(Value::as_str) != Some("output_text") {
                    continue;
                }
                events.push(json!({
                    "type": "response.output_text.done",
                    "item_id": item_id,
                    "output_index": index,
                    "content_index": content_index,
                    "text": part["text"].clone(),
                }));
                events.push(json!({
                    "type": "response.content_part.done",
                    "item_id": item_id,
                    "output_index": index,
                    "content_index": content_index,
                    "part": part.clone(),
                }));
            }
        }
        events.push(json!({
            "type": "response.output_item.done",
            "output_index": index,
            "item": item.clone(),
        }));
    }
}

/// `projection._project_output_item` with event production: message lifecycle
/// comes from `_message`; other items are upserted and announced by id.
fn project_output_item_events(
    snapshot: &mut Value,
    name: &str,
    data: &Value,
    events: &mut Vec<Value>,
) {
    let Some(item) = data.get("item").and_then(valid_output_item) else {
        return;
    };
    if item.get("type").and_then(Value::as_str) == Some("message") {
        if name.ends_with(".done")
            && let Some(content) = item.get("content")
        {
            message_with_events(snapshot, events);
            message_item(snapshot)["content"] = content.clone();
        }
        return;
    }
    let item_value = Value::Object(item);
    let item_id = item_value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !snapshot["output"].is_array() {
        snapshot["output"] = json!([]);
    }
    let output = snapshot["output"].as_array_mut().expect("output array");
    let existing = output
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(item_id.as_str()));
    let index = existing.unwrap_or_else(|| {
        output.push(item_value.clone());
        output.len() - 1
    });
    if existing.is_none() && name.ends_with(".done") {
        events.push(json!({
            "type": "response.output_item.added",
            "output_index": index,
            "item": item_value.clone(),
        }));
    }
    if existing.is_some() {
        output[index] = item_value.clone();
    }
    events.push(json!({
        "type": name,
        "output_index": index,
        "item": item_value,
    }));
}

/// `projection.terminal`: settle the snapshot and emit the item/part done
/// events followed by `response.<status>`.
fn terminal_events(snapshot: &mut Value, status: &str, error: Option<Value>) -> Vec<Value> {
    snapshot["status"] = json!(status);
    snapshot["error"] = error.unwrap_or(Value::Null);
    snapshot["is_latest"] = json!(true);
    let mut events = Vec::new();
    finish_messages_events(snapshot, &mut events);
    let event_status = if status == "cancelled" {
        "incomplete"
    } else {
        status
    };
    events.push(json!({
        "type": format!("response.{event_status}"),
        "response": snapshot.clone(),
    }));
    events
}

/// `projection.project`: the event list one runtime envelope produces, in the
/// Source's order. The snapshot is mutated in place.
fn project_events(snapshot: &mut Value, envelope: &Value) -> Vec<Value> {
    const ALLOWED: [&str; 7] = [
        "response.created",
        "response.in_progress",
        "response.output_text.delta",
        "response.output_text.done",
        "response.output_item.added",
        "response.output_item.done",
        "response.incomplete",
    ];
    const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "incomplete"];
    let mut events = Vec::new();
    if snapshot["status"]
        .as_str()
        .is_some_and(|status| TERMINAL.contains(&status))
    {
        return events;
    }
    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
    let data = payload.get("data").cloned().unwrap_or_else(|| json!({}));
    let mut name = envelope
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| payload.get("event_type").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let native = native_terminal_status(&name, &payload, &data);
    if let Some(status) = native {
        if name != "response.incomplete" || status == "cancelled" {
            name = match status {
                "completed" => "response.completed",
                "failed" => "response.failed",
                _ => "response.incomplete",
            }
            .to_string();
        }
    } else if !ALLOWED.contains(&name.as_str()) {
        return events;
    }
    if snapshot["status"].as_str() == Some("queued") {
        snapshot["status"] = json!("in_progress");
        events.push(json!({"type": "response.in_progress", "response": snapshot.clone()}));
    }
    match name.as_str() {
        "response.output_text.delta" => {
            let index = message_with_events(snapshot, &mut events);
            if let Some(delta) = data.get("delta").and_then(Value::as_str)
                && !delta.is_empty()
            {
                if let Some(item) = snapshot["output"]
                    .as_array_mut()
                    .and_then(|items| items.get_mut(index))
                {
                    item["content"][0]["text"] = json!(format!(
                        "{}{}",
                        item["content"][0]["text"].as_str().unwrap_or_default(),
                        delta
                    ));
                }
                events.push(json!({
                    "type": name,
                    "item_id": format!("msg_{}", snapshot["id"].as_str().unwrap_or_default()),
                    "output_index": index,
                    "content_index": 0,
                    "delta": delta,
                }));
            }
        }
        "response.output_text.done" => {
            if let Some(text) = data
                .get("text")
                .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                .or_else(|| {
                    data.get("value")
                        .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                })
                .or_else(|| data.get("output_text"))
                .and_then(Value::as_str)
            {
                message_with_events(snapshot, &mut events);
                set_text(snapshot, text);
            }
        }
        "response.output_item.added" | "response.output_item.done" => {
            project_output_item_events(snapshot, &name, &data, &mut events);
        }
        "response.completed" | "response.failed" | "response.incomplete" | "error" => {
            let final_response = data.get("response").cloned().unwrap_or_else(|| json!({}));
            if let Some(value) = data.get("value").and_then(Value::as_str) {
                message_with_events(snapshot, &mut events);
                set_text(snapshot, value);
            }
            if snapshot["output"]
                .as_array()
                .is_none_or(|items| items.is_empty())
                && let Some(items) = final_response.get("output").and_then(Value::as_array)
            {
                for item in items {
                    project_output_item_events(
                        snapshot,
                        "response.output_item.done",
                        &json!({"item": item}),
                        &mut events,
                    );
                }
            }
            let mut status = match name.as_str() {
                "response.completed" => "completed",
                "response.incomplete" => "incomplete",
                _ => "failed",
            };
            let cancelled_hint = data
                .get("status")
                .or_else(|| final_response.get("status"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_lowercase())
                .is_some_and(|value| value == "cancelled" || value == "canceled");
            if name == "response.incomplete"
                && (native == Some("cancelled")
                    || snapshot
                        .get("cancellation_requested")
                        .and_then(Value::as_bool)
                        == Some(true)
                    || cancelled_hint)
            {
                status = "cancelled";
            }
            let error = data.get("error").or_else(|| final_response.get("error"));
            events.extend(terminal_events(snapshot, status, normalize_error(error)));
        }
        _ => {}
    }
    events
}

/// Whether the snapshot reached a terminal status.
fn snapshot_terminal(snapshot: &Value) -> bool {
    snapshot["status"]
        .as_str()
        .is_some_and(|status| matches!(status, "completed" | "failed" | "cancelled" | "incomplete"))
}

/// Render a recorded identity option for comparison.
///
/// Recorded options can store the resource owner as a JSON number while a
/// resolved selection stores the same value as a string, so compare the text
/// form. Missing or non-scalar values cannot identify a model row.
fn recorded_option_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Whether a hidden fallback selection names the conversation's recorded model.
///
/// A recorded selection that lacks the cloud namespace or owner cannot prove
/// which model row it used: the same name can exist in another namespace or
/// belong to another account. Hidden continuations therefore require both
/// sides to carry the same identity options instead of skipping absent keys.
fn recorded_selection_matches(previous: Option<&Value>, selection: &ModelSelection) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    if previous.get("modelName").and_then(Value::as_str) != Some(selection.model_name.as_str())
        || previous.get("modelType").and_then(Value::as_str) != Some(selection.model_type.as_str())
    {
        return false;
    }
    let previous_options = previous.get("options").unwrap_or(&Value::Null);
    for key in [
        "weworkCloudModelNamespace",
        "weworkCloudModelResourceUserId",
    ] {
        if recorded_option_text(previous_options.get(key))
            != recorded_option_text(selection.options.get(key))
        {
            return false;
        }
    }
    true
}

/// The existing-conversation branch: get, checks, send, live wait.
async fn existing_conversation_response(
    state: &AppState,
    user_id: i64,
    body: &WeworkResponseCreate,
    selection: &ModelSelection,
) -> Result<brz_http_server::HttpResponse<BodyStream>, FastApiError> {
    let (device_id, task_id) = match (&body.conversation, &body.previous_response_id) {
        (Some(conversation), _) => conversation_address(conversation)?,
        (None, Some(previous)) => {
            let (device_id, task_id, _) = response_identity(previous)?;
            (device_id, task_id)
        }
        (None, None) => {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "conversation or previous_response_id is required",
            ));
        }
    };
    let task = find_conversation(state, user_id, &device_id, &task_id).await?;
    if task.running {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Conversation is already running",
        ));
    }
    if task.runtime != "codex" {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Creating responses currently requires a Codex conversation",
        ));
    }
    let previous_selection = task
        .runtime_handle
        .as_ref()
        .and_then(|handle| handle.get("modelSelection"));
    if selection.from_persisted && !recorded_selection_matches(previous_selection, selection) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Hidden model does not match the conversation's recorded model",
        ));
    }
    let selection = merged_selection(previous_selection, selection);
    let message = body.input_text();
    let title = runtime_task_title(body);
    let message_id = uuid_v4();
    let response_id = encode_identity("resp_", &[&device_id, &task_id, &message_id]);
    let conversation = conversation_id(&device_id, &task_id);
    let mut snapshot = queued_snapshot(
        &response_id,
        chrono::Utc::now().timestamp(),
        &body.model,
        body.previous_response_id.as_deref(),
        &conversation,
    );
    // Subscribe before dispatch so the terminal event cannot be missed.
    let channel = live_channel(user_id, &device_id, &task_id);
    let Some(redis) = state.redis.as_ref() else {
        return Err(FastApiError::internal());
    };
    let mut subscription = redis.subscribe(channel.as_str()).await.map_err(|error| {
        tracing::error!(?error, "wework live subscription failed");
        FastApiError::internal()
    })?;
    send_message(
        state,
        user_id,
        &device_id,
        &task_id,
        &task.workspace_path,
        &message,
        &message_id,
        &title,
        &selection,
    )
    .await?;
    let mut runtime_turn_id: Option<String> = None;
    let wait = async {
        loop {
            match tokio::time::timeout(
                std::time::Duration::from_secs(1),
                subscription.next_message(),
            )
            .await
            {
                Err(_elapsed) => continue,
                Ok(Ok(Some(message))) => {
                    let Ok(envelope) = serde_json::from_slice::<Value>(message.payload.as_ref())
                    else {
                        continue;
                    };
                    if envelope_matches(&envelope, &task_id, &message_id, &mut runtime_turn_id)
                        && project_envelope(&mut snapshot, &envelope)
                    {
                        return Ok(());
                    }
                }
                Ok(Ok(None)) => {
                    return Err(FastApiError::detail(
                        StatusCode::BAD_GATEWAY,
                        "Runtime live subscription ended",
                    ));
                }
                Ok(Err(error)) => {
                    tracing::error!(?error, "wework live subscription read failed");
                    return Err(FastApiError::detail(
                        StatusCode::BAD_GATEWAY,
                        "Runtime live subscription failed",
                    ));
                }
            }
        }
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(300), wait)
        .await
        .map_err(|_| {
            FastApiError::detail(
                StatusCode::GATEWAY_TIMEOUT,
                "Runtime response did not settle",
            )
        });
    let _ = subscription.close().await;
    result??;
    if snapshot["output"]
        .as_array()
        .is_none_or(|items| items.is_empty())
    {
        // No projected text arrived; keep the settled status with an empty output.
        snapshot["output"] = json!([]);
    }
    seam::json_response(&snapshot)
}

/// The user row the model catalog and runtime tokens consume.
pub(crate) async fn create_response(
    state: &AppState,
    principal: DeferredResponsesUser,
    body: Value,
    limit: RateLimit,
    limit_key: &str,
) -> Result<brz_http_server::HttpResponse<BodyStream>, FastApiError> {
    // The body is parsed only after the discriminator selected this branch.
    let body: WeworkResponseCreate = serde_json::from_value(body).map_err(|error| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Invalid Wework response request: {error}"),
        )
    })?;
    body.validate_intent()?;
    // `current_api_user`: the Wework API is personal-API-key only, unlike the
    // flexible JWT/task-token principal the Wegent branch accepts.
    if matches!(&principal, DeferredResponsesUser::Resolved(_)) {
        return Err(second_auth_required());
    }
    // `response_execution_type` only requires `execution.type == "wework"`
    // when an execution block is present; `conversation`/`previous_response_id`
    // continuations carry no execution block.
    if body
        .execution
        .as_ref()
        .is_some_and(|execution| execution.execution_type.as_str() != "wework")
    {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "execution.type must be 'wework'",
        ));
    }

    // `current_api_user` re-derives the presented key's hash; keep it for the
    // second personal-key verification the Wework branch performs after the
    // limiter. A JWT/task token has no key hash and is rejected there.
    let second_key_hash = match &principal {
        DeferredResponsesUser::Deferred { key, .. } => Some(key.key_hash.clone()),
        DeferredResponsesUser::Resolved(_) => None,
    };
    // `get_auth_context` and `current_api_user` share the request session;
    // the endpoint's second authentication commits at the end of this first
    // transaction (the recorded {35..40} group), and the post-commit ORM
    // reloads follow before the model catalog.
    let (api_key_id, owner_id) = crate::transaction_outcome::run(
        &state.mysql,
        async |transaction| {
            let mut sql: &mut brz_mysql::MysqlTransactionService = transaction;
            let (_principal, _api_key_name) = super::handler::resolve_principal_on(
                state.user_reader.as_ref(),
                &mut sql,
                principal,
            )
            .await?;
            let rate_limited =
                !rate_limit::hit(state.redis.as_ref(), limit, limit_key, "/api/v1/responses").await;
            if rate_limited {
                return Err(FastApiError::json_body(
                    StatusCode::TOO_MANY_REQUESTS,
                    json!({"error": format!(
                        "Rate limit exceeded: {} per {} {}",
                        limit.amount, limit.multiples, limit.granularity
                    )}),
                ));
            }
            // `openapi_responses.py:499` → `wework_api.current_api_user` →
            // `auth_utils.verify_api_key(key_type="personal")`: after the
            // limiter and before the model catalog, the Wework branch
            // authenticates the same presented key a second time as a
            // personal key and commits its `last_used_at` write.
            let Some(key_hash) = second_key_hash.as_deref() else {
                return Err(second_auth_required());
            };
            let (api_key_id, owner_id) =
                crate::responses::auth::verify_personal_api_key_on(&mut sql, key_hash)
                    .await
                    .map_err(|error| {
                        tracing::warn!(?error, "wework second personal-key verification failed");
                        second_auth_required()
                    })?;
            Ok(crate::transaction_outcome::Completion::Commit((
                api_key_id, owner_id,
            )))
        },
        FastApiError::internal,
    )
    .await?;
    // The commit expires both ORM objects; the endpoint's `logger.debug`
    // reloads them by id and returns the user row, which the endpoint passes
    // into `models.selection` instead of reading it again.
    let user =
        crate::responses::auth::reload_personal_api_objects(&state.mysql, api_key_id, owner_id)
            .await
            .map_err(|error| {
                tracing::warn!(?error, "wework post-commit personal-key reload failed");
                FastApiError::internal()
            })?;
    let user_id = i64::from(user.id);
    // The endpoint ends with `db.rollback()`: the catalog reads are discarded.
    let selection = crate::transaction_outcome::run(
        &state.mysql,
        async |_transaction| {
            // Continuing a conversation keeps its recorded model even after an
            // admin hides that model from new selections.
            let allow_hidden = body.conversation.is_some() || body.previous_response_id.is_some();
            let selection = model_selection(state, &user, &body, allow_hidden).await?;
            Ok(crate::transaction_outcome::Completion::Rollback(selection))
        },
        FastApiError::internal,
    )
    .await?;

    if body.conversation.is_some() || body.previous_response_id.is_some() {
        return existing_conversation_response(state, user_id, &body, &selection).await;
    }
    let device_id = body
        .execution
        .as_ref()
        .and_then(|execution| execution.device_id.clone())
        .ok_or_else(|| {
            FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "execution.device_id is required for a new conversation",
            )
        })?;
    let runtime_device_id = ensure_device_online(state, user_id, &device_id).await?;
    // `compile_runtime_task_create`'s `_ensure_owned_device`, before the
    // execution request is compiled (pure DB, no online-state read).
    ensure_owned_device(state, user_id, &device_id).await?;
    let task_id = uuid_v4();
    let message_id = uuid_v4();
    let response_id = encode_identity("resp_", &[&device_id, &task_id, &message_id]);
    let conversation = conversation_id(&device_id, &task_id);
    let snapshot = queued_snapshot(
        &response_id,
        chrono::Utc::now().timestamp(),
        &body.model,
        body.previous_response_id.as_deref(),
        &conversation,
    );
    // `body.stream or not body.background`: subscribe before dispatch so the
    // terminal event cannot be missed.
    let subscribed = body.stream || !body.background;
    let subscription = if subscribed {
        let Some(redis) = state.redis.as_ref() else {
            return Err(FastApiError::internal());
        };
        let channel = live_channel(user_id, &device_id, &task_id);
        Some(redis.subscribe(channel.as_str()).await.map_err(|error| {
            tracing::error!(?error, "wework live subscription failed");
            FastApiError::internal()
        })?)
    } else {
        None
    };
    let payload = create_payload(
        state,
        user_id,
        &body,
        &runtime_device_id,
        &task_id,
        &message_id,
        &selection,
    )
    .await?;
    let result = runtime_rpc::call(
        state,
        user_id,
        &runtime_device_id,
        "runtime.tasks.create",
        payload,
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "wework runtime create failed");
        FastApiError::detail(StatusCode::BAD_GATEWAY, error.to_string())
    })?;
    if result.get("success") == Some(&Value::Bool(false))
        || result.get("accepted") == Some(&Value::Bool(false))
    {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Runtime rejected the task")
                .to_string(),
        ));
    }
    let Some(subscription) = subscription else {
        // `background=True`: the queued snapshot is returned immediately.
        return seam::json_response(&snapshot);
    };
    if body.stream {
        return Ok(sse_response(snapshot, subscription, task_id, message_id));
    }
    // `wait_response`: consume the live projection until the snapshot is
    // terminal and return it as the completed response object.
    let snapshot = wait_for_terminal(snapshot, subscription, &task_id, &message_id).await?;
    seam::json_response(&snapshot)
}

/// `service.wait_response`: drain the live projection until the snapshot is
/// terminal (`service.py:320-323`).
async fn wait_for_terminal(
    mut snapshot: Value,
    mut subscription: brz_redis::RedisSubscription,
    task_id: &str,
    message_id: &str,
) -> Result<Value, FastApiError> {
    let mut runtime_turn_id: Option<String> = None;
    let wait = async {
        loop {
            match tokio::time::timeout(
                std::time::Duration::from_secs(1),
                subscription.next_message(),
            )
            .await
            {
                Err(_elapsed) => continue,
                Ok(Ok(Some(message))) => {
                    let Ok(envelope) = serde_json::from_slice::<Value>(message.payload.as_ref())
                    else {
                        continue;
                    };
                    if envelope_matches(&envelope, task_id, message_id, &mut runtime_turn_id)
                        && project_envelope(&mut snapshot, &envelope)
                    {
                        return Ok(());
                    }
                }
                Ok(Ok(None)) => return Err(FastApiError::internal()),
                Ok(Err(error)) => {
                    tracing::error!(?error, "wework live subscription failed");
                    return Err(FastApiError::internal());
                }
            }
        }
    };
    wait.await?;
    Ok(snapshot)
}

/// `service.stream_response`: one SSE frame per projected event, with
/// `sequence_number` in event order and a `: keep-alive` line when the
/// subscription is idle for 15 seconds (`service.py:308-317`).
fn sse_response(
    snapshot: Value,
    subscription: brz_redis::RedisSubscription,
    task_id: String,
    message_id: String,
) -> brz_http_server::HttpResponse<BodyStream> {
    let state = WeworkSse {
        subscription,
        pending: std::collections::VecDeque::from(vec![json!({
            "type": "response.created",
            "response": snapshot.clone(),
        })]),
        snapshot,
        task_id,
        message_id,
        runtime_turn_id: None,
        sequence: 0,
        last_refresh: std::time::Instant::now(),
        finished: false,
    };
    let stream: BodyStream = Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            loop {
                if let Some(mut event) = state.pending.pop_front() {
                    let frame = sse_frame(&mut event, state.sequence);
                    state.sequence += 1;
                    return Some((Ok(Bytes::from(frame)), state));
                }
                if state.finished {
                    return None;
                }
                match tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    state.subscription.next_message(),
                )
                .await
                {
                    Ok(Ok(Some(message))) => {
                        let Ok(envelope) =
                            serde_json::from_slice::<Value>(message.payload.as_ref())
                        else {
                            continue;
                        };
                        if envelope_matches(
                            &envelope,
                            &state.task_id,
                            &state.message_id,
                            &mut state.runtime_turn_id,
                        ) {
                            state
                                .pending
                                .extend(project_events(&mut state.snapshot, &envelope));
                            if snapshot_terminal(&state.snapshot) {
                                state.finished = true;
                            }
                        }
                    }
                    Ok(Ok(None)) | Ok(Err(_)) => state.finished = true,
                    Err(_elapsed) => {
                        if state.last_refresh.elapsed() >= std::time::Duration::from_secs(15) {
                            state.last_refresh = std::time::Instant::now();
                            return Some((Ok(Bytes::from_static(b": keep-alive\n\n")), state));
                        }
                    }
                }
            }
        },
    ));
    seam::sse_stream_response(stream)
}

/// `service.stream_response`'s frame: `event: <type>\ndata: <json>\n\n` with
/// the event's `sequence_number` assigned before serialization.
fn sse_frame(event: &mut Value, sequence: u64) -> String {
    event["sequence_number"] = json!(sequence);
    let name = event["type"].as_str().unwrap_or("message");
    let data = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    format!("event: {name}\ndata: {data}\n\n")
}

/// One in-flight `text/event-stream` body: the subscription, the mutable
/// snapshot and the queued projected events.
struct WeworkSse {
    subscription: brz_redis::RedisSubscription,
    pending: std::collections::VecDeque<Value>,
    snapshot: Value,
    task_id: String,
    message_id: String,
    runtime_turn_id: Option<String>,
    sequence: u64,
    last_refresh: std::time::Instant,
    finished: bool,
}

/// `WeworkResponseObject(... status="queued" ...).model_dump()` for a new
/// conversation (`service.py:146-155`).
fn queued_snapshot(
    response_id: &str,
    created_at: i64,
    model: &str,
    previous_response_id: Option<&str>,
    conversation: &str,
) -> Value {
    json!({
        "id": response_id,
        "object": "response",
        "created_at": created_at,
        "status": "queued",
        "error": null,
        "model": model,
        "output": [],
        "pending_user_input": null,
        "pending_user_input_payload": null,
        "previous_response_id": previous_response_id,
        "conversation": {"id": conversation},
        "cancellation_requested": false,
        "is_latest": true,
    })
}

#[path = "wework_models.rs"]
pub(super) mod models;
pub(crate) use models::reasoning_from_model_options;
#[path = "wework_runtime.rs"]
mod runtime;
#[cfg(test)]
#[path = "wework_tests.rs"]
mod tests;
