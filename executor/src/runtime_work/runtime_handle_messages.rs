// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};

use crate::protocol::ExecutionRequest;

use super::{
    codex_notifications::{codex_notification, debug_ignored_codex_notification},
    response::RuntimeTaskLink,
    store::RuntimeWorkStore,
    transcript::{tool_block_from_notification, tool_update_from_notification},
    util::{extract_text, integer_field, now_ms, reasoning_content, string_field},
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

pub(crate) fn cache_codex_notification(
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
                    "thinking",
                    delta,
                );
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = string_field(params, "delta")
                .or_else(|| extract_text(params))
                .filter(|delta| !delta.is_empty())
            {
                match assistant_delta_phase(params).as_deref() {
                    Some("analysis") | Some("commentary") => {
                        append_runtime_assistant_process_delta(
                            store,
                            local_task_id,
                            request,
                            "text",
                            delta,
                        )
                    }
                    _ => {
                        append_runtime_assistant_content_delta(store, local_task_id, request, delta)
                    }
                }
            }
        }
        "item/started" => {
            if let Some(block) = tool_block_from_notification(params, "pending") {
                cache_runtime_assistant_block(store, local_task_id, request, block);
            }
        }
        "item/completed" => {
            if let Some((block_id, updates)) = tool_update_from_notification(params) {
                update_runtime_assistant_block(store, local_task_id, request, &block_id, updates);
            }
        }
        "turn/completed" => complete_runtime_assistant_message(store, local_task_id, request),
        _ => debug_ignored_codex_notification(message, &notification.method, params),
    }
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
    block_type: &str,
    delta: String,
) {
    mutate_cached_assistant_blocks(store, local_task_id, request, |blocks| {
        append_process_block_delta(blocks, local_task_id, request.subtask_id, block_type, delta);
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
        let Some(index) = cached_assistant_message_index(&messages, request.subtask_id) else {
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
    if let Some(index) = cached_assistant_message_index(messages, request.subtask_id) {
        return &mut messages[index];
    }

    messages.push(json!({
        "id": format!("{local_task_id}:assistant:{}", request.subtask_id),
        "role": "assistant",
        "content": "",
        "status": "streaming",
        "subtaskId": request.subtask_id,
        "createdAt": now_ms(),
        "blocks": [],
    }));
    messages
        .last_mut()
        .expect("assistant message was just inserted")
}

fn cached_assistant_message_index(messages: &[Value], subtask_id: i64) -> Option<usize> {
    messages.iter().rposition(|message| {
        string_field(message, "role").is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
            && integer_field(message, "subtaskId")
                .or_else(|| integer_field(message, "subtask_id"))
                .is_some_and(|message_subtask_id| message_subtask_id == subtask_id)
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
            merged.push(codex_blocks[index].clone());
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
    block_type: &str,
    delta: String,
) {
    if let Some(block) = blocks
        .last_mut()
        .filter(|block| process_block_accepts_delta(block, block_type))
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

fn assistant_delta_phase(params: &Value) -> Option<String> {
    string_field(params, "phase").map(|phase| phase.replace(['_', '-'], "").to_ascii_lowercase())
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

    fn temp_index_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wegent-runtime-work-{label}-{}-{}.json",
            std::process::id(),
            now_ms()
        ))
    }
}
