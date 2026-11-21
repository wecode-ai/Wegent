// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `chat:block_created` and `chat:block_updated` Socket.IO frames.
//!
//! Mirrors the block branches of `WebSocketResultEmitter`
//! (`app/services/execution/emitters/websocket.py`) together with the payload
//! builders of `WebPageSocketEmitter`
//! (`app/services/chat/webpage_ws_chat_emitter.py:291-374`):
//!
//! - `tool_start` -> `_emit_block_created` (`websocket.py:320`)
//! - `tool_argument_delta` / `tool_argument_done` -> `emit_block_updated`
//!   (`websocket.py:344-362`)
//! - `tool_result` -> `_emit_block_updated` (`websocket.py:429`)
//! - `block_created` -> `_emit_direct_block_created` (`websocket.py:365`)
//! - `block_updated` -> `_emit_direct_block_updated` (`websocket.py:382`)
//! - `done` -> `_emit_result_guidance_blocks` (`websocket.py:413`)
//!
//! Every builder here returns the exact frame payload the source passes to
//! `socketio.emit`; the `publish_*` helpers are the one-line call sites used by
//! the streaming emitter. The source's `create_tool_block` for the socket frame
//! deliberately receives no tool protocol or MCP server label: those fields
//! belong to the persisted block and must not leak into `chat:block_created`.
use brz_redis::{Redis, RedisResult};
use serde_json::{Map, Value, json};

use super::event::ExecutionEvent;
use super::session;
use super::socketio::publish_emit;

/// `chat:block_created` payload: `{"task_id", "subtask_id", "block"}`
/// (`webpage_ws_chat_emitter.py:305-313`).
pub(crate) fn created_payload(task_id: i64, subtask_id: i64, block: &Map<String, Value>) -> Value {
    json!({
        "task_id": task_id,
        "subtask_id": subtask_id,
        "block": Value::Object(block.clone()),
    })
}

/// `chat:block_updated` payload (`webpage_ws_chat_emitter.py:335-374`).
///
/// The source builds the payload from the declared keyword arguments in this
/// exact order; a value that is `None` (JSON null) or absent is omitted.
pub(crate) fn updated_payload(
    task_id: i64,
    subtask_id: i64,
    block_id: &str,
    updates: &Map<String, Value>,
) -> Value {
    const KEYS: [&str; 9] = [
        "content",
        "tool_output",
        "tool_input",
        "parent_tool_use_id",
        "render_payload",
        "output",
        "summary",
        "children",
        "status",
    ];
    let mut payload = Map::new();
    payload.insert("task_id".into(), json!(task_id));
    payload.insert("subtask_id".into(), json!(subtask_id));
    payload.insert("block_id".into(), Value::String(block_id.to_string()));
    for key in KEYS {
        if let Some(value) = updates.get(key).filter(|value| !value.is_null()) {
            payload.insert(key.into(), value.clone());
        }
    }
    Value::Object(payload)
}

/// `WebSocketResultEmitter._emit_block_created`'s tool block
/// (`websocket.py:327-337`): `create_tool_block` plus the streaming-arguments
/// override. MCP protocol metadata is not part of the socket block.
pub(crate) fn tool_block(event: &ExecutionEvent) -> Map<String, Value> {
    let display_name = event.data.get("display_name").and_then(Value::as_str);
    let mut block = session::create_tool_block(
        event.tool_use_id.as_deref().unwrap_or_default(),
        event.tool_name.as_deref().unwrap_or_default(),
        event.tool_input.as_ref(),
        display_name,
        None,
        None,
    );
    if event.data.get("argument_status").and_then(Value::as_str) == Some("streaming") {
        block.insert(
            "status".into(),
            Value::String("generating_arguments".into()),
        );
        block.insert("argument_status".into(), Value::String("streaming".into()));
    }
    block
}

/// `tool_argument_delta` / `tool_argument_done` update map
/// (`websocket.py:344-362`): the current arguments plus the emitted status.
fn argument_updates(event: &ExecutionEvent, status: &str) -> Map<String, Value> {
    let mut updates = Map::new();
    if let Some(tool_input) = event.tool_input.as_ref() {
        updates.insert("tool_input".into(), tool_input.clone());
    }
    updates.insert("status".into(), Value::String(status.to_string()));
    updates
}

/// `_emit_block_updated`'s tool-result update map (`websocket.py:441-453`).
///
/// The source also adds `render_payload` from
/// `build_interactive_form_render_payload`; that helper needs the
/// `interactive_form_question` MCP tool module, which this backend has not
/// migrated, so the field stays absent exactly as for every non-interactive
/// tool.
fn result_updates(event: &ExecutionEvent) -> Map<String, Value> {
    let status = if matches!(
        event.data.get("status").and_then(Value::as_str),
        Some("error" | "failed")
    ) {
        "error"
    } else {
        "done"
    };
    let mut updates = Map::new();
    if let Some(tool_output) = event.tool_output.as_ref() {
        updates.insert("tool_output".into(), tool_output.clone());
    }
    if let Some(tool_input) = event.tool_input.as_ref() {
        updates.insert("tool_input".into(), tool_input.clone());
    }
    if let Some(render_payload) = event.data.get("render_payload") {
        updates.insert("render_payload".into(), render_payload.clone());
    }
    updates.insert("status".into(), Value::String(status.to_string()));
    updates
}

/// `_emit_direct_block_created` (`websocket.py:365-380`): forward the event's
/// block payload verbatim, but only when it is a JSON object.
pub(crate) fn direct_created_payload(event: &ExecutionEvent) -> Option<Value> {
    let Value::Object(block) = event.data.get("block")? else {
        return None;
    };
    Some(created_payload(event.task_id, event.subtask_id, block))
}

/// `_emit_direct_block_updated` (`websocket.py:382-410`): stringify the block
/// id, keep only the declared update keys and let `emit_block_updated` drop
/// nulls. `render_payload` is not part of this branch's whitelist.
pub(crate) fn direct_updated_payload(event: &ExecutionEvent) -> Option<Value> {
    let block_id = event.data.get("block_id")?;
    if !python_truthy(block_id) {
        return None;
    }
    let Value::Object(source) = event.data.get("updates")? else {
        return None;
    };
    const KEYS: [&str; 8] = [
        "content",
        "tool_input",
        "tool_output",
        "parent_tool_use_id",
        "output",
        "summary",
        "children",
        "status",
    ];
    let mut updates = Map::new();
    for key in KEYS {
        if let Some(value) = source.get(key) {
            updates.insert(key.into(), value.clone());
        }
    }
    Some(updated_payload(
        event.task_id,
        event.subtask_id,
        &python_str(block_id),
        &updates,
    ))
}

/// `_emit_result_guidance_blocks` (`websocket.py:413-427`): every completed
/// guidance block in the final result, in result order.
pub(crate) fn guidance_created_payloads(
    task_id: i64,
    subtask_id: i64,
    result: &Value,
) -> Vec<Value> {
    let Some(Value::Array(blocks)) = result.get("blocks") else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter_map(|block| match block {
            Value::Object(block)
                if block.get("type").and_then(Value::as_str) == Some("guidance") =>
            {
                Some(created_payload(task_id, subtask_id, block))
            }
            _ => None,
        })
        .collect()
}

/// Publish the `tool_start` `chat:block_created` frame.
pub(crate) async fn publish_tool_block_created<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
) -> RedisResult<()> {
    let payload = created_payload(event.task_id, event.subtask_id, &tool_block(event));
    publish_emit(redis, "chat:block_created", event.task_id, payload)
        .await
        .map(|_| ())
}

/// Publish the `block_created` `chat:block_created` frame.
pub(crate) async fn publish_direct_block_created<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
) -> RedisResult<()> {
    let Some(payload) = direct_created_payload(event) else {
        return Ok(());
    };
    publish_emit(redis, "chat:block_created", event.task_id, payload)
        .await
        .map(|_| ())
}

/// Publish the `tool_argument_delta` / `tool_argument_done` frame.
pub(crate) async fn publish_argument_updated<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    status: &str,
) -> RedisResult<()> {
    let block_id = event.tool_use_id.as_deref().unwrap_or_default();
    let payload = updated_payload(
        event.task_id,
        event.subtask_id,
        block_id,
        &argument_updates(event, status),
    );
    publish_emit(redis, "chat:block_updated", event.task_id, payload)
        .await
        .map(|_| ())
}

/// Publish the `tool_result` `chat:block_updated` frame.
pub(crate) async fn publish_result_updated<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
) -> RedisResult<()> {
    let block_id = event.tool_use_id.as_deref().unwrap_or_default();
    let payload = updated_payload(
        event.task_id,
        event.subtask_id,
        block_id,
        &result_updates(event),
    );
    publish_emit(redis, "chat:block_updated", event.task_id, payload)
        .await
        .map(|_| ())
}

/// Publish the `block_updated` `chat:block_updated` frame.
pub(crate) async fn publish_direct_block_updated<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
) -> RedisResult<()> {
    let Some(payload) = direct_updated_payload(event) else {
        return Ok(());
    };
    publish_emit(redis, "chat:block_updated", event.task_id, payload)
        .await
        .map(|_| ())
}

/// Publish every guidance `chat:block_created` frame a finished turn carries.
pub(crate) async fn publish_guidance_blocks<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    result: &Value,
) -> RedisResult<()> {
    for payload in guidance_created_payloads(event.task_id, event.subtask_id, result) {
        publish_emit(redis, "chat:block_created", event.task_id, payload).await?;
    }
    Ok(())
}

/// Python truthiness, used by the source's `if not block_id` guard.
fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

/// Python `str()` for the scalar values a block id can carry.
fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Null => "None".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
#[path = "block_frames_tests.rs"]
mod tests;
