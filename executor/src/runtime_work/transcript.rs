// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::util::{
    extract_text, integer_field, item_id, item_type, now_ms, raw_string_field, reasoning_content,
    string_field,
};

pub(crate) fn transcript_messages(thread: &Value) -> Vec<Value> {
    let mut messages = Vec::new();
    for turn in thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let created_at = integer_field(turn, "createdAt").unwrap_or_else(now_ms);
        let mut blocks = Vec::new();
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match item_type(item).as_str() {
                "usermessage" => push_user_message(&mut messages, item, created_at),
                "reasoning" => push_reasoning_block(&mut blocks, item, created_at),
                "commandexecution" => blocks.push(command_block(item, created_at)),
                "agentmessage" | "message" => {
                    push_assistant_message(&mut messages, item, created_at, &blocks);
                    blocks.clear();
                }
                _ => {}
            }
        }
    }
    messages
}

pub(crate) fn tool_block_from_notification(params: &Value, status: &str) -> Option<Value> {
    let item = params.get("item").unwrap_or(params);
    let item_type = item_type(item);
    if !matches!(item_type.as_str(), "commandexecution" | "shellcall") {
        return None;
    }
    Some(json!({
        "id": item_id(item, "tool"),
        "type": "tool",
        "tool_use_id": item_id(item, "tool"),
        "tool_name": "bash",
        "tool_input": command_input(item),
        "status": status,
        "timestamp": now_ms(),
    }))
}

pub(crate) fn tool_update_from_notification(params: &Value) -> Option<(String, Value)> {
    let item = params.get("item").unwrap_or(params);
    let item_type = item_type(item);
    if !matches!(item_type.as_str(), "commandexecution" | "shellcall") {
        return None;
    }
    Some((
        item_id(item, "tool"),
        json!({
            "status": "done",
            "tool_output": command_output(item),
        }),
    ))
}

fn push_user_message(messages: &mut Vec<Value>, item: &Value, created_at: i64) {
    if let Some(content) = extract_text(item) {
        messages.push(json!({
            "id": item_id(item, "user"),
            "role": "user",
            "content": content,
            "status": "done",
            "createdAt": created_at,
        }));
    }
}

fn push_reasoning_block(blocks: &mut Vec<Value>, item: &Value, created_at: i64) {
    if let Some(content) = reasoning_content(item) {
        blocks.push(json!({
            "id": item_id(item, "thinking"),
            "type": "thinking",
            "content": content,
            "status": "done",
            "timestamp": created_at,
        }));
    }
}

fn push_assistant_message(
    messages: &mut Vec<Value>,
    item: &Value,
    created_at: i64,
    blocks: &[Value],
) {
    if let Some(content) = extract_text(item) {
        messages.push(json!({
            "id": item_id(item, "assistant"),
            "role": "assistant",
            "content": content,
            "status": "done",
            "createdAt": created_at,
            "blocks": blocks,
        }));
    }
}

fn command_block(item: &Value, timestamp: i64) -> Value {
    let status = string_field(item, "status").unwrap_or_else(|| "completed".to_owned());
    json!({
        "id": item_id(item, "tool"),
        "type": "tool",
        "tool_use_id": item_id(item, "tool"),
        "tool_name": "bash",
        "tool_input": command_input(item),
        "tool_output": command_output(item),
        "status": if status.eq_ignore_ascii_case("failed") || status.eq_ignore_ascii_case("error") {
            "error"
        } else {
            "done"
        },
        "timestamp": timestamp,
    })
}

fn command_input(item: &Value) -> Value {
    json!({
        "command": string_field(item, "command").unwrap_or_default(),
        "cwd": string_field(item, "cwd").unwrap_or_default(),
    })
}

fn command_output(item: &Value) -> String {
    raw_string_field(item, "aggregatedOutput")
        .or_else(|| raw_string_field(item, "output"))
        .unwrap_or_default()
}
