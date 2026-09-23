// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Status dependency composition. The cache handles remain optional inputs
//! for compatibility with the shared state; public readers use direct SQL.
use crate::remote_workspace_status::{
    AppState, app_state::VideoRefresh, config::AppConfig, http_deps::HttpDependencies,
    redis_cache::CacheClients,
};
use anyhow::{Context as _, Result};
use brz_mysql::Mysql;
use brz_redis::RedisServiceOptions;
use std::{sync::Arc, time::Duration};

pub async fn build<M: Mysql>(
    mysql: M,
    task_policy: crate::task_routing::TaskPolicy,
    erp: std::sync::Arc<
        dyn crate::erp_provider::ErpProvider<brz_redis::RedisService> + Send + Sync,
    >,
    video_refresh: VideoRefresh,
) -> Result<Arc<AppState<M, brz_redis::RedisService>>> {
    let config = AppConfig::from_env().context("failed to load application configuration")?;
    let cache = match build_cache(&config).await {
        Ok(cache) => cache,
        Err(error) => {
            tracing::warn!(%error, "failed to connect the kind/user cache Redis; continuing without Redis-backed caches");
            CacheClients::disabled()
        }
    };
    let http = brz_http::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .build()
        .context("failed to build the executor-manager HTTP client")?;
    let http = HttpDependencies::new(http, &config.executor_manager_url);
    let mut state = AppState::new(config, mysql, http, cache, erp, video_refresh);
    state.task_policy = task_policy;
    Ok(Arc::new(state))
}

async fn build_cache(config: &AppConfig) -> Result<CacheClients<brz_redis::RedisService>> {
    let redis_config = crate::config::RedisConfig::from_urls(
        &config.redis_cache_url,
        config.redis_slave_url.as_deref(),
    )?;
    let options = RedisServiceOptions::default()
        .with_password(redis_config.password.clone())
        .with_timeout(Duration::from_secs(5));
    let master = redis_config.endpoint();
    let slave = redis_config
        .slave_endpoint()
        .unwrap_or_else(|| master.clone());
    let user_cache = brz_redis::RedisService::noshard_with_options(
        master.clone(),
        [slave.clone()],
        options.clone(),
    )
    .await
    .context("failed to connect the user-cache Redis")?;
    let kinds_cache = brz_redis::RedisService::noshard_with_options(master, [slave], options)
        .await
        .context("failed to connect the kinds-cache Redis")?;
    Ok(CacheClients::new(Some(user_cache), Some(kinds_cache)))
}
