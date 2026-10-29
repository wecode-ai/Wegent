// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Atomic appends addressed by provider item ID and Unicode character offset.
use brz_redis::{Redis, RedisResult};
use serde_json::Value;

use super::{
    BLOCK_CONTENT_KEY_FIELD, STREAMING_TTL, block_content_key, blocks_key, now_epoch_ms,
    streaming_key, text_block_json, text_block_key, thinking_block_key,
};
use crate::internal_callback::py_json::python_dumps;

// Redis strings contain UTF-8 bytes; offsets count Unicode code points.
const APPEND_IDENTIFIED_TEXT: &str = r#"
local count = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[3]) or '0')
local offset = tonumber(ARGV[1]) or current
if offset + count <= current then return 0 end
if offset > current then return redis.error_reply('Non-contiguous text block offset') end
local function finish_block(id)
    local blocks = redis.call('LRANGE', KEYS[4], 0, -1)
    for index, raw in ipairs(blocks) do
        local block = cjson.decode(raw)
        if block.id == id then
            block.status = 'done'
            redis.call('LSET', KEYS[4], index - 1, cjson.encode(block))
            break
        end
    end
end
local previous = redis.call('GET', KEYS[5])
if previous and previous ~= ARGV[6] then finish_block(previous) end
local thinking = redis.call('GET', KEYS[6])
if thinking then
    finish_block(thinking)
    redis.call('DEL', KEYS[6])
end
local skip = current - offset
local cursor = 1
for index = 1, skip do
    cursor = cursor + 1
    while cursor <= #ARGV[3] do
        local byte = string.byte(ARGV[3], cursor)
        if byte < 128 or byte >= 192 then break end
        cursor = cursor + 1
    end
end
if redis.call('EXISTS', KEYS[3]) == 0 then
    redis.call('RPUSH', KEYS[4], ARGV[4])
end
local delta = string.sub(ARGV[3], cursor)
redis.call('APPEND', KEYS[1], delta)
redis.call('APPEND', KEYS[2], delta)
redis.call('SET', KEYS[3], offset + count, 'EX', ARGV[5])
redis.call('SET', KEYS[5], ARGV[6], 'EX', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
redis.call('EXPIRE', KEYS[4], ARGV[5])
return count - skip
"#;

#[tracing::instrument(skip_all, fields(subtask_id = subtask_id, block_id = block_id, offset = ?offset))]
pub(super) async fn append<R: Redis>(
    redis: &R,
    subtask_id: i64,
    content: &str,
    block_id: &str,
    offset: Option<u64>,
) -> RedisResult<()> {
    if content.is_empty() {
        return Ok(());
    }
    let content_key = block_content_key(subtask_id, block_id);
    let mut block = text_block_json(block_id.to_string(), now_epoch_ms());
    block.insert(
        BLOCK_CONTENT_KEY_FIELD.into(),
        Value::String(content_key.clone()),
    );
    let keys = [
        streaming_key(subtask_id),
        content_key.clone(),
        format!("{content_key}:offset"),
        blocks_key(subtask_id),
        text_block_key(subtask_id),
        thinking_block_key(subtask_id),
    ];
    let arguments = [
        offset.map(|offset| offset.to_string()).unwrap_or_default(),
        content.chars().count().to_string(),
        content.to_string(),
        python_dumps(&Value::Object(block)),
        STREAMING_TTL.to_string(),
        block_id.to_string(),
    ];
    let _: i64 = redis.eval(APPEND_IDENTIFIED_TEXT, keys, arguments).await?;
    Ok(())
}
