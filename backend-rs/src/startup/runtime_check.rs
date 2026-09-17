// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Runtime-check dependency composition with the existing connection policy.
use crate::runtime_check::{AppState, config::Config};
use anyhow::{Context as _, Result};
use brz_mysql::Mysql;
use brz_redis::{RedisService, RedisServiceOptions};
use std::time::Duration;

pub async fn build<M: Mysql>(
    mysql: M,
    task_policy: crate::task_routing::TaskPolicy,
) -> Result<AppState<M, brz_redis::RedisService>> {
    let config = Config::load()?;
    let redis = match build_redis(&config).await {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to connect runtime-check Redis; continuing without Redis-backed streaming state");
            None
        }
    };
    Ok(AppState::new(config, mysql, redis, task_policy))
}

/// Unsharded master/slave service with the configured optional password and
/// source-compatible 5s socket timeout for cache reads.
async fn build_redis(config: &Config) -> Result<RedisService> {
    let (endpoint, password) = config.redis_endpoint()?;
    let options = RedisServiceOptions::default()
        .with_password(password)
        .with_timeout(Duration::from_secs(5))
        .with_connect_timeout(Duration::from_secs(2));
    RedisService::noshard_with_options(endpoint.clone(), [endpoint], options)
        .await
        .context("failed to connect Redis service")
}
