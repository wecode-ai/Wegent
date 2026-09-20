// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Runtime-check dependency composition with the existing connection policy.
use crate::runtime_check::{AppState, config::Config};
use anyhow::{Context as _, Result};
use brz_redis::{RedisService, RedisServiceOptions};
use std::{sync::Arc, time::Duration};

pub async fn build(
    mysql: brz_mysql::MysqlService,
    user_reader: Arc<dyn crate::user_reader::UserByIdReader>,
    task_policy: crate::task_routing::TaskPolicy,
) -> Result<AppState<brz_mysql::MysqlService, brz_redis::RedisService>> {
    let config = Config::load()?;
    let redis = match build_redis(&config).await {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to connect runtime-check Redis; continuing without Redis-backed streaming state");
            None
        }
    };
    Ok(AppState::new(
        config,
        mysql,
        redis,
        user_reader,
        task_policy,
    ))
}

/// Unsharded master/slave service with the configured optional password and
/// source-compatible 5s socket timeout for cache reads.
async fn build_redis(config: &Config) -> Result<RedisService> {
    let redis_config = crate::config::RedisConfig::from_urls(
        &config.redis_url,
        config.redis_slave_url.as_deref(),
    )?;
    let options = RedisServiceOptions::default()
        .with_password(redis_config.password.clone())
        .with_timeout(Duration::from_secs(5))
        .with_connect_timeout(Duration::from_secs(2));
    let master = redis_config.endpoint();
    let slave = redis_config
        .slave_endpoint()
        .unwrap_or_else(|| master.clone());
    RedisService::noshard_with_options(master, [slave], options)
        .await
        .context("failed to connect Redis service")
}
