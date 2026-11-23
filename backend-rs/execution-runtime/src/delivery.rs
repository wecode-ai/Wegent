// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Idempotent Redis publication of execution completion steps.

use brz_redis::Redis;

/// Publish and record the individual delivery step atomically in Redis.
pub async fn publish_once<R: Redis>(
    redis: &R,
    key: &str,
    channel: &str,
    message: &str,
) -> brz_redis::RedisResult<bool> {
    let published: i64 = redis
        .eval(
            "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
         redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
         local published = redis.pcall('PUBLISH', ARGV[1], ARGV[2])
         if type(published) == 'table' and published.err then
             redis.call('DEL', KEYS[1])
             return published
         end
         return 1",
            [key],
            [channel, message, "604800"],
        )
        .await?;
    Ok(published == 1)
}

pub fn notification_key(task_id: i64, subtask_id: i64, step: &str) -> String {
    format!("wegent:terminal-delivery:{task_id}:{subtask_id}:{step}")
}
