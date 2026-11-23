// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Positional lookup shared with the atomic identified-text writer.
//! Python uses the same hash key, prefixed ID fields and suffix watermark.
use brz_redis::{Redis, RedisResult};
use serde_json::{Map, Value};

use super::{STREAMING_TTL, blocks_key};

const FIND_BLOCK: &str = concat!(
    include_str!("block_index.lua"),
    "\nlocal index, raw = find_block(KEYS[1], KEYS[2], ARGV[1], ARGV[2])\n",
    "if index then return {tostring(index), raw} end\nreturn {}\n"
);

pub(super) fn key(subtask_id: i64) -> String {
    format!("chat:streaming:blocks_index:{subtask_id}")
}

pub(super) async fn record<R: Redis>(
    redis: &R,
    subtask_id: i64,
    block_id: &str,
    position: i64,
) -> RedisResult<()> {
    let key = key(subtask_id);
    redis
        .hset(&key, format!("block:{block_id}"), position)
        .await?;
    redis.expire(&key, STREAMING_TTL).await?;
    Ok(())
}

pub(super) async fn find<R: Redis>(
    redis: &R,
    subtask_id: i64,
    block_id: &str,
) -> RedisResult<Option<(i64, Map<String, Value>)>> {
    let result: Vec<String> = redis
        .eval(
            FIND_BLOCK,
            [blocks_key(subtask_id), key(subtask_id)],
            [block_id.to_string(), STREAMING_TTL.to_string()],
        )
        .await?;
    let [position, raw] = result.as_slice() else {
        return Ok(None);
    };
    let (Ok(position), Ok(Value::Object(block))) =
        (position.parse::<i64>(), serde_json::from_str::<Value>(raw))
    else {
        return Ok(None);
    };
    Ok(Some((position, block)))
}
