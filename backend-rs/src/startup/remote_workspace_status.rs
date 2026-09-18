// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Status dependency composition. The cache handles remain optional inputs
//! for compatibility with the shared state; public readers use direct SQL.
use crate::remote_workspace_status::{
    AppState, config::AppConfig, http_deps::HttpDependencies, redis_cache::CacheClients,
};
use anyhow::{Context as _, Result};
use brz_mysql::Mysql;
use brz_redis::RedisServiceOptions;
use std::{sync::Arc, time::Duration};

pub async fn build<M: Mysql>(
    mysql: M,
    task_policy: crate::task_routing::TaskPolicy,
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
    let mut state = AppState::new(config, mysql, http, cache);
    state.task_policy = task_policy;
    Ok(Arc::new(state))
}

async fn build_cache(config: &AppConfig) -> Result<CacheClients<brz_redis::RedisService>> {
    let options = RedisServiceOptions::default()
        .with_password(crate::config::RedisConfig::parse(&config.redis_cache_url)?.password)
        .with_timeout(Duration::from_secs(5));
    let endpoint = endpoint_from_url(&config.redis_cache_url)?;
    let user_cache =
        brz_redis::RedisService::single_with_options(endpoint.clone(), options.clone())
            .await
            .context("failed to connect the user-cache Redis")?;
    let kinds_cache = brz_redis::RedisService::single_with_options(endpoint, options)
        .await
        .context("failed to connect the kinds-cache Redis")?;
    Ok(CacheClients::new(Some(user_cache), Some(kinds_cache)))
}

/// Extracts a `host:port[:db]` endpoint from a `redis://` URL.
fn endpoint_from_url(url: &str) -> Result<String> {
    let authority = url
        .trim()
        .strip_prefix("redis://")
        .or_else(|| url.trim().strip_prefix("rediss://"))
        .unwrap_or(url.trim());
    // Drop credentials and the path; keep an optional trailing numeric db.
    let no_auth = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    let (host_port, db) = match no_auth.split_once('/') {
        Some((host_port, path)) => (host_port, path.split('?').next().unwrap_or("")),
        None => (no_auth, ""),
    };
    if db.chars().all(|c| c.is_ascii_digit()) && !db.is_empty() {
        Ok(format!("{host_port}:{db}"))
    } else {
        Ok(host_port.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_redis_url_with_credentials() {
        let endpoint = endpoint_from_url("redis://:password@redis-cache.example.test:48958/0")
            .expect("valid URL");
        assert_eq!(endpoint, "redis-cache.example.test:48958:0");
    }

    #[test]
    fn parses_redis_url_without_db() {
        let endpoint =
            endpoint_from_url("redis://redis-cache.example.test:48958").expect("valid URL");
        assert_eq!(endpoint, "redis-cache.example.test:48958");
    }
}
