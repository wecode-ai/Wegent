// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.core.cache.RedisCache` operations used by the repository providers.
//!
//! The providers only read a domain's fully fetched repository list, write one
//! back, and coordinate the background refetch with the `building:` flag. Every
//! method here mirrors the source's swallow semantics: a Redis failure is a
//! cache miss or a failed write, never a request failure.
use async_trait::async_trait;
use brz_redis::{Redis, RedisBytes, RedisService, SetExpiration, SetOptions};

/// `REPO_CACHE_EXPIRED_TIME` (`settings`, default 7200).
const REPO_CACHE_EXPIRED_TIME_SECONDS: u64 = 7200;
/// `cache_manager.set_building(..., True)` (`expire=300`).
const BUILDING_EXPIRED_TIME_SECONDS: u64 = 300;

/// `cache_manager.generate_full_cache_key`: `git_repos:{user_id}:{git_domain}`.
pub(crate) fn full_cache_key(user_id: i32, git_domain: &str) -> String {
    format!("git_repos:{user_id}:{git_domain}")
}

/// `f"building:{user_id}:{git_domain}"`.
fn building_key(user_id: i32, git_domain: &str) -> String {
    format!("building:{user_id}:{git_domain}")
}

/// `client.set(key, value, ex=seconds)`: `SET key value EX seconds`.
fn set_with_expiry(seconds: u64) -> SetOptions {
    SetOptions::default().with_expiration(SetExpiration::Seconds(seconds))
}

/// The `cache_manager` surface the providers use.
#[async_trait]
pub(crate) trait RepositoryCache: Send + Sync {
    /// `cache_manager.get`: the raw stored bytes, `None` for a missing key or a
    /// swallowed read error.
    async fn get(&self, key: &str) -> Option<Vec<u8>>;

    /// `cache_manager.set(key, value, expire=REPO_CACHE_EXPIRED_TIME)`. A
    /// failed write is logged and dropped.
    async fn set(&self, key: &str, value: Vec<u8>);

    /// `cache_manager.is_building`: only a stored `true` counts.
    async fn is_building(&self, user_id: i32, git_domain: &str) -> bool;

    /// `cache_manager.set_building`: `True` writes with a 300s expiry, `False`
    /// deletes the key.
    async fn set_building(&self, user_id: i32, git_domain: &str, building: bool);
}

/// The application Redis service, or an always-miss stub when Redis is
/// unavailable (matching the source deployment tolerating a missing cache).
pub(crate) struct RedisRepositoryCache {
    pub(crate) redis: Option<RedisService>,
}

#[async_trait]
impl RepositoryCache for RedisRepositoryCache {
    async fn get(&self, key: &str) -> Option<Vec<u8>> {
        let redis = self.redis.as_ref()?;
        match redis.get::<_, RedisBytes>(key).await {
            Ok(value) => value.map(|bytes| bytes.as_ref().to_vec()),
            Err(error) => {
                tracing::warn!(%error, key, "repository cache read failed");
                None
            }
        }
    }

    async fn set(&self, key: &str, value: Vec<u8>) {
        let Some(redis) = self.redis.as_ref() else {
            return;
        };
        match redis
            .set_with(key, value, set_with_expiry(REPO_CACHE_EXPIRED_TIME_SECONDS))
            .await
        {
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, key, "repository cache write failed"),
        }
    }

    async fn is_building(&self, user_id: i32, git_domain: &str) -> bool {
        let Some(redis) = self.redis.as_ref() else {
            return false;
        };
        let key = building_key(user_id, git_domain);
        match redis.get::<_, RedisBytes>(&key).await {
            Ok(Some(bytes)) => serde_json::from_slice::<serde_json::Value>(bytes.as_ref())
                .map(|value| value == serde_json::Value::Bool(true))
                .unwrap_or(false),
            Ok(None) => false,
            Err(error) => {
                tracing::warn!(%error, key, "repository cache read failed");
                false
            }
        }
    }

    async fn set_building(&self, user_id: i32, git_domain: &str, building: bool) {
        let Some(redis) = self.redis.as_ref() else {
            return;
        };
        let key = building_key(user_id, git_domain);
        let result = if building {
            redis
                .set_with(
                    &key,
                    serde_json::Value::Bool(true).to_string(),
                    set_with_expiry(BUILDING_EXPIRED_TIME_SECONDS),
                )
                .await
                .map(|_| ())
        } else {
            redis.del(&key).await.map(|_| ())
        };
        if let Err(error) = result {
            tracing::warn!(%error, key, "repository building flag write failed");
        }
    }
}
