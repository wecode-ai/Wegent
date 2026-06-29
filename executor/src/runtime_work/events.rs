// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::{
    codex_phase::{codex_phase_is_process, codex_phase_name, CodexAgentMessagePhaseTracker},
    logging::log_executor_event,
    protocol::ExecutionRequest,
};

use super::{
    codex_notifications::{codex_notification, debug_ignored_codex_notification},
    transcript::{tool_block_from_notification, tool_update_from_notification},
    util::{extract_text, now_ms, raw_string_field, reasoning_content, string_field},
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
            "turn_id": request.subtask_id,
            "message_id": request.message_id,
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

#[cfg(test)]
fn map_codex_notification(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    message: Value,
) {
    CodexNotificationEventMapper::default().map(
        event_tx,
        device_id,
        local_task_id,
        request,
        message,
    );
}

#[derive(Default)]
pub(crate) struct CodexNotificationEventMapper {
    agent_message_phases: CodexAgentMessagePhaseTracker,
    process_text: Option<ProcessTextStream>,
    process_text_count: usize,
}

struct ProcessTextStream {
    id: String,
    content: String,
}

impl CodexNotificationEventMapper {
    pub(crate) fn map(
        &mut self,
        event_tx: &Option<broadcast::Sender<Value>>,
        device_id: &str,
        local_task_id: &str,
        request: &ExecutionRequest,
        message: Value,
    ) {
        let notification = codex_notification(&message);
        match notification.method.as_str() {
            "item/agentMessage/delta" => {
                let phase = self
                    .agent_message_phases
                    .phase_for_delta(notification.params);
                if codex_phase_is_process(phase.as_deref()) {
                    log_codex_event_mapper_text(
                        local_task_id,
                        &notification.method,
                        "emit_process_block",
                        phase.as_deref(),
                        notification.params,
                    );
                    self.emit_process_text_delta(
                        event_tx,
                        device_id,
                        local_task_id,
                        request,
                        notification.params,
                    );
                } else {
                    log_codex_event_mapper_text(
                        local_task_id,
                        &notification.method,
                        "emit_final_delta",
                        phase.as_deref(),
                        notification.params,
                    );
                    self.reset_process_text();
                    emit_text_delta(
                        event_tx,
                        device_id,
                        local_task_id,
                        request,
                        notification.params,
                    );
                }
            }
            "item/reasoning/delta" | "item/reasoningSummary/delta" => {
                emit_reasoning_delta(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "item/started" => {
                self.agent_message_phases.observe_item(notification.params);
                self.reset_process_text();
                emit_tool_start(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "item/completed" => {
                emit_tool_done(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
                self.agent_message_phases.forget_item(notification.params);
            }
            _ => {
                debug_ignored_codex_notification(
                    &message,
                    &notification.method,
                    notification.params,
                );
            }
        }
    }

    fn emit_process_text_delta(
        &mut self,
        event_tx: &Option<broadcast::Sender<Value>>,
        device_id: &str,
        local_task_id: &str,
        request: &ExecutionRequest,
        params: &Value,
    ) {
        let Some(delta) = agent_text(params) else {
            return;
        };

        if let Some(process_text) = self.process_text.as_mut() {
            process_text.content.push_str(&delta);
            emit_response_event(
                event_tx,
                device_id,
                "response.block.updated",
                local_task_id,
                request,
                json!({
                    "block_id": process_text.id.clone(),
                    "updates": {
                        "content": process_text.content.clone(),
                        "status": "streaming",
                    }
                }),
            );
            return;
        }

        self.process_text_count += 1;
        let id = format!(
            "text-{local_task_id}-{}-{}",
            request.subtask_id, self.process_text_count
        );
        self.process_text = Some(ProcessTextStream {
            id: id.clone(),
            content: delta.clone(),
        });
        emit_response_event(
            event_tx,
            device_id,
            "response.block.created",
            local_task_id,
            request,
            json!({
                "block": {
                    "id": id,
                    "type": "text",
                    "content": delta,
                    "status": "streaming",
                    "timestamp": now_ms(),
                }
            }),
        );
    }

    fn reset_process_text(&mut self) {
        self.process_text = None;
    }
}

fn log_codex_event_mapper_text(
    local_task_id: &str,
    method: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
) {
    let text = agent_text(params).unwrap_or_default();
    log_executor_event(
        "codex runtime event text classification",
        &[
            ("local_task_id", local_task_id.to_owned()),
            ("method", method.to_owned()),
            ("action", action.to_owned()),
            (
                "resolved_phase",
                resolved_phase.unwrap_or("<none>").to_owned(),
            ),
            ("item_id", json_string_field(params, "itemId")),
            (
                "phase",
                codex_phase_name(params).unwrap_or_else(|| "<none>".to_owned()),
            ),
            ("params_type", json_string_field(params, "type")),
            ("params_phase", json_string_field(params, "phase")),
            ("params_channel", json_string_field(params, "channel")),
            (
                "payload_type",
                nested_json_string_field(params, "payload", "type"),
            ),
            (
                "payload_phase",
                nested_json_string_field(params, "payload", "phase"),
            ),
            (
                "payload_channel",
                nested_json_string_field(params, "payload", "channel"),
            ),
            ("text_len", text.len().to_string()),
            ("text_preview", truncate_log_text(&text, 160)),
        ],
    );
}

fn agent_text(params: &Value) -> Option<String> {
    raw_string_field(params, "delta").or_else(|| extract_text(params))
}

fn json_string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn nested_json_string_field(value: &Value, object_key: &str, key: &str) -> String {
    value
        .get(object_key)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn truncate_log_text(text: &str, max_chars: usize) -> String {
    let mut result = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars {
            result.push('…');
            return result;
        }
        result.push(ch);
    }
    result
}

fn emit_text_delta(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    let Some(delta) = agent_text(params) else {
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
    let Some(delta) = string_field(params, "delta").or_else(|| reasoning_content(params)) else {
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::sync::broadcast;

    use crate::protocol::ExecutionRequest;

    use super::*;

    #[test]
    fn maps_codex_commentary_agent_messages_to_process_text_blocks() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: 7,
            subtask_id: 8,
            ..ExecutionRequest::default()
        };

        map_codex_notification(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "commentary",
                    "message": "I will inspect."
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(event["payload"]["data"]["block"]["type"], "text");
        assert_eq!(
            event["payload"]["data"]["block"]["content"],
            "I will inspect."
        );
        assert_eq!(event["payload"]["data"]["block"]["status"], "streaming");
    }

    #[test]
    fn maps_codex_commentary_channel_agent_messages_to_process_text_blocks() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: 7,
            subtask_id: 8,
            ..ExecutionRequest::default()
        };

        map_codex_notification(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "channel": "commentary",
                    "delta": "I will inspect."
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(event["payload"]["data"]["block"]["type"], "text");
        assert_eq!(
            event["payload"]["data"]["block"]["content"],
            "I will inspect."
        );
    }

    #[test]
    fn maps_codex_started_final_agent_message_deltas_to_output_text() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: 7,
            subtask_id: 8,
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationEventMapper::default();

        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "msg-final",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": ""
                    }
                }
            }),
        );
        mapper.map(
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-final",
                    "delta": "Done."
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.output_text.delta");
        assert_eq!(event["payload"]["data"]["delta"], "Done.");
    }

    #[test]
    fn maps_codex_process_text_deltas_to_one_block_stream() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: 7,
            subtask_id: 8,
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationEventMapper::default();

        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "msg-commentary",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": ""
                    }
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "I will "
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "inspect."
                }
            }),
        );

        let created = event_rx
            .try_recv()
            .expect("created event should be emitted");
        let updated = event_rx
            .try_recv()
            .expect("updated event should be emitted");
        let block_id = created["payload"]["data"]["block"]["id"]
            .as_str()
            .expect("block id should be present");

        assert_eq!(created["event"], "response.block.created");
        assert_eq!(created["payload"]["data"]["block"]["content"], "I will ");
        assert_eq!(updated["event"], "response.block.updated");
        assert_eq!(updated["payload"]["data"]["block_id"], block_id);
        assert_eq!(
            updated["payload"]["data"]["updates"]["content"],
            "I will inspect."
        );
    }

    #[test]
    fn maps_codex_final_agent_messages_to_output_text_deltas() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: 7,
            subtask_id: 8,
            ..ExecutionRequest::default()
        };

        map_codex_notification(
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "final_answer",
                    "message": "Done."
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.output_text.delta");
        assert_eq!(event["payload"]["data"]["delta"], "Done.");
    }

    #[test]
    fn maps_codex_commentary_then_tool_then_unphased_final_without_duplication() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let request = ExecutionRequest {
            task_id: 7,
            subtask_id: 8,
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationEventMapper::default();

        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "msg-commentary",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": ""
                    }
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "I will inspect."
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "call-1",
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "msg-final",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": ""
                    }
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-final",
                    "delta": "Current directory: /tmp/project"
                }
            }),
        );
        mapper.map(
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "phase": "final_answer",
                        "content": [{"type": "output_text", "text": "Current directory: /tmp/project"}]
                    }
                }
            }),
        );

        let process = event_rx
            .try_recv()
            .expect("commentary process event should be emitted");
        let tool = event_rx.try_recv().expect("tool event should be emitted");
        let final_text = event_rx
            .try_recv()
            .expect("final text event should be emitted");

        assert_eq!(process["event"], "response.block.created");
        assert_eq!(process["payload"]["data"]["block"]["type"], "text");
        assert_eq!(
            process["payload"]["data"]["block"]["content"],
            "I will inspect."
        );
        assert_eq!(tool["event"], "response.block.created");
        assert_eq!(
            tool["payload"]["data"]["block"]["tool_name"],
            "exec_command"
        );
        assert_eq!(final_text["event"], "response.output_text.delta");
        assert_eq!(
            final_text["payload"]["data"]["delta"],
            "Current directory: /tmp/project"
        );
        assert!(event_rx.try_recv().is_err());
    }
}
