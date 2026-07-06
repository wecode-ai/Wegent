// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use crate::{codex_phase::CodexAgentMessagePhaseTracker, protocol::ExecutionRequest};

use super::{
    codex_notifications::{codex_notification, debug_ignored_codex_notification},
    notification_mapping::{
        log_dropped_notification, log_stream_text_mapping, log_text_mapping, map_text_chunk,
        notification_item_id, TextChunkMapping,
    },
    transcript::{
        completed_workbench_block_from_notification, file_changes_block_from_patch_updated,
        file_changes_update_from_patch_updated, tool_update_from_notification,
        workbench_block_from_notification,
    },
    util::{extract_text, is_completed_plan_item, item_id, now_ms, raw_string_field, string_field},
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
            "taskId": local_task_id,
            "subtaskId": request.subtask_id.to_string(),
            "data": data,
            "deviceId": device_id,
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

struct EventEmitContext<'a> {
    event_tx: &'a Option<broadcast::Sender<Value>>,
    device_id: &'a str,
    local_task_id: &'a str,
    request: &'a ExecutionRequest,
}

#[derive(Default)]
pub(crate) struct CodexNotificationEventMapper {
    agent_message_phases: CodexAgentMessagePhaseTracker,
    subagent_item_ids: BTreeSet<String>,
    root_thread_id: Option<String>,
    process_text: Option<ProcessTextStream>,
    process_text_count: usize,
    final_text_offset: usize,
    plan_blocks: BTreeMap<String, String>,
}

struct ProcessTextStream {
    id: String,
    block_type: String,
    process_kind: String,
    item_id: Option<String>,
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
        let emit_context = EventEmitContext {
            event_tx,
            device_id,
            local_task_id,
            request,
        };
        let notification = codex_notification(&message);
        match notification.method.as_str() {
            "item/agentMessage/delta" => {
                if self.is_subagent_delta(notification.params) {
                    return;
                }
                let phase = self
                    .agent_message_phases
                    .phase_for_delta(notification.params);
                self.emit_text_chunk(
                    &emit_context,
                    &notification.method,
                    notification.params,
                    phase.as_deref(),
                );
            }
            "item/reasoning/delta" | "item/reasoningSummary/delta" => {
                if self.is_subagent_delta(notification.params) {
                    return;
                }
                self.emit_text_chunk(
                    &emit_context,
                    &notification.method,
                    notification.params,
                    Some("analysis"),
                );
            }
            "item/started" => {
                self.observe_root_thread(notification.params);
                if self.is_subagent_delta(notification.params) {
                    self.remember_subagent_item(notification.params);
                    return;
                }
                self.agent_message_phases.observe_item(notification.params);
                emit_tool_start(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "item/tool/requestUserInput" => {
                emit_request_user_input(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                    message.get("id"),
                );
            }
            "item/plan/delta" => {
                self.emit_plan_delta(
                    event_tx,
                    device_id,
                    local_task_id,
                    request,
                    notification.params,
                );
            }
            "item/fileChange/patchUpdated" => {
                self.emit_file_change_patch_updated(
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
                let phase = self
                    .agent_message_phases
                    .phase_for_item(notification.params);
                if self.emit_text_chunk(
                    &emit_context,
                    &notification.method,
                    notification.params,
                    phase.as_deref(),
                ) {
                    self.agent_message_phases.forget_item(notification.params);
                    return;
                }
                if is_completed_plan_item(notification.params) {
                    self.reset_process_text();
                    if let Some(text) = plan_item_text(notification.params) {
                        self.emit_completed_plan(
                            event_tx,
                            device_id,
                            local_task_id,
                            request,
                            notification.params,
                            text,
                        );
                    }
                    self.agent_message_phases.forget_item(notification.params);
                    return;
                }
                if let Some(block) = completed_workbench_block_from_notification(
                    notification.params,
                    &request.subtask_id,
                    device_id,
                    request.cwd().unwrap_or_default(),
                ) {
                    emit_response_event(
                        event_tx,
                        device_id,
                        "response.block.created",
                        local_task_id,
                        request,
                        json!({"block": block}),
                    );
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
            "context/compaction" => {
                emit_context_compaction_event(
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
                self.final_text_offset = 0;
                self.observe_root_thread(notification.params);
            }
            "thread/goal/updated" => {
                emit_response_event(
                    event_tx,
                    device_id,
                    "runtime.goal.updated",
                    local_task_id,
                    request,
                    json!({
                        "thread_id": string_field(notification.params, "threadId")
                            .or_else(|| string_field(notification.params, "thread_id")),
                        "goal": notification.params.get("goal").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            "thread/goal/cleared" => {
                emit_response_event(
                    event_tx,
                    device_id,
                    "runtime.goal.cleared",
                    local_task_id,
                    request,
                    json!({
                        "thread_id": string_field(notification.params, "threadId")
                            .or_else(|| string_field(notification.params, "thread_id")),
                    }),
                );
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
        emit_context: &EventEmitContext<'_>,
        block_type: &str,
        process_kind: &str,
        item_id: Option<String>,
        delta: String,
    ) {
        if let Some(process_text) = self.process_text.as_mut().filter(|process_text| {
            process_text.accepts(block_type, process_kind, item_id.as_deref())
        }) {
            process_text.content.push_str(&delta);
            emit_response_event(
                emit_context.event_tx,
                emit_context.device_id,
                "response.block.updated",
                emit_context.local_task_id,
                emit_context.request,
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
            "text-{}-{}-{}",
            emit_context.local_task_id, emit_context.request.subtask_id, self.process_text_count
        );
        self.process_text = Some(ProcessTextStream {
            id: id.clone(),
            block_type: block_type.to_owned(),
            process_kind: process_kind.to_owned(),
            item_id: item_id.clone(),
            content: delta.clone(),
        });
        emit_response_event(
            emit_context.event_tx,
            emit_context.device_id,
            "response.block.created",
            emit_context.local_task_id,
            emit_context.request,
            json!({
                "block": {
                    "id": id,
                    "type": block_type,
                    "process_kind": process_kind,
                    "process_item_id": item_id,
                    "content": delta,
                    "status": "streaming",
                    "timestamp": now_ms(),
                }
            }),
        );
    }

    fn emit_completed_process_text(
        &mut self,
        emit_context: &EventEmitContext<'_>,
        block_type: &str,
        process_kind: &str,
        item_id: Option<String>,
        text: String,
    ) {
        if let Some(process_text) = self.process_text.as_mut().filter(|process_text| {
            process_text.accepts(block_type, process_kind, item_id.as_deref())
        }) {
            process_text.content = text.clone();
            emit_response_event(
                emit_context.event_tx,
                emit_context.device_id,
                "response.block.updated",
                emit_context.local_task_id,
                emit_context.request,
                json!({
                    "block_id": process_text.id.clone(),
                    "updates": {
                        "content": text,
                        "status": "done",
                    }
                }),
            );
            self.reset_process_text();
            return;
        }

        self.process_text_count += 1;
        let id = format!(
            "text-{}-{}-{}",
            emit_context.local_task_id, emit_context.request.subtask_id, self.process_text_count
        );
        emit_response_event(
            emit_context.event_tx,
            emit_context.device_id,
            "response.block.created",
            emit_context.local_task_id,
            emit_context.request,
            json!({
                "block": {
                    "id": id,
                    "type": block_type,
                    "process_kind": process_kind,
                    "process_item_id": item_id,
                    "content": text,
                    "status": "done",
                    "timestamp": now_ms(),
                }
            }),
        );
    }

    fn emit_text_chunk(
        &mut self,
        emit_context: &EventEmitContext<'_>,
        method: &str,
        params: &Value,
        resolved_phase: Option<&str>,
    ) -> bool {
        match map_text_chunk(method, params, resolved_phase) {
            Ok(Some(TextChunkMapping::ProcessDelta {
                process_kind,
                block_type,
                item_id,
                delta,
            })) => {
                log_stream_text_mapping(
                    emit_context.local_task_id,
                    method,
                    "emit_process_delta",
                    resolved_phase,
                    params,
                    &delta,
                );
                self.emit_process_text_delta(
                    emit_context,
                    block_type,
                    process_kind,
                    item_id,
                    delta,
                );
                true
            }
            Ok(Some(TextChunkMapping::FinalDelta { delta })) => {
                log_stream_text_mapping(
                    emit_context.local_task_id,
                    method,
                    "emit_final_delta",
                    resolved_phase,
                    params,
                    &delta,
                );
                self.reset_process_text();
                let offset = self.final_text_offset;
                self.final_text_offset += delta.chars().count();
                emit_response_event(
                    emit_context.event_tx,
                    emit_context.device_id,
                    "response.output_text.delta",
                    emit_context.local_task_id,
                    emit_context.request,
                    json!({"delta": delta, "offset": offset}),
                );
                true
            }
            Ok(Some(TextChunkMapping::ProcessCompleted {
                process_kind,
                block_type,
                item_id,
                text,
            })) => {
                log_text_mapping(
                    emit_context.local_task_id,
                    method,
                    "emit_completed_process",
                    resolved_phase,
                    params,
                    &text,
                );
                self.emit_completed_process_text(
                    emit_context,
                    block_type,
                    process_kind,
                    item_id,
                    text,
                );
                true
            }
            Ok(Some(TextChunkMapping::FinalCompleted)) => {
                log_text_mapping(
                    emit_context.local_task_id,
                    method,
                    "ignore_completed_final_snapshot",
                    resolved_phase,
                    params,
                    "",
                );
                self.final_text_offset = 0;
                true
            }
            Ok(None) => false,
            Err(reason) => {
                log_dropped_notification(
                    emit_context.local_task_id,
                    &emit_context.request.task_id,
                    &emit_context.request.subtask_id,
                    method,
                    params,
                    reason,
                );
                true
            }
        }
    }

    fn emit_plan_delta(
        &mut self,
        event_tx: &Option<broadcast::Sender<Value>>,
        device_id: &str,
        local_task_id: &str,
        request: &ExecutionRequest,
        params: &Value,
    ) {
        let Some(delta) = raw_string_field(params, "delta").filter(|delta| !delta.is_empty())
        else {
            return;
        };
        let block_id = plan_block_id(params);
        let content = self.plan_blocks.entry(block_id.clone()).or_default();
        let is_new = content.is_empty();
        content.push_str(&delta);

        if is_new {
            emit_response_event(
                event_tx,
                device_id,
                "response.block.created",
                local_task_id,
                request,
                json!({
                    "block": {
                        "id": block_id,
                        "type": "plan",
                        "content": content.clone(),
                        "status": "streaming",
                        "timestamp": now_ms(),
                    }
                }),
            );
            return;
        }

        emit_response_event(
            event_tx,
            device_id,
            "response.block.updated",
            local_task_id,
            request,
            json!({
                "block_id": block_id,
                "updates": {
                    "content": content.clone(),
                    "status": "streaming",
                }
            }),
        );
    }

    fn emit_completed_plan(
        &mut self,
        event_tx: &Option<broadcast::Sender<Value>>,
        device_id: &str,
        local_task_id: &str,
        request: &ExecutionRequest,
        params: &Value,
        text: String,
    ) {
        let block_id = plan_block_id(params);
        let had_streaming_block = self.plan_blocks.remove(&block_id).is_some();
        if had_streaming_block {
            emit_response_event(
                event_tx,
                device_id,
                "response.block.updated",
                local_task_id,
                request,
                json!({
                    "block_id": block_id,
                    "updates": {
                        "content": text,
                        "status": "done",
                    }
                }),
            );
            return;
        }

        emit_response_event(
            event_tx,
            device_id,
            "response.block.created",
            local_task_id,
            request,
            json!({
                "block": {
                    "id": block_id,
                    "type": "plan",
                    "content": text,
                    "status": "done",
                    "timestamp": now_ms(),
                }
            }),
        );
    }

    fn emit_file_change_patch_updated(
        &mut self,
        event_tx: &Option<broadcast::Sender<Value>>,
        device_id: &str,
        local_task_id: &str,
        request: &ExecutionRequest,
        params: &Value,
    ) {
        let Some((block_id, updates)) = file_changes_update_from_patch_updated(
            params,
            &request.subtask_id,
            device_id,
            request.cwd().unwrap_or_default(),
            "streaming",
        ) else {
            return;
        };

        emit_response_event(
            event_tx,
            device_id,
            "response.block.updated",
            local_task_id,
            request,
            json!({"block_id": block_id, "updates": updates}),
        );

        if let Some(block) = file_changes_block_from_patch_updated(
            params,
            &request.subtask_id,
            device_id,
            request.cwd().unwrap_or_default(),
            "streaming",
        ) {
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

impl ProcessTextStream {
    fn accepts(&self, block_type: &str, process_kind: &str, item_id: Option<&str>) -> bool {
        self.block_type == block_type
            && self.process_kind == process_kind
            && self.item_id.as_deref() == item_id
    }
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

fn emit_context_compaction_event(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    emit_response_event(
        event_tx,
        device_id,
        "response.block.created",
        local_task_id,
        request,
        json!({"block": context_compaction_block(params)}),
    );
}

fn context_compaction_block(params: &Value) -> Value {
    let block_id = item_id(params, "context_compaction");
    json!({
        "id": block_id,
        "type": "tool",
        "tool_use_id": block_id,
        "tool_name": "context_compaction",
        "status": "done",
        "timestamp": now_ms(),
    })
}

fn plan_item_text(params: &Value) -> Option<String> {
    if !is_completed_plan_item(params) {
        return None;
    }
    params
        .get("item")
        .and_then(extract_text)
        .or_else(|| extract_text(params))
}

fn plan_block_id(params: &Value) -> String {
    let item = params.get("item").unwrap_or(params);
    let plan_item_id = string_field(params, "itemId")
        .or_else(|| string_field(params, "item_id"))
        .or_else(|| string_field(item, "id"))
        .unwrap_or_else(|| item_id(item, "plan"));
    format!("plan-{plan_item_id}")
}

fn emit_tool_start(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    if let Some(block) = workbench_block_from_notification(
        params,
        &request.subtask_id,
        device_id,
        request.cwd().unwrap_or_default(),
        Some("pending"),
    ) {
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

fn emit_request_user_input(
    event_tx: &Option<broadcast::Sender<Value>>,
    device_id: &str,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
    message_request_id: Option<&Value>,
) {
    let request_id = params
        .get("request_id")
        .or_else(|| params.get("requestId"))
        .or(message_request_id);
    let item_id = params
        .get("item_id")
        .or_else(|| params.get("itemId"))
        .and_then(Value::as_str)
        .unwrap_or("request_user_input");
    let block_id = request_id
        .and_then(value_identifier)
        .map(|id| format!("request-user-input-{id}"))
        .unwrap_or_else(|| format!("request-user-input-{item_id}"));
    let mut render_payload = params.clone();
    if let Some(object) = render_payload.as_object_mut() {
        object.insert(
            "kind".to_owned(),
            Value::String("request_user_input".to_owned()),
        );
        if let Some(request_id) = request_id {
            object.insert("requestId".to_owned(), request_id.clone());
        }
    }
    emit_response_event(
        event_tx,
        device_id,
        "response.block.created",
        local_task_id,
        request,
        json!({
            "block": {
                "id": block_id,
                "type": "tool",
                "tool_name": "request_user_input",
                "status": "pending",
                "timestamp": now_ms(),
                "render_payload": render_payload,
            }
        }),
    );
}

fn value_identifier(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
        assert_eq!(event["payload"]["data"]["block"]["status"], "done");
    }

    #[test]
    fn maps_codex_commentary_channel_agent_messages_to_process_text_blocks() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
    fn maps_completed_codex_commentary_agent_messages_to_process_text_blocks() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
                        "id": "msg-commentary",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": "I will inspect."
                    }
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
        assert_eq!(event["payload"]["data"]["block"]["status"], "done");
    }

    #[test]
    fn completes_streamed_codex_commentary_agent_message_without_duplicate_block() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": "msg-commentary",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": "I will inspect."
                    }
                }
            }),
        );

        let created = event_rx
            .try_recv()
            .expect("created event should be emitted");
        let updated = event_rx
            .try_recv()
            .expect("updated event should be emitted");

        assert_eq!(created["event"], "response.block.created");
        assert_eq!(updated["event"], "response.block.updated");
        assert_eq!(
            updated["payload"]["data"]["block_id"],
            created["payload"]["data"]["block"]["id"]
        );
        assert_eq!(updated["payload"]["data"]["updates"]["status"], "done");
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn maps_codex_context_compacted_event_to_completed_tool_block() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
                    "id": "ctx-1",
                    "type": "context_compacted"
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(event["payload"]["data"]["block"]["id"], "ctx-1");
        assert_eq!(event["payload"]["data"]["block"]["type"], "tool");
        assert_eq!(
            event["payload"]["data"]["block"]["tool_name"],
            "context_compaction"
        );
        assert_eq!(event["payload"]["data"]["block"]["status"], "done");
    }

    #[test]
    fn maps_codex_started_final_agent_message_deltas_to_output_text() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            &Some(event_tx.clone()),
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
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-final",
                    "delta": " More."
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": "root-thread-2"
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
                    "itemId": "msg-final-2",
                    "delta": "Next."
                }
            }),
        );

        let first_event = event_rx.try_recv().expect("first event should be emitted");
        let second_event = event_rx.try_recv().expect("second event should be emitted");
        let next_event = event_rx
            .try_recv()
            .expect("next turn event should be emitted");
        assert_eq!(first_event["event"], "response.output_text.delta");
        assert_eq!(first_event["payload"]["data"]["delta"], "Done.");
        assert_eq!(first_event["payload"]["data"]["offset"], 0);
        assert_eq!(second_event["event"], "response.output_text.delta");
        assert_eq!(second_event["payload"]["data"]["delta"], " More.");
        assert_eq!(second_event["payload"]["data"]["offset"], 5);
        assert_eq!(next_event["event"], "response.output_text.delta");
        assert_eq!(next_event["payload"]["data"]["delta"], "Next.");
        assert_eq!(next_event["payload"]["data"]["offset"], 0);
    }

    #[test]
    fn ignores_subagent_agent_message_deltas() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
    fn keeps_codex_process_text_stream_open_across_tool_start() {
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
                    "delta": "I found "
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
                        "type": "commandExecution",
                        "command": "pwd",
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
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "the issue."
                }
            }),
        );

        let created = event_rx
            .try_recv()
            .expect("process text created event should be emitted");
        let tool_created = event_rx
            .try_recv()
            .expect("tool created event should be emitted");
        let updated = event_rx
            .try_recv()
            .expect("process text updated event should be emitted");
        let block_id = created["payload"]["data"]["block"]["id"]
            .as_str()
            .expect("block id should be present");

        assert_eq!(created["event"], "response.block.created");
        assert_eq!(created["payload"]["data"]["block"]["type"], "text");
        assert_eq!(tool_created["event"], "response.block.created");
        assert_eq!(tool_created["payload"]["data"]["block"]["type"], "tool");
        assert_eq!(updated["event"], "response.block.updated");
        assert_eq!(updated["payload"]["data"]["block_id"], block_id);
        assert_eq!(
            updated["payload"]["data"]["updates"]["content"],
            "I found the issue."
        );
    }

    #[test]
    fn ignores_legacy_final_agent_message_snapshots_for_live_delta_stream() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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

        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn emits_codex_completed_plan_items_as_plan_blocks() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
                        "id": "turn-1-plan",
                        "type": "plan",
                        "text": "# Plan\n\n- Inspect the repo."
                    }
                }
            }),
        );

        let event = event_rx.try_recv().expect("event should be emitted");
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(event["payload"]["data"]["block"]["id"], "plan-turn-1-plan");
        assert_eq!(event["payload"]["data"]["block"]["type"], "plan");
        assert_eq!(event["payload"]["data"]["block"]["status"], "done");
        assert_eq!(
            event["payload"]["data"]["block"]["content"],
            "# Plan\n\n- Inspect the repo."
        );
    }

    #[test]
    fn emits_codex_plan_deltas_as_streaming_plan_blocks() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationEventMapper::default();

        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/plan/delta",
                "params": {
                    "itemId": "turn-1-plan",
                    "delta": "# Plan\n"
                }
            }),
        );
        mapper.map(
            &Some(event_tx.clone()),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/plan/delta",
                "params": {
                    "itemId": "turn-1-plan",
                    "delta": "\n- Inspect the repo."
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
                        "id": "turn-1-plan",
                        "type": "plan",
                        "text": "# Plan\n\n- Inspect the repo."
                    }
                }
            }),
        );

        let created = event_rx
            .try_recv()
            .expect("created event should be emitted");
        assert_eq!(created["event"], "response.block.created");
        assert_eq!(
            created["payload"]["data"]["block"]["id"],
            "plan-turn-1-plan"
        );
        assert_eq!(created["payload"]["data"]["block"]["type"], "plan");
        assert_eq!(created["payload"]["data"]["block"]["status"], "streaming");
        assert_eq!(created["payload"]["data"]["block"]["content"], "# Plan\n");

        let updated = event_rx
            .try_recv()
            .expect("updated event should be emitted");
        assert_eq!(updated["event"], "response.block.updated");
        assert_eq!(updated["payload"]["data"]["block_id"], "plan-turn-1-plan");
        assert_eq!(
            updated["payload"]["data"]["updates"]["content"],
            "# Plan\n\n- Inspect the repo."
        );
        assert_eq!(updated["payload"]["data"]["updates"]["status"], "streaming");

        let completed = event_rx
            .try_recv()
            .expect("completed event should be emitted");
        assert_eq!(completed["event"], "response.block.updated");
        assert_eq!(completed["payload"]["data"]["block_id"], "plan-turn-1-plan");
        assert_eq!(
            completed["payload"]["data"]["updates"]["content"],
            "# Plan\n\n- Inspect the repo."
        );
        assert_eq!(completed["payload"]["data"]["updates"]["status"], "done");
    }

    #[test]
    fn emits_codex_subagent_activity_events() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
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

    #[test]
    fn maps_codex_request_user_input_to_interactive_tool_block() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "7".to_owned(),
            subtask_id: "8".to_owned(),
            ..ExecutionRequest::default()
        };

        map_codex_notification(
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/tool/requestUserInput",
                "params": {
                    "request_id": 42,
                    "thread_id": "thread-1",
                    "turn_id": "turn-1",
                    "item_id": "item-1",
                    "questions": [
                        {
                            "id": "goal",
                            "question": "What should I prioritize?",
                            "options": [
                                {
                                    "label": "Work goal",
                                    "description": "Focus on one concrete task."
                                }
                            ]
                        }
                    ]
                }
            }),
        );

        let event = event_rx
            .try_recv()
            .expect("request user input event should be emitted");
        let block = &event["payload"]["data"]["block"];
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(block["id"], "request-user-input-42");
        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "request_user_input");
        assert_eq!(block["status"], "pending");
        assert_eq!(block["render_payload"]["kind"], "request_user_input");
        assert_eq!(block["render_payload"]["questions"][0]["id"], "goal");
    }

    #[test]
    fn maps_codex_file_change_to_realtime_file_changes_block() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            project_workspace_path: Some("/workspace/repo".to_owned()),
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
                        "id": "file-change-1",
                        "type": "fileChange",
                        "status": "completed",
                        "changes": [
                            {
                                "path": "/workspace/repo/helloworld.html",
                                "kind": { "type": "add" },
                                "diff": "@@ -0,0 +1 @@\n+<h1>Hello</h1>\n"
                            }
                        ]
                    }
                }
            }),
        );

        let event = event_rx
            .try_recv()
            .expect("file changes event should be emitted");
        let block = &event["payload"]["data"]["block"];
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(block["type"], "file_changes");
        assert_eq!(block["file_changes"]["file_count"], 1);
        assert_eq!(block["file_changes"]["files"][0]["path"], "helloworld.html");
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn maps_started_codex_file_change_to_pending_file_changes_block() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            project_workspace_path: Some("/workspace/repo".to_owned()),
            ..ExecutionRequest::default()
        };

        map_codex_notification(
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "file-change-1",
                        "type": "fileChange",
                        "status": "inProgress",
                        "changes": [
                            {
                                "path": "/workspace/repo/helloworld.html",
                                "kind": { "type": "add" },
                                "diff": ""
                            }
                        ]
                    }
                }
            }),
        );

        let event = event_rx
            .try_recv()
            .expect("started file changes event should be emitted");
        let block = &event["payload"]["data"]["block"];
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(block["type"], "file_changes");
        assert_eq!(block["status"], "pending");
        assert_eq!(block["file_changes"]["additions"], 0);
        assert_eq!(block["file_changes"]["deletions"], 0);
    }

    #[test]
    fn maps_codex_patch_updates_to_streaming_file_changes_block() {
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let request = ExecutionRequest {
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            project_workspace_path: Some("/workspace/repo".to_owned()),
            ..ExecutionRequest::default()
        };

        map_codex_notification(
            &Some(event_tx),
            "device-1",
            "local-1",
            &request,
            json!({
                "method": "item/fileChange/patchUpdated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "call-1",
                    "changes": [
                        {
                            "path": "/workspace/repo/live.txt",
                            "kind": { "type": "add" },
                            "diff": "first\nsecond\n"
                        }
                    ]
                }
            }),
        );

        let updated = event_rx
            .try_recv()
            .expect("patch update should emit a block update");
        assert_eq!(updated["event"], "response.block.updated");
        assert_eq!(
            updated["payload"]["data"]["block_id"],
            "file-changes-call-1"
        );
        assert_eq!(
            updated["payload"]["data"]["updates"]["file_changes"]["additions"],
            2
        );

        let created = event_rx
            .try_recv()
            .expect("patch update should ensure a block exists");
        let block = &created["payload"]["data"]["block"];
        assert_eq!(created["event"], "response.block.created");
        assert_eq!(block["id"], "file-changes-call-1");
        assert_eq!(block["status"], "streaming");
    }
}
