// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-owned Redis configuration and process-lifetime services.
use crate::config::RedisConfig;
use brz_redis::{RedisResult, RedisService, RedisServiceOptions};
use std::time::Duration;

pub async fn shared(config: &RedisConfig) -> RedisResult<RedisService> {
    let options = RedisServiceOptions::default()
        .with_password(config.password.clone())
        .with_timeout(Duration::from_secs(5));
    let master = config.endpoint();
    let slave = config.slave_endpoint().unwrap_or_else(|| master.clone());
    RedisService::noshard_with_options(master, [slave], options).await
}

/// The cache extension's own client (`get_redis_client()`).
///
/// The source builds a second, independent client from `REDIS_URL` (plus the
/// optional `REDIS_SLAVE_URL` replica pair) for the cache extension,
/// exactly as `app/core/rate_limit.py` keeps slowapi's separate storage client
/// on the same URL. The extension therefore owns its own connections instead of
/// sharing the application client with every other Redis user. An unavailable
/// Redis yields `None`, which leaves the extension's public readers in place
/// (`CachedUserReader.wrap()` returning `None`).
pub async fn cache_client() -> Option<RedisService> {
    let config = match RedisConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(%error, "failed to load the cache Redis configuration");
            return None;
        }
    };
    match shared(&config).await {
        Ok(service) => Some(service),
        Err(error) => {
            tracing::warn!(%error, "failed to connect the cache Redis service; continuing without Redis-backed caches");
            None
        }
    }
}
