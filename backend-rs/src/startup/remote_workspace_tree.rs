// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tree dependency composition. Redis handles are optional compatibility
//! inputs; public user/kind readers use direct SQL.
use crate::remote_workspace_tree::{build_deps, config::Config};
use brz_http::Client as HttpClient;
use brz_mysql::Mysql;
use brz_redis::{RedisService, RedisServiceOptions};
use std::{sync::Arc, time::Duration};

pub async fn build<M: Mysql>(
    mysql: M,
) -> anyhow::Result<Arc<crate::remote_workspace_tree::Deps<M, brz_redis::RedisService>>> {
    let config = Config::load()?;
    let http = HttpClient::builder()
        .connect_timeout(Duration::from_millis(400))
        .read_timeout(Duration::from_secs(5))
        .build()?;
    let connect_redis = || async {
        let redis_options = RedisServiceOptions::default()
            .with_password(crate::config::RedisConfig::parse(&config.redis_url)?.password)
            .with_timeout(Duration::from_secs(5));
        let endpoints = config.redis_endpoints();
        let master = endpoints
            .first()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("REDIS_URL has no endpoint"))?;
        Ok::<RedisService, anyhow::Error>(
            RedisService::noshard_with_options(master, endpoints, redis_options).await?,
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

    Ok(build_deps(config, mysql, http, redis, kinds_redis))
}
