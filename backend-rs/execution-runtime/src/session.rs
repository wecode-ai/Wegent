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

use wegent_execution_events::event::ExecutionEvent;
use wegent_python_compat::py_json::{orjson_dumps, python_dumps, utc_isoformat};

#[path = "block_index.rs"]
mod block_index;
#[path = "identified_text.rs"]
mod identified_text;

/// Unified TTL for all streaming-related data (1 hour).
pub const STREAMING_TTL: u64 = 3600;
const STREAMING_KEY_PREFIX: &str = "chat:streaming:";
const TASK_STREAMING_KEY_PREFIX: &str = "chat:task_streaming:";
const CONTEXT_METRICS_KEY_PREFIX: &str = "chat:context_metrics:";
const CALLBACK_CHANNEL_PREFIX: &str = "callback:channel:";
const TOUCH_TASK_STREAMING_ACTIVITY: &str = r#"
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
"#;
/// Internal field stored in block metadata and stripped before returning.
pub const BLOCK_CONTENT_KEY_FIELD: &str = "_content_key";

/// Hydrated blocks retain the wire-format string while tracking unavailable
/// text internally so completion can distinguish it from an explicit empty value.
#[derive(Default)]
pub struct LoadedBlocks {
    pub blocks: Vec<Map<String, Value>>,
    pub has_missing_text_content: bool,
}

fn set_ex_options() -> SetOptions {
    SetOptions::default().with_expiration(SetExpiration::Seconds(STREAMING_TTL))
}

/// `settings.STREAMING_REDIS_TTL` (300 seconds): the context-metrics snapshot
/// uses the shorter cache TTL, unlike the one-hour streaming state.
pub const CONTEXT_METRICS_TTL: u64 = 300;

fn context_metrics_options() -> SetOptions {
    SetOptions::default().with_expiration(SetExpiration::Seconds(CONTEXT_METRICS_TTL))
}

pub fn streaming_key(subtask_id: i64) -> String {
    format!("{STREAMING_KEY_PREFIX}{subtask_id}")
}

pub fn blocks_key(subtask_id: i64) -> String {
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
pub fn callback_channel(subtask_id: i64) -> String {
    format!("{CALLBACK_CHANNEL_PREFIX}{subtask_id}")
}

fn now_epoch_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `set_task_streaming_status`: write the status object with a 1-hour TTL.
pub async fn set_task_streaming_status<R: Redis>(
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

/// Refresh this subtask's activity, recovering missing metadata after a failed
/// START write or expiration. Compare raw bytes before writing so a concurrent
/// START cannot be replaced by the previously read marker.
pub async fn touch_task_streaming_activity<R: Redis>(
    redis: &R,
    task_id: i64,
    subtask_id: i64,
    observed_started_at: &str,
) -> RedisResult<bool> {
    let key = task_streaming_key(task_id);
    let raw = redis.get::<_, String>(&key).await?;
    let mut value = match raw.as_deref() {
        Some(raw) => {
            let Ok(Value::Object(value)) = serde_json::from_str::<Value>(raw) else {
                return Ok(false);
            };
            if value.get("subtask_id").and_then(Value::as_i64) != Some(subtask_id) {
                return Ok(false);
            }
            value
        }
        None => Map::from_iter([
            ("subtask_id".into(), json!(subtask_id)),
            ("user_id".into(), json!(0)),
            ("username".into(), json!("")),
            ("started_at".into(), json!(observed_started_at)),
        ]),
    };
    value.insert(
        "last_activity_at".into(),
        Value::String(utc_isoformat(chrono::Utc::now())),
    );
    let payload = orjson_dumps(&Value::Object(value));
    let updated: i64 = redis
        .eval(
            TOUCH_TASK_STREAMING_ACTIVITY,
            [key],
            [raw.unwrap_or_default(), payload, STREAMING_TTL.to_string()],
        )
        .await?;
    Ok(updated == 1)
}

/// `save_context_metrics`: cache the latest context-metrics snapshot.
///
/// The source passes `settings.STREAMING_REDIS_TTL` (300 seconds), so this key
/// expires earlier than the one-hour streaming state.
pub async fn save_context_metrics<R: Redis>(
    redis: &R,
    subtask_id: i64,
    context_metrics: &Value,
) -> RedisResult<()> {
    let payload = orjson_dumps(context_metrics);
    redis
        .set_with(
            context_metrics_key(subtask_id),
            payload,
            context_metrics_options(),
        )
        .await
        .map(|_| ())
}

/// `publish_callback_event`: publish the serialized event to the subtask's
/// callback channel so active SSE consumers receive it.
pub async fn publish_callback_event<R: Redis>(
    redis: &R,
    subtask_id: i64,
    event: &ExecutionEvent,
) -> RedisResult<i64> {
    let channel = callback_channel(subtask_id);
    let payload = python_dumps(&event.to_value());
    redis.publish(channel, payload).await
}

pub async fn publish_terminal_callback<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
) -> RedisResult<bool> {
    let key = super::delivery::notification_key(event.task_id, event.subtask_id, "callback");
    let channel = callback_channel(event.subtask_id);
    super::delivery::publish_once(redis, &key, &channel, &python_dumps(&event.to_value())).await
}

/// `_load_blocks_from_client`: read block metadata and hydrate per-block
/// content from the internal content keys, then strip the internal field.
/// Missing text content is tracked separately from the client-safe block payload.
async fn load_blocks<R: Redis>(redis: &R, subtask_id: i64, strict: bool) -> Option<LoadedBlocks> {
    let raw = redis
        .lrange::<_, String>(blocks_key(subtask_id), 0, -1)
        .await
        .ok()?;
    let mut blocks = Vec::with_capacity(raw.len());
    let mut has_missing_text_content = false;
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
            let block = &mut blocks[*index];
            let content = match value {
                Some(bytes) => std::str::from_utf8(bytes).ok()?.to_string(),
                None => {
                    has_missing_text_content |= matches!(
                        block.get("type").and_then(Value::as_str),
                        Some("text" | "output_text")
                    );
                    String::new()
                }
            };
            block.insert("content".into(), Value::String(content));
        }
    }
    for block in &mut blocks {
        block.shift_remove(BLOCK_CONTENT_KEY_FIELD);
    }
    Some(LoadedBlocks {
        blocks,
        has_missing_text_content,
    })
}

/// `get_blocks`: load blocks without finalizing pending text/thinking blocks.
pub async fn get_blocks<R: Redis>(redis: &R, subtask_id: i64) -> Vec<Map<String, Value>> {
    load_blocks(redis, subtask_id, true)
        .await
        .map(|loaded| loaded.blocks)
        .unwrap_or_default()
}

/// Load and hydrate one block without transferring the complete block list.
pub async fn get_block<R: Redis>(
    redis: &R,
    subtask_id: i64,
    block_id: &str,
) -> RedisResult<Option<Map<String, Value>>> {
    let Some((_, mut block)) = block_index::find(redis, subtask_id, block_id).await? else {
        return Ok(None);
    };
    if let Some(Value::String(content_key)) = block.shift_remove(BLOCK_CONTENT_KEY_FIELD) {
        let content = redis
            .get::<_, String>(content_key)
            .await?
            .unwrap_or_default();
        block.insert("content".into(), Value::String(content));
    }
    Ok(Some(block))
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
    if let Some((index, mut block)) = block_index::find(redis, subtask_id, &current).await? {
        block.insert("status".into(), Value::String("done".into()));
        redis
            .lset(&blocks_key, index, python_dumps(&Value::Object(block)))
            .await?;
        redis.expire(&blocks_key, STREAMING_TTL).await?;
        redis
            .expire(block_index::key(subtask_id), STREAMING_TTL)
            .await?;
    }
    redis.del(key).await?;
    Ok(())
}

pub async fn finalize_current_text_block<R: Redis>(redis: &R, subtask_id: i64) {
    finalize_block(redis, subtask_id, &text_block_key(subtask_id), "text").await
}

pub async fn finalize_current_thinking_block<R: Redis>(redis: &R, subtask_id: i64) {
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
pub async fn add_block<R: Redis>(
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
    match block_index::find(redis, subtask_id, &block_id).await? {
        Some((index, existing_block)) => {
            let mut to_store = block.clone();
            let content_key = existing_block
                .get(BLOCK_CONTENT_KEY_FIELD)
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
                        .get("content")
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
            redis
                .expire(block_index::key(subtask_id), STREAMING_TTL)
                .await?;
        }
        None => {
            let length = redis
                .rpush(&blocks_key, (python_dumps(&Value::Object(block.clone())),))
                .await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
            block_index::record(redis, subtask_id, &block_id, length - 1).await?;
        }
    }
    Ok(())
}

/// Append unseen text to the provider's block using a Unicode code-point offset.
/// A missing offset appends at the current end; an offset beyond it is rejected.
pub async fn add_identified_text_content<R: Redis>(
    redis: &R,
    subtask_id: i64,
    content: &str,
    block_id: &str,
    offset: Option<u64>,
) -> RedisResult<()> {
    identified_text::append(redis, subtask_id, content, block_id, offset).await
}

/// `add_text_content`: append streamed text to the current text block,
/// creating one when necessary.
pub async fn add_text_content<R: Redis>(
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
            redis
                .expire(block_index::key(subtask_id), STREAMING_TTL)
                .await?;
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
            let length = redis
                .rpush(&blocks_key, (python_dumps(&Value::Object(block.clone())),))
                .await?;
            redis
                .set_with(&text_key, &block_id, set_ex_options())
                .await?;
            redis.append(&streaming_key, content).await?;
            redis.expire(&streaming_key, STREAMING_TTL).await?;
            redis.append(&content_key, content).await?;
            redis.expire(&content_key, STREAMING_TTL).await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
            block_index::record(redis, subtask_id, &block_id, length - 1).await?;
        }
    }
    Ok(())
}

/// `add_thinking_content`: append reasoning content to the current thinking
/// block, creating one when necessary.
pub async fn add_thinking_content<R: Redis>(
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
            redis
                .expire(block_index::key(subtask_id), STREAMING_TTL)
                .await?;
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
            let length = redis
                .rpush(&blocks_key, (python_dumps(&Value::Object(block.clone())),))
                .await?;
            redis
                .set_with(&thinking_key, &block_id, set_ex_options())
                .await?;
            redis.append(&content_key, content).await?;
            redis.expire(&content_key, STREAMING_TTL).await?;
            redis.expire(&blocks_key, STREAMING_TTL).await?;
            block_index::record(redis, subtask_id, &block_id, length - 1).await?;
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
pub fn create_tool_block(
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
pub async fn add_tool_block<R: Redis>(
    redis: &R,
    subtask_id: i64,
    tool_use_id: &str,
    tool_name: &str,
    tool_input: Option<&Value>,
    display_name: Option<&str>,
    tool_protocol: Option<&str>,
    server_label: Option<&str>,
) -> RedisResult<()> {
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
pub async fn update_tool_block_status<R: Redis>(
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
    let matches_tool = |block: &Map<String, Value>| {
        block.get("type").and_then(Value::as_str) == Some("tool")
            && block.get("tool_use_id").and_then(Value::as_str) == Some(tool_use_id)
    };
    let indexed = get_block(redis, subtask_id, tool_use_id)
        .await?
        .filter(matches_tool);
    let existing = match indexed {
        Some(block) => Some(block),
        None => get_blocks(redis, subtask_id)
            .await
            .into_iter()
            .find(matches_tool),
    };
    let Some(mut existing) = existing else {
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
pub fn finalize_unresolved_preview_tool_blocks(
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
pub async fn get_streaming_content<R: Redis>(redis: &R, subtask_id: i64) -> Option<String> {
    let bytes = redis
        .get::<_, brz_redis::RedisBytes>(&streaming_key(subtask_id))
        .await
        .ok()
        .flatten()?;
    std::str::from_utf8(&bytes).ok().map(str::to_string)
}

/// `get_context_metrics`: the latest cached snapshot, when the stored value is
/// a JSON object (`session_manager.get_context_metrics`).
///
/// A missing key, an undecodable value, and a non-object value all yield
/// `None`, exactly like the source's `isinstance(value, dict)` guard.
pub async fn get_context_metrics<R: Redis>(
    redis: &R,
    subtask_id: i64,
) -> Option<serde_json::Value> {
    let bytes = redis
        .get::<_, brz_redis::RedisBytes>(&context_metrics_key(subtask_id))
        .await
        .ok()
        .flatten()?;
    match serde_json::from_slice::<serde_json::Value>(bytes.as_ref()) {
        Ok(value) if value.is_object() => Some(value),
        _ => None,
    }
}

/// `get_accumulated_content`: the streaming text, or an empty string.
pub async fn get_accumulated_content<R: Redis>(redis: &R, subtask_id: i64) -> String {
    get_streaming_content(redis, subtask_id)
        .await
        .unwrap_or_default()
}

/// `finalize_and_get_blocks`: finalize the pending text and thinking blocks,
/// hydrate block content, then close unresolved preview tool blocks.
///
/// The source's finalize helpers log and return without raising
/// (`session.py:1251-1282`, `:1288-1318`), and a failed block read yields `[]`.
pub async fn finalize_and_get_blocks<R: Redis>(
    redis: &R,
    subtask_id: i64,
    termination_reason: Option<&str>,
    terminal_status: Option<&str>,
) -> LoadedBlocks {
    finalize_current_text_block(redis, subtask_id).await;
    finalize_current_thinking_block(redis, subtask_id).await;
    let Some(mut loaded) = load_blocks(redis, subtask_id, true).await else {
        return LoadedBlocks::default();
    };
    loaded.blocks =
        finalize_unresolved_preview_tool_blocks(loaded.blocks, termination_reason, terminal_status);
    loaded
}

/// `clear_task_streaming_status`: drop the task-level streaming status key.
pub async fn clear_task_streaming_status<R: Redis>(redis: &R, task_id: i64) -> RedisResult<i64> {
    redis.del(task_streaming_key(task_id)).await
}

/// `cleanup_streaming_state`: delete the whole per-subtask streaming key set in
/// one `DEL`, followed by the task-level status key when a task id is known.
pub async fn cleanup_streaming_state<R: Redis>(
    redis: &R,
    subtask_id: i64,
    task_id: Option<i64>,
) -> RedisResult<()> {
    let blocks_key = blocks_key(subtask_id);
    let blocks_raw = redis.lrange::<_, String>(&blocks_key, 0, -1).await?;
    let mut keys = vec![
        streaming_key(subtask_id),
        blocks_key,
        block_index::key(subtask_id),
        text_block_key(subtask_id),
        thinking_block_key(subtask_id),
        context_metrics_key(subtask_id),
    ];
    keys.extend(extract_block_content_keys(&blocks_raw));
    redis.del_many(keys).await?;
    if let Some(task_id) = task_id {
        clear_task_streaming_status(redis, task_id).await?;
    }
    Ok(())
}

/// A late consumer may clean its own keys without clearing a newer turn's marker.
pub async fn cleanup_settled_streaming_state<R: Redis>(
    redis: &R,
    subtask_id: i64,
    task_id: i64,
) -> RedisResult<()> {
    cleanup_streaming_state(redis, subtask_id, None).await?;
    let key = task_streaming_key(task_id);
    let Some(raw) = redis.get::<_, String>(&key).await? else {
        return Ok(());
    };
    let owner = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("subtask_id").and_then(Value::as_i64));
    if owner == Some(subtask_id) {
        let _: i64 = redis
            .eval(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
                [key],
                [raw],
            )
            .await?;
    }
    Ok(())
}

/// Return each block's internal content key for cleanup
/// (`_extract_block_content_keys`). The Source deletes only the recorded
/// content keys; it has no per-key `:offset` companion.
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

#[cfg(test)]
mod tests {
    use super::extract_block_content_keys;

    /// `_extract_block_content_keys` deletes only the content key recorded in
    /// each block, never an appended `:offset` companion key.
    #[test]
    fn cleanup_deletes_only_the_content_keys() {
        let blocks = vec![
            r#"{"id":"text-1","_content_key":"chat:streaming:block_content:5:text-1"}"#.to_string(),
            r#"{"id":"thinking-abc","_content_key":"chat:streaming:block_content:5:thinking-abc"}"#
                .to_string(),
            r#"{"id":"tool-1"}"#.to_string(),
            "not json".to_string(),
        ];
        assert_eq!(
            extract_block_content_keys(&blocks),
            vec![
                "chat:streaming:block_content:5:text-1".to_string(),
                "chat:streaming:block_content:5:thinking-abc".to_string(),
            ]
        );
    }
}
