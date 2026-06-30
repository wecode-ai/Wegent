// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};

use crate::{
    codex_phase::{codex_phase_is_process, codex_phase_name, CodexAgentMessagePhaseTracker},
    logging::log_executor_event,
    protocol::ExecutionRequest,
};

use super::{
    codex_notifications::{codex_notification, debug_ignored_codex_notification},
    response::RuntimeTaskLink,
    store::RuntimeWorkStore,
    transcript::{tool_block_from_notification, tool_update_from_notification},
    util::{
        extract_text, integer_field, now_ms, raw_string_field, reasoning_content, string_field,
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
                if let Some(delta) = string_field(params, "delta")
                    .or_else(|| reasoning_content(params))
                    .filter(|delta| !delta.is_empty())
                {
                    append_runtime_assistant_process_delta(
                        store,
                        local_task_id,
                        request,
                        "reasoning",
                        "thinking",
                        delta,
                    );
                }
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = agent_text(params).filter(|delta| !delta.is_empty()) {
                    let phase = self.agent_message_phases.phase_for_delta(params);
                    if codex_phase_is_process(phase.as_deref()) {
                        log_codex_cache_text_classification(
                            local_task_id,
                            &notification.method,
                            "append_process_block",
                            phase.as_deref(),
                            params,
                            &delta,
                        );
                        append_runtime_assistant_process_delta(
                            store,
                            local_task_id,
                            request,
                            "assistant_message",
                            "text",
                            delta,
                        );
                    } else {
                        log_codex_cache_text_classification(
                            local_task_id,
                            &notification.method,
                            "append_content",
                            phase.as_deref(),
                            params,
                            &delta,
                        );
                        append_runtime_assistant_content_delta(
                            store,
                            local_task_id,
                            request,
                            delta,
                        );
                    }
                }
            }
            "item/started" => {
                self.agent_message_phases.observe_item(params);
                if let Some(block) = tool_block_from_notification(params, "pending") {
                    cache_runtime_assistant_block(store, local_task_id, request, block);
                }
            }
            "item/completed" => {
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
            "thread/started" => cache_runtime_thread_id(store, local_task_id, params),
            "turn/completed" => complete_runtime_assistant_message(store, local_task_id, request),
            _ => debug_ignored_codex_notification(message, &notification.method, params),
        }
    }
}

fn agent_text(params: &Value) -> Option<String> {
    raw_string_field(params, "delta").or_else(|| extract_text(params))
}

fn log_codex_cache_text_classification(
    local_task_id: &str,
    method: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    text: &str,
) {
    log_executor_event(
        "codex runtime cache text classification",
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
            ("text_preview", truncate_log_text(text, 160)),
        ],
    );
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

fn append_runtime_assistant_process_delta(
    store: &RuntimeWorkStore,
    local_task_id: &str,
    request: &ExecutionRequest,
    process_kind: &str,
    block_type: &str,
    delta: String,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        append_process_block_delta(
            blocks,
            local_task_id,
            request.subtask_id,
            process_kind,
            block_type,
            delta,
        );
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
    let left_message_id = integer_field(left, "message_id");
    let right_message_id = integer_field(right, "message_id");
    if left_message_id.is_some() && right_message_id.is_some() {
        return left_message_id == right_message_id;
    }

    let left_subtask_id = integer_field(left, "turn_id")
        .or_else(|| integer_field(left, "subtaskId"))
        .or_else(|| integer_field(left, "subtask_id"));
    let right_subtask_id = integer_field(right, "turn_id")
        .or_else(|| integer_field(right, "subtaskId"))
        .or_else(|| integer_field(right, "subtask_id"));
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

    let message_identity = request
        .message_id
        .map(|message_id| message_id.to_string())
        .unwrap_or_else(|| request.subtask_id.to_string());
    messages.push(json!({
        "id": format!("{local_task_id}:assistant:{message_identity}"),
        "role": "assistant",
        "content": "",
        "status": "streaming",
        "subtaskId": request.subtask_id,
        "subtask_id": request.subtask_id,
        "turn_id": request.subtask_id,
        "message_id": request.message_id,
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
        if let Some(message_id) = request.message_id {
            return integer_field(message, "message_id")
                .is_some_and(|cached_message_id| cached_message_id == message_id);
        }
        integer_field(message, "turn_id")
            .or_else(|| integer_field(message, "subtaskId"))
            .or_else(|| integer_field(message, "subtask_id"))
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
    subtask_id: i64,
    process_kind: &str,
    block_type: &str,
    delta: String,
) {
    if let Some(block) = blocks
        .last_mut()
        .filter(|block| process_block_accepts_delta_with_kind(block, block_type, process_kind))
    {
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

fn process_block_accepts_delta_with_kind(
    block: &Value,
    block_type: &str,
    process_kind: &str,
) -> bool {
    process_block_accepts_delta(block, block_type)
        && string_field(block, "process_kind").as_deref() == Some(process_kind)
}

fn complete_open_process_blocks(blocks: &mut Vec<Value>) {
    for block in blocks {
        let Some(block_type) = string_field(block, "type") else {
            continue;
        };
        if !matches!(block_type.as_str(), "thinking" | "text")
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
            task_id: 1,
            subtask_id: 42,
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
            task_id: 1,
            subtask_id: 42,
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
            task_id: 1,
            subtask_id: 42,
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
            task_id: 1,
            subtask_id: 42,
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

    fn temp_index_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wegent-runtime-work-{label}-{}-{}.json",
            std::process::id(),
            now_ms()
        ))
    }
}
