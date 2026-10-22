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
//! second read is reproduced here by a startup-owned worker with a bounded
//! queue: request handlers only enqueue admission, never a task of their own.
//!
//! When the re-read still misses, source `_refresh_version` performs the remote
//! version check and the cache write: it asks its `VersionChecker`
//! (`app.services.device.version_checker`) for the latest version and writes the
//! result back with `EXECUTOR_VERSION_CACHE_TTL`, or the explicit unavailability
//! marker with the shorter failure TTL. Both exchanges are reproduced here by
//! the same startup-owned worker, so a device-status request observes the full
//! refresh the source performs on a cold cache.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use brz_http::Client as HttpClient;
use brz_redis::{Redis, SetExpiration, SetOptions};
use tokio::sync::mpsc;

use crate::config::env_or_dotenv;
use crate::state::AppState;

/// `ExecutorVersionService.EXECUTOR_VERSION_CACHE_KEY`.
const EXECUTOR_VERSION_KEY: &str = "executor:latest_version";

/// The value stored when a remote version fetch failed
/// (`EXECUTOR_VERSION_UNAVAILABLE`); callers treat it as "no version".
const EXECUTOR_VERSION_UNAVAILABLE: &str = "__unavailable__";

/// Default when neither Redis nor the checker produced a version
/// (`settings.EXECUTOR_LATEST_VERSION`).
const EXECUTOR_LATEST_VERSION_DEFAULT: &str = "1.0.0";

/// `EXECUTOR_VERSION_FAILURE_CACHE_TTL`: how long a failed remote check is
/// suppressed before the next request may refresh again.
const EXECUTOR_VERSION_FAILURE_CACHE_TTL: i64 = 30;

/// `settings.EXECUTOR_VERSION_CACHE_TTL` pydantic default (seconds).
const EXECUTOR_VERSION_CACHE_TTL_DEFAULT: i64 = 60;

/// `_start_refresh` keeps one pending refresh and returns while it is pending
/// (`if self._refresh_task and not self._refresh_task.done(): return`), so the
/// queue holds a single job and a full queue drops the duplicate request.
const REFRESH_QUEUE_CAPACITY: usize = 1;

/// `RegistryVersionChecker.BINARY_NAME` (`all platform binary is same version`).
const REGISTRY_BINARY_NAME: &str = "wegent-executor-linux-amd64";

/// `RegistryVersionChecker.API_TIMEOUT` / `GithubVersionChecker.API_TIMEOUT`.
const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// `GithubVersionChecker.API_BASE`.
const GITHUB_API_BASE: &str = "https://api.github.com";

/// `GithubVersionChecker.GITHUB_REPO`.
const GITHUB_REPO: &str = "wecode-ai/Wegent";

/// Stable metric profile for the registry version check (the URL carries the
/// resolved host, so the profile names the route shape).
const REGISTRY_PROFILE: &str = "http://executor-registry/wegent-executor-linux-amd64/update.json";

/// Stable metric profile for the GitHub releases check.
const GITHUB_PROFILE: &str = "https://api.github.com/repos/wecode-ai/Wegent/releases/latest";

/// Source `cache_manager`: one cached read whose errors and missing keys both
/// degrade to `None`, plus the `set(key, value, expire)` write the refresh uses.
#[async_trait]
trait ExecutorVersionCache: Send + Sync {
    /// Read one key; `None` is a missing key or a swallowed read error.
    async fn get(&self, key: &str) -> Option<Vec<u8>>;

    /// `cache_manager.set(key, value, expire=ttl_seconds)`; write failures are
    /// swallowed like the source's `cache_manager.set`.
    async fn set(&self, key: &str, value: &str, ttl_seconds: i64);
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

    async fn set(&self, key: &str, value: &str, ttl_seconds: i64) {
        let Some(redis) = self.redis.as_ref() else {
            return;
        };
        let options = SetOptions::default()
            .with_expiration(SetExpiration::Seconds(ttl_seconds.max(0) as u64));
        if let Err(error) = redis.set_with(key, value, options).await {
            tracing::warn!(%error, key, "executor version cache write failed");
        }
    }
}

/// `app.services.device.version_checker.VersionChecker`: the remote latest
/// version source, either the internal registry or GitHub.
#[async_trait]
trait VersionChecker: Send + Sync {
    /// The latest version string, or `None` when the check failed
    /// (`VersionChecker.get_latest_version` returning `None`).
    ///
    /// `request_id` is the `X-Request-ID` the triggering request carried; the
    /// source's `traced_session()` injects it into every outbound request, so
    /// the check reproduces it when present.
    async fn latest_version(&self, request_id: Option<&str>) -> Option<String>;
}

/// `shared.utils.http_client._inject_trace_headers`'s request-id header name.
const REQUEST_ID_HEADER: &str = "x-request-id";

/// Apply `traced_session()`'s `X-Request-ID` injection to one request builder.
fn with_request_id(
    request: brz_http::RequestBuilder,
    request_id: Option<&str>,
) -> brz_http::RequestBuilder {
    match request_id {
        Some(request_id) if !request_id.is_empty() => request.header(REQUEST_ID_HEADER, request_id),
        _ => request,
    }
}

/// `RegistryVersionChecker`: fetch the latest version from the internal
/// registry's `update.json`.
struct RegistryVersionChecker {
    client: HttpClient,
    api_url: String,
    token: Option<String>,
}

impl RegistryVersionChecker {
    /// `RegistryVersionChecker._build_api_url`: an explicit `update.json` or a
    /// binary-scoped URL is used as-is, otherwise the binary name and
    /// `update.json` are appended to the registry root.
    fn build_api_url(registry_url: &str) -> String {
        let base_url = registry_url.trim_end_matches('/');
        if base_url.ends_with("/update.json") || base_url.contains(REGISTRY_BINARY_NAME) {
            base_url.to_string()
        } else {
            format!("{base_url}/{REGISTRY_BINARY_NAME}/update.json")
        }
    }
}

#[async_trait]
impl VersionChecker for RegistryVersionChecker {
    async fn latest_version(&self, request_id: Option<&str>) -> Option<String> {
        let endpoint = self
            .client
            .endpoint_named(&self.api_url, REGISTRY_PROFILE)
            .ok()?;
        let mut request = endpoint.get().timeout(VERSION_CHECK_TIMEOUT);
        if let Some(token) = self.token.as_deref() {
            // `headers["PRIVATE-TOKEN"] = self.auth_token`.
            request = request.header("PRIVATE-TOKEN", token);
        }
        // `traced_session()` sets `headers["X-Request-ID"] = request_id`.
        request = with_request_id(request, request_id);
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, "failed to fetch executor version from registry");
                return None;
            }
        };
        if !response.status().is_success() {
            tracing::warn!(
                status = response.status().as_u16(),
                "executor registry version check returned a non-success status"
            );
            return None;
        }
        // `data.get("version")` gated on a non-empty string.
        let data: serde_json::Value = response.json().await.ok()?;
        data.get("version")
            .and_then(serde_json::Value::as_str)
            .filter(|version| !version.is_empty())
            .map(str::to_string)
    }
}

/// `GithubVersionChecker`: fetch the latest release tag from GitHub.
struct GithubVersionChecker {
    client: HttpClient,
}

#[async_trait]
impl VersionChecker for GithubVersionChecker {
    async fn latest_version(&self, request_id: Option<&str>) -> Option<String> {
        let url = format!("{GITHUB_API_BASE}/repos/{GITHUB_REPO}/releases/latest");
        let endpoint = self.client.endpoint_named(&url, GITHUB_PROFILE).ok()?;
        let request = endpoint
            .get()
            .header("Accept", "application/vnd.github+json")
            .timeout(VERSION_CHECK_TIMEOUT);
        let response = match with_request_id(request, request_id).send().await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, "failed to fetch executor version from GitHub");
                return None;
            }
        };
        if !response.status().is_success() {
            return None;
        }
        // `tag_name.lstrip("v")`.
        let data: serde_json::Value = response.json().await.ok()?;
        data.get("tag_name")
            .and_then(serde_json::Value::as_str)
            .map(|tag| tag.trim_start_matches('v').to_string())
    }
}

/// Process-lifetime `executor_version_service` singleton.
#[derive(Clone)]
pub struct ExecutorVersionService {
    cache: Arc<dyn ExecutorVersionCache>,
    /// `_start_refresh` admission: a request enqueues the triggering request's
    /// `X-Request-ID` here and returns.
    refresh: mpsc::Sender<Option<String>>,
}

impl ExecutorVersionService {
    /// Build the service over the application's Redis service.
    ///
    /// Called once from process startup (`startup::app::build`), before any
    /// route is constructed, so the refresh worker is initialization-owned.
    /// The worker lives for the process lifetime and ends when the last
    /// service handle is dropped.
    pub fn from_redis(redis: Option<brz_redis::RedisService>) -> anyhow::Result<Self> {
        let checker = build_checker()?;
        Ok(Self::with_cache(
            Arc::new(RedisVersionCache { redis }),
            checker,
            executor_version_cache_ttl(),
        ))
    }

    fn with_cache(
        cache: Arc<dyn ExecutorVersionCache>,
        checker: Arc<dyn VersionChecker>,
        cache_ttl: i64,
    ) -> Self {
        let (refresh, refresh_rx) = mpsc::channel(REFRESH_QUEUE_CAPACITY);
        // The worker retains the checker and the cache TTL; the service only
        // keeps what the request path needs.
        tokio::spawn(run_refresh_worker(
            cache.clone(),
            checker,
            cache_ttl,
            refresh_rx,
        ));
        Self { cache, refresh }
    }

    /// `executor_version_service.get_latest_version()` before the callers'
    /// `or settings.EXECUTOR_LATEST_VERSION`: a cached version wins, the
    /// unavailable marker and every miss render the settings default.
    ///
    /// `request_id` is the triggering request's `X-Request-ID`; the source's
    /// `asyncio.create_task` copies the request context into the detached
    /// refresh, so the header reflects the request that admitted it.
    pub async fn latest_version(&self, request_id: Option<&str>) -> Option<String> {
        let Some(payload) = self.cache.get(EXECUTOR_VERSION_KEY).await else {
            // `get_latest_version` found no cached value and called
            // `_start_refresh()`; the caller then applies the default.
            self.start_refresh(request_id);
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
                self.start_refresh(request_id);
                Some(EXECUTOR_LATEST_VERSION_DEFAULT.to_string())
            }
        }
    }

    /// `_start_refresh`: admit one process-local refresh without delaying the
    /// caller. A refresh that is already queued or running is kept, exactly
    /// like the source's pending-task check.
    fn start_refresh(&self, request_id: Option<&str>) {
        let job = request_id
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Err(error) = self.refresh.try_send(job) {
            tracing::debug!(%error, "executor version refresh already pending");
        }
    }
}

/// `ExecutorVersionService._create_checker`: registry when
/// `EXECUTOR_REGISTRY_URL` is set, otherwise GitHub. The HTTP client is built
/// once here, at startup, so the worker reuses one pooled transport.
fn build_checker() -> anyhow::Result<Arc<dyn VersionChecker>> {
    let client = HttpClient::builder()
        .timeout(VERSION_CHECK_TIMEOUT)
        .build()
        .map_err(|error| {
            anyhow::anyhow!("failed to build the executor-version HTTP client: {error}")
        })?;
    let registry_url = env_or_dotenv("EXECUTOR_REGISTRY_URL").filter(|value| !value.is_empty());
    Ok(match registry_url {
        Some(url) => Arc::new(RegistryVersionChecker {
            api_url: RegistryVersionChecker::build_api_url(&url),
            token: env_or_dotenv("EXECUTOR_REGISTRY_TOKEN").filter(|value| !value.is_empty()),
            client,
        }),
        None => Arc::new(GithubVersionChecker { client }),
    })
}

/// `settings.EXECUTOR_VERSION_CACHE_TTL` as an integer, defaulting to the
/// pydantic default when unset or unparseable.
fn executor_version_cache_ttl() -> i64 {
    env_or_dotenv("EXECUTOR_VERSION_CACHE_TTL")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(EXECUTOR_VERSION_CACHE_TTL_DEFAULT)
}

/// Encode a version the way `cache_manager.set`'s `orjson.dumps` does, so the
/// stored bytes match the source (a JSON string such as `"2.0.20"`).
fn version_payload(version: &str) -> Option<String> {
    serde_json::to_string(version).ok()
}

/// `if cached: return` in `_refresh_version`: Python truthiness of the decoded
/// `cache_manager.get` value.
fn cached_version_present(payload: &[u8]) -> bool {
    match serde_json::from_slice::<serde_json::Value>(payload) {
        Ok(serde_json::Value::Null) => false,
        Ok(serde_json::Value::String(value)) => !value.is_empty(),
        Ok(serde_json::Value::Bool(value)) => value,
        Ok(serde_json::Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Ok(serde_json::Value::Array(values)) => !values.is_empty(),
        Ok(serde_json::Value::Object(map)) => !map.is_empty(),
        Err(_) => !payload.is_empty(),
    }
}

/// `_refresh_version`: the background re-read, remote check and cache write.
///
/// The source reads the key and returns when it is present; otherwise it asks
/// the `VersionChecker` and writes the result (`EXECUTOR_VERSION_CACHE_TTL`, or
/// `EXECUTOR_VERSION_FAILURE_CACHE_TTL` for the unavailability marker). Started
/// once by [`ExecutorVersionService::from_redis`] during process startup;
/// request handlers never reach this launcher, they only enqueue admission.
async fn run_refresh_worker(
    cache: Arc<dyn ExecutorVersionCache>,
    checker: Arc<dyn VersionChecker>,
    cache_ttl: i64,
    mut refresh_rx: mpsc::Receiver<Option<String>>,
) {
    // Each job carries the triggering request's `X-Request-ID`, mirroring the
    // request context `asyncio.create_task` copies into the detached refresh.
    while let Some(request_id) = refresh_rx.recv().await {
        if let Some(payload) = cache.get(EXECUTOR_VERSION_KEY).await
            && cached_version_present(&payload)
        {
            continue;
        }
        match checker.latest_version(request_id.as_deref()).await {
            Some(version) => {
                if let Some(payload) = version_payload(&version) {
                    cache.set(EXECUTOR_VERSION_KEY, &payload, cache_ttl).await;
                }
                tracing::info!(%version, "fetched and cached executor version");
            }
            None => {
                if let Some(payload) = version_payload(EXECUTOR_VERSION_UNAVAILABLE) {
                    cache
                        .set(
                            EXECUTOR_VERSION_KEY,
                            &payload,
                            EXECUTOR_VERSION_FAILURE_CACHE_TTL,
                        )
                        .await;
                }
                tracing::warn!("failed to fetch executor version from all sources");
            }
        }
    }
}

/// `executor_version_service.get_latest_version() or
/// settings.EXECUTOR_LATEST_VERSION` for the application state's service.
///
/// `request_id` is the calling request's `X-Request-ID`, forwarded to the
/// detached refresh so its outbound check carries the source's
/// `traced_session()` request-id header.
pub async fn latest_executor_version(state: &AppState, request_id: Option<&str>) -> Option<String> {
    state.executor_version.latest_version(request_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::Notify;

    /// A scripted `cache_manager`: every read returns the same payload, writes
    /// are recorded, and one chosen read can block until the test releases it.
    struct FakeCache {
        inner: Mutex<FakeInner>,
        release_blocked_read: Notify,
    }

    struct FakeInner {
        payload: Option<Vec<u8>>,
        reads: usize,
        blocked_read: Option<usize>,
        keys: Vec<String>,
        writes: Vec<(String, String, i64)>,
    }

    impl FakeCache {
        fn new(payload: Option<&str>) -> Self {
            Self {
                inner: Mutex::new(FakeInner {
                    payload: payload.map(|value| value.as_bytes().to_vec()),
                    reads: 0,
                    blocked_read: None,
                    keys: Vec::new(),
                    writes: Vec::new(),
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

        fn writes(&self) -> Vec<(String, String, i64)> {
            self.inner.lock().expect("fake cache").writes.clone()
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

        /// Wait for the cache to have recorded at least `expected` writes.
        async fn served_writes(&self, expected: usize) {
            let reached = tokio::time::timeout(Duration::from_secs(5), async {
                while self.writes().len() < expected {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            });
            if reached.await.is_err() {
                panic!("expected {expected} writes, saw {}", self.writes().len());
            }
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

        async fn set(&self, key: &str, value: &str, ttl_seconds: i64) {
            self.inner.lock().expect("fake cache").writes.push((
                key.to_string(),
                value.to_string(),
                ttl_seconds,
            ));
        }
    }

    /// A scripted `VersionChecker` returning one fixed version (or a miss).
    struct FakeChecker {
        version: Option<&'static str>,
        calls: Mutex<Vec<Option<String>>>,
    }

    impl FakeChecker {
        fn returning(version: &'static str) -> Self {
            Self {
                version: Some(version),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn failing() -> Self {
            Self {
                version: None,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> usize {
            self.calls.lock().expect("fake checker").len()
        }

        /// The `X-Request-ID` each check received, in call order.
        fn request_ids(&self) -> Vec<Option<String>> {
            self.calls.lock().expect("fake checker").clone()
        }
    }

    #[async_trait]
    impl VersionChecker for FakeChecker {
        async fn latest_version(&self, request_id: Option<&str>) -> Option<String> {
            self.calls
                .lock()
                .expect("fake checker")
                .push(request_id.map(str::to_string));
            self.version.map(str::to_string)
        }
    }

    fn service(
        cache: &Arc<FakeCache>,
        checker: Arc<dyn VersionChecker>,
        cache_ttl: i64,
    ) -> ExecutorVersionService {
        ExecutorVersionService::with_cache(cache.clone(), checker, cache_ttl)
    }

    fn no_check(cache: &Arc<FakeCache>) -> ExecutorVersionService {
        service(cache, Arc::new(FakeChecker::failing()), 300)
    }

    #[tokio::test]
    async fn cached_version_is_returned_without_a_refresh() {
        let cache = Arc::new(FakeCache::new(Some("\"2.0.20\"")));
        let service = no_check(&cache);

        assert_eq!(
            service.latest_version(None).await.as_deref(),
            Some("2.0.20")
        );
        assert_eq!(cache.keys(), vec![EXECUTOR_VERSION_KEY.to_string()]);
        cache.no_further_reads(1).await;
        assert!(cache.writes().is_empty());
    }

    #[tokio::test]
    async fn unavailable_marker_falls_back_to_the_settings_default() {
        let cache = Arc::new(FakeCache::new(Some("\"__unavailable__\"")));
        let service = no_check(&cache);

        assert_eq!(service.latest_version(None).await.as_deref(), Some("1.0.0"));
        cache.no_further_reads(1).await;
        assert!(cache.writes().is_empty());
    }

    #[tokio::test]
    async fn empty_cached_value_is_a_miss_like_the_source_truthiness_check() {
        let cache = Arc::new(FakeCache::new(Some("\"\"")));
        let checker = Arc::new(FakeChecker::returning("2.0.20"));
        let service = service(&cache, checker.clone(), 300);

        assert_eq!(service.latest_version(None).await.as_deref(), Some("1.0.0"));
        cache.served_reads(2).await;
        assert_eq!(cache.keys(), vec![EXECUTOR_VERSION_KEY.to_string(); 2]);
        cache.served_writes(1).await;
        assert_eq!(checker.calls(), 1);
        assert_eq!(
            cache.writes(),
            vec![(
                EXECUTOR_VERSION_KEY.to_string(),
                "\"2.0.20\"".to_string(),
                300
            )]
        );
    }

    #[tokio::test]
    async fn a_cache_miss_falls_back_starts_one_refresh_and_writes_the_fetched_version() {
        let cache = Arc::new(FakeCache::new(None));
        let checker = Arc::new(FakeChecker::returning("2.0.20"));
        let service = service(&cache, checker.clone(), 300);

        assert_eq!(service.latest_version(None).await.as_deref(), Some("1.0.0"));
        cache.served_reads(2).await;
        assert_eq!(cache.keys(), vec![EXECUTOR_VERSION_KEY.to_string(); 2]);
        cache.no_further_reads(2).await;
        cache.served_writes(1).await;
        assert_eq!(checker.calls(), 1);
        assert_eq!(
            cache.writes(),
            vec![(
                EXECUTOR_VERSION_KEY.to_string(),
                "\"2.0.20\"".to_string(),
                300
            )]
        );
    }

    #[tokio::test]
    async fn a_cache_miss_threads_the_triggering_request_id_into_the_check() {
        // The source's `asyncio.create_task` copies the request context, so the
        // detached refresh issues its outbound check with the admitting
        // request's `X-Request-ID`.
        let cache = Arc::new(FakeCache::new(None));
        let checker = Arc::new(FakeChecker::returning("2.0.20"));
        let service = service(&cache, checker.clone(), 300);

        assert_eq!(
            service
                .latest_version(Some("wework-http-abc"))
                .await
                .as_deref(),
            Some("1.0.0")
        );
        cache.served_writes(1).await;
        assert_eq!(
            checker.request_ids(),
            vec![Some("wework-http-abc".to_string())]
        );
    }

    #[tokio::test]
    async fn a_failed_check_writes_the_unavailable_marker_with_the_failure_ttl() {
        let cache = Arc::new(FakeCache::new(None));
        let service = no_check(&cache);

        assert_eq!(service.latest_version(None).await.as_deref(), Some("1.0.0"));
        cache.served_writes(1).await;
        assert_eq!(
            cache.writes(),
            vec![(
                EXECUTOR_VERSION_KEY.to_string(),
                "\"__unavailable__\"".to_string(),
                EXECUTOR_VERSION_FAILURE_CACHE_TTL
            )]
        );
    }

    #[tokio::test]
    async fn a_present_value_after_the_re_read_skips_the_remote_check() {
        // The refresh re-read returns the version another caller wrote, so the
        // worker must not perform the remote check.
        let cache = Arc::new(FakeCache::new(Some("\"2.0.20\"")));
        let checker = Arc::new(FakeChecker::returning("9.9.9"));
        let service = service(&cache, checker.clone(), 300);

        assert_eq!(
            service.latest_version(None).await.as_deref(),
            Some("2.0.20")
        );
        cache.no_further_reads(1).await;
        assert_eq!(checker.calls(), 0);
        assert!(cache.writes().is_empty());
    }

    #[tokio::test]
    async fn misses_while_a_refresh_is_pending_are_dropped() {
        // Read 2 is the refresh's re-read: it stays in flight while the request
        // path keeps missing, so further refresh requests are coalesced
        // instead of queued behind it.
        let cache = Arc::new(FakeCache::new(None).block_read(2));
        let checker = Arc::new(FakeChecker::failing());
        let service = service(&cache, checker, 300);

        assert_eq!(service.latest_version(None).await.as_deref(), Some("1.0.0"));
        cache.served_reads(2).await;

        for _ in 0..3 {
            assert_eq!(service.latest_version(None).await.as_deref(), Some("1.0.0"));
        }

        // Read 1 is the first request, read 2 the refresh, reads 3-5 the three
        // request misses, and read 6 the single duplicate that fit in the
        // queue; the other two duplicates were dropped.
        cache.release();
        cache.served_reads(6).await;
        cache.no_further_reads(6).await;
    }

    #[test]
    fn registry_api_url_appends_the_binary_and_update_json() {
        // The configured registry root (`EXECUTOR_REGISTRY_URL`).
        assert_eq!(
            RegistryVersionChecker::build_api_url("https://registry.example.invalid/releases"),
            "https://registry.example.invalid/releases/wegent-executor-linux-amd64/update.json"
        );
        // An explicit `update.json`, and a binary-scoped URL, are used as-is.
        assert_eq!(
            RegistryVersionChecker::build_api_url(
                "https://registry.example.invalid/releases/update.json"
            ),
            "https://registry.example.invalid/releases/update.json"
        );
        assert_eq!(
            RegistryVersionChecker::build_api_url(
                "https://registry.example.invalid/releases/wegent-executor-linux-amd64"
            ),
            "https://registry.example.invalid/releases/wegent-executor-linux-amd64"
        );
    }

    #[test]
    fn cached_version_presence_follows_python_truthiness() {
        assert!(!cached_version_present(b"null"));
        assert!(!cached_version_present(b"\"\""));
        assert!(cached_version_present(b"\"2.0.20\""));
        assert!(cached_version_present(b"\"__unavailable__\""));
        assert!(!cached_version_present(b"0"));
        assert!(cached_version_present(b"1"));
    }
}
