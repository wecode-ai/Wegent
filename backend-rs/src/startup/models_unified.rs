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
    let redis = match build_redis(&config.redis_url).await {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to connect models-unified Redis; continuing without Redis-backed caches");
            None
        }
    };
    Ok(Arc::new(build_state(config, mysql, redis, erp)?))
}

/// Build the unsharded Redis service for the source `REDIS_URL`.
///
/// `brz-redis` takes `host:port[:db]` endpoints; the URL scheme, userinfo, and
/// path are normalized here because the crate does not parse `redis://` URLs.
async fn build_redis(redis_url: &str) -> Result<brz_redis::RedisService> {
    let endpoint = redis_endpoint(redis_url)?;
    let options = brz_redis::RedisServiceOptions::default()
        .with_password(crate::config::RedisConfig::parse(redis_url)?.password)
        .with_timeout(Duration::from_millis(200));
    brz_redis::RedisService::single_with_options(endpoint, options)
        .await
        .context("failed to connect Redis dependency")
}

fn redis_endpoint(redis_url: &str) -> Result<String> {
    let rest = redis_url
        .strip_prefix("redis://")
        .or_else(|| redis_url.strip_prefix("rediss://"))
        .unwrap_or(redis_url);
    // Drop userinfo and the leading slash of the db selector.
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    let mut endpoint = rest.trim_start_matches('/').to_string();
    if endpoint.is_empty() || endpoint.ends_with(':') {
        anyhow::bail!("invalid REDIS_URL");
    }
    if !endpoint.contains(':') {
        anyhow::bail!("invalid REDIS_URL: missing port");
    }
    // brz-redis expects host:port[:db]; keep any numeric db selector and drop
    // a trailing slash introduced by URL paths like /0.
    if let Some((host_port, db)) = endpoint.rsplit_once('/')
        && !db.is_empty()
        && db.chars().all(|c| c.is_ascii_digit())
    {
        endpoint = format!("{host_port}:{db}");
    }
    Ok(endpoint)
}

#[cfg(test)]
mod tests {
    use super::redis_endpoint;

    #[test]
    fn redis_endpoint_strips_scheme_userinfo_and_path() {
        assert_eq!(
            redis_endpoint("redis://:password@redis.example.invalid:6379/0").unwrap(),
            "redis.example.invalid:6379:0"
        );
        assert_eq!(
            redis_endpoint("redis://user:password@127.0.0.1:6379/1").unwrap(),
            "127.0.0.1:6379:1"
        );
        assert_eq!(
            redis_endpoint("redis://redis.example.invalid:6379").unwrap(),
            "redis.example.invalid:6379"
        );
    }

    #[test]
    fn redis_endpoint_rejects_missing_port() {
        assert!(redis_endpoint("redis://only-host").is_err());
    }
}
