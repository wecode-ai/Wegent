// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Acceptance is fenced by the same expiring owner token as execution.

use brz_redis::{Redis, RedisResult};

pub(crate) const ACCEPT_SCRIPT: &str = "\
local current = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
if current == ARGV[2] then return 1 end
if current ~= ARGV[1] then return 0 end
if redis.call('SET', KEYS[1], ARGV[2], 'XX', 'PX', ttl) then return 1 end
return 0";
pub(crate) const OBSERVE_SCRIPT: &str = "\
local current = redis.call('GET', KEYS[1])
if current and string.sub(current, 1, 9) == 'accepted:' and string.len(current) > 9
   and redis.call('PTTL', KEYS[1]) > 0 then return 1 end
return 0";
pub(crate) const RENEW_SCRIPT: &str = "\
local current = redis.call('GET', KEYS[1])
if (current == ARGV[1] or current == ARGV[2]) and redis.call('PTTL', KEYS[1]) > 0 then
    return redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return 0";
pub(crate) const RELEASE_SCRIPT: &str = "\
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] or current == ARGV[2] then return redis.call('DEL', KEYS[1]) end
return 0";

#[derive(Clone)]
pub(crate) struct LeaseReceipt {
    key: String,
    token: String,
}

impl LeaseReceipt {
    pub(crate) fn new(key: &str, token: String) -> Self {
        Self {
            key: key.into(),
            token,
        }
    }
    fn accepted(&self) -> String {
        format!("accepted:{}", self.token)
    }
    pub(crate) async fn accept(&self, redis: &impl Redis) -> RedisResult<bool> {
        let changed: i64 = redis
            .eval(
                ACCEPT_SCRIPT,
                [self.key.as_str()],
                [self.token.as_str(), self.accepted().as_str()],
            )
            .await?;
        Ok(changed == 1)
    }
    pub(crate) async fn renew(&self, redis: &impl Redis, ttl_ms: u64) -> RedisResult<bool> {
        let changed: i64 = redis
            .eval(
                RENEW_SCRIPT,
                [self.key.as_str()],
                [
                    self.token.as_str(),
                    self.accepted().as_str(),
                    ttl_ms.to_string().as_str(),
                ],
            )
            .await?;
        Ok(changed == 1)
    }
    pub(crate) async fn release(&self, redis: &impl Redis) -> RedisResult<bool> {
        let changed: i64 = redis
            .eval(
                RELEASE_SCRIPT,
                [self.key.as_str()],
                [self.token.as_str(), self.accepted().as_str()],
            )
            .await?;
        Ok(changed == 1)
    }
}

pub(crate) async fn accepted_owner(redis: &impl Redis, key: &str) -> RedisResult<bool> {
    let accepted: i64 = redis.eval(OBSERVE_SCRIPT, [key], [] as [&str; 0]).await?;
    Ok(accepted == 1)
}
