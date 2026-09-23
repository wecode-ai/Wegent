//! The AIGC quota service client and response transform.
//!
//! Ported from the reference implementation's `src/wecode/quota.rs`
//! (`mod quota_service`), which mirrors `wecode/api/quota_endpoint_patch.py`:
//! an upstream POST with a 10-second total timeout carrying
//! `{"user_name": ...}`, followed by the `_transform_aigc_response` mapping.
//! Every transport failure, non-2xx status, non-object body, or body without
//! `user_quota` returns `None`, which the caller renders as the open-source
//! empty quota response.
//!
//! Successful results are cached per user in Redis for one hour. Values no
//! older than two minutes are returned directly; older values are returned
//! while a startup-owned mpsc worker refreshes them. A cache miss waits for
//! the upstream response because no stale value exists yet.
//!
//! The transform reads the upstream body as a JSON object rather than through
//! a typed struct, because the source uses `dict.get(key, default)`: the
//! default applies only when the key is **absent**, so an explicit upstream
//! `null` is echoed as `null`. A typed `Option` field cannot express that
//! distinction.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use brz_http::{Client, Endpoint, Response as HttpResponse};
use brz_redis::Redis;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use tokio::sync::mpsc;
use wegent_backend_rs::json_compat::OpaqueJson;

/// `AIGC_QUOTA_URL` in `wecode/api/quota_endpoint_patch.py`.
pub(super) const AIGC_QUOTA_URL: &str =
    "https://copilot.weibo.com/v1/wecode_quota/user_aigc_model_quota_detail";

/// Source `_wrap_quota_endpoint`: `timeout=10` seconds for the whole call.
const AIGC_QUOTA_TIMEOUT: Duration = Duration::from_secs(10);

/// Redis lifetime for a cached quota response.
const QUOTA_CACHE_TTL_SECONDS: u64 = 60 * 60;

/// Cached quota remains fresh for two minutes. Older values are returned
/// immediately while a refresh runs in the background.
const QUOTA_CACHE_FRESH_SECONDS: u64 = 2 * 60;

const QUOTA_CACHE_KEY_PREFIX: &str = "quota:aigc:v1:";

/// Refresh work is deliberately bounded and handled by one startup worker so
/// request handlers never spawn background tasks or overload the upstream.
const QUOTA_REFRESH_QUEUE_CAPACITY: usize = 256;

/// The POST body the source sends (`{"user_name": current_user.user_name}`).
#[derive(Serialize)]
struct QuotaRequest<'a> {
    user_name: &'a str,
}

/// The transformed payload consumed by the frontend.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct QuotaDetails {
    data: QuotaData,
    quota_source: String,
    status: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct QuotaData {
    // `quota`, `usage_rate`, and `user` are passed through exactly as the
    // upstream sent them, including an explicit null and any shape at all.
    quota: OpaqueJson,
    usage: Number,
    remaining: Number,
    usage_rate: OpaqueJson,
    user: OpaqueJson,
}

#[derive(Deserialize, Serialize)]
struct CachedQuota {
    fetched_at: u64,
    quota: QuotaDetails,
}

#[async_trait]
trait QuotaCache: Send + Sync {
    async fn get(&self, key: &str) -> Option<Vec<u8>>;
    async fn set(&self, key: &str, value: &[u8]);
}

struct RedisQuotaCache {
    redis: Option<brz_redis::RedisService>,
}

#[async_trait]
impl QuotaCache for RedisQuotaCache {
    async fn get(&self, key: &str) -> Option<Vec<u8>> {
        let redis = self.redis.as_ref()?;
        match redis.get(key).await {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, key, "AIGC quota cache read failed");
                None
            }
        }
    }

    async fn set(&self, key: &str, value: &[u8]) {
        let Some(redis) = self.redis.as_ref() else {
            return;
        };
        if let Err(error) = redis.set_ex(key, QUOTA_CACHE_TTL_SECONDS, value).await {
            tracing::warn!(%error, key, "AIGC quota cache write failed");
        }
    }
}

/// Cached client for the internal AIGC quota service.
#[derive(Clone)]
pub(crate) struct AigcQuotaService {
    client: AigcQuotaClient,
    refresh_tx: mpsc::Sender<String>,
}

impl AigcQuotaService {
    pub(super) fn new(endpoint: Endpoint, redis: Option<brz_redis::RedisService>) -> Self {
        Self::with_cache(endpoint, Arc::new(RedisQuotaCache { redis }))
    }

    fn with_cache(endpoint: Endpoint, cache: Arc<dyn QuotaCache>) -> Self {
        let client = AigcQuotaClient { endpoint, cache };
        let (refresh_tx, refresh_rx) = mpsc::channel(QUOTA_REFRESH_QUEUE_CAPACITY);
        tokio::spawn(run_refresh_worker(client.clone(), refresh_rx));
        Self { client, refresh_tx }
    }

    /// Returns a fresh or stale cached quota when available. A cache miss
    /// waits for the upstream service because there is no value to return.
    pub(super) async fn fetch(&self, user_name: &str) -> Option<QuotaDetails> {
        let key = quota_cache_key(user_name);
        if let Some(cached) = self.client.cached(&key).await {
            if cache_is_fresh(cached.fetched_at, unix_seconds()) {
                return Some(cached.quota);
            }

            if let Err(error) = self.refresh_tx.try_send(user_name.to_owned()) {
                tracing::warn!(%error, user_name, "AIGC quota refresh enqueue failed");
            }
            return Some(cached.quota);
        }

        self.client.refresh(user_name).await
    }
}

#[derive(Clone)]
struct AigcQuotaClient {
    endpoint: Endpoint,
    cache: Arc<dyn QuotaCache>,
}

impl AigcQuotaClient {
    async fn cached(&self, key: &str) -> Option<CachedQuota> {
        let payload = self.cache.get(key).await?;
        match serde_json::from_slice(&payload) {
            Ok(cached) => Some(cached),
            Err(error) => {
                tracing::warn!(%error, key, "AIGC quota cache decode failed");
                None
            }
        }
    }

    async fn refresh(&self, user_name: &str) -> Option<QuotaDetails> {
        let quota = fetch_aigc_quota(&self.endpoint, user_name).await?;
        let cached = CachedQuota {
            fetched_at: unix_seconds(),
            quota: quota.clone(),
        };
        match serde_json::to_vec(&cached) {
            Ok(payload) => {
                self.cache.set(&quota_cache_key(user_name), &payload).await;
            }
            Err(error) => {
                tracing::warn!(%error, user_name, "AIGC quota cache encode failed");
            }
        }
        Some(quota)
    }
}

async fn run_refresh_worker(client: AigcQuotaClient, mut refresh_rx: mpsc::Receiver<String>) {
    while let Some(user_name) = refresh_rx.recv().await {
        let _ = client.refresh(&user_name).await;
    }
}

fn quota_cache_key(user_name: &str) -> String {
    format!("{QUOTA_CACHE_KEY_PREFIX}{user_name}")
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cache_is_fresh(fetched_at: u64, now: u64) -> bool {
    now.saturating_sub(fetched_at) <= QUOTA_CACHE_FRESH_SECONDS
}

/// Builds the retained AIGC quota endpoint for the process lifetime.
///
/// The source creates a fresh `httpx.AsyncClient()` per request; the target
/// keeps one Breeze client with the same transport policy (one connect+read
/// window bounded by the request timeout) and one stable endpoint, which is
/// the client-ownership contract of the platform HTTP capability.
///
/// # Errors
///
/// Returns an error when the client cannot be built or `quota_url` is not a
/// valid URL.
pub(super) fn build_endpoint(quota_url: &str) -> brz_http::Result<Endpoint> {
    let client = Client::builder()
        // httpx `timeout=10` applies the same deadline to every phase
        // (connect, read, write, pool), so the connect phase gets the full
        // 10s rather than httpx's 5s default. A shorter connect timeout would
        // abort slow connects the source accepts.
        .connect_timeout(AIGC_QUOTA_TIMEOUT)
        .read_timeout(AIGC_QUOTA_TIMEOUT)
        .timeout(AIGC_QUOTA_TIMEOUT)
        .build()?;
    client.endpoint_named(quota_url, AIGC_QUOTA_URL)
}

/// Fetches and transforms the user's AIGC quota.
///
/// Returns `None` for every condition the source patch answers with the
/// open-source empty response.
pub(super) async fn fetch_aigc_quota(endpoint: &Endpoint, user_name: &str) -> Option<QuotaDetails> {
    let response: HttpResponse = endpoint
        .post()
        .json(&QuotaRequest { user_name })
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, user_name, "AIGC quota service request failed");
        })
        .ok()?;

    // `resp.raise_for_status()`: an HTTP error status is a fallback path,
    // checked before the body is read.
    let status = response.status();
    if !status.is_success() {
        tracing::warn!(%status, user_name, "AIGC quota service returned error status");
        return None;
    }

    let body = response
        .bytes()
        .await
        .map_err(|error| {
            tracing::warn!(%error, user_name, "AIGC quota response body read failed");
        })
        .ok()?;
    parse_aigc_quota_response(&body, user_name)
}

/// Applies the patch's response checks and transform.
///
/// The body must decode to a JSON object that carries `user_quota`, and that
/// value must be usable in the subtraction the source performs. Anything else
/// takes the fallback path, matching the wrapper's `except Exception`.
fn parse_aigc_quota_response(body: &[u8], user_name: &str) -> Option<QuotaDetails> {
    let raw: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, user_name, "AIGC quota response body decode failed");
            return None;
        }
    };
    // `isinstance(raw, dict)`
    let Value::Object(raw) = raw else {
        tracing::warn!(user_name, "Unexpected AIGC quota response");
        return None;
    };
    // `"user_quota" not in raw`
    let Some(user_quota) = raw.get("user_quota") else {
        tracing::warn!(user_name, "Unexpected AIGC quota response");
        return None;
    };
    transform_aigc_response(&raw, user_quota)
}

/// Applies `_transform_aigc_response` to a validated upstream object.
fn transform_aigc_response(raw: &Map<String, Value>, user_quota: &Value) -> Option<QuotaDetails> {
    // `user_quota - user_usage` runs inside the wrapper's `try`, so a
    // non-numeric operand is a fallback rather than an error response.
    let quota_number = python_number(user_quota)?;
    let usage_number = match raw.get("user_usage") {
        Some(value) => python_number(value)?,
        // `raw.get("user_usage", 0)`: an absent key defaults to the int 0.
        None => Number::from(0),
    };

    // Python `round(user_usage, 2)` returns an int for an int input, and the
    // quota-minus-usage subtraction preserves int operands, so integer
    // upstream values render as `0`, never `0.0`.
    let usage = round2_like_python(usage_number.clone());
    let remaining = round2_like_python(sub_like_python(&quota_number, &usage_number));
    Some(QuotaDetails {
        data: QuotaData {
            quota: OpaqueJson::from_serializable(user_quota),
            usage,
            remaining,
            usage_rate: passthrough(raw.get("user_usage_rate"), 0),
            user: passthrough(raw.get("username"), ""),
        },
        quota_source: "AIGC".to_owned(),
        status: "success".to_owned(),
    })
}

/// `dict.get(key, default)`: the default applies only when the key is absent,
/// so a present `null` is echoed as `null` rather than replaced.
fn passthrough(value: Option<&Value>, default: impl serde::Serialize) -> OpaqueJson {
    match value {
        Some(value) => OpaqueJson::from_serializable(value),
        None => OpaqueJson::from_serializable(default),
    }
}

/// The number Python arithmetic would use for this operand.
///
/// A JSON number is used as-is, keeping its int or float representation. A
/// `bool` is an `int` subclass in Python, so `True - 0` is `1` and
/// `round(True, 2)` is `1`; it maps to `1`/`0` accordingly. Every other JSON
/// type raises `TypeError` in the source, which falls back.
fn python_number(value: &Value) -> Option<Number> {
    match value {
        Value::Number(number) => Some(number.clone()),
        Value::Bool(flag) => Some(Number::from(u8::from(*flag))),
        _ => None,
    }
}

/// Python `round(x, 2)` on an int returns the same int; on a float it returns a
/// float correctly rounded (half-even on the exact binary value) to two
/// decimals. Rust's float formatting implements the same correct rounding, so
/// format and parse back. `Number::as_i64` is representation-based, so an
/// integral float such as `1.0` still takes the float path, matching
/// `json.loads("1.0")` yielding a Python float.
fn round2_like_python(number: Number) -> Number {
    if let Some(int) = number.as_i64() {
        return Number::from(int);
    }
    let Some(float) = number.as_f64() else {
        return number;
    };
    format!("{float:.2}")
        .parse::<f64>()
        .ok()
        .and_then(Number::from_f64)
        .unwrap_or_else(|| Number::from(0))
}

/// Python `user_quota - user_usage`: int operands stay int; any float operand
/// promotes the result to float.
fn sub_like_python(a: &Number, b: &Number) -> Number {
    if let (Some(a_int), Some(b_int)) = (a.as_i64(), b.as_i64())
        && let Some(diff) = a_int.checked_sub(b_int)
    {
        return Number::from(diff);
    }
    let diff = a.as_f64().unwrap_or(0.0) - b.as_f64().unwrap_or(0.0);
    Number::from_f64(diff).unwrap_or_else(|| Number::from(0))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Notify;

    use super::*;

    #[derive(Default)]
    struct FakeQuotaCache {
        values: Mutex<HashMap<String, Vec<u8>>>,
        writes: AtomicUsize,
        written: Notify,
    }

    impl FakeQuotaCache {
        fn seed(&self, key: &str, value: Vec<u8>) {
            self.values
                .lock()
                .expect("cache mutex")
                .insert(key.to_owned(), value);
        }

        fn value(&self, key: &str) -> Option<Vec<u8>> {
            self.values.lock().expect("cache mutex").get(key).cloned()
        }
    }

    #[async_trait::async_trait]
    impl QuotaCache for FakeQuotaCache {
        async fn get(&self, key: &str) -> Option<Vec<u8>> {
            self.value(key)
        }

        async fn set(&self, key: &str, value: &[u8]) {
            self.values
                .lock()
                .expect("cache mutex")
                .insert(key.to_owned(), value.to_vec());
            self.writes.fetch_add(1, Ordering::SeqCst);
            self.written.notify_one();
        }
    }

    fn quota(body: &str) -> QuotaDetails {
        parse_aigc_quota_response(body.as_bytes(), "test").expect("valid quota")
    }

    fn cached_quota(body: &str, fetched_at: u64) -> Vec<u8> {
        serde_json::to_vec(&CachedQuota {
            fetched_at,
            quota: quota(body),
        })
        .expect("cached quota serializes")
    }

    fn quota_value(quota: QuotaDetails) -> Value {
        serde_json::to_value(quota).expect("quota serializes")
    }

    /// The serialized transform output for a raw upstream body.
    fn transformed(body: &str) -> Value {
        serde_json::to_value(
            parse_aigc_quota_response(body.as_bytes(), "test").expect("valid upstream response"),
        )
        .expect("transform serializes")
    }

    /// The serialized representation of one field of the transform output.
    fn rendered(body: &str, pointer: &str) -> String {
        let value = transformed(body)
            .pointer(pointer)
            .expect("field is present")
            .clone();
        serde_json::to_string(&value).expect("serializable")
    }

    /// A full HTTP/1.1 response with the given status line and JSON body.
    fn http_response(status_line: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Serves exactly one HTTP request on a loopback port and records it.
    ///
    /// Returns the base URL to point an `Endpoint` at and a receiver that
    /// yields the raw request bytes once the client has sent them. This is a
    /// real socket and a real HTTP exchange; only the response is canned.
    fn serve_once(response: String) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("read local address");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept the request");
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            // Read until the header block is complete, then the declared body.
            let head_end = loop {
                let read = stream.read(&mut buffer).expect("read the request");
                request.extend_from_slice(&buffer[..read]);
                if let Some(position) = head_end(&request) {
                    break position;
                }
                assert!(read > 0, "connection closed before the headers ended");
            };
            let head = String::from_utf8_lossy(&request[..head_end]).into_owned();
            let body_end = head_end + content_length(&head);
            while request.len() < body_end {
                let read = stream.read(&mut buffer).expect("read the request body");
                assert!(read > 0, "connection closed before the body ended");
                request.extend_from_slice(&buffer[..read]);
            }
            sender
                .send(String::from_utf8_lossy(&request).into_owned())
                .ok();
            stream
                .write_all(response.as_bytes())
                .expect("write the response");
            stream.flush().ok();
        });
        (format!("http://{address}"), receiver)
    }

    /// The byte offset just past the request's header block.
    fn head_end(request: &[u8]) -> Option<usize> {
        request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
    }

    /// The request's declared body length (absent means none).
    fn content_length(head: &str) -> usize {
        for line in head.lines() {
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                return value.trim().parse().unwrap_or(0);
            }
        }
        0
    }

    /// The upstream path `AIGC_QUOTA_URL` resolves to.
    const AIGC_QUOTA_PATH: &str = "/v1/wecode_quota/user_aigc_model_quota_detail";

    /// Builds an endpoint pointed at a test server.
    fn test_endpoint(base: &str) -> Endpoint {
        build_endpoint(&format!("{base}{AIGC_QUOTA_PATH}")).expect("valid quota URL")
    }

    #[tokio::test]
    async fn returns_a_fresh_user_cache_without_calling_upstream() {
        let cache = Arc::new(FakeQuotaCache::default());
        cache.seed(
            &quota_cache_key("sifang"),
            cached_quota(
                r#"{"user_quota": 100, "user_usage": 25, "username": "sifang"}"#,
                unix_seconds(),
            ),
        );
        let service =
            AigcQuotaService::with_cache(test_endpoint("http://127.0.0.1:1"), cache.clone());

        let result = service.fetch("sifang").await.expect("cached quota");

        assert_eq!(quota_value(result)["data"]["remaining"], 75);
        assert_eq!(cache.writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_cache_miss_loads_upstream_synchronously_and_caches_the_result() {
        let (base, _requests) = serve_once(http_response(
            "200 OK",
            r#"{"user_quota": 100, "user_usage": 40, "username": "yansheng3"}"#,
        ));
        let cache = Arc::new(FakeQuotaCache::default());
        let service = AigcQuotaService::with_cache(test_endpoint(&base), cache.clone());

        let result = service.fetch("yansheng3").await.expect("upstream quota");

        assert_eq!(quota_value(result)["data"]["remaining"], 60);
        assert_eq!(cache.writes.load(Ordering::SeqCst), 1);
        let stored: CachedQuota = serde_json::from_slice(
            &cache
                .value(&quota_cache_key("yansheng3"))
                .expect("cache value"),
        )
        .expect("valid cached quota");
        assert_eq!(quota_value(stored.quota)["data"]["remaining"], 60);
    }

    #[tokio::test]
    async fn returns_stale_cache_and_queues_a_refresh() {
        let (base, _requests) = serve_once(http_response(
            "200 OK",
            r#"{"user_quota": 100, "user_usage": 45, "username": "sifang"}"#,
        ));
        let cache = Arc::new(FakeQuotaCache::default());
        cache.seed(
            &quota_cache_key("sifang"),
            cached_quota(
                r#"{"user_quota": 100, "user_usage": 20, "username": "sifang"}"#,
                unix_seconds() - QUOTA_CACHE_FRESH_SECONDS - 1,
            ),
        );
        let service = AigcQuotaService::with_cache(test_endpoint(&base), cache.clone());

        let result = service.fetch("sifang").await.expect("stale quota");

        assert_eq!(quota_value(result)["data"]["remaining"], 80);
        tokio::time::timeout(Duration::from_secs(2), cache.written.notified())
            .await
            .expect("background refresh writes the cache");
        let stored: CachedQuota = serde_json::from_slice(
            &cache
                .value(&quota_cache_key("sifang"))
                .expect("refreshed cache value"),
        )
        .expect("valid refreshed quota");
        assert_eq!(quota_value(stored.quota)["data"]["remaining"], 55);
    }

    #[tokio::test]
    async fn a_failed_background_refresh_keeps_the_stale_cache() {
        let (base, requests) = serve_once(http_response("500 Internal Server Error", "boom"));
        let cache = Arc::new(FakeQuotaCache::default());
        let stale = cached_quota(
            r#"{"user_quota": 100, "user_usage": 20, "username": "sifang"}"#,
            unix_seconds() - QUOTA_CACHE_FRESH_SECONDS - 1,
        );
        cache.seed(&quota_cache_key("sifang"), stale.clone());
        let service = AigcQuotaService::with_cache(test_endpoint(&base), cache.clone());

        let result = service.fetch("sifang").await.expect("stale quota");
        let request_received = tokio::task::spawn_blocking(move || {
            requests
                .recv_timeout(Duration::from_secs(2))
                .expect("refresh request")
        })
        .await
        .expect("request observer");

        assert!(request_received.ends_with(r#"{"user_name":"sifang"}"#));
        assert_eq!(quota_value(result)["data"]["remaining"], 80);
        assert_eq!(cache.value(&quota_cache_key("sifang")), Some(stale));
        assert_eq!(cache.writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_closed_refresh_queue_still_returns_the_stale_cache() {
        let cache = Arc::new(FakeQuotaCache::default());
        cache.seed(
            &quota_cache_key("sifang"),
            cached_quota(
                r#"{"user_quota": 100, "user_usage": 20, "username": "sifang"}"#,
                unix_seconds() - QUOTA_CACHE_FRESH_SECONDS - 1,
            ),
        );
        let (refresh_tx, refresh_rx) = mpsc::channel(1);
        drop(refresh_rx);
        let service = AigcQuotaService {
            client: AigcQuotaClient {
                endpoint: test_endpoint("http://127.0.0.1:1"),
                cache,
            },
            refresh_tx,
        };

        let result = service.fetch("sifang").await.expect("stale quota");

        assert_eq!(quota_value(result)["data"]["remaining"], 80);
    }

    #[tokio::test]
    async fn no_redis_client_falls_back_to_a_synchronous_upstream_load() {
        let (base, _requests) = serve_once(http_response(
            "200 OK",
            r#"{"user_quota": 50, "user_usage": 5, "username": "sifang"}"#,
        ));
        let service = AigcQuotaService::new(test_endpoint(&base), None);

        let result = service.fetch("sifang").await.expect("upstream quota");

        assert_eq!(quota_value(result)["data"]["remaining"], 45);
    }

    #[test]
    fn cache_keys_are_isolated_by_user() {
        assert_eq!(quota_cache_key("sifang"), "quota:aigc:v1:sifang");
        assert_eq!(quota_cache_key("yansheng3"), "quota:aigc:v1:yansheng3");
    }

    #[tokio::test]
    async fn posts_the_source_request_and_transforms_the_response() {
        let (base, requests) = serve_once(http_response(
            "200 OK",
            r#"{"user_quota": 100, "user_usage": 33.336,
                "user_usage_rate": 0.33, "username": "liting9"}"#,
        ));

        let details = fetch_aigc_quota(&test_endpoint(&base), "liting9")
            .await
            .expect("a well-formed upstream response transforms");

        let request = requests
            .recv_timeout(Duration::from_secs(5))
            .expect("the server received a request");
        assert!(
            request.starts_with(&format!("POST {AIGC_QUOTA_PATH} HTTP/1.1\r\n")),
            "unexpected request line: {request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("content-type: application/json"),
            "missing JSON content type: {request}"
        );
        // The source sends `{"user_name": current_user.user_name}`.
        assert!(
            request.ends_with(r#"{"user_name":"liting9"}"#),
            "unexpected request body: {request}"
        );

        let body = serde_json::to_value(details).expect("transform serializes");
        assert_eq!(body["quota_source"], "AIGC");
        assert_eq!(body["status"], "success");
        assert_eq!(body["data"]["quota"], 100);
        assert_eq!(body["data"]["usage"], 33.34);
        assert_eq!(body["data"]["remaining"], 66.66);
    }

    #[tokio::test]
    async fn falls_back_when_the_service_returns_an_error_status() {
        let (base, _requests) = serve_once(http_response("500 Internal Server Error", "boom"));
        assert!(
            fetch_aigc_quota(&test_endpoint(&base), "liting9")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn falls_back_when_the_service_returns_a_non_object_body() {
        let (base, _requests) = serve_once(http_response("200 OK", "[]"));
        assert!(
            fetch_aigc_quota(&test_endpoint(&base), "liting9")
                .await
                .is_none()
        );
    }

    #[test]
    fn transforms_aigc_response_fields() {
        let transformed = transformed(
            r#"{"user_quota": 100, "user_usage": 33.336,
                "user_usage_rate": 0.33, "username": "liting9"}"#,
        );
        assert_eq!(transformed["quota_source"], "AIGC");
        assert_eq!(transformed["status"], "success");
        assert_eq!(transformed["data"]["quota"], 100);
        assert_eq!(transformed["data"]["usage"], 33.34);
        assert_eq!(transformed["data"]["remaining"], 66.66);
        assert_eq!(transformed["data"]["usage_rate"], 0.33);
        assert_eq!(transformed["data"]["user"], "liting9");
    }

    #[test]
    fn applies_source_defaults_for_absent_fields() {
        let body = r#"{"user_quota": 5}"#;
        assert_eq!(rendered(body, "/data/quota"), "5");
        // An absent `user_usage` defaults to the int `0`, so round/subtract
        // keep ints.
        assert_eq!(rendered(body, "/data/usage"), "0");
        assert_eq!(rendered(body, "/data/remaining"), "5");
        assert_eq!(rendered(body, "/data/usage_rate"), "0");
        assert_eq!(rendered(body, "/data/user"), "\"\"");
    }

    #[test]
    fn echoes_an_explicit_upstream_null() {
        // `dict.get(key, default)` returns the stored `None`, not the default,
        // when the key exists; the source therefore emits `null`.
        let body = r#"{"user_quota": 5, "user_usage_rate": null, "username": null}"#;
        assert_eq!(rendered(body, "/data/usage_rate"), "null");
        assert_eq!(rendered(body, "/data/user"), "null");
    }

    #[test]
    fn integer_quota_stays_integer_like_python_passthrough() {
        let body = r#"{"user_quota": 286, "user_usage": 277.47}"#;
        assert_eq!(rendered(body, "/data/quota"), "286");
        assert_eq!(transformed(body)["data"]["usage"], 277.47);
        assert_eq!(transformed(body)["data"]["remaining"], 8.53);
    }

    #[test]
    fn float_quota_stays_float() {
        let body = r#"{"user_quota": 286.5, "user_usage": 1.0}"#;
        assert_eq!(rendered(body, "/data/quota"), "286.5");
        // Float upstream values keep float output for usage/remaining.
        assert_eq!(rendered(body, "/data/usage"), "1.0");
        assert_eq!(rendered(body, "/data/remaining"), "285.5");
    }

    #[test]
    fn integer_usage_and_remaining_stay_integers_like_python() {
        let zero = r#"{"user_quota": 0, "user_usage": 0}"#;
        assert_eq!(rendered(zero, "/data/usage"), "0");
        assert_eq!(rendered(zero, "/data/remaining"), "0");

        let ints = r#"{"user_quota": 5, "user_usage": 2}"#;
        assert_eq!(rendered(ints, "/data/remaining"), "3");

        // A mixed int quota / float usage promotes remaining to float.
        let mixed = r#"{"user_quota": 5, "user_usage": 2.25}"#;
        assert_eq!(rendered(mixed, "/data/remaining"), "2.75");
    }

    #[test]
    fn boolean_operands_keep_python_int_arithmetic() {
        // A Python `bool` is an `int` subclass, so these are valid operands
        // and the passthrough still emits the original `true`.
        let body = r#"{"user_quota": true, "user_usage": false}"#;
        assert_eq!(rendered(body, "/data/quota"), "true");
        assert_eq!(rendered(body, "/data/usage"), "0");
        assert_eq!(rendered(body, "/data/remaining"), "1");
    }

    #[test]
    fn opaque_fields_echo_arbitrary_upstream_json() {
        let body = r#"{"user_quota": 1, "user_usage_rate": {"b": 1, "a": [1, 2]}}"#;
        assert_eq!(rendered(body, "/data/usage_rate"), "{\"b\":1,\"a\":[1,2]}");
    }

    #[test]
    fn falls_back_for_bodies_without_user_quota() {
        // A non-object, an empty object, and an object missing the key all
        // take the source's fallback path.
        for body in [
            "[]",
            "\"x\"",
            "5",
            "true",
            "null",
            "{}",
            r#"{"user_usage": 1}"#,
        ] {
            assert!(
                parse_aigc_quota_response(body.as_bytes(), "test").is_none(),
                "body {body} must fall back"
            );
        }
    }

    #[test]
    fn falls_back_for_invalid_json() {
        assert!(parse_aigc_quota_response(b"not json", "test").is_none());
        assert!(parse_aigc_quota_response(b"", "test").is_none());
    }

    #[test]
    fn falls_back_when_an_operand_is_not_arithmetic() {
        // Python raises inside the transform and the wrapper then falls back.
        for body in [
            r#"{"user_quota": "abc"}"#,
            r#"{"user_quota": 1, "user_usage": "abc"}"#,
            r#"{"user_quota": null}"#,
            r#"{"user_quota": []}"#,
        ] {
            assert!(
                parse_aigc_quota_response(body.as_bytes(), "test").is_none(),
                "body {body} must fall back"
            );
        }
    }

    #[test]
    fn round2_matches_python_rounding() {
        // Compare the serialized representation, which is what the response
        // carries, rather than raw floats.
        let round_of = |value: f64| {
            round2_like_python(Number::from_f64(value).expect("finite float")).to_string()
        };
        assert_eq!(round_of(33.336), "33.34");
        assert_eq!(round_of(2.675), "2.67");
        assert_eq!(round_of(2.5), "2.5");
        assert_eq!(round_of(3.5), "3.5");
        assert_eq!(round_of(0.125), "0.12");
        assert_eq!(round_of(0.135), "0.14");
        assert_eq!(round_of(0.0), "0.0");
        assert_eq!(round_of(-1.005), "-1.0");
    }
}
