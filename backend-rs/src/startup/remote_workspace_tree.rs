// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tree dependency composition.
//!
//! The two cache clients mirror the source's cached-reader extension, which
//! builds an independent Redis client per reader from `REDIS_URL` and the
//! optional `REDIS_SLAVE_URL`
//! (`users.wrap` and `kinds.wrap` each call `get_redis_client()`); both stay
//! optional so an unavailable Redis degrades the readers to direct SQL.
use crate::remote_workspace_tree::{build_deps, config::Config};
use brz_http::Client as HttpClient;
use brz_mysql::Mysql;
use brz_redis::{RedisService, RedisServiceOptions};
use std::{sync::Arc, time::Duration};

pub async fn build<M: Mysql>(
    mysql: M,
    erp: std::sync::Arc<
        dyn crate::erp_provider::ErpProvider<brz_redis::RedisService> + Send + Sync,
    >,
) -> anyhow::Result<Arc<crate::remote_workspace_tree::Deps<M, brz_redis::RedisService>>> {
    let config = Config::load()?;
    let http = HttpClient::builder()
        .connect_timeout(Duration::from_millis(400))
        .read_timeout(Duration::from_secs(5))
        .build()?;
    let connect_redis = || async {
        let redis_config = crate::config::RedisConfig::from_urls(
            &config.redis_url,
            config.redis_slave_url.as_deref(),
        )?;
        let redis_options = RedisServiceOptions::default()
            .with_password(redis_config.password.clone())
            .with_timeout(Duration::from_secs(5));
        let master = redis_config.endpoint();
        let slave = redis_config
            .slave_endpoint()
            .unwrap_or_else(|| master.clone());
        Ok::<RedisService, anyhow::Error>(
            RedisService::noshard_with_options(master, [slave], redis_options).await?,
        )
    };
    let redis = match connect_redis().await {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to connect Redis service; continuing without Redis-backed caches");
            None
        }
    };
    let kinds_redis = match connect_redis().await {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to connect kinds Redis service; continuing without the kinds cache");
            None
        }
    };

    Ok(build_deps(config, mysql, http, redis, kinds_redis, erp))
}
