// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! DingTalk `StreamingResponseEmitter` shared-write protocol.
//!
//! Source: `app/services/channels/dingtalk/emitter.py`. The emitter renders one
//! AI Card per runtime turn; its text and compact progress state live in Redis
//! so another worker can reconstruct the card. This module ports the
//! Redis-observable half reached by `LocalTaskResponsesHandler`:
//!
//! 1. `_shared_write` takes the `:terminal:writer` lease with `SET <token> PX
//!    60000 NX` and reads the `:terminal` marker;
//! 2. `_flush_pending` loads the `:progress` state, saves the updated JSON,
//!    APPENDs the answer text and refreshes its TTL;
//! 3. `_may_update_display` takes the 500 ms `:display-lock`, and the lease is
//!    released with the lock's Lua script;
//! 4. the terminal event repeats the lease, saves the final answer and the
//!    terminal marker, deletes the per-card streaming keys, then the base
//!    service removes the shared key and the callback info.
//!
//! The card HTTP transport ([`super::dingtalk_card`]) writes the rendered
//! content through the DingTalk OpenAPI while the writer lease is held, in
//! Source order: the chunk flush updates the card, and the terminal turn
//! updates then finishes it.

use std::time::Duration;

use brz_redis::{Redis, RedisBytes, SetExpiration, SetOptions};
use serde_json::{Map, Value, json};

use super::dingtalk_card::{CardRef, CardStream};
use super::event::ExecutionEvent;
use crate::plugins_installed::write_coordination::{RELEASE_SCRIPT, RELEASE_SHA};

/// `CHANNEL_TASK_CALLBACK_TTL`.
const STATE_TTL_SECONDS: u64 = 3600;
/// `StreamingResponseEmitter.WRITER_LOCK_SECONDS`.
const WRITER_LOCK_MILLISECONDS: u64 = 60_000;
/// `StreamingResponseEmitter.WRITE_TIMEOUT_SECONDS`: the bounded acquire budget.
const WRITE_TIMEOUT_MILLISECONDS: u64 = 45_000;
/// redis-py `Lock`'s default retry interval on a denied NX.
const LOCK_RETRY_INTERVAL_MILLISECONDS: u64 = 100;
/// `StreamingResponseEmitter.MIN_UPDATE_INTERVAL`.
const DISPLAY_LOCK_MILLISECONDS: u64 = 500;

/// The Redis keys of one card-bound turn.
struct CardKeys {
    /// The base shared key `channel:streaming_content:{task_key}` that
    /// `_remove_emitter` deletes after the turn.
    base: String,
    answer: String,
    progress: String,
    display_lock: String,
    terminal: String,
    writer: String,
}

impl CardKeys {
    /// `set_shared_content_key` appends the out-track id, then `_answer_key`
    /// appends the card instance id. Reconnecting to an existing card makes
    /// both values the card instance id, which is why the recorded key repeats
    /// the card segment.
    fn new(task_key: &str, out_track_id: &str, card_instance_id: &str) -> Self {
        let base = format!("channel:streaming_content:{task_key}");
        let shared = format!("{base}:{out_track_id}");
        let answer = format!("{shared}:{card_instance_id}");
        Self {
            progress: format!("{answer}:progress"),
            display_lock: format!("{answer}:display-lock"),
            terminal: format!("{answer}:terminal"),
            writer: format!("{answer}:terminal:writer"),
            answer,
            base,
        }
    }
}

/// `emit_event` for the DingTalk stream: chunk/thinking text and compact
/// progress updates.
pub(crate) async fn emit_event<R: Redis, C: CardStream>(
    redis: &R,
    transport: &C,
    task_key: &str,
    callback_info: &Value,
    event: &ExecutionEvent,
) -> bool {
    let Some(card) = card_instance_id(callback_info) else {
        return false;
    };
    let keys = CardKeys::new(task_key, card, card);
    // `_initialize` loads the persisted progress state once before the write.
    let _ = read_state(redis, &keys.progress).await;
    let Some(token) = acquire_writer(redis, &keys.writer).await else {
        return false;
    };
    let finished = read_truthy(redis, &keys.terminal).await;
    let persisted = if finished {
        false
    } else {
        match event.event_type.as_str() {
            "chunk" => {
                let display = flush_answer(redis, &keys, &event.content).await;
                if let Some(display) = display.as_deref() {
                    // `_write_card` runs while the writer lease is still held.
                    let card_ref = CardRef {
                        channel_id: channel_id(callback_info),
                        out_track_id: card,
                        content_key: content_key(callback_info),
                    };
                    if let Err(error) = transport.update(&card_ref, display).await {
                        tracing::warn!(%error, "DingTalk card update failed");
                    }
                }
                display.is_some()
            }
            "thinking" => save_progress(redis, &keys, "正在分析…", "progress").await,
            // Tool/progress/status labels need their own compact projections;
            // only the answer and reasoning updates above are ported.
            _ => false,
        }
    };
    release_writer(redis, &keys.writer, &token).await;
    persisted
}

/// `send_task_result`'s DingTalk half: finish the card state and clean up.
pub(crate) async fn finish<R: Redis, C: CardStream>(
    redis: &R,
    transport: &C,
    task_key: &str,
    callback_info: &Value,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
) -> bool {
    let Some(card) = card_instance_id(callback_info) else {
        return false;
    };
    let keys = CardKeys::new(task_key, card, card);
    let Some(token) = acquire_writer(redis, &keys.writer).await else {
        return false;
    };
    let _ = read_truthy(redis, &keys.terminal).await;
    let content = final_content(result, status, error);
    // `_save_final_answer`: SET the authoritative answer, then refresh its TTL.
    let _ = redis.set(keys.answer.as_str(), content.as_str()).await;
    let _ = redis.expire(keys.answer.as_str(), STATE_TTL_SECONDS).await;
    let card_ref = CardRef {
        channel_id: channel_id(callback_info),
        out_track_id: card,
        content_key: content_key(callback_info),
    };
    await_finish_card(transport, &card_ref, &content, status == "FAILED").await;
    // `_finish_card` calls the adapter's `finish`/`fail`, whose
    // `mark_card_ready` reads the card binding before the terminal marker.
    mark_card_ready(redis, channel_id(callback_info), card).await;
    let _ = redis
        .set_with(
            keys.terminal.as_str(),
            "true",
            SetOptions::default().with_expiration(SetExpiration::Seconds(STATE_TTL_SECONDS)),
        )
        .await;
    let _ = redis
        .del_many([
            keys.answer.as_str(),
            keys.progress.as_str(),
            keys.display_lock.as_str(),
        ])
        .await;
    release_writer(redis, &keys.writer, &token).await;
    // `_remove_emitter` deletes the base shared streaming key, not the
    // per-card key derived from it.
    let _ = redis.del_many([keys.base.as_str()]).await;
    // `delete_callback_info`.
    let callback_key = format!("channel:task_callback:dingtalk:{task_key}");
    let _ = redis.del_many([callback_key.as_str()]).await;
    true
}

/// `_call_card("update")` then `finish`/`fail`, logging delivery failures the
/// way `_write_card` does instead of failing the terminal event.
async fn await_finish_card<C: CardStream>(
    transport: &C,
    card: &CardRef<'_>,
    content: &str,
    failed: bool,
) {
    if let Err(error) = transport.update(card, content).await {
        tracing::warn!(%error, "DingTalk card update failed");
    }
    let outcome = if failed {
        transport.fail(card, content).await
    } else {
        transport.finish(card, content).await
    };
    if let Err(error) = outcome {
        tracing::warn!(%error, "DingTalk card terminal delivery failed");
    }
}

/// `mark_card_ready` -> `load_binding` / `save_binding`
/// (`app/services/channels/dingtalk/card_binding.py`). A missing binding is a
/// no-op; a present one is rewritten with `ready = true`.
async fn mark_card_ready<R: Redis>(redis: &R, channel_id: i64, out_track_id: &str) {
    const CARD_BINDING_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
    let key = format!("dingtalk:chat_card:{channel_id}:{out_track_id}");
    let Ok(Some(raw)) = redis.get::<_, RedisBytes>(key.as_str()).await else {
        return;
    };
    let Ok(Value::Object(mut binding)) = serde_json::from_slice::<Value>(&raw) else {
        return;
    };
    binding.insert("ready".into(), Value::Bool(true));
    let payload = serde_json::to_string(&Value::Object(binding)).unwrap_or_default();
    let _ = redis
        .set_with(
            key.as_str(),
            payload,
            SetOptions::default().with_expiration(SetExpiration::Seconds(CARD_BINDING_TTL_SECONDS)),
        )
        .await;
}

/// `_answer_key`'s card instance; without a bound card there is nothing to
/// stream.
fn card_instance_id(callback_info: &Value) -> Option<&str> {
    callback_info
        .get("card_instance_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// `DingTalkChatCardConfig.content_key` (default `"content"`).
fn content_key(callback_info: &Value) -> &str {
    callback_info
        .get("chat_card")
        .and_then(|card| card.get("content_key"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("content")
}

/// The saved channel id used by the card binding key.
fn channel_id(callback_info: &Value) -> i64 {
    callback_info
        .get("channel_id")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// `_flush_pending`'s Redis side for an answer chunk. Returns the display
/// content when the throttled display write is allowed.
async fn flush_answer<R: Redis>(redis: &R, keys: &CardKeys, content: &str) -> Option<String> {
    // `CompactProgressState.from_dict(cache_manager.get(progress))`.
    let mut state = read_state(redis, &keys.progress).await;
    state.mode = "answer".to_string();
    if !save_state(redis, &keys.progress, &state).await {
        return None;
    }
    // `_redis_append_answer`.
    if redis
        .append(keys.answer.as_str(), content.as_bytes())
        .await
        .is_err()
    {
        return None;
    }
    let _ = redis.expire(keys.answer.as_str(), STATE_TTL_SECONDS).await;
    // `_redis_get_answer`.
    let answer = redis
        .get::<_, RedisBytes>(keys.answer.as_str())
        .await
        .ok()
        .flatten();
    // `_may_update_display`.
    let allowed = redis
        .set_with(
            keys.display_lock.as_str(),
            "1",
            SetOptions::default()
                .with_expiration(SetExpiration::Milliseconds(DISPLAY_LOCK_MILLISECONDS))
                .if_absent(),
        )
        .await
        .unwrap_or(false);
    if !allowed {
        return None;
    }
    let display = answer
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| content.to_string());
    Some(display)
}

/// `_update_progress` -> `_save_progress_state` for a non-answer update.
async fn save_progress<R: Redis>(redis: &R, keys: &CardKeys, current: &str, mode: &str) -> bool {
    let mut state = read_state(redis, &keys.progress).await;
    state.mode = mode.to_string();
    if current != state.current {
        state.current = current.to_string();
    }
    save_state(redis, &keys.progress, &state).await
}

/// The compact progress document (`CompactProgressState.to_dict`).
struct ProgressState {
    mode: String,
    current: String,
    recent: Value,
    blocks: Value,
    reasoning_summary: String,
}

impl Default for ProgressState {
    fn default() -> Self {
        Self {
            mode: "progress".to_string(),
            current: "正在理解需求…".to_string(),
            recent: json!([]),
            blocks: json!({}),
            reasoning_summary: String::new(),
        }
    }
}

/// `CompactProgressState.from_dict` for the fields the ported writer owns
/// (`recent`/`blocks` are carried through unchanged).
async fn read_state<R: Redis>(redis: &R, key: &str) -> ProgressState {
    let mut state = ProgressState::default();
    let Some(raw) = redis.get::<_, RedisBytes>(key).await.ok().flatten() else {
        return state;
    };
    let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(&raw) else {
        return state;
    };
    if let Some(mode) = object.get("mode").and_then(Value::as_str)
        && matches!(mode, "progress" | "answer")
    {
        state.mode = mode.to_string();
    }
    if let Some(current) = object.get("current").and_then(Value::as_str)
        && !current.trim().is_empty()
    {
        state.current = current.to_string();
    }
    if let Some(recent) = object.get("recent").filter(|value| value.is_array()) {
        state.recent = recent.clone();
    }
    if let Some(blocks) = object.get("blocks").filter(|value| value.is_object()) {
        state.blocks = blocks.clone();
    }
    if let Some(summary) = object.get("reasoning_summary").and_then(Value::as_str) {
        state.reasoning_summary = summary.to_string();
    }
    state
}

/// `cache_manager.set(key, state.to_dict(), expire=TTL)` with the Source's
/// compact JSON separators and `ensure_ascii=False`.
async fn save_state<R: Redis>(redis: &R, key: &str, state: &ProgressState) -> bool {
    let mut object = Map::new();
    object.insert("mode".into(), Value::String(state.mode.clone()));
    object.insert("current".into(), Value::String(state.current.clone()));
    object.insert("recent".into(), state.recent.clone());
    object.insert("blocks".into(), state.blocks.clone());
    object.insert(
        "reasoning_summary".into(),
        Value::String(state.reasoning_summary.clone()),
    );
    let payload = serde_json::to_string(&Value::Object(object)).unwrap_or_default();
    redis
        .set_with(
            key,
            payload,
            SetOptions::default().with_expiration(SetExpiration::Seconds(STATE_TTL_SECONDS)),
        )
        .await
        .is_ok()
}

/// `_shared_write`'s `client.lock()` acquisition (`SET token PX 60000 NX`).
/// redis-py retries a denied NX at its 100 ms default interval inside the
/// Source's bounded 45 s blocking budget. The token is generated once and
/// reused for every attempt and for the release, so the shared write runs only
/// after this writer owns the lease.
async fn acquire_writer<R: Redis>(redis: &R, key: &str) -> Option<String> {
    let token = random_token();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(WRITE_TIMEOUT_MILLISECONDS);
    loop {
        match redis
            .set_with(
                key,
                token.as_str(),
                SetOptions::default()
                    .with_expiration(SetExpiration::Milliseconds(WRITER_LOCK_MILLISECONDS))
                    .if_absent(),
            )
            .await
        {
            Ok(true) => return Some(token),
            Ok(false) => {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return None;
                }
                tokio::time::sleep(
                    remaining.min(Duration::from_millis(LOCK_RETRY_INTERVAL_MILLISECONDS)),
                )
                .await;
            }
            Err(_) => return None,
        }
    }
}

/// redis-py `Lock.release` -> `Script.__call__`: EVALSHA with the canonical
/// digest first, then load the same canonical bytes with `SCRIPT LOAD` on
/// NOSCRIPT and retry once. Transport, NOAUTH, BUSY and ordinary errors must
/// not add commands.
async fn release_writer<R: Redis>(redis: &R, key: &str, token: &str) {
    let first = redis
        .evalsha::<_, _, _, i64>(RELEASE_SHA, [key], [token])
        .await;
    if first
        .as_ref()
        .err()
        .is_none_or(|error| error.kind() != brz_redis::ErrorKind::NoScript)
    {
        return;
    }
    let mut load = brz_redis::cmd("SCRIPT");
    load.arg("LOAD").arg(RELEASE_SCRIPT);
    // Wait for the load reply before retrying; a lazy pipe would let the
    // retry race the load.
    if redis.command::<RedisBytes>(load).await.is_err() {
        return;
    }
    let _ = redis
        .evalsha::<_, _, _, i64>(RELEASE_SHA, [key], [token])
        .await;
}

/// `_read_terminal` truthiness.
async fn read_truthy<R: Redis>(redis: &R, key: &str) -> bool {
    matches!(
        redis.get::<_, RedisBytes>(key).await,
        Ok(Some(value)) if value.first().is_some_and(|first| *first != b'0')
    )
}

/// `_final_content`: an authoritative result wins, otherwise the accumulated
/// answer (or the Source's empty/error defaults).
fn final_content(result: Option<&Value>, status: &str, error: Option<&str>) -> String {
    if status == "FAILED" {
        let text = error.unwrap_or("未知错误");
        return format!("❌ 任务执行失败：{text}");
    }
    if let Some(result) = result {
        let authoritative = result.get("silent_exit_reason").and_then(Value::as_str)
            != Some("waiting_for_user_input")
            && !matches!(
                result.get("value_origin").and_then(Value::as_str),
                Some("process_fallback" | "empty")
            );
        if authoritative {
            for field in ["value", "output"] {
                if let Some(value) = result.get(field).and_then(Value::as_str)
                    && !value.is_empty()
                {
                    return value.to_string();
                }
            }
        }
    }
    String::new()
}

/// A 32-character random token matching redis-py's lock value shape.
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use brz_redis::{
        Cmd, EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult,
        Value as RedisValue, cmd,
    };
    use serde_json::json;

    /// Serves empty reads and records every command the stream issues.
    #[derive(Default)]
    struct StreamRedis {
        log: Mutex<Vec<String>>,
        /// Number of initial `SET ... NX` attempts to deny.
        deny_first: usize,
        written: Mutex<Vec<String>>,
        no_script: bool,
        script_loaded: Mutex<bool>,
        digests: Mutex<Vec<String>>,
        script_loads: Mutex<Vec<String>>,
        release_args: Mutex<Vec<Vec<String>>>,
        deleted: Mutex<Vec<Vec<String>>>,
    }

    impl StreamRedis {
        fn ops(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
        fn record(&self, name: &str) {
            self.log.lock().unwrap().push(name.to_string());
        }
    }

    impl Redis for StreamRedis {
        async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
        where
            K: brz_redis::EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: brz_redis::EncodeRedisArgs + Send,
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

        async fn hmget<K, F, R>(
            &self,
            _key: K,
            _fields: F,
        ) -> RedisResult<brz_redis::RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: brz_redis::EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "stub does not serve HMGET",
            ))
        }

        async fn get<K, R>(&self, key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            let _ = key;
            self.record("GET");
            Ok(None)
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            self.record("SET");
            Ok(())
        }

        async fn set_with<K, V>(&self, key: K, value: V, _options: SetOptions) -> RedisResult<bool>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            let mut command = cmd("SET");
            command.arg_encoded(key)?.arg_encoded(value)?;
            let value = (0..)
                .map_while(|index| command.arg_at(index))
                .nth(2)
                .map(|value| String::from_utf8_lossy(value).into_owned())
                .unwrap_or_default();
            self.record("SET");
            let mut written = self.written.lock().unwrap();
            written.push(value);
            Ok(written.len() > self.deny_first)
        }

        async fn append<K, V>(&self, _key: K, _value: V) -> RedisResult<i64>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            self.record("APPEND");
            Ok(0)
        }

        async fn expire<K>(&self, _key: K, _seconds: u64) -> RedisResult<bool>
        where
            K: EncodeRedisArg + Send,
        {
            self.record("EXPIRE");
            Ok(true)
        }

        async fn del_many<K>(&self, keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            let mut command = cmd("DEL");
            keys.encode_args(&mut command)?;
            let keys: Vec<String> = (1..)
                .map_while(|index| command.arg_at(index))
                .map(|value| String::from_utf8_lossy(value).into_owned())
                .collect();
            self.record("DEL");
            self.deleted.lock().unwrap().push(keys);
            Ok(0)
        }

        async fn evalsha<D, K, A, R>(&self, digest: D, keys: K, args: A) -> RedisResult<R>
        where
            D: EncodeRedisArg + Send,
            K: EncodeRedisArgs + Send,
            A: EncodeRedisArgs + Send,
            R: FromRedisValue + Send,
        {
            let mut command = cmd("EVALSHA");
            command.arg_encoded(digest)?.arg_encoded(keys.num_args())?;
            keys.encode_args(&mut command)?;
            args.encode_args(&mut command)?;
            let args: Vec<String> = (0..)
                .map_while(|index| command.arg_at(index))
                .map(|value| String::from_utf8_lossy(value).into_owned())
                .collect();
            let digest = args.get(1).cloned().unwrap_or_default();
            self.record("EVALSHA");
            self.digests.lock().unwrap().push(digest);
            self.release_args.lock().unwrap().push(args);
            if self.no_script && !*self.script_loaded.lock().unwrap() {
                return Err(brz_redis::RedisError::new(
                    brz_redis::ErrorKind::NoScript,
                    "script is not cached",
                ));
            }
            R::from_redis_value(&RedisValue::Int(1))
        }

        async fn command<R>(&self, command: Cmd) -> RedisResult<R>
        where
            R: FromRedisValue + Send,
        {
            let args: Vec<String> = (0..)
                .map_while(|index| command.arg_at(index))
                .map(|value| String::from_utf8_lossy(value).into_owned())
                .collect();
            assert_eq!(args.first().map(String::as_str), Some("SCRIPT"));
            self.record("SCRIPT LOAD");
            self.script_loads
                .lock()
                .unwrap()
                .push(args.get(2).cloned().unwrap_or_default());
            *self.script_loaded.lock().unwrap() = true;
            R::from_redis_value(&RedisValue::SimpleString("OK".to_string()))
        }
    }

    fn card_info() -> Value {
        json!({
            "channel_type": "dingtalk",
            "channel_id": 1001,
            "card_instance_id": "card-test-1",
            "chat_card": {"content_key": "content"},
            "incoming_message_data": {"msgId": "msg-test-1"},
        })
    }

    /// Records the card transport calls in order.
    #[derive(Default)]
    struct RecordingCard {
        calls: Mutex<Vec<&'static str>>,
    }

    impl RecordingCard {
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CardStream for RecordingCard {
        async fn update(&self, card: &CardRef<'_>, _content: &str) -> Result<(), String> {
            assert_eq!(card.out_track_id, "card-test-1");
            assert_eq!(card.content_key, "content");
            self.calls.lock().unwrap().push("update");
            Ok(())
        }

        async fn finish(&self, _card: &CardRef<'_>, _content: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push("finish");
            Ok(())
        }

        async fn fail(&self, _card: &CardRef<'_>, _content: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push("fail");
            Ok(())
        }
    }

    fn chunk_event() -> ExecutionEvent {
        let mut event = ExecutionEvent::new(
            crate::internal_callback::event::EventType::Chunk,
            0,
            1357134546,
        );
        event.content = "stream-ok".into();
        event
    }

    #[tokio::test]
    async fn a_chunk_takes_the_writer_lease_saves_progress_appends_and_releases() {
        let redis = StreamRedis::default();
        let card = RecordingCard::default();
        assert!(
            emit_event(
                &redis,
                &card,
                "runtime:dev:local",
                &card_info(),
                &chunk_event()
            )
            .await
        );
        assert_eq!(
            redis.ops(),
            vec![
                "GET", "SET", "GET", "GET", "SET", "APPEND", "EXPIRE", "GET", "SET", "EVALSHA"
            ]
        );
        // `_flush_pending` writes the displayed content while the lease is held.
        assert_eq!(card.calls(), vec!["update"]);
    }

    #[tokio::test]
    async fn a_terminal_turn_repeats_the_lease_and_saves_final_state() {
        let redis = StreamRedis::default();
        let card = RecordingCard::default();
        let result = json!({"value": "stream-ok"});
        assert!(
            finish(
                &redis,
                &card,
                "runtime:dev:local",
                &card_info(),
                "COMPLETED",
                Some(&result),
                None
            )
            .await
        );
        assert_eq!(
            redis.ops(),
            vec![
                "SET", "GET", "SET", "EXPIRE", "GET", "SET", "DEL", "EVALSHA", "DEL", "DEL"
            ]
        );
        // `_finish_card` updates then finishes the card, then `mark_card_ready`
        // reads the binding before the terminal marker is written.
        assert_eq!(card.calls(), vec!["update", "finish"]);
        // The first DEL clears the per-card state; `_remove_emitter` then
        // deletes the BASE shared key, and `delete_callback_info` removes the
        // registry entry.
        let deleted = redis.deleted.lock().unwrap().clone();
        assert_eq!(deleted.len(), 3);
        assert_eq!(
            deleted[0],
            vec![
                "channel:streaming_content:runtime:dev:local:card-test-1:card-test-1".to_string(),
                "channel:streaming_content:runtime:dev:local:card-test-1:card-test-1:progress"
                    .to_string(),
                "channel:streaming_content:runtime:dev:local:card-test-1:card-test-1:display-lock"
                    .to_string(),
            ]
        );
        assert_eq!(
            deleted[1],
            vec!["channel:streaming_content:runtime:dev:local".to_string()]
        );
        assert_eq!(
            deleted[2],
            vec!["channel:task_callback:dingtalk:runtime:dev:local".to_string()]
        );
    }

    #[tokio::test]
    async fn a_failed_terminal_turn_fails_the_card_after_updating_it() {
        let redis = StreamRedis::default();
        let card = RecordingCard::default();
        assert!(
            finish(
                &redis,
                &card,
                "runtime:dev:local",
                &card_info(),
                "FAILED",
                None,
                Some("boom")
            )
            .await
        );
        assert_eq!(card.calls(), vec!["update", "fail"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_denied_writer_lease_never_enters_the_shared_write() {
        let redis = StreamRedis {
            deny_first: usize::MAX,
            ..StreamRedis::default()
        };
        let card = RecordingCard::default();
        assert!(
            !emit_event(
                &redis,
                &card,
                "runtime:dev:local",
                &card_info(),
                &chunk_event()
            )
            .await
        );
        // Every bounded retry reused the same generated token, and the
        // progress save, answer append, display write and card call never ran.
        let written = redis.written.lock().unwrap().clone();
        assert!(written.len() > 1);
        assert!(
            written.iter().all(|value| value == &written[0]),
            "retries must reuse the acquisition token: {written:?}"
        );
        assert!(card.calls().is_empty());
        let ops = redis.ops();
        assert_eq!(ops.first().map(String::as_str), Some("GET"));
        assert!(ops.iter().skip(1).all(|op| op == "SET"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_contended_writer_lease_retries_then_acquires_with_the_same_token() {
        let redis = StreamRedis {
            deny_first: 1,
            ..StreamRedis::default()
        };
        let token = acquire_writer(&redis, "writer")
            .await
            .expect("the second SET NX acquires the lease");
        assert_eq!(redis.ops(), vec!["SET", "SET"]);
        let written = redis.written.lock().unwrap().clone();
        assert_eq!(written, vec![token.clone(), token]);
    }

    #[tokio::test]
    async fn release_uses_the_canonical_digest_and_only_loads_after_noscript() {
        let redis = StreamRedis {
            no_script: true,
            ..StreamRedis::default()
        };
        release_writer(&redis, "writer", "token").await;
        assert_eq!(redis.ops(), vec!["EVALSHA", "SCRIPT LOAD", "EVALSHA"]);
        assert_eq!(
            *redis.digests.lock().unwrap(),
            vec![RELEASE_SHA.to_string(), RELEASE_SHA.to_string()]
        );
        assert_eq!(
            *redis.script_loads.lock().unwrap(),
            vec![RELEASE_SCRIPT.to_string()]
        );
        // Both EVALSHA occurrences carry the acquisition key and token.
        let args = redis.release_args.lock().unwrap().clone();
        assert_eq!(args.len(), 2);
        assert!(
            args.iter()
                .all(|args| args.get(3).map(String::as_str) == Some("writer"))
        );
        assert!(
            args.iter()
                .all(|args| args.get(4).map(String::as_str) == Some("token"))
        );
    }

    #[tokio::test]
    async fn a_cached_release_sends_only_the_canonical_evalsha() {
        let redis = StreamRedis::default();
        release_writer(&redis, "writer", "token").await;
        assert_eq!(redis.ops(), vec!["EVALSHA"]);
        assert!(redis.script_loads.lock().unwrap().is_empty());
        assert_eq!(
            *redis.digests.lock().unwrap(),
            vec![RELEASE_SHA.to_string()]
        );
        assert_eq!(redis.release_args.lock().unwrap()[0][4], "token");
    }

    #[test]
    fn the_final_content_prefers_an_authoritative_result() {
        assert_eq!(
            final_content(Some(&json!({"value": "answer"})), "COMPLETED", None),
            "answer"
        );
        assert_eq!(
            final_content(
                Some(&json!({"value": "answer", "value_origin": "empty"})),
                "COMPLETED",
                None
            ),
            ""
        );
        assert_eq!(
            final_content(None, "FAILED", Some("boom")),
            "❌ 任务执行失败：boom"
        );
    }
}
