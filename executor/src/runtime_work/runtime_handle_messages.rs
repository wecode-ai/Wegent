// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::{codex_phase::CodexAgentMessagePhaseTracker, protocol::ExecutionRequest};

use super::{
    codex_notifications::{codex_notification, debug_ignored_codex_notification},
    notification_mapping::{
        log_dropped_notification, log_stream_text_mapping, log_text_mapping, map_text_chunk,
        map_tool_output_delta, notification_item_id, TextChunkMapping,
    },
    response::RuntimeTaskLink,
    store::RuntimeWorkStore,
    transcript::{
        completed_workbench_block_from_notification, file_changes_block_from_patch_updated,
        file_changes_update_from_patch_updated, tool_update_from_notification,
        workbench_block_from_notification,
    },
    util::{
        extract_text, id_field, is_completed_plan_item, item_id, now_ms, raw_string_field,
        string_field,
    },
};

pub(crate) fn cached_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    link.runtime_handle
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.is_object())
        .cloned()
        .collect()
}

pub(crate) fn set_runtime_handle_messages(runtime_handle: &mut Value, messages: Vec<Value>) {
    let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
    object.insert("messages".to_owned(), Value::Array(messages));
    *runtime_handle = Value::Object(object);
}

pub(crate) fn append_runtime_handle_message(runtime_handle: &mut Value, message: Value) {
    let mut messages = runtime_handle
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    messages.push(message);
    set_runtime_handle_messages(runtime_handle, messages);
}

#[cfg(test)]
fn cache_codex_notification(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    message: &Value,
) {
    CodexNotificationCacheMapper::default().map(store, local_task_id, request, message);
}

#[derive(Default)]
pub(crate) struct CodexNotificationCacheMapper {
    agent_message_phases: CodexAgentMessagePhaseTracker,
    subagent_item_ids: BTreeSet<String>,
    root_thread_id: Option<String>,
}

impl CodexNotificationCacheMapper {
    pub(crate) fn map(
        &mut self,
        store: &RuntimeWorkStore,
        local_task_id: &str,
        request: &ExecutionRequest,
        message: &Value,
    ) {
        let notification = codex_notification(message);
        let params = notification.params;
        match notification.method.as_str() {
            "item/reasoning/delta" | "item/reasoningSummary/delta" => {
                if self.is_subagent_delta(params) {
                    return;
                }
                self.cache_text_chunk(
                    store,
                    local_task_id,
                    request,
                    &notification.method,
                    params,
                    Some("analysis"),
                );
            }
            "item/agentMessage/delta" => {
                if self.is_subagent_delta(params) {
                    return;
                }
                let phase = self.agent_message_phases.phase_for_delta(params);
                self.cache_text_chunk(
                    store,
                    local_task_id,
                    request,
                    &notification.method,
                    params,
                    phase.as_deref(),
                );
            }
            "item/tool/outputDelta"
            | "item/commandExecution/outputDelta"
            | "process/outputDelta"
            | "command/exec/outputDelta" => {
                match map_tool_output_delta(&notification.method, params) {
                    Ok(Some(mapping)) => append_runtime_assistant_tool_output_delta(
                        store,
                        local_task_id,
                        request,
                        &mapping.tool_use_id,
                        mapping.delta,
                    ),
                    Ok(None) => {}
                    Err(reason) => log_dropped_notification(
                        local_task_id,
                        &request.task_id,
                        &request.subtask_id,
                        &notification.method,
                        params,
                        reason,
                    ),
                }
            }
            "item/plan/delta" => {
                if let Some(delta) =
                    raw_string_field(params, "delta").filter(|delta| !delta.is_empty())
                {
                    append_runtime_assistant_process_delta(
                        store,
                        local_task_id,
                        request,
                        "plan",
                        "plan",
                        notification_item_id(params),
                        delta,
                    );
                }
            }
            "item/fileChange/patchUpdated" => {
                if let Some(block) = file_changes_block_from_patch_updated(
                    params,
                    &request.subtask_id,
                    request.device_id.as_deref().unwrap_or_default(),
                    request.cwd().unwrap_or_default(),
                    "streaming",
                ) {
                    cache_runtime_assistant_block(store, local_task_id, request, block);
                }
                if let Some((block_id, updates)) = file_changes_update_from_patch_updated(
                    params,
                    &request.subtask_id,
                    request.device_id.as_deref().unwrap_or_default(),
                    request.cwd().unwrap_or_default(),
                    "streaming",
                ) {
                    update_runtime_assistant_block(
                        store,
                        local_task_id,
                        request,
                        &block_id,
                        updates,
                    );
                }
            }
            "item/started" => {
                self.observe_root_thread(params);
                if self.is_subagent_delta(params) {
                    self.remember_subagent_item(params);
                    return;
                }
                self.agent_message_phases.observe_item(params);
                if let Some(block) = workbench_block_from_notification(
                    params,
                    &request.subtask_id,
                    request.device_id.as_deref().unwrap_or_default(),
                    request.cwd().unwrap_or_default(),
                    Some("pending"),
                ) {
                    cache_runtime_assistant_block(store, local_task_id, request, block);
                }
            }
            "item/completed" => {
                self.observe_root_thread(params);
                if self.is_subagent_delta(params) {
                    self.forget_subagent_item(params);
                    self.agent_message_phases.forget_item(params);
                    return;
                }
                let phase = self.agent_message_phases.phase_for_item(params);
                if self.cache_text_chunk(
                    store,
                    local_task_id,
                    request,
                    &notification.method,
                    params,
                    phase.as_deref(),
                ) {
                    self.agent_message_phases.forget_item(params);
                    return;
                }
                if let Some(text) = plan_item_text(params) {
                    cache_runtime_assistant_plan_item(store, local_task_id, request, params, text);
                    self.agent_message_phases.forget_item(params);
                    return;
                }
                if let Some(block) = completed_workbench_block_from_notification(
                    params,
                    &request.subtask_id,
                    request.device_id.as_deref().unwrap_or_default(),
                    request.cwd().unwrap_or_default(),
                ) {
                    cache_runtime_assistant_block(store, local_task_id, request, block);
                    self.agent_message_phases.forget_item(params);
                    return;
                }
                if let Some((block_id, updates)) = tool_update_from_notification(params) {
                    update_runtime_assistant_block(
                        store,
                        local_task_id,
                        request,
                        &block_id,
                        updates,
                    );
                }
                self.agent_message_phases.forget_item(params);
            }
            "thread/started" => {
                self.observe_root_thread(params);
                cache_runtime_thread_id(store, local_task_id, params);
            }
            "context/compaction" => {
                cache_runtime_context_compaction(store, local_task_id, request, params)
            }
            "turn/completed" if is_root_codex_turn_event(params) => {
                complete_runtime_assistant_message(store, local_task_id, request)
            }
            "turn/completed" => {}
            _ => debug_ignored_codex_notification(message, &notification.method, params),
        }
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

    fn cache_text_chunk(
        &mut self,
        store: &RuntimeWorkStore,
        local_task_id: &str,
        request: &ExecutionRequest,
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
                    local_task_id,
                    method,
                    "cache_process_delta",
                    resolved_phase,
                    params,
                    &delta,
                );
                append_runtime_assistant_process_delta(
                    store,
                    local_task_id,
                    request,
                    process_kind,
                    block_type,
                    item_id,
                    delta,
                );
                true
            }
            Ok(Some(TextChunkMapping::FinalDelta { delta })) => {
                log_stream_text_mapping(
                    local_task_id,
                    method,
                    "cache_final_delta",
                    resolved_phase,
                    params,
                    &delta,
                );
                append_runtime_assistant_content_delta(store, local_task_id, request, delta);
                true
            }
            Ok(Some(TextChunkMapping::ProcessCompleted {
                process_kind,
                block_type,
                item_id,
                text,
            })) => {
                log_text_mapping(
                    local_task_id,
                    method,
                    "cache_completed_process",
                    resolved_phase,
                    params,
                    &text,
                );
                append_runtime_assistant_process_snapshot(
                    store,
                    local_task_id,
                    request,
                    process_kind,
                    block_type,
                    item_id,
                    text,
                );
                true
            }
            Ok(Some(TextChunkMapping::FinalCompleted)) => {
                log_text_mapping(
                    local_task_id,
                    method,
                    "ignore_completed_final_snapshot",
                    resolved_phase,
                    params,
                    "",
                );
                true
            }
            Ok(None) => false,
            Err(reason) => {
                log_dropped_notification(
                    local_task_id,
                    &request.task_id,
                    &request.subtask_id,
                    method,
                    params,
                    reason,
                );
                true
            }
        }
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

fn is_root_codex_turn_event(params: &Value) -> bool {
    let turn = params.get("turn").unwrap_or(params);
    string_field(turn, "agent_path")
        .or_else(|| string_field(turn, "agentPath"))
        .or_else(|| string_field(params, "agent_path"))
        .or_else(|| string_field(params, "agentPath"))
        .map_or(true, |agent_path| agent_path == "/root")
}

fn cache_runtime_thread_id(store: &RuntimeWorkStore, local_task_id: &str, params: &Value) {
    let Some(thread_id) = params
        .get("thread")
        .and_then(|thread| string_field(thread, "id"))
        .or_else(|| string_field(params, "threadId"))
        .or_else(|| string_field(params, "thread_id"))
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    store.update_task(local_task_id, |link| {
        link.thread_id = Some(thread_id);
        link.updated_at = now_ms();
    });
}

pub(crate) fn retain_runtime_handle_user_messages(runtime_handle: &mut Value) {
    let messages = runtime_handle
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| {
            string_field(message, "role").is_some_and(|role| role.eq_ignore_ascii_case("user"))
        })
        .cloned()
        .collect::<Vec<_>>();
    set_runtime_handle_messages(runtime_handle, messages);
}

fn cache_runtime_assistant_block(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    block: Value,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        complete_open_process_blocks(blocks);
        merge_cached_block(blocks, block);
    });
}

fn cache_runtime_assistant_plan_item(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
    content: String,
) {
    let block_id = plan_block_id(params);
    let process_item_id = notification_item_id(params);
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        if let Some(block) = blocks.iter_mut().find(|block| {
            block_identity(block).as_deref() == Some(block_id.as_str())
                || process_block_accepts_delta_for_item(
                    block,
                    "plan",
                    "plan",
                    process_item_id.as_deref(),
                )
        }) {
            if let Some(object) = block.as_object_mut() {
                object.insert("id".to_owned(), Value::String(block_id.clone()));
                object.insert("process_kind".to_owned(), Value::String("plan".to_owned()));
                object.insert("content".to_owned(), Value::String(content));
                object.insert("status".to_owned(), Value::String("done".to_owned()));
            }
            return;
        }

        let mut block = json!({
            "id": block_id,
            "type": "plan",
            "process_kind": "plan",
            "content": content,
            "status": "done",
            "timestamp": now_ms(),
        });
        if let Some(process_item_id) = process_item_id {
            if let Some(object) = block.as_object_mut() {
                object.insert("process_item_id".to_owned(), Value::String(process_item_id));
            }
        }
        blocks.push(block);
    });
}

fn update_runtime_assistant_block(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    block_id: &str,
    updates: Value,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        update_cached_block(blocks, block_id, updates);
    });
}

fn append_runtime_assistant_tool_output_delta(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    tool_use_id: &str,
    delta: String,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        append_tool_output_delta(blocks, tool_use_id, delta);
    });
}

fn append_runtime_assistant_process_delta(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    process_kind: &str,
    block_type: &str,
    process_item_id: Option<String>,
    delta: String,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        append_process_block_delta(
            blocks,
            local_task_id,
            &request.subtask_id,
            process_kind,
            block_type,
            process_item_id,
            delta,
        );
    });
}

fn append_runtime_assistant_process_snapshot(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    process_kind: &str,
    block_type: &str,
    process_item_id: Option<String>,
    content: String,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        if let Some(block) = blocks.iter_mut().rev().find(|block| {
            process_block_accepts_delta_for_item(
                block,
                block_type,
                process_kind,
                process_item_id.as_deref(),
            )
        }) {
            if let Some(object) = block.as_object_mut() {
                object.insert("content".to_owned(), Value::String(content));
                object.insert("status".to_owned(), Value::String("done".to_owned()));
            }
            return;
        }

        let block_index = blocks
            .iter()
            .filter(|block| string_field(block, "type").as_deref() == Some(block_type))
            .count()
            + 1;
        blocks.push(json!({
            "id": format!("{block_type}-{local_task_id}-{}-{block_index}", request.subtask_id),
            "type": block_type,
            "process_kind": process_kind,
            "process_item_id": process_item_id,
            "content": content,
            "status": "done",
            "timestamp": now_ms(),
        }));
    });
}

fn append_runtime_assistant_content_delta(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    delta: String,
) {
    mutate_cached_assistant_message(store, local_task_id, request, |message| {
        append_message_content_delta(message, delta);
    });
}

fn complete_runtime_assistant_message(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
) {
    mutate_existing_cached_assistant_message(store, local_task_id, request, |message| {
        if let Some(object) = message.as_object_mut() {
            object.insert("status".to_owned(), Value::String("done".to_owned()));
        }
        complete_open_process_blocks(ensure_message_blocks(message));
    });
}

pub(crate) fn merge_cached_messages(
    codex_messages: Vec<Value>,
    cached_messages: Vec<Value>,
) -> Vec<Value> {
    if cached_messages.is_empty() {
        return codex_messages;
    }
    if codex_messages.is_empty() {
        return cached_messages;
    }

    let mut used = vec![false; cached_messages.len()];
    let mut merged = codex_messages
        .into_iter()
        .map(|codex_message| {
            let Some(index) =
                cached_messages
                    .iter()
                    .enumerate()
                    .find_map(|(index, cached_message)| {
                        if !used[index] && messages_match(&codex_message, cached_message) {
                            Some(index)
                        } else {
                            None
                        }
                    })
            else {
                return codex_message;
            };
            used[index] = true;
            merge_cached_message_fields(codex_message, &cached_messages[index])
        })
        .collect::<Vec<_>>();

    for (index, cached_message) in cached_messages.into_iter().enumerate() {
        if !used[index] {
            merged.push(cached_message);
        }
    }
    merged
}

fn mutate_cached_assistant_blocks(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    mutate_blocks: impl FnOnce(&mut Vec<Value>),
) {
    mutate_cached_assistant_message(store, local_task_id, request, |assistant| {
        let blocks = ensure_message_blocks(assistant);
        mutate_blocks(blocks);
    });
}

fn mutate_cached_assistant_message(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    mutate_message: impl FnOnce(&mut Value),
) {
    store.update_task(local_task_id, |link| {
        let mut messages = cached_messages(link);
        let assistant = ensure_cached_assistant_message(&mut messages, local_task_id, request);
        mutate_message(assistant);
        link.updated_at = now_ms();
        set_runtime_handle_messages(&mut link.runtime_handle, messages);
    });
}

fn mutate_existing_cached_assistant_message(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    mutate_message: impl FnOnce(&mut Value),
) {
    store.update_task(local_task_id, |link| {
        let mut messages = cached_messages(link);
        let Some(index) = cached_assistant_message_index(&messages, request) else {
            return;
        };
        mutate_message(&mut messages[index]);
        link.updated_at = now_ms();
        set_runtime_handle_messages(&mut link.runtime_handle, messages);
    });
}

fn cache_runtime_context_compaction(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    params: &Value,
) {
    cache_runtime_assistant_block(
        store,
        local_task_id,
        request,
        context_compaction_block(params),
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

fn merge_cached_message_fields(mut codex_message: Value, cached_message: &Value) -> Value {
    let Some(codex_object) = codex_message.as_object_mut() else {
        return codex_message;
    };
    let Some(cached_object) = cached_message.as_object() else {
        return codex_message;
    };

    for key in ["source", "attachments", "error", "errorType", "error_type"] {
        if !codex_object.contains_key(key) {
            if let Some(value) = cached_object.get(key).cloned() {
                codex_object.insert(key.to_owned(), value);
            }
        }
    }

    if codex_object
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .is_empty()
    {
        if let Some(content) = cached_object.get("content").cloned() {
            codex_object.insert("content".to_owned(), content);
        }
    }

    if let Some(blocks) = merge_message_blocks(
        codex_object.get("blocks").and_then(Value::as_array),
        cached_object.get("blocks").and_then(Value::as_array),
    ) {
        codex_object.insert("blocks".to_owned(), Value::Array(blocks));
    }

    codex_message
}

fn messages_match(left: &Value, right: &Value) -> bool {
    if string_field(left, "role") != string_field(right, "role") {
        return false;
    }

    let left_subtask_id = id_field(left, "subtaskId");
    let right_subtask_id = id_field(right, "subtaskId");
    if left_subtask_id.is_some() && right_subtask_id.is_some() {
        return left_subtask_id == right_subtask_id;
    }

    let left_content = string_field(left, "content").unwrap_or_default();
    let right_content = string_field(right, "content").unwrap_or_default();
    if left_content == right_content {
        return true;
    }
    !right_content.is_empty()
        && right.get("attachments").is_some()
        && left_content.contains(&right_content)
}

fn ensure_cached_assistant_message<'a>(
    messages: &'a mut Vec<Value>,
    local_task_id: &str,
    request: &ExecutionRequest,
) -> &'a mut Value {
    if let Some(index) = cached_assistant_message_index(messages, request) {
        return &mut messages[index];
    }

    messages.push(json!({
        "id": format!("{local_task_id}:assistant:{}", request.subtask_id),
        "role": "assistant",
        "content": "",
        "status": "streaming",
        "subtaskId": request.subtask_id.to_string(),
        "createdAt": now_ms(),
        "blocks": [],
    }));
    messages
        .last_mut()
        .expect("assistant message was just inserted")
}

fn cached_assistant_message_index(messages: &[Value], request: &ExecutionRequest) -> Option<usize> {
    messages.iter().rposition(|message| {
        if !string_field(message, "role").is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        {
            return false;
        }
        id_field(message, "subtaskId")
            .is_some_and(|message_subtask_id| message_subtask_id == request.subtask_id)
    })
}

fn ensure_message_blocks(message: &mut Value) -> &mut Vec<Value> {
    if !message.is_object() {
        *message = Value::Object(Map::new());
    }
    let object = message
        .as_object_mut()
        .expect("message object was just inserted");
    if !object.get("blocks").is_some_and(Value::is_array) {
        object.insert("blocks".to_owned(), Value::Array(Vec::new()));
    }
    object
        .get_mut("blocks")
        .and_then(Value::as_array_mut)
        .expect("blocks array was just inserted")
}

fn merge_cached_block(blocks: &mut Vec<Value>, block: Value) {
    let Some(block_id) = block_identity(&block) else {
        blocks.push(block);
        return;
    };
    if let Some(existing) = blocks
        .iter_mut()
        .find(|existing| block_identity(existing).as_deref() == Some(block_id.as_str()))
    {
        *existing = block;
        return;
    }
    blocks.push(block);
}

fn update_cached_block(blocks: &mut [Value], block_id: &str, updates: Value) {
    let Some(block) = blocks
        .iter_mut()
        .find(|block| block_identity(block).as_deref() == Some(block_id))
    else {
        return;
    };
    let Some(block_object) = block.as_object_mut() else {
        return;
    };
    let Some(updates_object) = updates.as_object() else {
        return;
    };
    for (key, value) in updates_object {
        block_object.insert(key.clone(), value.clone());
    }
}

fn append_tool_output_delta(blocks: &mut [Value], tool_use_id: &str, delta: String) {
    let Some(block) = blocks.iter_mut().rev().find(|block| {
        block_identity(block).as_deref() == Some(tool_use_id)
            || string_field(block, "tool_use_id").as_deref() == Some(tool_use_id)
    }) else {
        return;
    };
    let Some(object) = block.as_object_mut() else {
        return;
    };
    let mut output = object
        .get("tool_output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    output.push_str(&delta);
    object.insert("tool_output".to_owned(), Value::String(output));
    object.insert("status".to_owned(), Value::String("streaming".to_owned()));
}

fn block_identity(block: &Value) -> Option<String> {
    string_field(block, "id").or_else(|| string_field(block, "tool_use_id"))
}

fn merge_message_blocks(
    codex_blocks: Option<&Vec<Value>>,
    cached_blocks: Option<&Vec<Value>>,
) -> Option<Vec<Value>> {
    let cached_blocks = cached_blocks.filter(|blocks| !blocks.is_empty())?;
    let codex_blocks = codex_blocks.cloned().unwrap_or_default();
    if codex_blocks.is_empty() {
        return Some(cached_blocks.clone());
    }

    let mut used_codex_blocks = vec![false; codex_blocks.len()];
    let mut merged = Vec::new();
    for cached_block in cached_blocks {
        if let Some(index) = matching_block_index(&codex_blocks, &used_codex_blocks, cached_block) {
            used_codex_blocks[index] = true;
            merged.push(merge_cached_block_fields(
                codex_blocks[index].clone(),
                cached_block,
            ));
        } else {
            merged.push(cached_block.clone());
        }
    }

    for (index, codex_block) in codex_blocks.into_iter().enumerate() {
        if !used_codex_blocks[index] {
            merged.push(codex_block);
        }
    }

    Some(merged)
}

fn merge_cached_block_fields(mut codex_block: Value, cached_block: &Value) -> Value {
    let Some(codex_object) = codex_block.as_object_mut() else {
        return codex_block;
    };
    let Some(cached_object) = cached_block.as_object() else {
        return codex_block;
    };

    for key in ["content", "tool_input", "tool_output"] {
        if field_should_fill_from_cached(codex_object.get(key)) {
            if let Some(value) = cached_object.get(key).cloned() {
                codex_object.insert(key.to_owned(), value);
            }
        }
    }

    let codex_status = codex_object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let cached_status = cached_object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !cached_status.is_empty()
        && (codex_status.is_empty() || block_status_is_pending(codex_status))
        && !block_status_is_pending(cached_status)
    {
        codex_object.insert("status".to_owned(), Value::String(cached_status.to_owned()));
    }

    codex_block
}

fn field_should_fill_from_cached(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(value)) => value.is_empty(),
        Some(Value::Array(value)) => value.is_empty(),
        Some(Value::Object(value)) => value.is_empty(),
        _ => false,
    }
}

fn block_status_is_pending(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "pending" | "running" | "streaming" | "inprogress" | "in_progress" | "active" | "busy"
    )
}

fn matching_block_index(blocks: &[Value], used_blocks: &[bool], block: &Value) -> Option<usize> {
    let identity = block_identity(block);
    blocks.iter().enumerate().find_map(|(index, candidate)| {
        if used_blocks[index] {
            return None;
        }
        match identity.as_deref() {
            Some(identity) if block_identity(candidate).as_deref() == Some(identity) => Some(index),
            None if candidate == block => Some(index),
            _ => None,
        }
    })
}

fn append_process_block_delta(
    blocks: &mut Vec<Value>,
    local_task_id: &str,
    subtask_id: &str,
    process_kind: &str,
    block_type: &str,
    process_item_id: Option<String>,
    delta: String,
) {
    if let Some(block) = blocks.iter_mut().rev().find(|block| {
        process_block_accepts_delta_for_item(
            block,
            block_type,
            process_kind,
            process_item_id.as_deref(),
        )
    }) {
        append_block_content_delta(block, delta);
        return;
    }

    let block_index = blocks
        .iter()
        .filter(|block| string_field(block, "type").as_deref() == Some(block_type))
        .count()
        + 1;
    blocks.push(json!({
        "id": format!("{block_type}-{local_task_id}-{subtask_id}-{block_index}"),
        "type": block_type,
        "process_kind": process_kind,
        "process_item_id": process_item_id,
        "content": delta,
        "status": "streaming",
        "timestamp": now_ms(),
    }));
}

fn append_message_content_delta(message: &mut Value, delta: String) {
    if !message.is_object() {
        *message = Value::Object(Map::new());
    }
    let object = message
        .as_object_mut()
        .expect("message object was just inserted");
    let mut content = object
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    content.push_str(&delta);
    object.insert("content".to_owned(), Value::String(content));
    object.insert("status".to_owned(), Value::String("streaming".to_owned()));
}

fn append_block_content_delta(block: &mut Value, delta: String) {
    let Some(object) = block.as_object_mut() else {
        return;
    };
    let mut content = object
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    content.push_str(&delta);
    object.insert("content".to_owned(), Value::String(content));
    object.insert("status".to_owned(), Value::String("streaming".to_owned()));
}

fn process_block_accepts_delta(block: &Value, block_type: &str) -> bool {
    string_field(block, "type").as_deref() == Some(block_type)
        && !matches!(
            string_field(block, "status")
                .unwrap_or_else(|| "streaming".to_owned())
                .replace(['_', '-'], "")
                .to_ascii_lowercase()
                .as_str(),
            "done" | "completed" | "error" | "failed" | "cancelled" | "canceled"
        )
}

fn process_block_accepts_delta_for_item(
    block: &Value,
    block_type: &str,
    process_kind: &str,
    process_item_id: Option<&str>,
) -> bool {
    if string_field(block, "type").as_deref() != Some(block_type)
        || string_field(block, "process_kind").as_deref() != Some(process_kind)
    {
        return false;
    }

    match process_item_id {
        Some(item_id) => string_field(block, "process_item_id").as_deref() == Some(item_id),
        None => process_block_accepts_delta(block, block_type),
    }
}

fn complete_open_process_blocks(blocks: &mut Vec<Value>) {
    for block in blocks {
        let Some(block_type) = string_field(block, "type") else {
            continue;
        };
        if !matches!(block_type.as_str(), "thinking" | "text" | "plan")
            || !process_block_accepts_delta(block, &block_type)
        {
            continue;
        }
        if let Some(object) = block.as_object_mut() {
            object.insert("status".to_owned(), Value::String("done".to_owned()));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    #[test]
    fn cache_codex_notification_accepts_wrapped_response_items() {
        let index_path = temp_index_path("wrapped-cache");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "commentary",
                    "message": "I will inspect."
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "response_item",
                "payload": {
                    "type": "reasoning",
                    "summary": ["Checking files."]
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "response_item",
                "payload": {
                    "id": "call-1",
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"rg runtime\"}"
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": "runtime.rs"
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["blocks"][0]["type"], "text");
        assert_eq!(messages[0]["blocks"][0]["content"], "I will inspect.");
        assert_eq!(messages[0]["blocks"][0]["status"], "done");
        assert_eq!(messages[0]["blocks"][1]["type"], "thinking");
        assert_eq!(messages[0]["blocks"][1]["content"], "Checking files.");
        assert_eq!(messages[0]["blocks"][1]["status"], "done");
        assert_eq!(messages[0]["blocks"][2]["tool_name"], "exec_command");
        assert_eq!(messages[0]["blocks"][2]["tool_output"], "runtime.rs");
        assert_eq!(messages[0]["blocks"][2]["status"], "done");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_preserves_context_compaction_as_tool_block() {
        let index_path = temp_index_path("context-compaction-cache");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "event_msg",
                "payload": {
                    "id": "ctx-1",
                    "type": "context_compacted"
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "assistant");
        assert_eq!(messages[0]["blocks"][0]["id"], "ctx-1");
        assert_eq!(messages[0]["blocks"][0]["type"], "tool");
        assert_eq!(messages[0]["blocks"][0]["tool_name"], "context_compaction");
        assert_eq!(messages[0]["blocks"][0]["status"], "done");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_appends_exec_output_delta_to_tool_block() {
        let index_path = temp_index_path("exec-output-delta-cache");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "response_item",
                "payload": {
                    "id": "call-1",
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"printf hello\"}"
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "event_msg",
                "payload": {
                    "type": "exec_command_output_delta",
                    "call_id": "call-1",
                    "stream": "stdout",
                    "chunk": "hello"
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "event_msg",
                "payload": {
                    "type": "exec_command_output_delta",
                    "call_id": "call-1",
                    "stream": "stdout",
                    "chunk": "\n"
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        let block = &messages[0]["blocks"][0];
        assert_eq!(block["tool_name"], "exec_command");
        assert_eq!(block["tool_output"], "hello\n");
        assert_eq!(block["status"], "streaming");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_keeps_commentary_agent_delta_out_of_content() {
        let index_path = temp_index_path("commentary-agent-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        let mut mapper = CodexNotificationCacheMapper::default();
        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "I will inspect."
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "");
        assert_eq!(messages[0]["blocks"][0]["type"], "text");
        assert_eq!(messages[0]["blocks"][0]["content"], "I will inspect.");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_merges_commentary_text_across_tool_blocks() {
        let index_path = temp_index_path("commentary-text-across-tool");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        let mut mapper = CodexNotificationCacheMapper::default();
        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "I already "
                }
            }),
        );
        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
                "type": "response_item",
                "payload": {
                        "id": "call-1",
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                }
            }),
        );
        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "started explorers."
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        let blocks = messages[0]["blocks"]
            .as_array()
            .expect("blocks should be an array");
        let text_blocks: Vec<&Value> = blocks
            .iter()
            .filter(|block| block["type"].as_str() == Some("text"))
            .collect();
        assert_eq!(text_blocks.len(), 1);
        assert_eq!(text_blocks[0]["content"], "I already started explorers.");
        assert_eq!(blocks[1]["type"], "tool");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_keeps_commentary_channel_delta_out_of_content() {
        let index_path = temp_index_path("commentary-channel-agent-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "channel": "commentary",
                    "delta": "I will inspect."
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "");
        assert_eq!(messages[0]["blocks"][0]["type"], "text");
        assert_eq!(messages[0]["blocks"][0]["content"], "I will inspect.");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_keeps_unphased_agent_delta_as_content() {
        let index_path = temp_index_path("unphased-agent-final-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "delta": "Current directory: /tmp/project"
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "Current directory: /tmp/project");
        assert_eq!(messages[0]["blocks"].as_array().map(Vec::len), Some(0));

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_ignores_completed_final_snapshot_after_delta() {
        let index_path = temp_index_path("final-snapshot-ignored-after-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-final",
                    "delta": "Done."
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": "msg-final",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "Done.Done."
                    }
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "Done.");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_appends_completed_plan_item_as_plan_block() {
        let index_path = temp_index_path("completed-plan-item");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
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

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "");
        let blocks = messages[0]["blocks"]
            .as_array()
            .expect("plan block should be cached");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["id"], "plan-turn-1-plan");
        assert_eq!(blocks[0]["type"], "plan");
        assert_eq!(blocks[0]["status"], "done");
        assert_eq!(blocks[0]["content"], "# Plan\n\n- Inspect the repo.");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_updates_streaming_plan_block_on_completion() {
        let index_path = temp_index_path("streaming-plan-item");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };

        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/plan/delta",
                "params": {
                    "itemId": "turn-1-plan",
                    "delta": "# Plan\n"
                }
            }),
        );
        cache_codex_notification(
            &store,
            local_task_id,
            &request,
            &json!({
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

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        let blocks = messages[0]["blocks"]
            .as_array()
            .expect("plan block should be cached");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["id"], "plan-turn-1-plan");
        assert_eq!(blocks[0]["type"], "plan");
        assert_eq!(blocks[0]["process_kind"], "plan");
        assert_eq!(blocks[0]["status"], "done");
        assert_eq!(blocks[0]["content"], "# Plan\n\n- Inspect the repo.");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_ignores_subagent_agent_message_deltas() {
        let index_path = temp_index_path("subagent-agent-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationCacheMapper::default();

        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-child",
                    "delta": "child output"
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        assert!(cached_messages(&link).is_empty());

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_ignores_cross_thread_agent_message_deltas() {
        let index_path = temp_index_path("cross-thread-agent-delta");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationCacheMapper::default();

        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": "root-thread"
                    }
                }
            }),
        );
        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
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
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "msg-root",
                    "delta": "root"
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "root");

        let _ = fs::remove_file(index_path);
    }

    #[test]
    fn cache_codex_notification_ignores_subagent_turn_completion() {
        let index_path = temp_index_path("subagent-turn-complete");
        let store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = "runtime-cache";
        store.upsert_task(RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Runtime cache".to_owned(),
        ));
        let request = ExecutionRequest {
            task_id: "1".to_owned(),
            subtask_id: "42".to_owned(),
            ..ExecutionRequest::default()
        };
        let mut mapper = CodexNotificationCacheMapper::default();

        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "delta": "Still working"
                }
            }),
        );
        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed",
                        "agent_path": "/root/worker"
                    }
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages[0]["status"], "streaming");

        mapper.map(
            &store,
            local_task_id,
            &request,
            &json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed",
                        "agent_path": "/root"
                    }
                }
            }),
        );

        let link = store
            .get_task(local_task_id)
            .expect("runtime task should exist");
        let messages = cached_messages(&link);
        assert_eq!(messages[0]["status"], "done");

        let _ = fs::remove_file(index_path);
    }

    fn temp_index_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wegent-runtime-work-{label}-{}-{}.json",
            std::process::id(),
            now_ms()
        ))
    }
}
