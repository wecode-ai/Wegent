// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Real Redis coverage. CI supplies its existing disposable loopback service.

use super::*;
use crate::internal_callback::event::EventType;
use brz_redis::{
    Cmd, EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult, RedisService,
    RedisValues,
};
use futures_util::FutureExt;
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Fixture {
    redis: RedisService,
    task_id: i64,
    subtask_id: i64,
}

impl Fixture {
    fn key(&self) -> String {
        format!("chat:task_streaming:{}", self.task_id)
    }

    async fn raw(&self) -> Option<String> {
        self.redis.get(self.key()).await.expect("read marker")
    }

    async fn marker(&self) -> Value {
        serde_json::from_str(&self.raw().await.expect("marker exists")).expect("marker JSON")
    }
}

async fn with_fixture(run: impl AsyncFnOnce(&Fixture)) {
    let endpoint = std::env::var("WEGENT_TEST_REDIS_ADDRESS")
        .expect("set the disposable Redis fixture address");
    let address = endpoint
        .parse::<std::net::SocketAddr>()
        .expect("Redis fixture must be an IP:port");
    assert!(address.ip().is_loopback(), "loopback fixture required");
    let mut random = [0; 8];
    getrandom::getrandom(&mut random).expect("random fixture IDs");
    // Exercise exact IDs beyond the range of Lua/cjson's floating-point integers.
    let task_id = (i64::from_le_bytes(random) & ((1 << 60) - 1)) | (1 << 56);
    let fixture = Fixture {
        redis: RedisService::single(endpoint)
            .await
            .expect("connect disposable Redis"),
        task_id,
        subtask_id: task_id + 1,
    };
    let outcome = std::panic::AssertUnwindSafe(run(&fixture))
        .catch_unwind()
        .await;
    wegent_execution_runtime::stream_state::unregister_stream(
        Some(&fixture.redis),
        fixture.subtask_id,
    )
    .await;
    session::cleanup_streaming_state(&fixture.redis, fixture.subtask_id, Some(fixture.task_id))
        .await
        .expect("remove fixture keys");
    fixture
        .redis
        .del(crate::internal_callback::pipeline::execution_lease_key(
            fixture.task_id,
            fixture.subtask_id,
        ))
        .await
        .expect("remove fixture lease");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn indexed_blocks_preserve_reserved_ids_and_python_writer_positions() {
    with_fixture(async |fixture| {
        let redis = &fixture.redis;
        let id = fixture.subtask_id;
        let list = session::blocks_key(id);
        let index = format!("chat:streaming:blocks_index:{id}");
        let ids = ["_watermark", "_watermark_id", "block:a", "a"];
        for block_id in ids {
            let mut block = json!({"id": block_id, "type": "tool", "tool_use_id": block_id,
                "status": "pending", "tool_output": "original"}).as_object().unwrap().clone();
            session::add_block(redis, id, &mut block).await.unwrap();
        }
        for block_id in ids {
            session::update_tool_block_status(redis, id, block_id, Some("done"),
                Some(&json!("updated")), None, None, None, None).await.unwrap();
        }
        let blocks = session::get_blocks(redis, id).await;
        assert_eq!(blocks.len(), ids.len());
        for (block, block_id) in blocks.iter().zip(ids) {
            assert_eq!(block["id"], block_id);
            assert_eq!(block["tool_output"], "updated");
            let position: Option<String> = redis.hget(&index, format!("block:{block_id}")).await.unwrap();
            assert!(position.is_some());
        }

        // A Python writer records its append position using the same field format.
        let length = redis.rpush(&list, (r#"{"id":"python","type":"tool","tool_use_id":"python"}"#,)).await.unwrap();
        redis.hset(&index, "block:python", length - 1).await.unwrap();
        assert_eq!(session::get_block(redis, id, "python").await.unwrap().unwrap()["id"], "python");
        // Legacy writers can append without the index, far beyond a fixed tail.
        for offset in 0..20 {
            redis.rpush(&list, (format!(r#"{{"id":"legacy-{offset}","type":"tool","tool_use_id":"legacy-{offset}"}}"#),)).await.unwrap();
        }
        session::update_tool_block_status(redis, id, "legacy-0", Some("done"), None, None, None, None, None).await.unwrap();
        assert_eq!(session::get_blocks(redis, id).await.len(), 25);
        assert_eq!(session::get_block(redis, id, "legacy-0").await.unwrap().unwrap()["status"], "done");

        // Expiring the cache rebuilds it from the unchanged source list.
        let mut expire = brz_redis::cmd("PEXPIREAT");
        expire.arg_encoded(&index).unwrap().arg_encoded(1).unwrap();
        let _: i64 = redis.command(expire).await.unwrap();
        assert!(session::get_block(redis, id, "_watermark_id").await.unwrap().is_some());
        session::cleanup_streaming_state(redis, id, None).await.unwrap();
        let remaining: Option<String> = redis.hget(&index, "block:_watermark_id").await.unwrap();
        assert!(remaining.is_none(), "cleanup removes the index with the list");
    }).await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn identified_text_and_block_updates_share_the_streaming_index() {
    with_fixture(async |fixture| {
        let redis = &fixture.redis;
        let id = fixture.subtask_id;
        session::add_identified_text_content(redis, id, "你好", "_watermark_id", Some(0))
            .await
            .unwrap();
        session::add_thinking_content(redis, id, "reasoning")
            .await
            .unwrap();
        session::add_identified_text_content(redis, id, "next", "next-text", Some(0))
            .await
            .unwrap();
        session::add_identified_text_content(redis, id, "!", "next-text", Some(4))
            .await
            .unwrap();
        session::add_identified_text_content(redis, id, "next!", "next-text", Some(0))
            .await
            .unwrap();
        assert!(
            session::add_identified_text_content(redis, id, "gap", "next-text", Some(8))
                .await
                .is_err(),
            "a forward gap fails before changing block state"
        );
        let first = session::get_block(redis, id, "_watermark_id")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first["content"], "你好");
        assert_eq!(first["status"], "done");
        let next = session::get_block(redis, id, "next-text")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next["content"], "next!");
        assert!(!next.contains_key(session::BLOCK_CONTENT_KEY_FIELD));
        let loaded = session::finalize_and_get_blocks(redis, id, None, Some("COMPLETED")).await;
        assert_eq!(loaded.blocks.len(), 3);
        assert!(loaded.blocks.iter().all(|block| block["status"] == "done"));
    })
    .await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn settled_consumer_cleanup_preserves_a_newer_turn_marker() {
    with_fixture(async |fixture| {
        let redis = &fixture.redis;
        session::add_text_content(redis, fixture.subtask_id, "old partial")
            .await
            .unwrap();
        session::set_task_streaming_status(
            redis,
            fixture.task_id,
            fixture.subtask_id + 1,
            7,
            "owner",
        )
        .await
        .unwrap();
        let newer = fixture.raw().await;
        session::cleanup_settled_streaming_state(redis, fixture.subtask_id, fixture.task_id)
            .await
            .unwrap();
        assert_eq!(fixture.raw().await, newer);
        assert!(
            session::get_streaming_content(redis, fixture.subtask_id)
                .await
                .is_none()
        );

        session::set_task_streaming_status(redis, fixture.task_id, fixture.subtask_id, 7, "owner")
            .await
            .unwrap();
        session::cleanup_settled_streaming_state(redis, fixture.subtask_id, fixture.task_id)
            .await
            .unwrap();
        assert!(fixture.raw().await.is_none());
    })
    .await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn response_cancel_registration_preserves_intent_until_atomic_owner_cleanup() {
    with_fixture(async |fixture| {
        use wegent_execution_runtime::stream_state::{register_stream, unregister_stream};
        let flag = format!("chat:cancel:{}", fixture.subtask_id);
        let intent = format!("chat:cancel-intent:{}", fixture.subtask_id);

        fixture.redis.set(&flag, "true").await.expect("old flag");
        register_stream(Some(&fixture.redis), fixture.subtask_id).await;
        let cleared: Option<String> = fixture.redis.get(&flag).await.expect("old flag read");
        assert!(
            cleared.is_none(),
            "registration clears a flag without an intent"
        );

        fixture
            .redis
            .set(&intent, "pending-token")
            .await
            .expect("admitted intent");
        register_stream(Some(&fixture.redis), fixture.subtask_id).await;
        fixture
            .redis
            .set(&flag, "true")
            .await
            .expect("committed notification");
        // Both the outer response and inner dispatch may register after COMMIT.
        register_stream(Some(&fixture.redis), fixture.subtask_id).await;
        register_stream(Some(&fixture.redis), fixture.subtask_id).await;
        let preserved: Option<String> = fixture.redis.get(&flag).await.expect("flag read");
        assert_eq!(preserved.as_deref(), Some("true"));
        let preserved_intent: Option<String> =
            fixture.redis.get(&intent).await.expect("intent read");
        assert_eq!(preserved_intent.as_deref(), Some("pending-token"));

        unregister_stream(Some(&fixture.redis), fixture.subtask_id).await;
        let closed: Vec<Option<String>> = fixture
            .redis
            .mget([&flag, &intent])
            .await
            .expect("closed keys");
        assert_eq!(closed, [None, None]);
        unregister_stream(Some(&fixture.redis), fixture.subtask_id).await;
    })
    .await;
}

// Only inject a failed START command or a new START immediately after GET.
// Every successful command, including the CAS Lua script, runs in real Redis.
struct InterleavedRedis<'a> {
    fixture: &'a Fixture,
    fail_start: AtomicBool,
    next_start: Mutex<Option<i64>>,
    interleaved_raw: Mutex<Option<String>>,
}

impl<'a> InterleavedRedis<'a> {
    fn new(fixture: &'a Fixture) -> Self {
        Self {
            fixture,
            fail_start: AtomicBool::new(false),
            next_start: Mutex::new(None),
            interleaved_raw: Mutex::new(None),
        }
    }
}

impl Redis for InterleavedRedis<'_> {
    async fn hset<K, F, V>(&self, key: K, field: F, value: V) -> RedisResult<i64>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.fixture.redis.hset(key, field, value).await
    }

    async fn eval<S, K, A, T>(&self, script: S, keys: K, arguments: A) -> RedisResult<T>
    where
        S: EncodeRedisArg + Send,
        K: EncodeRedisArgs + Send,
        A: EncodeRedisArgs + Send,
        T: FromRedisValue + Send,
    {
        self.fixture.redis.eval(script, keys, arguments).await
    }

    async fn command<T: FromRedisValue + Send>(&self, command: Cmd) -> RedisResult<T> {
        if command.arg_at(0) == Some(b"SET") && self.fail_start.swap(false, Ordering::SeqCst) {
            return Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "injected START write failure",
            ));
        }
        self.fixture.redis.command(command).await
    }

    async fn get<K, T>(&self, key: K) -> RedisResult<Option<T>>
    where
        K: EncodeRedisArg + Send,
        T: FromRedisBulk + Send,
    {
        let value = self.fixture.redis.get(key).await?;
        let next_start = self.next_start.lock().expect("next START").take();
        if let Some(subtask_id) = next_start {
            session::set_task_streaming_status(
                &self.fixture.redis,
                self.fixture.task_id,
                subtask_id,
                42,
                "new-round",
            )
            .await?;
            let raw = self.fixture.raw().await;
            *self.interleaved_raw.lock().expect("new START marker") = raw;
        }
        Ok(value)
    }

    async fn set<K, V>(&self, key: K, value: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        self.fixture.redis.set(key, value).await
    }

    async fn mget<K, T>(&self, keys: K) -> RedisResult<Vec<Option<T>>>
    where
        K: EncodeRedisArgs + Send,
        T: FromRedisBulk + Send,
    {
        self.fixture.redis.mget(keys).await
    }

    async fn del_many<K: EncodeRedisArgs + Send>(&self, keys: K) -> RedisResult<i64> {
        self.fixture.redis.del_many(keys).await
    }

    async fn pfcount<K: EncodeRedisArgs + Send>(&self, keys: K) -> RedisResult<i64> {
        self.fixture.redis.pfcount(keys).await
    }

    async fn hget<K, F, T>(&self, key: K, field: F) -> RedisResult<Option<T>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        T: FromRedisBulk + Send,
    {
        self.fixture.redis.hget(key, field).await
    }

    async fn hmget<K, F, T>(&self, key: K, fields: F) -> RedisResult<RedisValues<T>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        T: FromRedisBulk + Send,
    {
        self.fixture.redis.hmget(key, fields).await
    }
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn content_recovers_missing_metadata_without_a_start_event() {
    with_fixture(async |fixture| {
        let mut emitter =
            StatusUpdatingEmitter::new(fixture.redis.clone(), fixture.task_id, fixture.subtask_id);
        let observed_start = emitter.observed_started_at_for_test().clone();
        let mut chunk = ExecutionEvent::new(EventType::Chunk, fixture.task_id, fixture.subtask_id);
        chunk.content = "real streamed content".into();
        emitter.emit_persist_only(&mut chunk).await.expect("chunk");
        emitter.flush_due().await;

        let marker = fixture.marker().await;
        assert_eq!(marker["subtask_id"], fixture.subtask_id);
        assert_eq!(marker["started_at"], observed_start);
        assert_eq!(marker["user_id"], 0);
        assert_eq!(marker["username"], "");
        assert!(
            chrono::DateTime::parse_from_rfc3339(marker["last_activity_at"].as_str().unwrap())
                .unwrap()
                > chrono::DateTime::parse_from_rfc3339(&observed_start).unwrap()
        );
        let mut command = brz_redis::cmd("TTL");
        command.arg_encoded(fixture.key()).expect("TTL key");
        let ttl: i64 = fixture.redis.command(command).await.expect("marker TTL");
        assert!(ttl > 0 && ttl <= session::STREAMING_TTL as i64);
        assert_eq!(
            fixture
                .redis
                .get::<_, String>(session::streaming_key(fixture.subtask_id))
                .await
                .unwrap()
                .as_deref(),
            Some("real streamed content")
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn content_recovers_metadata_after_a_failed_start_write() {
    with_fixture(async |fixture| {
        let redis = InterleavedRedis::new(fixture);
        redis.fail_start.store(true, Ordering::SeqCst);
        let mut emitter = StatusUpdatingEmitter::new(redis, fixture.task_id, fixture.subtask_id);
        *emitter.observed_started_at_for_test() = "2000-01-01T00:00:00.000000+00:00".into();
        let mut start = ExecutionEvent::new(EventType::Start, fixture.task_id, fixture.subtask_id);
        assert!(emitter.emit_persist_only(&mut start).await.is_err());
        assert!(fixture.raw().await.is_none());
        let observed_start = emitter.observed_started_at_for_test().clone();
        assert_ne!(observed_start, "2000-01-01T00:00:00.000000+00:00");

        let mut chunk = ExecutionEvent::new(EventType::Chunk, fixture.task_id, fixture.subtask_id);
        chunk.content = "content after recovery".into();
        emitter.emit_persist_only(&mut chunk).await.expect("chunk");
        emitter.flush_due().await;
        let marker = fixture.marker().await;
        assert_eq!(marker["subtask_id"], fixture.subtask_id);
        assert_eq!(marker["started_at"], observed_start);
        assert_ne!(marker["last_activity_at"], marker["started_at"]);
    })
    .await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn activity_preserves_another_subtask_even_for_adjacent_large_ids() {
    with_fixture(async |fixture| {
        session::set_task_streaming_status(
            &fixture.redis,
            fixture.task_id,
            fixture.subtask_id + 1,
            42,
            "other-round",
        )
        .await
        .expect("other START");
        let original = fixture.raw().await;
        assert!(
            !session::touch_task_streaming_activity(
                &fixture.redis,
                fixture.task_id,
                fixture.subtask_id,
                "2000-01-01T00:00:00.000000+00:00",
            )
            .await
            .expect("different owner")
        );
        assert_eq!(fixture.raw().await, original);
    })
    .await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn activity_cas_never_overwrites_a_start_after_its_get() {
    with_fixture(async |fixture| {
        for existing in [false, true] {
            fixture
                .redis
                .del(fixture.key())
                .await
                .expect("reset marker");
            if existing {
                session::set_task_streaming_status(
                    &fixture.redis,
                    fixture.task_id,
                    fixture.subtask_id,
                    7,
                    "old-round",
                )
                .await
                .expect("old START");
            }
            let redis = InterleavedRedis::new(fixture);
            *redis.next_start.lock().expect("next START") = Some(fixture.subtask_id + 1);
            assert!(
                !session::touch_task_streaming_activity(
                    &redis,
                    fixture.task_id,
                    fixture.subtask_id,
                    "2000-01-01T00:00:00.000000+00:00",
                )
                .await
                .expect("competing START")
            );
            assert_eq!(
                fixture.raw().await,
                *redis.interleaved_raw.lock().expect("new START marker")
            );
            assert_eq!(fixture.marker().await["subtask_id"], fixture.subtask_id + 1);
        }
    })
    .await;
}

async fn lease_ttl(redis: &RedisService, key: &str) -> i64 {
    let mut command = brz_redis::cmd("PTTL");
    command.arg(key);
    redis.command(command).await.expect("lease TTL")
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn pipeline_receipt_is_fenced_and_preserves_the_live_owner_ttl() {
    use crate::internal_callback::completion::lease_receipt::{LeaseReceipt, accepted_owner};
    use brz_redis::{SetExpiration, SetOptions};
    with_fixture(async |fixture| {
        let key = crate::internal_callback::pipeline::execution_lease_key(
            fixture.task_id,
            fixture.subtask_id,
        );
        let owner = LeaseReceipt::new(&key, "owner".into());
        let old_owner = LeaseReceipt::new(&key, "old-owner".into());
        assert!(
            !owner.accept(&fixture.redis).await.unwrap(),
            "missing owner"
        );
        assert!(!accepted_owner(&fixture.redis, &key).await.unwrap());
        fixture
            .redis
            .set_with(
                &key,
                "owner",
                SetOptions::default().with_expiration(SetExpiration::Milliseconds(10_000)),
            )
            .await
            .unwrap();
        assert!(
            owner.renew(&fixture.redis, 10_000).await.unwrap(),
            "raw owner renews before first event"
        );
        let before = lease_ttl(&fixture.redis, &key).await;
        assert!(!old_owner.accept(&fixture.redis).await.unwrap());
        assert!(!old_owner.renew(&fixture.redis, 30_000).await.unwrap());
        assert!(!old_owner.release(&fixture.redis).await.unwrap());
        assert!(owner.accept(&fixture.redis).await.unwrap());
        assert!(
            owner.accept(&fixture.redis).await.unwrap(),
            "idempotent owner acceptance"
        );
        assert!(accepted_owner(&fixture.redis, &key).await.unwrap());
        let after = lease_ttl(&fixture.redis, &key).await;
        assert!(
            after > 0 && after <= before,
            "acceptance must not extend TTL"
        );
        assert_eq!(
            fixture
                .redis
                .get::<_, String>(&key)
                .await
                .unwrap()
                .as_deref(),
            Some("accepted:owner")
        );
        assert!(owner.renew(&fixture.redis, 30_000).await.unwrap());
        assert!(lease_ttl(&fixture.redis, &key).await > after);
        assert!(!old_owner.release(&fixture.redis).await.unwrap());
        assert!(owner.release(&fixture.redis).await.unwrap());
        assert!(!accepted_owner(&fixture.redis, &key).await.unwrap());

        fixture.redis.set(&key, "owner").await.unwrap();
        assert!(
            !owner.accept(&fixture.redis).await.unwrap(),
            "a non-expiring value is not a live lease"
        );
        let mut expire = brz_redis::cmd("PEXPIREAT");
        expire.arg(&key).arg(1);
        fixture.redis.command::<i64>(expire).await.unwrap();
        assert!(
            !owner.accept(&fixture.redis).await.unwrap(),
            "expired owner cannot be resurrected"
        );
        fixture
            .redis
            .set_with(
                &key,
                "new-owner",
                SetOptions::default().with_expiration(SetExpiration::Milliseconds(10_000)),
            )
            .await
            .unwrap();
        assert!(!owner.accept(&fixture.redis).await.unwrap());
        assert!(!owner.renew(&fixture.redis, 30_000).await.unwrap());
        assert!(!owner.release(&fixture.redis).await.unwrap());
        assert_eq!(
            fixture
                .redis
                .get::<_, String>(&key)
                .await
                .unwrap()
                .as_deref(),
            Some("new-owner")
        );
        fixture.redis.del(&key).await.unwrap();
    })
    .await;
}

#[tokio::test]
#[ignore = "requires explicit disposable WEGENT_TEST_REDIS_ADDRESS; CI runs this group"]
async fn pipeline_receipt_observers_never_execute_or_release_the_owner() {
    use crate::internal_callback::completion::{LeaseReceipt, with_owned_lease};
    use brz_redis::{SetExpiration, SetOptions};
    with_fixture(async |fixture| {
        let key = crate::internal_callback::pipeline::execution_lease_key(
            fixture.task_id,
            fixture.subtask_id,
        );
        fixture
            .redis
            .set_with(
                &key,
                "fixture",
                SetOptions::default().with_expiration(SetExpiration::Milliseconds(20_000)),
            )
            .await
            .unwrap();
        let started = tokio::time::Instant::now();
        let phantom = with_owned_lease(
            &fixture.redis,
            &key,
            || "unaccepted",
            Some(|| ()),
            |_| async {
                panic!("a busy observer must not run consumer work or its cleanup");
                #[allow(unreachable_code)]
                Ok::<(), &str>(())
            },
        )
        .await;
        assert_eq!(phantom, Err("unaccepted"));
        assert!(started.elapsed() >= std::time::Duration::from_secs(5));
        let owner = LeaseReceipt::new(&key, "fixture".into());
        assert!(owner.accept(&fixture.redis).await.unwrap());
        let before = lease_ttl(&fixture.redis, &key).await;
        let observed = with_owned_lease(
            &fixture.redis,
            &key,
            || "unavailable",
            Some(|| ()),
            |_| async {
                panic!("an accepted observer must not run consumer work or its cleanup");
                #[allow(unreachable_code)]
                Ok::<(), &str>(())
            },
        )
        .await;
        assert_eq!(observed, Ok(()));
        let after = lease_ttl(&fixture.redis, &key).await;
        assert!(
            after > 0 && after <= before,
            "observer does not renew or release"
        );
        assert_eq!(
            fixture
                .redis
                .get::<_, String>(&key)
                .await
                .unwrap()
                .as_deref(),
            Some("accepted:fixture")
        );
        owner.release(&fixture.redis).await.unwrap();
    })
    .await;
}
