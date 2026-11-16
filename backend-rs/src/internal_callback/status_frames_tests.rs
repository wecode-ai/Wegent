// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the `chat:status_updated` frame and snapshot.

use std::sync::{Arc, Mutex};

use brz_redis::{Cmd, FromRedisValue};
use serde_json::{Value, json};

use super::{StatusUpdate, build, emit_status_updated};
use crate::internal_callback::event::{EventType, ExecutionEvent};

fn status_event(data: Value) -> ExecutionEvent {
    let mut event = ExecutionEvent::new(EventType::StatusUpdated, 11, 22);
    event.data = data.as_object().cloned().unwrap_or_default();
    event
}

fn metrics() -> Value {
    json!({
        "context_window": 1000000,
        "used_input_tokens": 42696,
        "remaining_percent": 95,
    })
}

fn expected_snapshot(compaction: Value) -> Value {
    json!({
        "task_id": 11,
        "subtask_id": 22,
        "phase": "after_compaction",
        "context_metrics": metrics(),
        "context_compaction": compaction,
    })
}

#[test]
fn snapshot_and_frame_match_the_recorded_shape() {
    let event = status_event(json!({
        "phase": "after_compaction",
        "context_metrics": metrics(),
        "context_compaction": null,
    }));
    let StatusUpdate { snapshot, frame } = build(&event).expect("valid status update");

    // The cached snapshot always carries `context_compaction`, `null` when the
    // event has no dict.
    assert_eq!(snapshot, expected_snapshot(Value::Null));
    // The frame omits the key when it is not a dict, exactly like
    // `emit_chat_status_updated`.
    assert_eq!(
        frame,
        json!({
            "task_id": 11,
            "subtask_id": 22,
            "phase": "after_compaction",
            "context_metrics": metrics(),
        })
    );
    let keys: Vec<&str> = frame
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["task_id", "subtask_id", "phase", "context_metrics"]);
}

#[test]
fn a_compaction_dict_is_kept_in_both_payloads() {
    let compaction = json!({"before_tokens": 900000, "after_tokens": 42000});
    let event = status_event(json!({
        "phase": "after_compaction",
        "context_metrics": metrics(),
        "context_compaction": compaction,
    }));
    let StatusUpdate { snapshot, frame } = build(&event).expect("valid status update");

    assert_eq!(snapshot, expected_snapshot(compaction.clone()));
    assert_eq!(frame["context_compaction"], compaction);
    let keys: Vec<&str> = frame
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "task_id",
            "subtask_id",
            "phase",
            "context_metrics",
            "context_compaction"
        ]
    );
}

#[test]
fn a_non_dict_compaction_folds_to_null_in_the_snapshot_and_is_omitted() {
    let event = status_event(json!({
        "phase": "final",
        "context_metrics": metrics(),
        "context_compaction": "not-a-dict",
    }));
    let StatusUpdate { snapshot, frame } = build(&event).expect("valid status update");

    assert_eq!(snapshot["context_compaction"], Value::Null);
    assert!(
        !frame
            .as_object()
            .expect("object")
            .contains_key("context_compaction")
    );
}

#[test]
fn a_missing_context_metrics_defaults_to_an_empty_object() {
    let event = status_event(json!({"phase": "build_messages"}));
    let StatusUpdate { snapshot, frame } = build(&event).expect("valid status update");

    assert_eq!(frame["context_metrics"], json!({}));
    assert_eq!(snapshot["context_metrics"], json!({}));
}

#[test]
fn a_falsy_phase_skips_the_event() {
    for phase in [Value::Null, json!(""), json!(0), json!(false)] {
        let event = status_event(json!({"phase": phase, "context_metrics": metrics()}));
        assert!(build(&event).is_none(), "phase {phase} must skip");
    }
    let missing = status_event(json!({"context_metrics": metrics()}));
    assert!(build(&missing).is_none());
}

#[test]
fn a_non_dict_context_metrics_skips_the_event() {
    for context_metrics in [json!("text"), json!(3), json!([1]), Value::Null] {
        let event = status_event(json!({
            "phase": "final",
            "context_metrics": context_metrics,
        }));
        assert!(
            build(&event).is_none(),
            "context_metrics {context_metrics} must skip"
        );
    }
}

#[derive(Clone, Default)]
struct RecordingRedis {
    commands: Arc<Mutex<Vec<Vec<String>>>>,
    fail_sets: bool,
}

impl RecordingRedis {
    fn new(fail_sets: bool) -> Self {
        Self {
            commands: Arc::new(Mutex::new(Vec::new())),
            fail_sets,
        }
    }

    fn commands(&self) -> Vec<Vec<String>> {
        self.commands.lock().expect("commands").clone()
    }
}

impl brz_redis::Redis for RecordingRedis {
    async fn command<R>(&self, command: Cmd) -> brz_redis::RedisResult<R>
    where
        R: FromRedisValue + Send,
    {
        let args: Vec<String> = (0..command.arg_count())
            .filter_map(|index| command.arg_at(index))
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect();
        if self.fail_sets && args.first().is_some_and(|name| name == "SET") {
            return Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "cache unavailable",
            ));
        }
        let command_name = args.first().cloned().unwrap_or_default();
        self.commands.lock().expect("commands").push(args);
        let reply = if command_name == "SET" { 1 } else { 0 };
        R::from_redis_value(&brz_redis::Value::Int(reply))
    }

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

#[tokio::test]
async fn emit_caches_the_snapshot_with_the_source_ttl_then_publishes_the_frame() {
    let redis = RecordingRedis::new(false);
    let event = status_event(json!({
        "phase": "after_compaction",
        "context_metrics": metrics(),
        "context_compaction": null,
    }));

    emit_status_updated(&redis, &event)
        .await
        .expect("emit succeeds");

    let commands = redis.commands();
    assert_eq!(commands.len(), 2);

    // `save_context_metrics`: `SET chat:context_metrics:{subtask} <orjson> EX 300`
    // (`settings.STREAMING_REDIS_TTL`, not the one-hour streaming TTL).
    assert_eq!(
        commands[0][..5],
        [
            "SET",
            "chat:context_metrics:22",
            commands[0][2].as_str(),
            "EX",
            "300"
        ]
    );
    let cached: Value = serde_json::from_str(&commands[0][2]).expect("snapshot JSON");
    assert_eq!(cached, expected_snapshot(Value::Null));
    // orjson's compact separators.
    assert!(!commands[0][2].contains(", "));
    assert!(!commands[0][2].contains(": "));

    // `emit_chat_status_updated`: `PUBLISH socketio <AsyncRedisManager message>`.
    assert_eq!(commands[1][0], "PUBLISH");
    assert_eq!(commands[1][1], "socketio");
    let message = &commands[1][2];
    assert!(message.contains("\"event\": \"chat:status_updated\""));
    assert!(message.contains("\"namespace\": \"/chat\""));
    assert!(message.contains("\"room\": \"task:11\""));
    assert!(message.contains(
        "\"data\": [{\"task_id\": 11, \"subtask_id\": 22, \"phase\": \"after_compaction\""
    ));
    assert!(!message.contains("context_compaction"));
}

#[tokio::test]
async fn a_failed_cache_write_still_publishes_the_frame() {
    let redis = RecordingRedis::new(true);
    let event = status_event(json!({
        "phase": "final",
        "context_metrics": metrics(),
    }));

    emit_status_updated(&redis, &event)
        .await
        .expect("a cache failure is swallowed");

    let commands = redis.commands();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0][0], "PUBLISH");
}

#[tokio::test]
async fn an_invalid_event_writes_and_publishes_nothing() {
    let redis = RecordingRedis::new(false);
    let event = status_event(json!({"phase": null, "context_metrics": metrics()}));

    emit_status_updated(&redis, &event)
        .await
        .expect("skip succeeds");

    assert!(redis.commands().is_empty());
}

#[test]
fn snapshot_key_order_is_python_insertion_order() {
    let event = status_event(json!({
        "phase": "final",
        "context_metrics": metrics(),
    }));
    let update = build(&event).expect("valid status update");
    let keys: Vec<&str> = update
        .snapshot
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "task_id",
            "subtask_id",
            "phase",
            "context_metrics",
            "context_compaction"
        ]
    );
}
