// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::protocol::ExecutionRequest;

use super::{
    transcript::{tool_block_from_notification, tool_update_from_notification},
    util::string_field,
};

pub(crate) fn emit_response_event(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    event: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    data: Value,
) {
    let Some(event_tx) = event_tx else {
        return;
    };
    let mut payload = json!({
        "type": "event",
        "event": event,
        "payload": {
            "event_type": event,
            "task_id": request.task_id,
            "subtask_id": request.subtask_id,
            "data": data,
            "device_id": device_id,
            "local_task_id": local_task_id,
            "runtime": "codex",
        },
    });
    if let Some(source) = request.extra.get("source") {
        if let Some(payload_object) = payload.get_mut("payload").and_then(Value::as_object_mut) {
            payload_object.insert("source".to_owned(), source.clone());
        }
    }
    let _ = event_tx.send(payload);
}

pub(crate) fn map_codex_notification(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    message: Value,
) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").unwrap_or(&message);
    match method {
        "item/agentMessage/delta" => {
            emit_text_delta(event_tx, device_id, local_task_id, request, params)
        }
        "item/reasoning/delta" | "item/reasoningSummary/delta" => {
            emit_reasoning_delta(event_tx, device_id, local_task_id, request, params)
        }
        "item/started" => emit_tool_start(event_tx, device_id, local_task_id, request, params),
        "item/completed" => emit_tool_done(event_tx, device_id, local_task_id, request, params),
        _ => {}
    }
}

fn emit_text_delta(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    let Some(delta) = string_field(params, "delta") else {
        return;
    };
    emit_response_event(
        event_tx,
        device_id,
        "response.output_text.delta",
        local_task_id,
        request,
        json!({"delta": delta}),
    );
}

fn emit_reasoning_delta(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    let Some(delta) = string_field(params, "delta") else {
        return;
    };
    emit_response_event(
        event_tx,
        device_id,
        "response.reasoning_summary_text.delta",
        local_task_id,
        request,
        json!({"delta": delta}),
    );
}

fn emit_tool_start(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    if let Some(block) = tool_block_from_notification(params, "pending") {
        emit_response_event(
            event_tx,
            device_id,
            "response.block.created",
            local_task_id,
            request,
            json!({"block": block}),
        );
    }
}

fn emit_tool_done(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    if let Some((block_id, updates)) = tool_update_from_notification(params) {
        emit_response_event(
            event_tx,
            device_id,
            "response.block.updated",
            local_task_id,
            request,
            json!({"block_id": block_id, "updates": updates}),
        );
    }
}
