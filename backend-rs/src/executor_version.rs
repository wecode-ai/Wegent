// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Executor latest-version cache for the device listings.
//!
//! Mirrors `app.services.device.version_service.ExecutorVersionService`:
//! `get_latest_version` reads the `executor:latest_version` Redis key and
//! returns the cached version string, while the explicit unavailable marker,
//! a missing key, and a failed read all fall back to
//! `settings.EXECUTOR_LATEST_VERSION` at the callers' `... or
//! settings.EXECUTOR_LATEST_VERSION`.
//!
//! A miss is not only a fallback: the source calls `_start_refresh()`, which
//! starts one process-local refresh without delaying the caller, and
//! `_refresh_version` re-reads the same key inside that background task. That
//! second read is the only version-service exchange a device listing adds
//! beyond its own lookup, so it is reproduced here by a startup-owned worker
//! with a bounded queue: request handlers only enqueue admission, never a
//! task of their own.
//!
//! Source `_refresh_version` continues with the remote version check and the
//! cache write when the key is still absent. Neither is implemented: the
//! target has no version checker, and the recorded deployment never wrote the
//! key (`ExecutorVersionService` is the only writer of this key in the source
//! and no `SET executor:latest_version` appears in its recorded traffic).
use std::sync::Arc;

use async_trait::async_trait;
use brz_redis::Redis;
use tokio::sync::mpsc;

use crate::state::AppState;

/// `ExecutorVersionService.EXECUTOR_VERSION_CACHE_KEY`.
const EXECUTOR_VERSION_KEY: &str = "executor:latest_version";

/// The value stored when a remote version fetch failed
/// (`EXECUTOR_VERSION_UNAVAILABLE`); callers treat it as "no version".
const EXECUTOR_VERSION_UNAVAILABLE: &str = "__unavailable__";

/// Default when neither Redis nor the checker produced a version
/// (`settings.EXECUTOR_LATEST_VERSION`).
const EXECUTOR_LATEST_VERSION_DEFAULT: &str = "1.0.0";

/// `_start_refresh` keeps one pending refresh and returns while it is pending
/// (`if self._refresh_task and not self._refresh_task.done(): return`), so the
/// queue holds a single job and a full queue drops the duplicate request.
const REFRESH_QUEUE_CAPACITY: usize = 1;

/// Source `cache_manager.get`: one cached read whose errors and missing keys
/// both degrade to `None`.
#[async_trait]
trait ExecutorVersionCache: Send + Sync {
    /// Read one key; `None` is a missing key or a swallowed read error.
    async fn get(&self, key: &str) -> Option<Vec<u8>>;
}

/// `cache_manager` over the application's shared Redis service.
///
/// The service is created during startup and retained for the process
/// lifetime, so the worker reuses the one pooled connection rather than
/// building a client per refresh.
struct RedisVersionCache {
    redis: Option<brz_redis::RedisService>,
}

#[async_trait]
impl ExecutorVersionCache for RedisVersionCache {
    async fn get(&self, key: &str) -> Option<Vec<u8>> {
        let redis = self.redis.as_ref()?;
        match redis.get::<_, brz_redis::RedisBytes>(key).await {
            Ok(value) => value.map(|bytes| bytes.as_ref().to_vec()),
            Err(error) => {
                tracing::warn!(%error, key, "executor version cache read failed");
                None
            }
        }
    }
}

/// Process-lifetime `executor_version_service` singleton.
#[derive(Clone)]
pub struct ExecutorVersionService {
    cache: Arc<dyn ExecutorVersionCache>,
    /// `_start_refresh` admission: a request enqueues here and returns.
    refresh: mpsc::Sender<()>,
}

impl ExecutorVersionService {
    /// Build the service over the application's Redis service.
    ///
    /// Called once from process startup (`startup::app::build`), before any
    /// route is constructed, so the refresh worker is initialization-owned.
    /// The worker lives for the process lifetime and ends when the last
    /// service handle is dropped.
    pub fn from_redis(redis: Option<brz_redis::RedisService>) -> Self {
        Self::with_cache(Arc::new(RedisVersionCache { redis }))
    }

    fn with_cache(cache: Arc<dyn ExecutorVersionCache>) -> Self {
        let (refresh, refresh_rx) = mpsc::channel(REFRESH_QUEUE_CAPACITY);
        tokio::spawn(run_refresh_worker(cache.clone(), refresh_rx));
        Self { cache, refresh }
    }

    /// `executor_version_service.get_latest_version()` before the callers'
    /// `or settings.EXECUTOR_LATEST_VERSION`: a cached version wins, the
    /// unavailable marker and every miss render the settings default.
    pub async fn latest_version(&self) -> Option<String> {
        let Some(payload) = self.cache.get(EXECUTOR_VERSION_KEY).await else {
            // `get_latest_version` found no cached value and called
            // `_start_refresh()`; the caller then applies the default.
            self.start_refresh();
            return Some(EXECUTOR_LATEST_VERSION_DEFAULT.to_string());
        };
        match serde_json::from_slice::<String>(&payload) {
            Ok(value) if value == EXECUTOR_VERSION_UNAVAILABLE => {
                Some(EXECUTOR_LATEST_VERSION_DEFAULT.to_string())
            }
            Ok(value) if !value.is_empty() => Some(value),
            // `if cached:` is false for an empty string, and a decode failure
            // is the exception `cache_manager.get` swallows: both are misses.
            Ok(_) | Err(_) => {
                self.start_refresh();
                Some(EXECUTOR_LATEST_VERSION_DEFAULT.to_string())
            }
        }
    }

    /// `_start_refresh`: admit one process-local refresh without delaying the
    /// caller. A refresh that is already queued or running is kept, exactly
    /// like the source's pending-task check.
    fn start_refresh(&self) {
        if let Err(error) = self.refresh.try_send(()) {
            tracing::debug!(%error, "executor version refresh already pending");
        }
    }
}

/// `_refresh_version`: the background re-read of the cached version.
///
/// The source reads the key and returns when it is present, which is the
/// exchange a cache miss adds to the recorded dependencies. Started once by
/// [`ExecutorVersionService::from_redis`] during process startup; request
/// handlers never reach this launcher, they only enqueue admission.
///
/// The remote version check and the cache write the source performs when this
/// re-read still misses are deliberately absent: the recorded deployment holds
/// no such exchange (the key is never written by the recorded process), so the
/// target keeps the callers' settings default instead of inventing a write
/// path with no evidence behind it.
async fn run_refresh_worker(
    cache: Arc<dyn ExecutorVersionCache>,
    mut refresh_rx: mpsc::Receiver<()>,
) {
    while refresh_rx.recv().await.is_some() {
        let _ = cache.get(EXECUTOR_VERSION_KEY).await;
    }
}

/// `executor_version_service.get_latest_version() or
/// settings.EXECUTOR_LATEST_VERSION` for the application state's service.
pub async fn latest_executor_version(state: &AppState) -> Option<String> {
    state.executor_version.latest_version().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::Notify;

    /// A scripted `cache_manager`: every read returns the same payload, and one
    /// chosen read can block until the test releases it.
    struct FakeCache {
        inner: Mutex<FakeInner>,
        release_blocked_read: Notify,
    }

    struct FakeInner {
        payload: Option<Vec<u8>>,
        reads: usize,
        blocked_read: Option<usize>,
        keys: Vec<String>,
    }

    impl FakeCache {
        fn new(payload: Option<&str>) -> Self {
            Self {
                inner: Mutex::new(FakeInner {
                    payload: payload.map(|value| value.as_bytes().to_vec()),
                    reads: 0,
                    blocked_read: None,
                    keys: Vec::new(),
                }),
                release_blocked_read: Notify::new(),
            }
        }

        /// Block the read with this 1-based index until [`Self::release`].
        fn block_read(self, index: usize) -> Self {
            self.inner.lock().expect("fake cache").blocked_read = Some(index);
            self
        }

        fn reads(&self) -> usize {
            self.inner.lock().expect("fake cache").reads
        }

        fn keys(&self) -> Vec<String> {
            self.inner.lock().expect("fake cache").keys.clone()
        }

        fn release(&self) {
            self.release_blocked_read.notify_one();
        }

        /// Wait for the cache to have served at least `expected` reads.
        async fn served_reads(&self, expected: usize) {
            let reached = tokio::time::timeout(Duration::from_secs(5), async {
                while self.reads() < expected {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            });
            if reached.await.is_err() {
                panic!("expected {expected} reads, saw {}", self.reads());
            }
        }

        /// A negative assertion: no further read may start while the caller
        /// keeps the runtime busy for a bounded window.
        async fn no_further_reads(&self, expected: usize) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(self.reads(), expected);
        }
    }

    #[async_trait]
    impl ExecutorVersionCache for FakeCache {
        async fn get(&self, key: &str) -> Option<Vec<u8>> {
            let (blocked, payload) = {
                let mut inner = self.inner.lock().expect("fake cache");
                inner.reads += 1;
                inner.keys.push(key.to_string());
                (
                    inner.blocked_read == Some(inner.reads),
                    inner.payload.clone(),
                )
            };
            if blocked {
                self.release_blocked_read.notified().await;
            }
            payload
        }
    }

    fn service(cache: &Arc<FakeCache>) -> ExecutorVersionService {
        ExecutorVersionService::with_cache(cache.clone())
    }

    #[tokio::test]
    async fn cached_version_is_returned_without_a_refresh() {
        let cache = Arc::new(FakeCache::new(Some("\"2.0.20\"")));
        let service = service(&cache);

        assert_eq!(service.latest_version().await.as_deref(), Some("2.0.20"));
        assert_eq!(cache.keys(), vec![EXECUTOR_VERSION_KEY.to_string()]);
        cache.no_further_reads(1).await;
    }

    #[tokio::test]
    async fn unavailable_marker_falls_back_to_the_settings_default() {
        let cache = Arc::new(FakeCache::new(Some("\"__unavailable__\"")));
        let service = service(&cache);

        assert_eq!(service.latest_version().await.as_deref(), Some("1.0.0"));
        cache.no_further_reads(1).await;
    }

    #[tokio::test]
    async fn empty_cached_value_is_a_miss_like_the_source_truthiness_check() {
        let cache = Arc::new(FakeCache::new(Some("\"\"")));
        let service = service(&cache);

        assert_eq!(service.latest_version().await.as_deref(), Some("1.0.0"));
        cache.served_reads(2).await;
        assert_eq!(cache.keys(), vec![EXECUTOR_VERSION_KEY.to_string(); 2]);
    }

    #[tokio::test]
    async fn a_cache_miss_falls_back_and_start_refreshes_once() {
        let cache = Arc::new(FakeCache::new(None));
        let service = service(&cache);

        assert_eq!(service.latest_version().await.as_deref(), Some("1.0.0"));
        cache.served_reads(2).await;
        assert_eq!(cache.keys(), vec![EXECUTOR_VERSION_KEY.to_string(); 2]);
        cache.no_further_reads(2).await;
    }

    #[tokio::test]
    async fn misses_while_a_refresh_is_pending_are_dropped() {
        // Read 2 is the refresh's re-read: it stays in flight while the request
        // path keeps missing, so further refresh requests are coalesced
        // instead of queued behind it.
        let cache = Arc::new(FakeCache::new(None).block_read(2));
        let service = service(&cache);

        assert_eq!(service.latest_version().await.as_deref(), Some("1.0.0"));
        cache.served_reads(2).await;

        for _ in 0..3 {
            assert_eq!(service.latest_version().await.as_deref(), Some("1.0.0"));
        }

        // Read 1 is the first request, read 2 the refresh, reads 3-5 the three
        // request misses, and read 6 the single duplicate that fit in the
        // queue; the other two duplicates were dropped.
        cache.release();
        cache.served_reads(6).await;
        cache.no_further_reads(6).await;
    }
}
