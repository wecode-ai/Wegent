// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use crate::{
    codex_phase::{
        codex_item_id, codex_phase_is_process, codex_phase_name, CodexAgentMessagePhaseTracker,
    },
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
    subagent_item_ids: BTreeSet<String>,
    root_thread_id: Option<String>,
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
                if self.is_subagent_delta(notification.params) {
                    return;
                }
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
                if self.is_subagent_delta(notification.params) {
                    return;
                }
                emit_reasoning_delta(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "item/started" => {
                self.observe_root_thread(notification.params);
                if self.is_subagent_delta(notification.params) {
                    self.remember_subagent_item(notification.params);
                    return;
                }
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
                self.observe_root_thread(notification.params);
                if self.is_subagent_delta(notification.params) {
                    self.forget_subagent_item(notification.params);
                    self.agent_message_phases.forget_item(notification.params);
                    return;
                }
                emit_tool_done(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
                self.agent_message_phases.forget_item(notification.params);
            }
            "subagent/activity" => {
                emit_subagent_activity(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "collab-agent/activity" => {
                emit_collab_agent_activity(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "thread/started" => {
                self.observe_root_thread(notification.params);
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

    fn remember_subagent_item(&mut self, params: &Value) {
        if let Some(item_id) = notification_item_id(params) {
            self.subagent_item_ids.insert(item_id);
        }
    }

    fn forget_subagent_item(&mut self, params: &Value) {
        if let Some(item_id) = notification_item_id(params) {
            self.subagent_item_ids.remove(&item_id);
        }
    }

    fn is_subagent_delta(&self, params: &Value) -> bool {
        is_non_root_codex_stream_event(params)
            || self.is_subagent_thread(params)
            || notification_item_id(params)
                .is_some_and(|item_id| self.subagent_item_ids.contains(&item_id))
    }

    fn observe_root_thread(&mut self, params: &Value) {
        if self.root_thread_id.is_none() && is_explicit_root_codex_stream_event(params) {
            self.root_thread_id = stream_thread_id(params);
        }
    }

    fn is_subagent_thread(&self, params: &Value) -> bool {
        let Some(root_thread_id) = self.root_thread_id.as_deref() else {
            return false;
        };
        stream_thread_id(params).is_some_and(|thread_id| thread_id != root_thread_id)
    }
}

fn notification_item_id(params: &Value) -> Option<String> {
    params
        .get("item")
        .and_then(codex_item_id)
        .or_else(|| string_field(params, "itemId"))
        .or_else(|| string_field(params, "item_id"))
        .or_else(|| codex_item_id(params))
}

fn is_non_root_codex_stream_event(params: &Value) -> bool {
    codex_stream_agent_path(params).is_some_and(|agent_path| agent_path != "/root")
}

fn is_explicit_root_codex_stream_event(params: &Value) -> bool {
    params
        .get("thread")
        .and_then(|thread| string_field(thread, "id"))
        .is_some()
        || codex_stream_agent_path(params).is_some_and(|agent_path| agent_path == "/root")
}

fn codex_stream_agent_path(value: &Value) -> Option<String> {
    string_field(value, "agent_path")
        .or_else(|| string_field(value, "agentPath"))
        .or_else(|| {
            value.get("item").and_then(|item| {
                string_field(item, "agent_path").or_else(|| string_field(item, "agentPath"))
            })
        })
        .or_else(|| {
            value.get("payload").and_then(|payload| {
                string_field(payload, "agent_path").or_else(|| string_field(payload, "agentPath"))
            })
        })
        .or_else(|| {
            value.get("turn").and_then(|turn| {
                string_field(turn, "agent_path").or_else(|| string_field(turn, "agentPath"))
            })
        })
}

fn stream_thread_id(value: &Value) -> Option<String> {
    string_field(value, "threadId")
        .or_else(|| string_field(value, "thread_id"))
        .or_else(|| {
            value.get("item").and_then(|item| {
                string_field(item, "threadId").or_else(|| string_field(item, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("payload").and_then(|payload| {
                string_field(payload, "threadId").or_else(|| string_field(payload, "thread_id"))
            })
        })
        .or_else(|| {
            value.get("thread").and_then(|thread| {
                string_field(thread, "id")
                    .or_else(|| string_field(thread, "threadId"))
                    .or_else(|| string_field(thread, "thread_id"))
            })
        })
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

fn emit_subagent_activity(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    let Some(agent_path) = subagent_path(params) else {
        return;
    };
    if agent_path == "/root" {
        return;
    }

    let kind = subagent_kind(params);
    let agent_thread_id = subagent_thread_id(params);
    let agent_id = agent_thread_id
        .clone()
        .unwrap_or_else(|| agent_path.clone());
    let mut data = Map::new();
    data.insert("agent_path".to_owned(), Value::String(agent_path));
    data.insert("agent_id".to_owned(), Value::String(agent_id.clone()));
    data.insert(
        "agent_thread_id".to_owned(),
        agent_thread_id.map(Value::String).unwrap_or(Value::Null),
    );
    if let Some(agent_name) = explicit_subagent_name(params) {
        data.insert("agent_name".to_owned(), Value::String(agent_name));
    }
    data.insert("kind".to_owned(), Value::String(kind.clone()));
    data.insert(
        "status".to_owned(),
        Value::String(subagent_status(&kind).to_owned()),
    );
    data.insert(
        "occurred_at_ms".to_owned(),
        Value::Number(subagent_occurred_at_ms(params).into()),
    );
    emit_response_event(
        event_tx,
        device_id,
        "response.subagent.activity",
        local_task_id,
        request,
        Value::Object(data),
    );
    emit_subagent_block_update(
        event_tx,
        device_id,
        local_task_id,
        request,
        &agent_id,
        subagent_status(&kind),
    );
}

fn emit_collab_agent_activity(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    let item = params.get("item").unwrap_or(params);
    if item_type_name(item) != "collabagenttoolcall" {
        return;
    }

    let agent_ids = collab_agent_ids(item);
    if agent_ids.is_empty() {
        return;
    }

    let tool = string_field(item, "tool").unwrap_or_else(|| "collabAgent".to_owned());
    let has_agent_states = item
        .get("agentsStates")
        .and_then(Value::as_object)
        .is_some_and(|states| !states.is_empty());
    if tool == "wait" && !has_agent_states {
        return;
    }
    for agent_thread_id in agent_ids {
        let collab_status = collab_agent_state_status(item, &agent_thread_id)
            .or_else(|| string_field(item, "status"))
            .unwrap_or_else(|| "running".to_owned());
        let status = collab_agent_status(&collab_status);
        let mut data = Map::new();
        data.insert(
            "agent_path".to_owned(),
            Value::String(format!("thread:{agent_thread_id}")),
        );
        data.insert(
            "agent_id".to_owned(),
            Value::String(agent_thread_id.clone()),
        );
        data.insert(
            "agent_thread_id".to_owned(),
            Value::String(agent_thread_id.clone()),
        );
        data.insert("kind".to_owned(), Value::String(tool.clone()));
        data.insert("status".to_owned(), Value::String(status.to_owned()));
        data.insert(
            "occurred_at_ms".to_owned(),
            Value::Number(subagent_occurred_at_ms(params).into()),
        );
        emit_response_event(
            event_tx,
            device_id,
            "response.subagent.activity",
            local_task_id,
            request,
            Value::Object(data),
        );
        if tool == "spawnAgent" {
            emit_subagent_block_created(
                event_tx,
                device_id,
                local_task_id,
                request,
                SubagentBlockCreated {
                    agent_id: &agent_thread_id,
                    tool: &tool,
                    status,
                    timestamp: subagent_occurred_at_ms(params),
                },
            );
        } else {
            emit_subagent_block_update(
                event_tx,
                device_id,
                local_task_id,
                request,
                &agent_thread_id,
                status,
            );
        }
    }
}

struct SubagentBlockCreated<'a> {
    agent_id: &'a str,
    tool: &'a str,
    status: &'a str,
    timestamp: i64,
}

fn emit_subagent_block_created(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    block: SubagentBlockCreated<'_>,
) {
    emit_response_event(
        event_tx,
        device_id,
        "response.block.created",
        local_task_id,
        request,
        json!({
            "block": {
                "id": subagent_block_id(block.agent_id),
                "type": "tool",
                "tool_use_id": subagent_block_id(block.agent_id),
                "tool_name": block.tool,
                "tool_input": {
                    "agent_id": block.agent_id,
                    "agent_thread_id": block.agent_id,
                },
                "status": block.status,
                "timestamp": block.timestamp,
            }
        }),
    );
}

fn emit_subagent_block_update(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    agent_id: &str,
    status: &str,
) {
    emit_response_event(
        event_tx,
        device_id,
        "response.block.updated",
        local_task_id,
        request,
        json!({
            "block_id": subagent_block_id(agent_id),
            "updates": {
                "status": status,
            }
        }),
    );
}

fn subagent_block_id(agent_id: &str) -> String {
    format!("subagent-{agent_id}")
}

fn subagent_path(params: &Value) -> Option<String> {
    string_field(params, "agent_path")
        .or_else(|| string_field(params, "agentPath"))
        .or_else(|| {
            params.get("item").and_then(|item| {
                string_field(item, "agent_path").or_else(|| string_field(item, "agentPath"))
            })
        })
        .or_else(|| {
            params.get("turn").and_then(|turn| {
                string_field(turn, "agent_path").or_else(|| string_field(turn, "agentPath"))
            })
        })
}

fn subagent_kind(params: &Value) -> String {
    string_field(params, "kind")
        .or_else(|| {
            params
                .get("item")
                .and_then(|item| string_field(item, "kind"))
        })
        .or_else(|| {
            params.get("turn").and_then(|turn| {
                string_field(turn, "kind")
                    .or_else(|| string_field(turn, "status"))
                    .or_else(|| string_field(turn, "type"))
            })
        })
        .unwrap_or_else(|| "completed".to_owned())
}

fn subagent_status(kind: &str) -> &'static str {
    match kind.replace('_', "").to_ascii_lowercase().as_str() {
        "completed" | "done" | "taskcomplete" => "done",
        "interrupted" | "cancelled" | "canceled" => "interrupted",
        _ => "running",
    }
}

fn subagent_thread_id(params: &Value) -> Option<String> {
    string_field(params, "agent_thread_id")
        .or_else(|| string_field(params, "agentThreadId"))
        .or_else(|| string_field(params, "thread_id"))
        .or_else(|| string_field(params, "threadId"))
        .or_else(|| string_field(params, "turn_id"))
        .or_else(|| string_field(params, "turnId"))
        .or_else(|| {
            params.get("item").and_then(|item| {
                string_field(item, "agent_thread_id")
                    .or_else(|| string_field(item, "agentThreadId"))
                    .or_else(|| string_field(item, "thread_id"))
                    .or_else(|| string_field(item, "threadId"))
                    .or_else(|| string_field(item, "turn_id"))
                    .or_else(|| string_field(item, "turnId"))
            })
        })
        .or_else(|| {
            params.get("turn").and_then(|turn| {
                string_field(turn, "agent_thread_id")
                    .or_else(|| string_field(turn, "agentThreadId"))
                    .or_else(|| string_field(turn, "thread_id"))
                    .or_else(|| string_field(turn, "threadId"))
                    .or_else(|| string_field(turn, "turn_id"))
                    .or_else(|| string_field(turn, "turnId"))
            })
        })
}

fn explicit_subagent_name(params: &Value) -> Option<String> {
    string_field(params, "agent_name")
        .or_else(|| string_field(params, "agentName"))
        .or_else(|| {
            params.get("item").and_then(|item| {
                string_field(item, "agent_name").or_else(|| string_field(item, "agentName"))
            })
        })
}

fn subagent_occurred_at_ms(params: &Value) -> i64 {
    params
        .get("occurred_at_ms")
        .or_else(|| params.get("occurredAtMs"))
        .or_else(|| params.get("completedAtMs"))
        .or_else(|| params.get("startedAtMs"))
        .or_else(|| {
            params
                .get("item")
                .and_then(|item| item.get("occurred_at_ms"))
        })
        .or_else(|| params.get("item").and_then(|item| item.get("occurredAtMs")))
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| turn.get("occurred_at_ms"))
        })
        .or_else(|| params.get("turn").and_then(|turn| turn.get("occurredAtMs")))
        .and_then(Value::as_i64)
        .unwrap_or_else(now_ms)
}

fn item_type_name(item: &Value) -> String {
    item.get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .replace('_', "")
        .to_ascii_lowercase()
}

fn collab_agent_ids(item: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(receiver_thread_ids) = item.get("receiverThreadIds").and_then(Value::as_array) {
        for thread_id in receiver_thread_ids {
            if let Some(thread_id) = thread_id.as_str().filter(|value| !value.trim().is_empty()) {
                ids.push(thread_id.to_owned());
            }
        }
    }
    if let Some(agents_states) = item.get("agentsStates").and_then(Value::as_object) {
        for thread_id in agents_states.keys() {
            if !ids.iter().any(|id| id == thread_id) {
                ids.push(thread_id.to_owned());
            }
        }
    }
    ids
}

fn collab_agent_state_status(item: &Value, agent_thread_id: &str) -> Option<String> {
    item.get("agentsStates")
        .and_then(|states| states.get(agent_thread_id))
        .and_then(|state| string_field(state, "status"))
}

fn collab_agent_status(status: &str) -> &'static str {
    match status.replace('_', "").to_ascii_lowercase().as_str() {
        "completed" | "shutdown" | "done" => "done",
        "interrupted" | "errored" | "notfound" | "failed" => "interrupted",
        _ => "running",
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
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": "root-thread"
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
    fn ignores_subagent_agent_message_deltas() {
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
                        "id": "msg-child",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "agent_path": "/root/worker",
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
                    "itemId": "msg-child",
                    "delta": "child output"
                }
            }),
        );

        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn ignores_cross_thread_agent_message_deltas() {
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
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": "root-thread"
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
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "item": {
                        "id": "msg-root",
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
                "method": "item/started",
                "params": {
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "item": {
                        "id": "call-child",
                        "type": "commandExecution",
                        "command": "rg child",
                        "status": "inProgress"
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
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "item": {
                        "id": "msg-child",
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
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "itemId": "msg-child",
                    "delta": "child"
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
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "msg-root",
                    "delta": "root"
                }
            }),
        );

        let event = event_rx.try_recv().expect("root event should be emitted");
        assert_eq!(event["event"], "response.output_text.delta");
        assert_eq!(event["payload"]["data"]["delta"], "root");
        assert!(event_rx.try_recv().is_err());
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
    fn emits_codex_subagent_activity_events() {
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
                    "type": "sub_agent_activity",
                    "agent_path": "/root/worker",
                    "agent_thread_id": "thread-worker",
                    "kind": "started",
                    "occurred_at_ms": 12345
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.subagent.activity");
        assert_eq!(event["payload"]["data"]["agent_path"], "/root/worker");
        assert_eq!(event["payload"]["data"]["agent_id"], "thread-worker");
        assert!(event["payload"]["data"].get("agent_name").is_none());
        assert_eq!(event["payload"]["data"]["agent_thread_id"], "thread-worker");
        assert_eq!(event["payload"]["data"]["kind"], "started");
        assert_eq!(event["payload"]["data"]["status"], "running");
        assert_eq!(event["payload"]["data"]["occurred_at_ms"], 12345);
    }

    #[test]
    fn emits_child_turn_completion_as_done_subagent_activity() {
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
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-worker",
                    "turn": {
                        "turn_id": "child-turn",
                        "agent_path": "/root/worker"
                    }
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.subagent.activity");
        assert_eq!(event["payload"]["data"]["agent_id"], "thread-worker");
        assert_eq!(event["payload"]["data"]["agent_thread_id"], "thread-worker");
        assert_eq!(event["payload"]["data"]["status"], "done");
        assert_eq!(event["payload"]["data"]["kind"], "completed");

        let update = event_rx.try_recv().expect("block update should be emitted");
        assert_eq!(update["event"], "response.block.updated");
        assert_eq!(
            update["payload"]["data"]["block_id"],
            "subagent-thread-worker"
        );
        assert_eq!(update["payload"]["data"]["updates"]["status"], "done");
    }

    #[test]
    fn emits_explicit_subagent_activity_items() {
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
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "subAgentActivity",
                        "agentPath": "/root/worker",
                        "agentThreadId": "thread-worker",
                        "kind": "interacted"
                    }
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.subagent.activity");
        assert_eq!(event["payload"]["data"]["agent_path"], "/root/worker");
        assert_eq!(event["payload"]["data"]["agent_id"], "thread-worker");
        assert_eq!(event["payload"]["data"]["agent_thread_id"], "thread-worker");
        assert_eq!(event["payload"]["data"]["kind"], "interacted");
        assert_eq!(event["payload"]["data"]["status"], "running");
    }

    #[test]
    fn emits_collab_agent_tool_call_subagent_status() {
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
                "method": "item/completed",
                "params": {
                    "completedAtMs": 12345,
                    "item": {
                        "type": "collabAgentToolCall",
                        "tool": "spawnAgent",
                        "prompt": "你是一个只读代码库分析 subagent。请聚焦 Backend 模块，不要修改文件。",
                        "receiverThreadIds": ["thread-worker"],
                        "agentsStates": {
                            "thread-worker": {
                                "status": "pendingInit",
                                "message": null
                            }
                        },
                        "status": "completed"
                    }
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.subagent.activity");
        assert_eq!(
            event["payload"]["data"]["agent_path"],
            "thread:thread-worker"
        );
        assert_eq!(event["payload"]["data"]["agent_id"], "thread-worker");
        assert_eq!(event["payload"]["data"]["agent_thread_id"], "thread-worker");
        assert!(event["payload"]["data"].get("agent_name").is_none());
        assert_eq!(event["payload"]["data"]["kind"], "spawnAgent");
        assert_eq!(event["payload"]["data"]["status"], "running");
        assert_eq!(event["payload"]["data"]["occurred_at_ms"], 12345);

        let block = event_rx.try_recv().expect("block should be emitted");
        assert_eq!(block["event"], "response.block.created");
        assert_eq!(
            block["payload"]["data"]["block"]["id"],
            "subagent-thread-worker"
        );
        assert_eq!(
            block["payload"]["data"]["block"]["tool_use_id"],
            "subagent-thread-worker"
        );
        assert_eq!(block["payload"]["data"]["block"]["tool_name"], "spawnAgent");
        assert_eq!(block["payload"]["data"]["block"]["status"], "running");
    }

    #[test]
    fn emits_explicit_subagent_name_when_field_exists() {
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
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "subAgentActivity",
                        "agentPath": "/root/worker",
                        "agentThreadId": "thread-worker",
                        "agentName": "Frontend reviewer",
                        "kind": "interacted"
                    }
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["payload"]["data"]["agent_name"], "Frontend reviewer");
    }

    #[test]
    fn emits_collab_agent_id_without_inventing_name_from_prompt() {
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
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "collabAgentToolCall",
                        "tool": "spawnAgent",
                        "prompt": "在 /repo 分析前端部分，重点是 frontend/ 与 wework/。只读分析。",
                        "receiverThreadIds": ["thread-worker"],
                        "agentsStates": {
                            "thread-worker": {
                                "status": "running"
                            }
                        },
                        "status": "completed"
                    }
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["payload"]["data"]["agent_id"], "thread-worker");
        assert!(event["payload"]["data"].get("agent_name").is_none());
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
