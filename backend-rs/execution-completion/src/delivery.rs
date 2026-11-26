// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Persist outstanding delivery alongside the terminal transition in Task metadata.
use std::future::Future;
use std::time::Duration;

use brz_mysql::{Mysql, MysqlResult};
use brz_redis::{Redis, RedisService, SetExpiration, SetOptions};
use serde_json::Value;

use super::{CompletionStore, LeaseReceipt, lease_receipt::accepted_owner, persist};

#[derive(Clone, Copy)]
pub struct DeviceStream<'a> {
    pub owner: i64,
    pub devices: [Option<&'a str>; 3],
    pub attempt: &'a str,
}

pub fn device_attempt_id(task: &Value, subtask_id: i64) -> String {
    let initial = subtask_id.to_string();
    task["status"]["executionAttempts"]
        .get(&initial)
        .and_then(Value::as_str)
        .map_or(initial, str::to_owned)
}

impl DeviceStream<'_> {
    pub fn matches(
        self,
        task: &Value,
        subtask_id: i64,
        namespace: Option<&str>,
        executor: Option<&str>,
    ) -> bool {
        namespace == Some(format!("user-{}", self.owner).as_str())
            && executor
                .and_then(|name| name.strip_prefix("device-"))
                .is_some_and(|id| !id.is_empty() && self.devices.contains(&Some(id)))
            && self.attempt == device_attempt_id(task, subtask_id)
    }
}

#[derive(Clone, Copy)]
pub enum Delivery<'a> {
    Callback,
    Device(DeviceStream<'a>),
}

impl Delivery<'_> {
    fn name(self) -> &'static str {
        match self {
            Self::Callback => "callback",
            Self::Device(_) => "device",
        }
    }

    pub fn label(self, subtask_id: i64) -> String {
        format!("terminal-delivery-{}-{subtask_id}", self.name())
    }
}

pub use wegent_execution_runtime::delivery::{notification_key, publish_once};

pub(super) fn labels(task: &mut Value) -> &mut Value {
    &mut task["metadata"]["labels"]
}

pub async fn acknowledge_delivery<M: Mysql, R: brz_redis::Redis>(
    ctx: &CompletionStore<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    delivery: Delivery<'_>,
) -> MysqlResult<()> {
    persist::acknowledge_delivery(ctx, task_id, subtask_id, delivery).await
}

/// One worker at a time delivers an attempt. The database marker survives a
/// failed request, while the renewable lease prevents concurrent replays.
pub async fn with_delivery_lock<T, E, F>(
    redis: &RedisService,
    subtask_id: i64,
    delivery: Delivery<'_>,
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
        None,
        |_| work,
    )
    .await
}

pub fn delivery_lock_key(subtask_id: i64, delivery: Delivery<'_>) -> String {
    match delivery {
        Delivery::Device(_) => device_delivery_lock_key(subtask_id),
        Delivery::Callback => format!("wegent:lock:{}", delivery.label(subtask_id)),
    }
}

pub fn device_delivery_lock_key(subtask_id: i64) -> String {
    format!("wegent:lock:terminal-delivery-device-{subtask_id}")
}

pub async fn with_owned_lease<R, T, E, W, F>(
    redis: &R,
    key: &str,
    dependency: impl Fn() -> E,
    accepted: Option<fn() -> T>,
    work: W,
) -> Result<T, E>
where
    R: Redis,
    W: FnOnce(LeaseReceipt) -> F,
    F: Future<Output = Result<T, E>>,
{
    const LEASE_MS: u64 = 30_000;
    let token = wegent_backend_persistence::redis_lock::lock_token();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Milliseconds(LEASE_MS))
        .if_absent();
    loop {
        match redis.set_with(key, token.as_str(), options).await {
            Ok(true) => break,
            Ok(false) => {
                if let Some(accepted) = accepted {
                    match accepted_owner(redis, key).await {
                        Ok(true) => return Ok(accepted()),
                        Ok(false) => {}
                        Err(error) => {
                            tracing::warn!(%error, key, "execution acceptance unavailable");
                            return Err(dependency());
                        }
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(dependency());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
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
    let receipt = LeaseReceipt::new(key, token);
    let work = work(receipt.clone());
    tokio::pin!(work);
    let result = loop {
        tokio::select! {
            result = &mut work => break result,
            _ = renewal.tick() => {
                if !matches!(receipt.renew(redis, LEASE_MS).await, Ok(true)) {
                    break Err(dependency());
                }
            }
        }
    };
    if let Err(error) = receipt.release(redis).await {
        tracing::warn!(%error, key, "delivery lock release failed");
    }
    result
}
