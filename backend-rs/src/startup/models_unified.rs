// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Models dependency composition, retaining utf8mb4 and the +08:00 session.
use crate::erp_provider::ErpProvider;
use crate::models_unified::{build_state, config::AppConfig};
use anyhow::{Context as _, Result};
use brz_mysql::Mysql;
use std::{sync::Arc, time::Duration};

pub async fn build<M: Mysql>(
    mysql: M,
    config: &AppConfig,
    erp: Arc<dyn ErpProvider + Send + Sync>,
) -> Result<Arc<crate::models_unified::state::AppState<M, brz_redis::RedisService>>> {
    let redis = match build_redis(&config.redis_url, config.redis_slave_url.as_deref()).await {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to connect models-unified Redis; continuing without Redis-backed caches");
            None
        }
    };
    Ok(Arc::new(build_state(config, mysql, redis, erp)?))
}

/// Build the unsharded Redis service from `REDIS_URL` and optional
/// `REDIS_SLAVE_URL`.
///
/// `brz-redis` takes `host:port[:db]` endpoints; the URL scheme, userinfo, and
/// path are normalized here because the crate does not parse `redis://` URLs.
async fn build_redis(
    redis_url: &str,
    redis_slave_url: Option<&str>,
) -> Result<brz_redis::RedisService> {
    let config = crate::config::RedisConfig::from_urls(redis_url, redis_slave_url)?;
    let options = brz_redis::RedisServiceOptions::default()
        .with_password(config.password.clone())
        .with_timeout(Duration::from_millis(200));
    let master = config.endpoint();
    let slave = config.slave_endpoint().unwrap_or_else(|| master.clone());
    brz_redis::RedisService::noshard_with_options(master, [slave], options)
        .await
        .context("failed to connect Redis dependency")
}
