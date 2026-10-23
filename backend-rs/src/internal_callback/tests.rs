// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused compatibility tests for the execution callback.
use super::emitter::chunk_payload_for_test;
use super::event::ExecutionEvent;
use super::parser;
use super::py_json::python_dumps;
use super::{channel, session};
use serde_json::json;

#[test]
fn lifecycle_events_are_skipped() {
    let event = parser::shared()
        .parse(1, 2, None, "response.in_progress", &json!({}))
        .expect("parse");
    assert!(event.is_none());
}

#[test]
fn response_created_maps_to_start_with_shell_type() {
    let data = json!({"shell_type": "claudecode", "type": "response.created"});
    let event = parser::shared()
        .parse(
            801406538445813,
            801406538445816,
            Some(2),
            "response.created",
            &data,
        )
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "start");
    assert_eq!(event.data.get("shell_type"), Some(&json!("claudecode")));
    assert!(!event.data.contains_key("type"));
}

#[test]
fn block_created_requires_object_block() {
    let missing = parser::shared()
        .parse(1, 2, None, "response.block.created", &json!({"block": "x"}))
        .expect("parse");
    assert!(missing.is_none());

    let block = json!({"id": "b1", "type": "tool"});
    let event = parser::shared()
        .parse(
            1,
            2,
            None,
            "response.block.created",
            &json!({"block": block}),
        )
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "block_created");
    assert_eq!(event.data.get("block"), Some(&block));
}

#[test]
fn block_updated_coerces_block_id_to_string() {
    let data = json!({"block_id": 123, "updates": {"status": "done"}});
    let event = parser::shared()
        .parse(1, 2, None, "response.block.updated", &data)
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "block_updated");
    assert_eq!(event.data.get("block_id"), Some(&json!("123")));
}

#[test]
fn output_text_delta_maps_to_chunk() {
    let data = json!({"delta": "hello", "offset": 5});
    let event = parser::shared()
        .parse(1, 2, None, "response.output_text.delta", &data)
        .expect("parse")
        .expect("event");
    assert_eq!(event.event_type, "chunk");
    assert_eq!(event.content, "hello");
    assert_eq!(event.offset, 5);
}

#[test]
fn start_callback_channel_payload_matches_recorded_bytes() {
    let data = json!({"shell_type": "claudecode"});
    let mut event = ExecutionEvent::new(
        super::event::EventType::Start,
        801406538445813,
        801406538445816,
    );
    event.data = data.as_object().cloned().unwrap_or_default();
    event.message_id = Some(2);
    assert_eq!(
        python_dumps(&event.to_value()),
        "{\"type\": \"start\", \"task_id\": 801406538445813, \"subtask_id\": 801406538445816, \
         \"content\": \"\", \"offset\": 0, \"result\": null, \"progress\": 0, \"status\": \"\", \
         \"error\": null, \"error_code\": null, \"tool_name\": null, \"tool_use_id\": null, \
         \"tool_input\": null, \"tool_output\": null, \"message_id\": 2, \"executor_name\": null, \
         \"executor_namespace\": null, \"timestamp\": null, \"data\": {\"shell_type\": \"claudecode\"}}"
    );
}

#[test]
fn chat_chunk_payload_keeps_source_key_order() {
    let mut event = ExecutionEvent::new(super::event::EventType::Chunk, 10, 20);
    let payload = chunk_payload_for_test(&event, "hi", 3, Some(2), None, None, None);
    assert_eq!(
        python_dumps(&payload),
        "{\"subtask_id\": 20, \"content\": \"hi\", \"offset\": 3, \"task_id\": 10, \"message_id\": 2}"
    );
    // Result is only included when present.
    event.message_id = None;
    let payload = chunk_payload_for_test(
        &event,
        "",
        0,
        None,
        None,
        None,
        Some(json!({"reasoning_chunk": "r"})),
    );
    assert_eq!(
        python_dumps(&payload),
        "{\"subtask_id\": 20, \"content\": \"\", \"offset\": 0, \"task_id\": 10, \
         \"result\": {\"reasoning_chunk\": \"r\"}}"
    );
}

#[test]
fn streaming_key_layout_matches_source() {
    assert_eq!(session::streaming_key(5), "chat:streaming:5");
    assert_eq!(session::blocks_key(5), "chat:streaming:blocks:5");
    assert_eq!(session::callback_channel(5), "callback:channel:5");
}

#[test]
fn channel_prefixes_are_dingtalk_then_telegram() {
    assert_eq!(
        channel::channel_key_prefixes(),
        [
            "channel:task_callback:dingtalk:",
            "channel:task_callback:telegram:"
        ]
    );
}

/// `finalize_and_get_blocks` mirrors `session_manager.finalize_and_get_blocks`:
/// every failed or empty block read yields an empty list, which leaves the
/// terminal result without a `blocks` member.
mod block_read_tests {
    use super::session;
    use brz_redis::{
        EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisValues, Value,
    };

    /// `LRANGE` is an arbitrary command here, so the default `command` path
    /// rejects it like a failed dependency read.
    struct FailingListRedis;

    /// `LRANGE` succeeds but the stored list is empty.
    struct EmptyListRedis;

    /// `LRANGE` returns one block that references a content key, and `MGET`
    /// fails while hydrating it.
    struct FailingHydrationRedis;

    fn block_entry() -> String {
        r#"{"id":"b1","type":"text","content":"","status":"done","timestamp":1,"_content_key":"chat:streaming:block_content:5:b1"}"#.to_string()
    }

    macro_rules! required_redis_items {
        () => {
            async fn get<K, R>(&self, _key: K) -> brz_redis::RedisResult<Option<R>>
            where
                K: EncodeRedisArg + Send,
                R: FromRedisBulk + Send,
            {
                Ok(None)
            }

            async fn set<K, V>(&self, _key: K, _value: V) -> brz_redis::RedisResult<()>
            where
                K: EncodeRedisArg + Send,
                V: EncodeRedisArg + Send,
            {
                Ok(())
            }

            async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
            where
                K: EncodeRedisArgs + Send,
            {
                Ok(0)
            }

            async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
            where
                K: EncodeRedisArgs + Send,
            {
                Ok(0)
            }

            async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
            where
                K: EncodeRedisArg + Send,
                F: EncodeRedisArg + Send,
                R: FromRedisBulk + Send,
            {
                Ok(None)
            }

            async fn hmget<K, F, R>(
                &self,
                _key: K,
                _fields: F,
            ) -> brz_redis::RedisResult<RedisValues<R>>
            where
                K: EncodeRedisArg + Send,
                F: EncodeRedisArgs + Send,
                R: FromRedisBulk + Send,
            {
                Err(brz_redis::RedisError::new(
                    brz_redis::ErrorKind::ClientError,
                    "stub does not serve HMGET",
                ))
            }
        };
    }

    impl brz_redis::Redis for FailingListRedis {
        required_redis_items!();

        async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }
    }

    impl brz_redis::Redis for EmptyListRedis {
        required_redis_items!();

        async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn lrange<K, R>(
            &self,
            _key: K,
            _start: i64,
            _stop: i64,
        ) -> brz_redis::RedisResult<Vec<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisValue + Send,
        {
            Ok(Vec::new())
        }
    }

    impl brz_redis::Redis for FailingHydrationRedis {
        required_redis_items!();

        async fn lrange<K, R>(
            &self,
            _key: K,
            _start: i64,
            _stop: i64,
        ) -> brz_redis::RedisResult<Vec<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisValue + Send,
        {
            R::from_redis_value(&Value::BulkString(block_entry().into_bytes().into()))
                .map(|block| vec![block])
        }

        async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "stub read failure",
            ))
        }
    }

    #[tokio::test]
    async fn a_failed_block_read_yields_no_blocks() {
        let redis = FailingListRedis;
        assert!(session::get_blocks(&redis, 5).await.is_empty());
        assert!(
            session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED"))
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn an_empty_block_list_yields_no_blocks() {
        let redis = EmptyListRedis;
        assert!(session::get_blocks(&redis, 5).await.is_empty());
        assert!(
            session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED"))
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_failed_content_hydration_yields_no_blocks() {
        let redis = FailingHydrationRedis;
        assert!(session::get_blocks(&redis, 5).await.is_empty());
        assert!(
            session::finalize_and_get_blocks(&redis, 5, None, Some("COMPLETED"))
                .await
                .is_empty()
        );
    }
}

/// Block finalize behavior. The source's `_finalize_current_text_block` and
/// `_finalize_current_thinking_block` wrap their whole body in `try/except`
/// and only log a warning (`session.py:1251-1282`, `:1288-1318`), so a failed
/// dependency read must not abort the caller's following data write.
///
/// `session_manager.add_tool_block` also finalizes the current text and
/// thinking blocks itself (`session.py:930-931`) before `add_block` repeats
/// the pair (`session.py:1041-1042`); the recorded tool-start traffic is two
/// consecutive text/thinking `GET`s before the block `LRANGE`.
mod session_finalize_tests {
    use super::session;
    use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisValues};

    /// Records each command as `<COMMAND> <key>`. `failing_key` answers its
    /// `GET` with an error (a rejected dependency read); the other
    /// current-block key answers `current_block` when one is set.
    #[derive(Default)]
    struct RecordingRedis {
        calls: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        failing_key: Option<&'static str>,
        current_block: Option<&'static str>,
    }

    impl RecordingRedis {
        /// A stub whose `failing_key` read fails and whose other block read
        /// reports `current_block` as the active block id.
        fn with_failing_read(failing_key: &'static str, current_block: &'static str) -> Self {
            Self {
                calls: Default::default(),
                failing_key: Some(failing_key),
                current_block: Some(current_block),
            }
        }

        fn key_name<K: EncodeRedisArg>(key: &K) -> String {
            key.as_encoded_bytes()
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                .unwrap_or_default()
        }

        fn record<K: EncodeRedisArg>(&self, command: &str, key: &K) {
            let name = Self::key_name(key);
            self.calls
                .lock()
                .expect("calls")
                .push(format!("{command} {name}"));
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }
    }

    impl brz_redis::Redis for RecordingRedis {
        async fn get<K, R>(&self, key: K) -> brz_redis::RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            let name = Self::key_name(&key);
            self.record("GET", &key);
            if self.failing_key == Some(name.as_str()) {
                return Err(brz_redis::RedisError::new(
                    brz_redis::ErrorKind::ClientError,
                    "rejected dependency read",
                ));
            }
            let is_current_block = name.starts_with("chat:streaming:text_block:")
                || name.starts_with("chat:streaming:thinking_block:");
            if is_current_block && let Some(block) = self.current_block {
                return R::from_redis_bulk(brz_redis::RedisBytes::from(block.as_bytes().to_vec()))
                    .map(Some);
            }
            Ok(None)
        }

        async fn set<K, V>(&self, key: K, _value: V) -> brz_redis::RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            self.record("SET", &key);
            Ok(())
        }

        async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn hmget<K, F, R>(
            &self,
            _key: K,
            _fields: F,
        ) -> brz_redis::RedisResult<RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "stub does not serve HMGET",
            ))
        }

        async fn append<K, V>(&self, key: K, _value: V) -> brz_redis::RedisResult<i64>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            self.record("APPEND", &key);
            Ok(0)
        }

        async fn lrange<K, R>(
            &self,
            key: K,
            _start: i64,
            _stop: i64,
        ) -> brz_redis::RedisResult<Vec<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisValue + Send,
        {
            self.record("LRANGE", &key);
            Ok(Vec::new())
        }

        async fn rpush<K, V>(&self, key: K, _values: V) -> brz_redis::RedisResult<i64>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArgs + Send,
        {
            self.record("RPUSH", &key);
            Ok(1)
        }

        async fn expire<K>(&self, key: K, _seconds: u64) -> brz_redis::RedisResult<bool>
        where
            K: EncodeRedisArg + Send,
        {
            self.record("EXPIRE", &key);
            Ok(true)
        }
    }

    #[tokio::test]
    async fn add_tool_block_finalizes_text_then_thinking_before_the_block_add() {
        let redis = RecordingRedis::default();
        session::add_tool_block(&redis, 5, "toolu_1", "search", None, None, None, None)
            .await
            .expect("add tool block");

        let calls = redis.calls();
        assert_eq!(
            &calls[..6],
            [
                "GET chat:streaming:text_block:5",
                "GET chat:streaming:thinking_block:5",
                "GET chat:streaming:text_block:5",
                "GET chat:streaming:thinking_block:5",
                "LRANGE chat:streaming:blocks:5",
                "RPUSH chat:streaming:blocks:5",
            ],
            "{calls:?}"
        );
    }

    #[tokio::test]
    async fn add_text_content_appends_after_a_failed_thinking_finalize() {
        let redis = RecordingRedis::with_failing_read("chat:streaming:thinking_block:5", "text-1");
        session::add_text_content(&redis, 5, "hello")
            .await
            .expect("the failed finalize must not abort the append");

        let calls = redis.calls();
        assert!(
            calls
                .iter()
                .any(|call| call == "APPEND chat:streaming:block_content:5:text-1"),
            "{calls:?}"
        );
    }

    #[tokio::test]
    async fn add_thinking_content_appends_after_a_failed_text_finalize() {
        let redis = RecordingRedis::with_failing_read("chat:streaming:text_block:5", "thinking-1");
        session::add_thinking_content(&redis, 5, "reason")
            .await
            .expect("the failed finalize must not abort the append");

        let calls = redis.calls();
        assert!(
            calls
                .iter()
                .any(|call| call == "APPEND chat:streaming:block_content:5:thinking-1"),
            "{calls:?}"
        );
    }
}
