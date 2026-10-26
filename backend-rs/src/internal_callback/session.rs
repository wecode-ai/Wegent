// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Redis-backed streaming state for the execution callback.
//!
//! Mirrors the `session_manager` streaming surface in
//! `app/services/chat/storage/session.py`: task-level streaming status, the
//! mixed-content block list (with per-block content keys), and the callback
//! Pub/Sub channel. Encodings match the source byte-for-byte: the cache layer
//! uses `orjson` (compact, UTF-8) while the block list uses `json.dumps` with
//! its default separators and ASCII escaping.
use brz_redis::{Redis, RedisResult, SetExpiration, SetOptions};
use serde_json::{Map, Value, json};

use super::event::ExecutionEvent;
use super::py_json::{orjson_dumps, python_dumps, utc_isoformat};

/// Unified TTL for all streaming-related data (1 hour).
pub(crate) const STREAMING_TTL: u64 = 3600;
const STREAMING_KEY_PREFIX: &str = "chat:streaming:";
const TASK_STREAMING_KEY_PREFIX: &str = "chat:task_streaming:";
const CONTEXT_METRICS_KEY_PREFIX: &str = "chat:context_metrics:";
const CALLBACK_CHANNEL_PREFIX: &str = "callback:channel:";
/// Internal field stored in block metadata and stripped before returning.
pub(crate) const BLOCK_CONTENT_KEY_FIELD: &str = "_content_key";

fn set_ex_options() -> SetOptions {
    SetOptions::default().with_expiration(SetExpiration::Seconds(STREAMING_TTL))
}

pub(crate) fn streaming_key(subtask_id: i64) -> String {
    format!("{STREAMING_KEY_PREFIX}{subtask_id}")
}

pub(crate) fn blocks_key(subtask_id: i64) -> String {
    format!("{STREAMING_KEY_PREFIX}blocks:{subtask_id}")
}

fn text_block_key(subtask_id: i64) -> String {
    format!("{STREAMING_KEY_PREFIX}text_block:{subtask_id}")
}

fn thinking_block_key(subtask_id: i64) -> String {
    format!("{STREAMING_KEY_PREFIX}thinking_block:{subtask_id}")
}

fn block_content_key(subtask_id: i64, block_id: &str) -> String {
    format!("{STREAMING_KEY_PREFIX}block_content:{subtask_id}:{block_id}")
}

fn task_streaming_key(task_id: i64) -> String {
    format!("{TASK_STREAMING_KEY_PREFIX}{task_id}")
}

fn context_metrics_key(subtask_id: i64) -> String {
    format!("{CONTEXT_METRICS_KEY_PREFIX}{subtask_id}")
}

/// The callback Pub/Sub channel for a subtask (`callback:channel:{id}`).
pub(crate) fn callback_channel(subtask_id: i64) -> String {
    format!("{CALLBACK_CHANNEL_PREFIX}{subtask_id}")
}

fn now_epoch_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `set_task_streaming_status`: write the status object with a 1-hour TTL.
pub(crate) async fn set_task_streaming_status<R: Redis>(
    redis: &R,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    username: &str,
) -> RedisResult<()> {
    let now = utc_isoformat(chrono::Utc::now());
    let mut value = Map::new();
    value.insert("subtask_id".into(), json!(subtask_id));
    value.insert("user_id".into(), json!(user_id));
    value.insert("username".into(), Value::String(username.to_string()));
    value.insert("started_at".into(), Value::String(now.clone()));
    value.insert("last_activity_at".into(), Value::String(now));
    let payload = orjson_dumps(&Value::Object(value));
    redis
        .set_with(task_streaming_key(task_id), payload, set_ex_options())
        .await?;
    Ok(())
}

/// `touch_task_streaming_activity`: refresh `last_activity_at` on an existing
/// status object. A missing or non-object value is left untouched.
///
/// The source re-reads the stored dict and preserves every other field,
/// including `started_at`, exactly as Redis returns it.
pub(crate) async fn touch_task_streaming_activity<R: Redis>(
    redis: &R,
    task_id: i64,
) -> RedisResult<bool> {
    let key = task_streaming_key(task_id);
    let Some(raw) = redis.get::<_, String>(&key).await? else {
        return Ok(false);
    };
    let Ok(Value::Object(mut value)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(false);
    };
    value.insert(
        "last_activity_at".into(),
        Value::String(utc_isoformat(chrono::Utc::now())),
    );
    let payload = orjson_dumps(&Value::Object(value));
    redis.set_with(key, payload, set_ex_options()).await?;
    Ok(true)
}

/// `save_context_metrics`: cache the latest context-metrics snapshot.
pub(crate) async fn save_context_metrics<R: Redis>(
    redis: &R,
    subtask_id: i64,
    context_metrics: &Value,
) -> RedisResult<()> {
    let payload = orjson_dumps(context_metrics);
    redis
        .set_with(context_metrics_key(subtask_id), payload, set_ex_options())
        .await?;
    Ok(())
}

/// `publish_callback_event`: publish the serialized event to the subtask's
/// callback channel so active SSE consumers receive it.
pub(crate) async fn publish_callback_event<R: Redis>(
    redis: &R,
    subtask_id: i64,
    event: &ExecutionEvent,
) -> RedisResult<i64> {
    let channel = callback_channel(subtask_id);
    let payload = python_dumps(&event.to_value());
    redis.publish(channel, payload).await
}

/// `_load_blocks_from_client`: read block metadata and hydrate per-block
/// content from the internal content keys, then strip the internal field.
async fn load_blocks<R: Redis>(
    redis: &R,
    subtask_id: i64,
    strict: bool,
) -> Option<Vec<Map<String, Value>>> {
    let raw = redis
        .lrange::<_, String>(blocks_key(subtask_id), 0, -1)
        .await
        .ok()?;
    let mut blocks = Vec::with_capacity(raw.len());
    let mut content_refs: Vec<(usize, String)> = Vec::new();
    for entry in &raw {
        let Ok(Value::Object(block)) = serde_json::from_str::<Value>(entry) else {
            if strict {
                return None;
            }
            continue;
        };
        if let Some(Value::String(content_key)) = block.get(BLOCK_CONTENT_KEY_FIELD) {
            content_refs.push((blocks.len(), content_key.clone()));
        }
        blocks.push(block);
    }
    if !content_refs.is_empty() {
        let keys: Vec<String> = content_refs.iter().map(|(_, key)| key.clone()).collect();
        let values = redis.mget::<_, brz_redis::RedisBytes>(keys).await.ok()?;
        for ((index, _), value) in content_refs.iter().zip(values.iter()) {
            let content = match value {
                Some(bytes) => std::str::from_utf8(bytes).ok()?.to_string(),
                None => String::new(),
            };
            blocks[*index].insert("content".into(), Value::String(content));
        }
    }
    for block in &mut blocks {
        block.shift_remove(BLOCK_CONTENT_KEY_FIELD);
    }
    Some(blocks)
}

/// `get_blocks`: load blocks without finalizing pending text/thinking blocks.
pub(crate) async fn get_blocks<R: Redis>(redis: &R, subtask_id: i64) -> Vec<Map<String, Value>> {
    load_blocks(redis, subtask_id, true)
        .await
        .unwrap_or_default()
}

/// `_finalize_current_text_block` / `_finalize_current_thinking_block`: mark
/// the current block done.
///
/// The source wraps each helper's whole body in `try/except Exception` and only
/// logs a warning (`session.py:1251-1282`, `:1288-1318`), so a failed
/// dependency read never aborts the caller: `add_thinking_content` still
/// appends its content after a failed text finalize, and vice versa.
async fn finalize_block<R: Redis>(redis: &R, subtask_id: i64, key: &str, kind: &str) {
    if let Err(error) = finalize_block_state(redis, subtask_id, key).await {
        tracing::warn!(%error, subtask_id, "callback {kind} block finalize failed");
    }
}

/// The `try:` body of one finalize helper, including its `GET` and the
/// read-back of the block list.
async fn finalize_block_state<R: Redis>(redis: &R, subtask_id: i64, key: &str) -> RedisResult<()> {
    let Some(current) = redis.get::<_, String>(key).await? else {
        return Ok(());
    };
    let blocks_key = blocks_key(subtask_id);
    let raw = redis.lrange::<_, String>(&blocks_key, 0, -1).await?;
    let mut found_index = None;
    let mut serialized = None;
    for (index, entry) in raw.iter().enumerate() {
        let Ok(Value::Object(mut block)) = serde_json::from_str::<Value>(entry) else {
            continue;
        };
        if block.get("id").and_then(Value::as_str) == Some(current.as_str()) {
            block.insert("status".into(), Value::String("done".into()));
            serialized = Some(python_dumps(&Value::Object(block)));
            found_index = Some(index as i64);
            break;
        }
    }
    if let (Some(index), Some(value)) = (found_index, serialized) {
        redis.lset(&blocks_key, index, value).await?;
        redis.del(key).await?;
        redis.expire(&blocks_key, STREAMING_TTL).await?;
    } else {
        redis.del(key).await?;
    }
    Ok(())
}

pub(crate) async fn finalize_current_text_block<R: Redis>(redis: &R, subtask_id: i64) {
    finalize_block(redis, subtask_id, &text_block_key(subtask_id), "text").await
}

pub(crate) async fn finalize_current_thinking_block<R: Redis>(redis: &R, subtask_id: i64) {
    finalize_block(
        redis,
        subtask_id,
        &thinking_block_key(subtask_id),
        "thinking",
    )
    .await
}

/// `add_block`: upsert a block by id, finalizing any pending text/thinking
/// block first so tool/text ordering is preserved.
pub(crate) async fn add_block<R: Redis>(
    redis: &R,
    subtask_id: i64,
    block: &mut Map<String, Value>,
) -> RedisResult<()> {
    finalize_current_text_block(redis, subtask_id).await;
    finalize_current_thinking_block(redis, subtask_id).await;

    if block.get("id").is_none() {
        block.insert(
            "id".into(),
            Value::String(format!("block-{}", now_epoch_ms())),
        );
    }
    if block.get("timestamp").is_none() {
        block.insert("timestamp".into(), json!(now_epoch_ms()));
    }
    let block_id = block
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let blocks_key = blocks_key(subtask_id);
    let raw = redis.lrange::<_, String>(&blocks_key, 0, -1).await?;
    let mut existing_index = None;
    let mut existing_block: Option<Map<String, Value>> = None;
    for (index, entry) in raw.iter().enumerate() {
        let Ok(Value::Object(candidate)) = serde_json::from_str::<Value>(entry) else {
            // `json.loads` failure aborts the whole upsert in the source.
            return Ok(());
        };
        if candidate.get("id").and_then(Value::as_str) == Some(block_id.as_str()) {
            existing_index = Some(index as i64);
            existing_block = Some(candidate);
            break;
        }
    }

    match existing_index {
        Some(index) => {
            let mut to_store = block.clone();
            let content_key = existing_block
                .as_ref()
                .and_then(|value| value.get(BLOCK_CONTENT_KEY_FIELD))
                .and_then(Value::as_str)
                .map(str::to_string);
            let content_delta = to_store.shift_remove("content_delta");
            let delta_text = content_delta
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !delta_text.is_empty() {
                if let Some(content_key) = content_key {
                    redis.append(&content_key, delta_text).await?;
                    redis.expire(&content_key, STREAMING_TTL).await?;
                    to_store.insert(BLOCK_CONTENT_KEY_FIELD.into(), Value::String(content_key));
                    to_store.insert("content".into(), Value::String(String::new()));
                } else {
                    let existing_content = existing_block
                        .as_ref()
                        .and_then(|value| value.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    to_store.insert(
                        "content".into(),
                        Value::String(format!("{existing_content}{delta_text}")),
                    );
                }
            } else if let Some(content_key) = content_key {
                let content_value = to_store
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                redis
                    .set_with(&content_key, content_value, set_ex_options())
                    .await?;
                to_store.insert(BLOCK_CONTENT_KEY_FIELD.into(), Value::String(content_key));
                to_store.insert("content".into(), Value::String(String::new()));
            }
            redis
                .lset(&blocks_key, index, python_dumps(&Value::Object(to_store)))
                .await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
        }
        None => {
            redis
                .rpush(&blocks_key, (python_dumps(&Value::Object(block.clone())),))
                .await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
        }
    }
    Ok(())
}

/// `add_text_content`: append streamed text to the current text block,
/// creating one when necessary.
pub(crate) async fn add_text_content<R: Redis>(
    redis: &R,
    subtask_id: i64,
    content: &str,
) -> RedisResult<()> {
    if content.is_empty() {
        return Ok(());
    }
    finalize_current_thinking_block(redis, subtask_id).await;

    let streaming_key = streaming_key(subtask_id);
    let text_key = text_block_key(subtask_id);
    let blocks_key = blocks_key(subtask_id);
    let current = redis.get::<_, String>(&text_key).await?;

    match current {
        Some(block_id) => {
            let content_key = block_content_key(subtask_id, &block_id);
            redis.append(&streaming_key, content).await?;
            redis.expire(&streaming_key, STREAMING_TTL).await?;
            redis.append(&content_key, content).await?;
            redis.expire(&content_key, STREAMING_TTL).await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
            redis.expire(&text_key, STREAMING_TTL).await?;
        }
        None => {
            // `create_text_block` derives both the id and the timestamp from a
            // single `int(time.time() * 1000)`.
            let timestamp = now_epoch_ms();
            let mut block = text_block_json(format!("text-{timestamp}"), timestamp);
            let block_id = text_block_id(&block);
            let content_key = block_content_key(subtask_id, &block_id);
            block.insert(
                BLOCK_CONTENT_KEY_FIELD.into(),
                Value::String(content_key.clone()),
            );
            redis
                .rpush(&blocks_key, (python_dumps(&Value::Object(block.clone())),))
                .await?;
            redis
                .set_with(&text_key, block_id, set_ex_options())
                .await?;
            redis.append(&streaming_key, content).await?;
            redis.expire(&streaming_key, STREAMING_TTL).await?;
            redis.append(&content_key, content).await?;
            redis.expire(&content_key, STREAMING_TTL).await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
        }
    }
    Ok(())
}

/// `add_thinking_content`: append reasoning content to the current thinking
/// block, creating one when necessary.
pub(crate) async fn add_thinking_content<R: Redis>(
    redis: &R,
    subtask_id: i64,
    content: &str,
) -> RedisResult<()> {
    if content.is_empty() {
        return Ok(());
    }
    finalize_current_text_block(redis, subtask_id).await;

    let thinking_key = thinking_block_key(subtask_id);
    let blocks_key = blocks_key(subtask_id);
    let current = redis.get::<_, String>(&thinking_key).await?;

    match current {
        Some(block_id) => {
            let content_key = block_content_key(subtask_id, &block_id);
            redis.append(&content_key, content).await?;
            redis.expire(&content_key, STREAMING_TTL).await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
            redis.expire(&thinking_key, STREAMING_TTL).await?;
        }
        None => {
            let timestamp = now_epoch_ms();
            let block_id = format!("thinking-{}", short_uuid());
            let content_key = block_content_key(subtask_id, &block_id);
            let mut block = Map::new();
            block.insert("id".into(), Value::String(block_id.clone()));
            block.insert("type".into(), Value::String("thinking".into()));
            block.insert("content".into(), Value::String(String::new()));
            block.insert("status".into(), Value::String("streaming".into()));
            block.insert("timestamp".into(), json!(timestamp));
            block.insert(
                BLOCK_CONTENT_KEY_FIELD.into(),
                Value::String(content_key.clone()),
            );
            redis
                .rpush(&blocks_key, (python_dumps(&Value::Object(block.clone())),))
                .await?;
            redis
                .set_with(&thinking_key, block_id, set_ex_options())
                .await?;
            redis.append(&content_key, content).await?;
            redis.expire(&content_key, STREAMING_TTL).await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
        }
    }
    Ok(())
}

fn text_block_json(block_id: String, timestamp: i64) -> Map<String, Value> {
    let mut block = Map::new();
    block.insert("id".into(), Value::String(block_id));
    block.insert("type".into(), Value::String("text".into()));
    block.insert("content".into(), Value::String(String::new()));
    block.insert("status".into(), Value::String("streaming".into()));
    block.insert("timestamp".into(), json!(timestamp));
    block
}

/// `create_tool_block`: build the pending tool block with the source's key
/// order and optional display/protocol fields.
pub(crate) fn create_tool_block(
    tool_use_id: &str,
    tool_name: &str,
    tool_input: Option<&Value>,
    display_name: Option<&str>,
    tool_protocol: Option<&str>,
    server_label: Option<&str>,
) -> Map<String, Value> {
    let timestamp = now_epoch_ms();
    let block_id = if tool_use_id.is_empty() {
        format!("tool-{timestamp}")
    } else {
        tool_use_id.to_string()
    };
    let mut block = Map::new();
    block.insert("id".into(), Value::String(block_id));
    block.insert("type".into(), Value::String("tool".into()));
    block.insert("tool_use_id".into(), Value::String(tool_use_id.to_string()));
    block.insert("tool_name".into(), Value::String(tool_name.to_string()));
    block.insert(
        "tool_input".into(),
        tool_input.cloned().unwrap_or_else(|| json!({})),
    );
    block.insert("status".into(), Value::String("pending".into()));
    block.insert("timestamp".into(), json!(timestamp));
    if let Some(display_name) = display_name.filter(|value| !value.is_empty()) {
        block.insert(
            "display_name".into(),
            Value::String(display_name.to_string()),
        );
    }
    if let Some(tool_protocol) = tool_protocol.filter(|value| !value.is_empty()) {
        block.insert(
            "tool_protocol".into(),
            Value::String(tool_protocol.to_string()),
        );
    }
    if let Some(server_label) = server_label.filter(|value| !value.is_empty()) {
        block.insert(
            "server_label".into(),
            Value::String(server_label.to_string()),
        );
    }
    block
}

/// `add_tool_block`: finalize pending blocks then upsert the tool block.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn add_tool_block<R: Redis>(
    redis: &R,
    subtask_id: i64,
    tool_use_id: &str,
    tool_name: &str,
    tool_input: Option<&Value>,
    display_name: Option<&str>,
    tool_protocol: Option<&str>,
    server_label: Option<&str>,
) -> RedisResult<()> {
    // `add_tool_block` finalizes the current text and thinking blocks itself
    // (`session.py:930-931`) and then `add_block` repeats the same pair
    // (`session.py:1041-1042`), so one tool-block upsert reads both keys twice.
    finalize_current_text_block(redis, subtask_id).await;
    finalize_current_thinking_block(redis, subtask_id).await;

    let mut block = create_tool_block(
        tool_use_id,
        tool_name,
        tool_input,
        display_name,
        tool_protocol,
        server_label,
    );
    add_block(redis, subtask_id, &mut block).await
}

/// `update_tool_block_status`: update an existing tool block's fields and
/// upsert it, ignoring a missing block like the source.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_tool_block_status<R: Redis>(
    redis: &R,
    subtask_id: i64,
    tool_use_id: &str,
    status: Option<&str>,
    tool_output: Option<&Value>,
    tool_input: Option<&Value>,
    render_payload: Option<&Value>,
    tool_protocol: Option<&str>,
    server_label: Option<&str>,
) -> RedisResult<()> {
    let blocks = get_blocks(redis, subtask_id).await;
    let Some(mut existing) = blocks.into_iter().find(|block| {
        block.get("type").and_then(Value::as_str) == Some("tool")
            && block.get("tool_use_id").and_then(Value::as_str) == Some(tool_use_id)
    }) else {
        return Ok(());
    };
    if let Some(status) = status {
        existing.insert("status".into(), Value::String(status.to_string()));
    }
    if let Some(tool_output) = tool_output {
        existing.insert("tool_output".into(), tool_output.clone());
    }
    if let Some(tool_input) = tool_input {
        existing.insert("tool_input".into(), tool_input.clone());
    }
    if let Some(render_payload) = render_payload {
        existing.insert("render_payload".into(), render_payload.clone());
    }
    if let Some(tool_protocol) = tool_protocol {
        existing.insert(
            "tool_protocol".into(),
            Value::String(tool_protocol.to_string()),
        );
    }
    if let Some(server_label) = server_label {
        existing.insert(
            "server_label".into(),
            Value::String(server_label.to_string()),
        );
    }
    add_block(redis, subtask_id, &mut existing).await
}

/// `_finalize_unresolved_preview_tool_blocks`: close preview-only tool blocks
/// that never received a result. A successful terminal turn closes them as
/// `done`; an explicit unexecuted-tool termination keeps the error status.
pub(crate) fn finalize_unresolved_preview_tool_blocks(
    blocks: Vec<Map<String, Value>>,
    termination_reason: Option<&str>,
    terminal_status: Option<&str>,
) -> Vec<Map<String, Value>> {
    const PREVIEW_STATUSES: [&str; 2] = ["pending", "generating_arguments"];
    const UNRESOLVED_MESSAGE: &str = "Tool call was not executed before the turn completed. The turn may have hit the tool-call limit.";
    const GENERIC_MESSAGE: &str = "Tool call preview did not complete before the turn ended.";
    let inferred_tool_limit = termination_reason == Some("completed_with_unexecuted_tool_calls");
    let successful_terminal = terminal_status
        .map(str::to_uppercase)
        .is_some_and(|status| status == "COMPLETED");
    let has_explicit_tool_error = blocks.iter().any(|block| {
        block.get("type").and_then(Value::as_str) == Some("tool")
            && block.get("status").and_then(Value::as_str) == Some("error")
            && block
                .get("tool_output")
                .is_some_and(|value| !value.is_null())
    });
    let unresolved_message = if inferred_tool_limit && !has_explicit_tool_error {
        UNRESOLVED_MESSAGE
    } else {
        GENERIC_MESSAGE
    };
    let mut finalized = Vec::with_capacity(blocks.len());
    for mut block in blocks {
        let is_preview_tool = block.get("type").and_then(Value::as_str) == Some("tool")
            && block
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| PREVIEW_STATUSES.contains(&status))
            && block.get("tool_output").is_none_or(Value::is_null);
        if is_preview_tool {
            if successful_terminal && !inferred_tool_limit {
                block.insert("status".into(), Value::String("done".into()));
            } else {
                block.insert("status".into(), Value::String("error".into()));
                block.insert(
                    "tool_output".into(),
                    Value::String(unresolved_message.to_string()),
                );
            }
        }
        finalized.push(block);
    }
    finalized
}

/// `get_streaming_content`: raw read of the `APPEND`-built streaming text.
///
/// The source uses the raw client rather than the cache manager because
/// `add_text_content` writes raw bytes with `APPEND`. A missing key and any
/// read or decode error both yield `None`.
pub(crate) async fn get_streaming_content<R: Redis>(redis: &R, subtask_id: i64) -> Option<String> {
    let bytes = redis
        .get::<_, brz_redis::RedisBytes>(&streaming_key(subtask_id))
        .await
        .ok()
        .flatten()?;
    std::str::from_utf8(&bytes).ok().map(str::to_string)
}

/// `get_accumulated_content`: the streaming text, or an empty string.
pub(crate) async fn get_accumulated_content<R: Redis>(redis: &R, subtask_id: i64) -> String {
    get_streaming_content(redis, subtask_id)
        .await
        .unwrap_or_default()
}

/// `finalize_and_get_blocks`: finalize the pending text and thinking blocks,
/// hydrate block content, then close unresolved preview tool blocks.
///
/// The source's finalize helpers log and return without raising
/// (`session.py:1251-1282`, `:1288-1318`), and a failed block read yields `[]`.
pub(crate) async fn finalize_and_get_blocks<R: Redis>(
    redis: &R,
    subtask_id: i64,
    termination_reason: Option<&str>,
    terminal_status: Option<&str>,
) -> Vec<Map<String, Value>> {
    finalize_current_text_block(redis, subtask_id).await;
    finalize_current_thinking_block(redis, subtask_id).await;
    let Some(blocks) = load_blocks(redis, subtask_id, true).await else {
        return Vec::new();
    };
    finalize_unresolved_preview_tool_blocks(blocks, termination_reason, terminal_status)
}

const CLEAR_TASK_STREAMING_SCRIPT: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"#;

/// Delete only this round's task-level streaming status, atomically. A late
/// terminal callback must not clear the new round's status on a reused Task.
pub(crate) async fn clear_task_streaming_status<R: Redis>(
    redis: &R,
    task_id: i64,
    subtask_id: i64,
) -> RedisResult<i64> {
    let key = task_streaming_key(task_id);
    let Some(stored) = redis.get::<_, String>(&key).await? else {
        return Ok(0);
    };
    // Decode IDs in Rust so Lua's floating-point JSON decoder cannot round
    // a large subtask ID. Compare the entire stored value in the atomic delete
    // so a newer round/activity update between GET and EVAL stays untouched.
    let owner = serde_json::from_str::<Value>(&stored)
        .ok()
        .and_then(|value| value.get("subtask_id").and_then(Value::as_i64));
    if owner != Some(subtask_id) {
        return Ok(0);
    }
    redis
        .eval(CLEAR_TASK_STREAMING_SCRIPT, [key], [stored])
        .await
}

/// `session_manager.is_cancelled`'s Redis half: the cache stores
/// `orjson.dumps(True)`, so only the `true` payload cancels.
pub(crate) async fn is_cancelled<R: Redis>(redis: &R, key: &str) -> bool {
    matches!(
        redis.get::<_, String>(key).await,
        Ok(Some(flag)) if flag == "true"
    )
}

/// `cleanup_streaming_state`: delete the whole per-subtask streaming key set in
/// one `DEL`, followed by the task-level status key when a task id is known.
pub(crate) async fn cleanup_streaming_state<R: Redis>(
    redis: &R,
    subtask_id: i64,
    task_id: Option<i64>,
) -> RedisResult<()> {
    let blocks_key = blocks_key(subtask_id);
    let blocks_raw = redis.lrange::<_, String>(&blocks_key, 0, -1).await?;
    let mut keys = vec![
        streaming_key(subtask_id),
        blocks_key,
        text_block_key(subtask_id),
        thinking_block_key(subtask_id),
        context_metrics_key(subtask_id),
    ];
    keys.extend(extract_block_content_keys(&blocks_raw));
    redis.del_many(keys).await?;
    if let Some(task_id) = task_id {
        clear_task_streaming_status(redis, task_id, subtask_id).await?;
    }
    Ok(())
}

/// `_extract_block_content_keys`: the internal `_content_key` of each block.
fn extract_block_content_keys(blocks_raw: &[String]) -> Vec<String> {
    let mut keys = Vec::new();
    for entry in blocks_raw {
        let Ok(Value::Object(block)) = serde_json::from_str::<Value>(entry) else {
            continue;
        };
        if let Some(Value::String(content_key)) = block.get(BLOCK_CONTENT_KEY_FIELD) {
            keys.push(content_key.clone());
        }
    }
    keys
}

fn text_block_id(block: &Map<String, Value>) -> String {
    block
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `uuid.uuid4().hex[:12]` for generated thinking-block ids.
fn short_uuid() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&now, &mut hasher);
    std::hash::Hash::hash(&std::process::id(), &mut hasher);
    let value = std::hash::Hasher::finish(&hasher);
    format!("{value:012x}")[..12].to_string()
}
