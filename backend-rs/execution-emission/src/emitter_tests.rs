// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the streaming emit pipeline.

use super::*;
use crate::test_support::{NoopEmit, RecordingRedis};

type StatusUpdatingEmitter<R> = super::StatusUpdatingEmitter<R, NoopEmit>;
use wegent_python_compat::py_json::python_dumps;

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

    emitter.buffer_content(StreamContentType::Text, "first", None, None);
    let first = emitter.first_buffered_at.expect("first piece recorded");
    let deadline = emitter.flush_deadline().expect("deadline armed");
    assert_eq!(deadline, first + STREAMING_STORAGE_FLUSH_INTERVAL);

    // `_buffer_stream_content` only arms the task when none is pending, so
    // later pieces join the same one-second batch.
    std::thread::sleep(std::time::Duration::from_millis(5));
    emitter.buffer_content(StreamContentType::Text, "second", None, None);
    assert_eq!(emitter.flush_deadline(), Some(deadline));
}

/// Adjacent Unicode deltas merge within an item; replayed prefixes and distinct
/// item IDs must remain separate Redis appends for atomic offset handling.
#[tokio::test]
async fn identified_text_flush_preserves_unicode_offsets_and_callback_replays() {
    let redis = RecordingRedis::default();
    let mut emitter = StatusUpdatingEmitter::new(redis.clone(), 7, 9);
    for (id, offset, text) in [
        ("one", 0, "检查🙂"),
        ("one", 3, "中"),
        ("one", 0, "检查🙂中"),
        ("two", 0, "检查🙂中"),
    ] {
        emitter.buffer_content(StreamContentType::Text, text, Some(id), Some(offset));
    }
    emitter.flush_stream_storage().await;
    let state = redis.state.lock().expect("state");
    // The task marker now uses its own CAS script after the content batch.
    let content_appends: Vec<_> = state
        .evals
        .iter()
        .filter(|call| call[2] == "chat:streaming:9")
        .collect();
    assert_eq!(content_appends.len(), 3);
    for (call, id) in content_appends.into_iter().zip(["one", "one", "two"]) {
        assert_eq!(call[1], "7");
        assert_eq!(call[3], format!("chat:streaming:block_content:9:{id}"));
        assert_eq!(
            call[4],
            format!("chat:streaming:block_content:9:{id}:offset")
        );
        assert_eq!(call[8], "chat:streaming:blocks_index:9");
        assert_eq!(&call[9..12], ["0", "4", "检查🙂中"]);
        assert_eq!(call[13], session::STREAMING_TTL.to_string());
        assert_eq!(call[14], id);
        let block: Value = serde_json::from_str(&call[12]).expect("block JSON");
        assert_eq!(block["id"], id);
        assert_eq!(block["_content_key"], call[3]);
    }
}

#[test]
fn overlapping_item_offsets_stay_in_separate_buffer_entries() {
    let mut emitter = StatusUpdatingEmitter::new(StubRedis, 7, 9);
    emitter.buffer_content(StreamContentType::Text, "检查🙂", Some("one"), Some(0));
    emitter.buffer_content(StreamContentType::Text, "🙂中", Some("one"), Some(2));
    assert_eq!(emitter.buffer.len(), 2);
    assert_eq!(emitter.buffer[1].block_offset, Some(2));
    assert_eq!(emitter.buffer[1].content, "🙂中");
}

#[tokio::test]
async fn the_delayed_flush_writes_the_batch_without_a_cancellation_read() {
    let redis = RecordingRedis::default();
    let mut emitter = StatusUpdatingEmitter::new(redis.clone(), 7, 9);
    emitter.buffer_content(StreamContentType::Text, "first", None, None);

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
    emitter.buffer_content(StreamContentType::Thinking, "first\n", None, None);
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
    let marker_write = position("EVAL chat:task_streaming:7");
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

    emitter.buffer_content(StreamContentType::Text, "first", None, None);
    emitter.flush_stream_storage().await;
    emitter.buffer_content(StreamContentType::Text, "second", None, None);
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
        session::touch_task_streaming_activity(&redis, 7, 9, "2026-10-26T15:11:07+00:00")
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
        wegent_execution_events::event::EventType::Error,
        801406538682287,
        801406538682290,
    );
    event.message_id = Some(2);
    event.error = Some("API Error: timeout, model_id: qwen3.8-flash".to_string());
    event.error_code = Some("runtime_error".to_string());
    assert_eq!(
        python_dumps(&error_payload(&event)),
        "{\"subtask_id\": 801406538682290, \"error\": \"API Error: timeout, model_id: qwen3.8-flash\", \
         \"task_id\": 801406538682287, \"type\": \"runtime_error\", \"error_info\": \
         {\"code\": \"generic_error\", \"category\": \"unknown\", \
          \"retry_policy\": \"unknown\", \"stage\": \"unknown\"}, \"message_id\": 2}"
    );
}

/// `emit_chat_cancelled`'s payload carries only the two ids.
#[test]
fn cancelled_frame_carries_task_and_subtask_ids() {
    let mut event = ExecutionEvent::new(wegent_execution_events::event::EventType::Cancelled, 7, 9);
    event.message_id = Some(2);
    assert_eq!(
        python_dumps(&cancelled_payload(&event)),
        "{\"task_id\": 7, \"subtask_id\": 9}"
    );
}

/// The `task:status` frame always carries the event-derived status.
#[test]
fn task_status_frame_matches_the_terminal_status() {
    let mut event = ExecutionEvent::new(wegent_execution_events::event::EventType::Error, 7, 9);
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

#[tokio::test]
async fn the_parsed_start_emits_chat_start_and_task_created() {
    let redis = RecordingRedis::default();
    let mut emitter =
        StatusUpdatingEmitter::new(redis.clone(), 893_490_636_671_579, 893_490_636_671_584)
            .with_created_task(CreatedTask {
                user_id: 6501,
                team_id: 110_467,
                team_name: "wegent-chat".into(),
                title: "根据这份材料模版".into(),
                is_group_chat: false,
                project_id: 0,
            });
    // Production feeds the parsed `response.created` START to `emit`.
    let mut event = wegent_execution_events::parser::shared()
        .parse(
            893_490_636_671_579,
            893_490_636_671_584,
            Some(4),
            "response.created",
            &serde_json::json!({"shell_type": "Chat", "bot_name": "wegent-chat"}),
        )
        .expect("start parsed")
        .expect("start event");
    emitter.emit(&mut event).await.expect("start emitted");

    let state = redis.state.lock().expect("state");
    let published = &state.published;
    assert_eq!(published.len(), 2, "{published:?}");
    assert_eq!(published[0]["event"], "chat:start");
    assert_eq!(published[0]["room"], "task:893490636671579");
    assert_eq!(published[0]["data"][0]["bot_name"], "wegent-chat");
    assert_eq!(published[1]["event"], "task:created");
    assert_eq!(published[1]["room"], "user:6501");
    assert_eq!(published[1]["data"][0]["team_name"], "wegent-chat");
}

/// `_dispatch_chat_shell_sse` awaits the wrapped emitter's `emit_start`
/// before the POST: it publishes `chat:start` / `task:created` only, and the
/// `chat:task_streaming` marker is established later by the parsed
/// `response.created` START.
#[tokio::test]
async fn the_pre_http_start_forwards_without_writing_a_redis_marker() {
    let redis = RecordingRedis::default();
    let mut emitter =
        StatusUpdatingEmitter::new(redis.clone(), 893_490_636_671_579, 893_490_636_671_584)
            .with_created_task(CreatedTask {
                user_id: 6501,
                team_id: 110_467,
                team_name: "wegent-chat".into(),
                title: "根据这份材料模版".into(),
                is_group_chat: false,
                project_id: 0,
            });
    emitter
        .emit_start_forward_only(
            Some(4),
            &serde_json::json!({"shell_type": "Chat", "bot_name": "wegent-chat"}),
        )
        .await
        .expect("start forwarded");

    let guard = redis.state.lock().expect("state");
    assert!(
        guard.calls.is_empty(),
        "the pre-HTTP START must not write the task marker: {:?}",
        guard.calls
    );
    assert!(guard.sets.is_empty(), "{:?}", guard.sets);
    assert!(guard.commands.is_empty(), "{:?}", guard.commands);
    assert_eq!(guard.published.len(), 2, "{:?}", guard.published);
    assert_eq!(guard.published[0]["event"], "chat:start");
    assert_eq!(guard.published[1]["event"], "task:created");
}

/// The parsed `response.created` START runs the full `emit`, so it is the
/// point that establishes the `chat:task_streaming` marker.
#[tokio::test]
async fn the_parsed_start_establishes_the_task_streaming_marker() {
    let redis = RecordingRedis::default();
    let mut emitter =
        StatusUpdatingEmitter::new(redis.clone(), 893_490_636_671_579, 893_490_636_671_584);
    // Production feeds the parsed `response.created` START to `emit`.
    let mut event = wegent_execution_events::parser::shared()
        .parse(
            893_490_636_671_579,
            893_490_636_671_584,
            Some(4),
            "response.created",
            &serde_json::json!({"shell_type": "Chat", "bot_name": "wegent-chat"}),
        )
        .expect("start parsed")
        .expect("start event");
    emitter.emit(&mut event).await.expect("start persisted");

    let calls = redis.state.lock().expect("state").calls.clone();
    assert!(
        calls
            .iter()
            .any(|call| call == "SET chat:task_streaming:893490636671579"),
        "{calls:?}"
    );
}

/// `websocket.py:_load_context_briefs` -> `emit_chat_done`: the DONE frame
/// always carries the completed subtask's committed briefs under `contexts`;
/// the error frame (`emit_chat_error`) has no such field.
#[tokio::test]
async fn the_done_frame_publishes_the_contexts_field() {
    let redis = RecordingRedis::default();
    let mut event = ExecutionEvent::new(
        wegent_execution_events::event::EventType::Done,
        893_490_636_671_579,
        893_490_636_671_584,
    );
    event.message_id = Some(4);
    let contexts = json!([{
        "id": 11,
        "context_type": "attachment",
        "name": "a.txt",
        "status": "ready",
    }]);
    emit_done_frames(
        &NoopEmit,
        &redis,
        &event,
        Some(6501),
        &json!({"value": "x"}),
        None,
        Some(&contexts),
    )
    .await
    .expect("done frames");

    {
        let state = redis.state.lock().expect("state");
        let done = state
            .published
            .iter()
            .find(|message| message["event"] == "chat:done")
            .expect("chat:done publish");
        assert_eq!(done["data"][0]["contexts"], contexts);
    }

    let redis = RecordingRedis::default();
    let mut event = ExecutionEvent::new(
        wegent_execution_events::event::EventType::Error,
        893_490_636_671_579,
        893_490_636_671_584,
    );
    event.error = Some("boom".to_owned());
    emit_terminal_frames(&NoopEmit, &redis, &event, Some(6501), &Value::Null, None)
        .await
        .expect("error frames");
    let state = redis.state.lock().expect("state");
    let error = state
        .published
        .iter()
        .find(|message| message["event"] == "chat:error")
        .expect("chat:error publish");
    assert!(error["data"][0].get("contexts").is_none(), "{error}");
}
