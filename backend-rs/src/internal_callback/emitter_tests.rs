// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the streaming emit pipeline.

use super::*;
use crate::internal_callback::py_json::python_dumps;

/// A `Redis` implementation that is never asked to serve a command.
struct StubRedis;

impl brz_redis::Redis for StubRedis {
    async fn get<K, R>(&self, _key: K) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn set<K, V>(&self, _key: K, _value: V) -> brz_redis::RedisResult<()>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        Ok(())
    }

    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(
        &self,
        _key: K,
        _fields: F,
    ) -> brz_redis::RedisResult<brz_redis::RedisValues<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Err(brz_redis::RedisError::new(
            brz_redis::ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

#[test]
fn buffered_content_flush_deadline_is_armed_by_the_first_piece() {
    let mut emitter = StatusUpdatingEmitter::new(StubRedis, 1, 2);
    assert!(emitter.flush_deadline().is_none());

    emitter.buffer_content(StreamContentType::Text, "first");
    let first = emitter.first_buffered_at.expect("first piece recorded");
    let deadline = emitter.flush_deadline().expect("deadline armed");
    assert_eq!(deadline, first + STREAMING_STORAGE_FLUSH_INTERVAL);

    // `_buffer_stream_content` only arms the task when none is pending, so
    // later pieces join the same one-second batch.
    std::thread::sleep(std::time::Duration::from_millis(5));
    emitter.buffer_content(StreamContentType::Text, "second");
    assert_eq!(emitter.flush_deadline(), Some(deadline));
}

/// A `Redis` stub that records block-content appends and answers the block
/// key reads: the first text-block read misses (create) and later reads
/// return a recorded Source id.
#[derive(Clone, Default)]
struct RecordingRedis {
    state: std::sync::Arc<std::sync::Mutex<RecordingState>>,
}

#[derive(Default)]
struct RecordingState {
    text_reads: usize,
    appends: Vec<String>,
    /// Every served command rendered as `<COMMAND> <key>`, in call order.
    calls: Vec<String>,
    /// The recorded `chat:task_streaming:{task}` object served by `GET`.
    task_streaming: Option<String>,
    task_streaming_reads: usize,
    /// Every `SET key value` payload, in call order.
    sets: Vec<(String, Vec<u8>)>,
}

impl RecordingRedis {
    fn key_name<K: brz_redis::EncodeRedisArg>(key: &K) -> String {
        key.as_encoded_bytes()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default()
    }
}

impl brz_redis::Redis for RecordingRedis {
    async fn get<K, R>(&self, key: K) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("GET {name}"));
        if name.starts_with("chat:streaming:text_block:") {
            let mut state = self.state.lock().expect("state");
            state.text_reads += 1;
            if state.text_reads > 1 {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(
                    b"text-1792479722634".to_vec(),
                ))
                .map(Some);
            }
        }
        if name.starts_with("chat:task_streaming:") {
            let mut state = self.state.lock().expect("state");
            state.task_streaming_reads += 1;
            // Read-after-write: Replay serves the value this target already
            // wrote for the key before any canned recorded object.
            if let Some((_, value)) = state.sets.iter().rev().find(|(key, _)| *key == name) {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(value.clone())).map(Some);
            }
            if let Some(value) = state.task_streaming.clone() {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(value.into_bytes()))
                    .map(Some);
            }
        }
        Ok(None)
    }

    async fn set<K, V>(&self, key: K, _value: V) -> brz_redis::RedisResult<()>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("SET {name}"));
        Ok(())
    }

    async fn set_with<K, V>(
        &self,
        key: K,
        value: V,
        _options: brz_redis::SetOptions,
    ) -> brz_redis::RedisResult<bool>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        let payload = value
            .as_encoded_bytes()
            .map(<[u8]>::to_vec)
            .unwrap_or_default();
        let mut state = self.state.lock().expect("state");
        state.calls.push(format!("SET {name}"));
        state.sets.push((name, payload));
        Ok(true)
    }

    async fn append<K, V>(&self, key: K, _value: V) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        let mut state = self.state.lock().expect("state");
        state.calls.push(format!("APPEND {name}"));
        if name.starts_with("chat:streaming:block_content:") {
            state.appends.push(name);
        }
        Ok(0)
    }

    async fn expire<K>(&self, key: K, _seconds: u64) -> brz_redis::RedisResult<bool>
    where
        K: brz_redis::EncodeRedisArg + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("EXPIRE {name}"));
        Ok(true)
    }

    async fn rpush<K, V>(&self, key: K, _values: V) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArg + Send,
        V: brz_redis::EncodeRedisArgs + Send,
    {
        let name = Self::key_name(&key);
        self.state
            .lock()
            .expect("state")
            .calls
            .push(format!("RPUSH {name}"));
        Ok(1)
    }

    async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
    where
        K: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(Vec::new())
    }

    async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
    where
        K: brz_redis::EncodeRedisArgs + Send,
    {
        Ok(0)
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArg + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Ok(None)
    }

    async fn hmget<K, F, R>(
        &self,
        _key: K,
        _fields: F,
    ) -> brz_redis::RedisResult<brz_redis::RedisValues<R>>
    where
        K: brz_redis::EncodeRedisArg + Send,
        F: brz_redis::EncodeRedisArgs + Send,
        R: brz_redis::FromRedisBulk + Send,
    {
        Err(brz_redis::RedisError::new(
            brz_redis::ErrorKind::ClientError,
            "stub does not serve HMGET",
        ))
    }
}

#[tokio::test]
async fn the_delayed_flush_writes_the_batch_without_a_cancellation_read() {
    let redis = RecordingRedis::default();
    let mut emitter = StatusUpdatingEmitter::new(redis.clone(), 7, 9);
    emitter.buffer_content(StreamContentType::Text, "first");

    // `_flush_stream_storage_after_delay` is a detached task that only writes
    // the buffered `chat:streaming:*` batch. The cancellation reads belong to
    // the timeout-independent callers: `raw_chat_stream` reads once per
    // consumed event and `_wait_for_sse_cancellation` reads once per second.
    emitter.flush_due().await;

    let calls = redis.state.lock().expect("state").calls.clone();
    assert!(
        !calls
            .iter()
            .any(|call| call.starts_with("GET chat:cancel:")),
        "the flush task must not read the cancellation flag: {calls:?}"
    );
    let position = |prefix: &str| {
        calls
            .iter()
            .position(|call| call.starts_with(prefix))
            .unwrap_or_else(|| panic!("missing {prefix}: {calls:?}"))
    };
    let read_block = position("GET chat:streaming:");
    let append = position("APPEND chat:streaming:");
    let expire = position("EXPIRE chat:streaming:");
    assert!(read_block < append, "{calls:?}");
    assert!(read_block < expire, "{calls:?}");
}

/// `_flush_stream_storage` writes the buffered batch and then touches the
/// task-level marker (`status_updating.py:190-221`): `touch_task_streaming_activity`
/// re-reads `chat:task_streaming:{task}` before refreshing `last_activity_at`
/// (`session.py:716-731`). That GET is the streaming lane's early marker read,
/// and it must follow the content writes; the boundary path
/// (`emitter.rs`'s `persist`) runs it before `add_tool_block` finalizes a
/// block, so the read also precedes every `LRANGE chat:streaming:blocks:*`.
#[tokio::test]
async fn the_flush_reads_the_task_streaming_marker_after_the_batch() {
    let redis = RecordingRedis::default();
    // The recorded lane already holds the task marker when the first flush
    // runs; Replay serves this object for `GET chat:task_streaming:{task}`.
    redis.state.lock().expect("state").task_streaming = Some(
        "{\"subtask_id\":9,\"user_id\":0,\"username\":\"\",\"started_at\":\
         \"2026-10-26T15:11:07\",\"last_activity_at\":\"2026-10-26T15:11:07\"}"
            .to_string(),
    );
    let mut emitter = StatusUpdatingEmitter::new(redis.clone(), 7, 9);
    emitter.buffer_content(StreamContentType::Thinking, "first\n");
    emitter.flush_due().await;

    let calls = redis.state.lock().expect("state").calls.clone();
    let position = |prefix: &str| {
        calls
            .iter()
            .position(|call| call.starts_with(prefix))
            .unwrap_or_else(|| panic!("missing {prefix}: {calls:?}"))
    };
    let append = position("APPEND chat:streaming:block_content:");
    let marker_read = position("GET chat:task_streaming:7");
    let marker_write = position("SET chat:task_streaming:7");
    assert!(append < marker_read, "{calls:?}");
    assert!(marker_read < marker_write, "{calls:?}");
    assert_eq!(
        redis.state.lock().expect("state").task_streaming_reads,
        1,
        "the source's stored read must run once per flush"
    );
}

#[tokio::test]
async fn content_appends_use_the_stored_block_id() {
    let redis = RecordingRedis::default();
    let mut emitter = StatusUpdatingEmitter::new(redis.clone(), 7, 9);

    emitter.buffer_content(StreamContentType::Text, "first");
    emitter.flush_stream_storage().await;
    emitter.buffer_content(StreamContentType::Text, "second");
    emitter.flush_stream_storage().await;

    let appends = redis.state.lock().expect("state").appends.clone();
    assert_eq!(appends.len(), 2, "{appends:?}");
    let created = appends[0].rsplit(':').next().expect("block id");
    assert!(created.starts_with("text-"), "{created}");
    // The second append keys off the value Redis returned, which Replay now
    // serves from this target's own earlier write.
    assert!(appends[1].ends_with(":text-1792479722634"), "{appends:?}");
    assert_ne!(created, "text-1792479722634");
}

#[tokio::test]
async fn touch_preserves_the_stored_object_and_refreshes_activity() {
    let redis = RecordingRedis::default();
    session::set_task_streaming_status(&redis, 7, 9, 0, "")
        .await
        .expect("create");
    let (_, created) = redis
        .state
        .lock()
        .expect("state")
        .sets
        .last()
        .cloned()
        .expect("create write");
    let created: Value = serde_json::from_slice(&created).expect("create json");

    // Keep the refreshed clock distinguishable from the created one.
    std::thread::sleep(std::time::Duration::from_millis(2));
    assert!(
        session::touch_task_streaming_activity(&redis, 7)
            .await
            .expect("touch")
    );

    let state = redis.state.lock().expect("state");
    assert_eq!(
        state.task_streaming_reads, 1,
        "the source's stored read must run"
    );
    let (key, payload) = state.sets.last().expect("touch write");
    assert_eq!(key, "chat:task_streaming:7");
    let touched: Value = serde_json::from_slice(payload).expect("touch json");
    assert_eq!(touched["started_at"], created["started_at"]);
    assert_eq!(touched["subtask_id"], json!(9));
    assert_eq!(touched["user_id"], json!(0));
    assert_eq!(touched["username"], json!(""));
    assert_ne!(touched["last_activity_at"], created["last_activity_at"]);
}

#[test]
fn sanitize_client_payload_drops_only_private_workflow_urls() {
    let payload = json!({
        "value": "x",
        "polling_url": "https://a",
        "nested": {"task_url": "https://b", "keep": 1},
        "list": [{"query_url": "https://c"}, "v"],
    });
    assert_eq!(
        python_dumps(&sanitize_client_payload(&payload)),
        "{\"value\": \"x\", \"nested\": {\"keep\": 1}, \"list\": [{}, \"v\"]}"
    );
}

/// `emit_chat_error`'s recorded frame order: an error event with a code and a
/// message id produces `subtask_id`, `error`, `task_id`, `type`, `message_id`.
#[test]
fn error_frame_keeps_the_source_payload_order() {
    let mut event = ExecutionEvent::new(
        crate::internal_callback::event::EventType::Error,
        801406538682287,
        801406538682290,
    );
    event.message_id = Some(2);
    event.error = Some("API Error: timeout, model_id: qwen3.8-flash".to_string());
    event.error_code = Some("runtime_error".to_string());
    assert_eq!(
        python_dumps(&error_payload(&event)),
        "{\"subtask_id\": 801406538682290, \"error\": \"API Error: timeout, model_id: qwen3.8-flash\", \
         \"task_id\": 801406538682287, \"type\": \"runtime_error\", \"message_id\": 2}"
    );
}

/// `emit_chat_cancelled`'s payload carries only the two ids.
#[test]
fn cancelled_frame_carries_task_and_subtask_ids() {
    let mut event =
        ExecutionEvent::new(crate::internal_callback::event::EventType::Cancelled, 7, 9);
    event.message_id = Some(2);
    assert_eq!(
        python_dumps(&cancelled_payload(&event)),
        "{\"task_id\": 7, \"subtask_id\": 9}"
    );
}

/// The `task:status` frame always carries the event-derived status.
#[test]
fn task_status_frame_matches_the_terminal_status() {
    let mut event = ExecutionEvent::new(crate::internal_callback::event::EventType::Error, 7, 9);
    event.message_id = Some(2);
    let payload = task_status_payload(&event, "FAILED");
    let object = payload.as_object().expect("object payload");
    assert_eq!(object["task_id"], json!(7));
    assert_eq!(object["status"], json!("FAILED"));
    assert_eq!(object["progress"], Value::Null);
    assert!(object["completed_at"].as_str().is_some());
    assert!(python_dumps(&payload).starts_with(
        "{\"task_id\": 7, \"status\": \"FAILED\", \"progress\": null, \"completed_at\": \""
    ));
}
