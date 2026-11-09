#![cfg(test)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brz_redis::{
    EncodeRedisArg, EncodeRedisArgs, ErrorKind, FromRedisBulk, Redis, RedisBytes, RedisError,
    RedisResult, RedisValues,
};

use super::*;

/// One canned `GET` outcome for the disconnect gate.
#[derive(Clone, Copy)]
enum GateGet {
    Miss,
    Hit(&'static str),
    Fail,
}

/// A `Redis` client answering `GET` from a scripted outcome list.
struct GateRedis {
    outcomes: Mutex<Vec<GateGet>>,
    reads: AtomicUsize,
}

impl GateRedis {
    fn new(outcomes: Vec<GateGet>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes),
            reads: AtomicUsize::new(0),
        }
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl Redis for GateRedis {
    async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let outcome = if self.outcomes.lock().unwrap().is_empty() {
            GateGet::Miss
        } else {
            self.outcomes.lock().unwrap().remove(0)
        };
        match outcome {
            GateGet::Miss => Ok(None),
            GateGet::Hit(bytes) => {
                R::from_redis_bulk(RedisBytes::from(bytes.as_bytes().to_vec())).map(Some)
            }
            GateGet::Fail => Err(RedisError::new(ErrorKind::ClientError, "stub read failure")),
        }
    }

    async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        Ok(())
    }

    async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Err(RedisError::new(
            ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

/// A `Redis` stub that records the identity-lock commands it serves.
#[derive(Default)]
struct LockRedis {
    acquired: bool,
    events: Arc<Mutex<Vec<&'static str>>>,
}

impl Redis for LockRedis {
    async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        panic!("the identity lock never reads")
    }

    async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        panic!("the identity lock uses SET ... NX")
    }

    async fn set_with<K, V>(
        &self,
        _key: K,
        _value: V,
        _options: brz_redis::SetOptions,
    ) -> RedisResult<bool>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.events.lock().unwrap().push("set");
        Ok(self.acquired)
    }

    async fn evalsha<D, K, A, R>(&self, _digest: D, _keys: K, _arguments: A) -> RedisResult<R>
    where
        D: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        R: brz_redis::FromRedisValue + Send,
    {
        self.events.lock().unwrap().push("release");
        R::from_redis_value(&brz_redis::Value::Int(1))
    }

    async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        Err(RedisError::new(
            ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

#[tokio::test]
async fn the_app_identity_lock_wraps_the_body_and_releases_before_the_ack() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let redis = LockRedis {
        acquired: true,
        events: Arc::clone(&events),
    };
    let body_events = Arc::clone(&events);
    let reply = with_identity_lock(&redis, 9, || async move {
        body_events.lock().unwrap().push("body");
        Ok(Reply::payload(json!({"success": true})))
    })
    .await
    .expect("the handler reply");
    // Acquire → body → release, so the release precedes the returned ACK.
    assert_eq!(*events.lock().unwrap(), vec!["set", "body", "release"]);
    let _ = reply;
}

#[tokio::test]
async fn the_error_path_still_runs_under_the_lock_and_releases() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let redis = LockRedis {
        acquired: true,
        events: Arc::clone(&events),
    };
    let body_events = Arc::clone(&events);
    let reply = with_identity_lock(&redis, 9, || async move {
        body_events.lock().unwrap().push("body");
        Ok(Reply::payload(error_ack("Invalid payload: bad")))
    })
    .await
    .expect("the handler reply");
    // The body's error ACK is produced under the lock; the release still
    // precedes the returned ACK.
    assert_eq!(*events.lock().unwrap(), vec!["set", "body", "release"]);
    let _ = reply;
}

#[tokio::test(start_paused = true)]
async fn an_unavailable_lock_never_runs_the_registration_body() {
    // `LockError` from the blocking budget is the source's unavailable branch;
    // the session handler (and its payload validation) never runs.
    let events = Arc::new(Mutex::new(Vec::new()));
    let redis = LockRedis {
        acquired: false,
        events: Arc::clone(&events),
    };
    let body_events = Arc::clone(&events);
    let reply = with_identity_lock(&redis, 9, || async move {
        body_events.lock().unwrap().push("body");
        Ok(Reply::payload(json!({"success": true})))
    })
    .await
    .expect("the handler reply");
    let _ = reply;
    let events = events.lock().unwrap().clone();
    // redis-py retries until its blocking budget expires; the body never runs.
    assert!(!events.is_empty());
    assert!(events.iter().all(|event| *event == "set"), "{events:?}");
}

const OWN_SOCKET: &str = r#"{"socket_id":"mine","status":"online"}"#;
const STALE_SOCKET: &str = r#"{"socket_id":"other","status":"online"}"#;

async fn permitted(redis: &GateRedis) -> bool {
    online_cleanup_permitted(redis, 7, "device-1", "mine", Duration::ZERO).await
}

#[tokio::test]
async fn the_first_read_failure_never_reaches_the_offline_delete() {
    // `get_or_raise` raises; `on_disconnect` skips the rest of the cleanup, so
    // no grace sleep, no second read and no `DEL`.
    let redis = GateRedis::new(vec![GateGet::Fail]);
    assert!(!permitted(&redis).await);
    assert_eq!(redis.reads(), 1);
}

#[tokio::test]
async fn the_second_read_failure_never_reaches_the_offline_delete() {
    let redis = GateRedis::new(vec![GateGet::Hit(OWN_SOCKET), GateGet::Fail]);
    assert!(!permitted(&redis).await);
    assert_eq!(redis.reads(), 2);
}

#[tokio::test]
async fn a_cache_miss_keeps_the_original_cleanup_flow() {
    // A missing key is not a read failure: the source's `get_or_raise` returns
    // `None`, the stale guard does not fire, and the delete proceeds.
    let redis = GateRedis::new(vec![GateGet::Miss, GateGet::Miss]);
    assert!(permitted(&redis).await);
    assert_eq!(redis.reads(), 2);
}

#[tokio::test]
async fn a_live_socket_id_keeps_the_original_cleanup_flow() {
    let redis = GateRedis::new(vec![GateGet::Hit(OWN_SOCKET), GateGet::Hit(OWN_SOCKET)]);
    assert!(permitted(&redis).await);
}

#[tokio::test]
async fn a_stale_first_or_second_read_stops_the_cleanup() {
    let first = GateRedis::new(vec![GateGet::Hit(STALE_SOCKET), GateGet::Hit(OWN_SOCKET)]);
    assert!(!permitted(&first).await);
    assert_eq!(first.reads(), 1);

    let second = GateRedis::new(vec![GateGet::Hit(OWN_SOCKET), GateGet::Hit(STALE_SOCKET)]);
    assert!(!permitted(&second).await);
    assert_eq!(second.reads(), 2);
}

#[tokio::test]
async fn an_undecodable_document_skips_the_cleanup() {
    // The source indexes a non-JSON payload as a dict and raises.
    let redis = GateRedis::new(vec![GateGet::Hit("not-json"), GateGet::Hit(OWN_SOCKET)]);
    assert!(!permitted(&redis).await);
    assert_eq!(redis.reads(), 1);
}

#[test]
fn stale_online_state_matches_the_source_truthiness_and_types() {
    // Not stale: a missing document, a falsy document, a missing or falsy
    // `socket_id`, or the same string.
    for online in [
        None,
        Some(json!({})),
        Some(Value::Null),
        Some(json!(0)),
        Some(json!(false)),
        Some(json!([])),
        Some(json!({"socket_id": null})),
        Some(json!({"socket_id": ""})),
        Some(json!({"socket_id": 0})),
        Some(json!({"status": "online"})),
    ] {
        assert_eq!(
            stale_online_state(online.clone(), "mine"),
            Ok(false),
            "{online:?}"
        );
    }
    let own: Value = serde_json::from_str(OWN_SOCKET).unwrap();
    assert_eq!(stale_online_state(Some(own), "mine"), Ok(false));
    // Stale: another string, or any truthy non-string value, which can never
    // equal the socket-id string.
    let stale: Value = serde_json::from_str(STALE_SOCKET).unwrap();
    assert_eq!(stale_online_state(Some(stale), "mine"), Ok(true));
    for socket_id in [json!(5), json!(true), json!([1]), json!({"a": 1})] {
        assert_eq!(
            stale_online_state(Some(json!({"socket_id": socket_id})), "mine"),
            Ok(true),
            "{socket_id:?}"
        );
    }
    // A truthy non-dict document raises on `.get(...)` in the source.
    for online in [json!("text"), json!(true), json!([1])] {
        assert_eq!(
            stale_online_state(Some(online.clone()), "mine"),
            Err(()),
            "{online:?}"
        );
    }
}

#[tokio::test]
async fn a_truthy_non_dict_on_either_read_skips_the_cleanup() {
    for online in [json!("text"), json!(true), json!([1])] {
        let first = GateRedis::new(vec![GateGet::Hit(Box::leak(
            online.to_string().into_boxed_str(),
        ))]);
        assert!(!permitted(&first).await, "{online:?}");
        assert_eq!(first.reads(), 1, "{online:?}");

        let second = GateRedis::new(vec![
            GateGet::Hit(OWN_SOCKET),
            GateGet::Hit(Box::leak(online.to_string().into_boxed_str())),
        ]);
        assert!(!permitted(&second).await, "{online:?}");
        assert_eq!(second.reads(), 2, "{online:?}");
    }
}

#[tokio::test]
async fn a_truthy_non_string_socket_id_on_either_read_skips_the_cleanup() {
    for socket_id in [json!(5), json!(true), json!([1])] {
        let document: &'static str =
            Box::leak(json!({"socket_id": socket_id}).to_string().into_boxed_str());
        let first = GateRedis::new(vec![GateGet::Hit(document)]);
        assert!(!permitted(&first).await, "{socket_id:?}");
        assert_eq!(first.reads(), 1, "{socket_id:?}");

        let second = GateRedis::new(vec![GateGet::Hit(OWN_SOCKET), GateGet::Hit(document)]);
        assert!(!permitted(&second).await, "{socket_id:?}");
        assert_eq!(second.reads(), 2, "{socket_id:?}");
    }
}

#[test]
fn registration_fingerprints_trim_the_source_fields() {
    let payload = RegisterPayload::parse(&json!({
        "device_id": "d-1",
        "name": "  executor  ",
        "bind_shell": "openclaw"
    }))
    .unwrap();
    let fingerprint = registration_fingerprint(&payload, Some(" 127.0.0.1 "), None, Some(17888));
    assert_eq!(fingerprint.display_name, "executor");
    assert_eq!(fingerprint.client_ip, "127.0.0.1");
    assert_eq!(fingerprint.bind_shell, "openclaw");
    assert_eq!(fingerprint.runtime_transfer_port, Some(17888));
    assert_eq!(fingerprint.runtime_instance_id, "");
}
