// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Persist outstanding delivery alongside the terminal transition in Task metadata.
use std::future::Future;
use std::time::Duration;

use brz_mysql::{Mysql, MysqlResult};
use brz_redis::{Redis, RedisService, SetExpiration, SetOptions};
use serde_json::Value;

use super::{Completion, persist};

#[derive(Clone, Copy)]
pub(crate) enum Delivery {
    Callback,
    Device,
}

impl Delivery {
    fn name(self) -> &'static str {
        match self {
            Self::Callback => "callback",
            Self::Device => "device",
        }
    }

    pub(crate) fn label(self, subtask_id: i64) -> String {
        format!("terminal-delivery-{}-{subtask_id}", self.name())
    }
}

/// Publish and record the individual delivery step atomically in Redis.
pub(crate) async fn publish_once<R: Redis>(
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

pub(crate) fn notification_key(task_id: i64, subtask_id: i64, step: &str) -> String {
    format!("wegent:terminal-delivery:{task_id}:{subtask_id}:{step}")
}

pub(super) fn labels(task: &mut Value) -> &mut Value {
    &mut task["metadata"]["labels"]
}

pub(crate) async fn acknowledge_delivery<M: Mysql, R: brz_redis::Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    delivery: Delivery,
) -> MysqlResult<()> {
    persist::acknowledge_delivery(ctx, task_id, subtask_id, delivery).await
}

/// One worker at a time delivers an attempt. The database marker survives a
/// failed request, while the renewable lease prevents concurrent replays.
pub(crate) async fn with_delivery_lock<T, E, F>(
    redis: &RedisService,
    subtask_id: i64,
    delivery: Delivery,
    dependency: impl Fn() -> E,
    work: F,
) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
{
    with_owned_lease(
        redis,
        &delivery_lock_key(subtask_id, delivery),
        dependency,
        work,
    )
    .await
}

pub(crate) fn delivery_lock_key(subtask_id: i64, delivery: Delivery) -> String {
    format!("wegent:lock:{}", delivery.label(subtask_id))
}

pub(crate) async fn with_owned_lease<R, T, E, F>(
    redis: &R,
    key: &str,
    dependency: impl Fn() -> E,
    work: F,
) -> Result<T, E>
where
    R: Redis,
    F: Future<Output = Result<T, E>>,
{
    const LEASE_MS: u64 = 30_000;
    let token = crate::device_identity_lock::lock_token();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Milliseconds(LEASE_MS))
        .if_absent();
    loop {
        match redis.set_with(key, token.as_str(), options).await {
            Ok(true) => break,
            Ok(false) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok(false) => return Err(dependency()),
            Err(error) => {
                tracing::warn!(%error, key, "delivery lock unavailable");
                return Err(dependency());
            }
        }
    }
    let mut renewal = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    tokio::pin!(work);
    let ttl = LEASE_MS.to_string();
    let result = loop {
        tokio::select! {
            result = &mut work => break result,
            _ = renewal.tick() => {
                let renewed: Result<i64, _> = redis.eval(
                    "if redis.call('GET', KEYS[1]) == ARGV[1] then
                        return redis.call('PEXPIRE', KEYS[1], ARGV[2])
                     end
                     return 0",
                    [key],
                    [token.as_str(), ttl.as_str()],
                ).await;
                if !matches!(renewed, Ok(1)) {
                    break Err(dependency());
                }
            }
        }
    };
    let released: Result<i64, _> = redis
        .eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
         end
         return 0",
            [key],
            [token.as_str()],
        )
        .await;
    if let Err(error) = released {
        tracing::warn!(%error, key, "delivery lock release failed");
    }
    result
}
