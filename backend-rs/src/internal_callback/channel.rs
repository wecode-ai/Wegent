// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! IM channel callback forwarding for the execution callback.
//!
//! Mirrors `app/services/channels/callback.py`. The worker imports the
//! DingTalk and Telegram callback modules so their services register in the
//! process-wide registry; `emit_event` first probes
//! `channel:task_callback:{channel_type}:{task_id}` and returns without
//! forwarding when the key is absent. Terminal events are skipped.
use brz_redis::{Redis, RedisBytes};

use super::event::ExecutionEvent;

/// `channel:task_callback:{channel_type}:` key prefixes, in registry
/// (import) order.
const CHANNEL_KEY_PREFIXES: [&str; 2] = [
    "channel:task_callback:dingtalk:",
    "channel:task_callback:telegram:",
];

/// The registered channel key prefixes, in registry (import) order.
///
/// `status_updating.py`'s terminal handling forwards through
/// `TaskCompletedEvent`, so the completion fan-out probes the same list.
pub(crate) fn channel_key_prefixes() -> [&'static str; 2] {
    CHANNEL_KEY_PREFIXES
}

/// `forward_event_to_channel_callbacks`: probe each registered channel.
pub(crate) async fn forward_event_to_channel_callbacks<R: Redis>(
    redis: &R,
    task_id: i64,
    event: &ExecutionEvent,
) {
    if is_terminal(&event.event_type) {
        return;
    }
    for prefix in CHANNEL_KEY_PREFIXES {
        let key = format!("{prefix}{task_id}");
        match redis.get::<_, RedisBytes>(&key).await {
            Ok(Some(_)) => {
                // A registered channel with saved callback info would forward
                // the event here; the recorded traffic has none, and the
                // channel emitters themselves are outside this migration.
                tracing::debug!(channel_key = %key, "channel callback info present");
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, channel_key = %key, "channel callback probe failed");
            }
        }
    }
}

fn is_terminal(event_type: &str) -> bool {
    matches!(event_type, "done" | "error" | "cancel" | "cancelled")
}

/// `runtime_local_task_callback_key` (`channels/callback.py:40`).
pub(crate) fn runtime_local_task_callback_key(device_id: &str, local_task_id: &str) -> String {
    format!("runtime:{device_id}:{local_task_id}")
}

/// A registered IM channel (`ChannelType`, `channels/callback.py:45`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Channel {
    DingTalk,
    Telegram,
}

impl Channel {
    /// `ChannelType.value`.
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::DingTalk => "dingtalk",
            Self::Telegram => "telegram",
        }
    }

    /// `ChannelType(value)`; an unknown name is not registered.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "dingtalk" => Some(Self::DingTalk),
            "telegram" => Some(Self::Telegram),
            _ => None,
        }
    }
}

/// The registry's services in import order (`main.py` imports the DingTalk
/// callback module before the Telegram one).
pub(crate) const REGISTERED_CHANNELS: [Channel; 2] = [Channel::DingTalk, Channel::Telegram];

/// `CallbackRegistry.get_service_by_name`.
pub(crate) fn get_service_by_name(channel_type_name: &str) -> Option<Channel> {
    Channel::from_name(channel_type_name)
}

/// One channel's saved callback document (`service.get_callback_info`).
pub(crate) async fn callback_info<R: Redis>(
    redis: &R,
    channel: Channel,
    task_key: &str,
) -> Option<serde_json::Value> {
    let key = format!("channel:task_callback:{}:{task_key}", channel.name());
    match redis.get::<_, RedisBytes>(&key).await {
        Ok(Some(bytes)) => parse_callback_document(&bytes),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, channel_key = %key, "channel callback read failed");
            None
        }
    }
}

/// Decode the saved callback value.
///
/// `BaseChannelCallbackService.save_callback_info` serializes the document with
/// `json.dumps` and stores the resulting string through `cache_manager.set`,
/// whose own JSON encoding wraps it a second time. The read path therefore
/// unwraps both layers: the stored value is a JSON string containing the JSON
/// object. A native object payload is still accepted for callers that store
/// the document directly.
fn parse_callback_document(bytes: &[u8]) -> Option<serde_json::Value> {
    let outer = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let document = match outer {
        serde_json::Value::Object(_) => outer,
        serde_json::Value::String(inner) => serde_json::from_str(&inner).ok()?,
        _ => return None,
    };
    document.is_object().then_some(document)
}

/// `DingTalkCallbackService.accepts_runtime_source`
/// (`dingtalk/callback.py:125`): reject an event from an older local-runtime
/// turn once the card is bound to a specific incoming message.
pub(crate) async fn dingtalk_accepts_runtime_source<R: Redis>(
    redis: &R,
    task_key: &str,
    source: &serde_json::Value,
) -> bool {
    let Some(info) = callback_info(redis, Channel::DingTalk, task_key).await else {
        return true;
    };
    let chat_card = info.get("chat_card");
    if !chat_card.is_some_and(truthy) {
        return true;
    }
    let incoming_message = info
        .get("incoming_message_data")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let source_message = source.get("message_id");
    source_message.is_some_and(truthy)
        && source_message == incoming_message.get("msgId")
        && source.get("channel_id")
            == Some(info.get("channel_id").unwrap_or(&serde_json::Value::Null))
}

/// `BaseChannelCallbackService.accepts_runtime_source`: only DingTalk adds a
/// freshness gate.
pub(crate) async fn accepts_runtime_source<R: Redis>(
    redis: &R,
    channel: Channel,
    task_key: &str,
    source: &serde_json::Value,
) -> bool {
    match channel {
        Channel::DingTalk => dingtalk_accepts_runtime_source(redis, task_key, source).await,
        Channel::Telegram => true,
    }
}

/// Per-channel delivery, the boundary where the DingTalk card emitter and the
/// Telegram sender live. The Source runs them inside the services; the port
/// keeps the registry's routing and gates here and leaves the emitter itself to
/// its own module. Tests substitute a recording double.
pub(crate) trait ChannelDelivery {
    async fn emit_event(
        &self,
        channel: Channel,
        task_key: &str,
        subtask_id: i64,
        callback_info: Option<&serde_json::Value>,
        event: &ExecutionEvent,
    ) -> bool;

    #[allow(
        clippy::too_many_arguments,
        reason = "mirrors the channel result callback"
    )]
    async fn send_task_result(
        &self,
        channel: Channel,
        task_key: &str,
        subtask_id: i64,
        callback_info: Option<&serde_json::Value>,
        status: &str,
        result: Option<&serde_json::Value>,
        error: Option<&str>,
    ) -> bool;
}

/// The registered production channel emitters.
pub(crate) struct RuntimeChannelDelivery<'a, R: Redis, C: super::dingtalk_card::CardStream> {
    pub(crate) state: &'a crate::state::AppState,
    pub(crate) redis: &'a R,
    pub(crate) card: &'a C,
    pub(crate) source_message_id: Option<String>,
}

impl<R: Redis, C: super::dingtalk_card::CardStream> RuntimeChannelDelivery<'_, R, C> {
    fn telegram_turn_key(&self, task_key: &str) -> String {
        let source = self.source_message_id.as_deref().unwrap_or("");
        format!("{task_key}:{source}")
    }
}

impl<R: Redis, C: super::dingtalk_card::CardStream> ChannelDelivery
    for RuntimeChannelDelivery<'_, R, C>
{
    async fn emit_event(
        &self,
        channel: Channel,
        task_key: &str,
        subtask_id: i64,
        callback_info: Option<&serde_json::Value>,
        event: &ExecutionEvent,
    ) -> bool {
        let Some(info) = callback_info else {
            return false;
        };
        match channel {
            Channel::DingTalk => {
                super::dingtalk_stream::emit_event(self.redis, self.card, task_key, info, event)
                    .await
            }
            Channel::Telegram => {
                telegram::stream(
                    self.state,
                    self.redis,
                    &self.telegram_turn_key(task_key),
                    subtask_id,
                    info,
                    event,
                )
                .await
            }
        }
    }

    async fn send_task_result(
        &self,
        channel: Channel,
        task_key: &str,
        subtask_id: i64,
        callback_info: Option<&serde_json::Value>,
        status: &str,
        result: Option<&serde_json::Value>,
        error: Option<&str>,
    ) -> bool {
        let Some(info) = callback_info else {
            return false;
        };
        match channel {
            Channel::DingTalk => {
                super::dingtalk_stream::finish(
                    self.redis, self.card, task_key, info, status, result, error,
                )
                .await
            }
            Channel::Telegram => {
                let text = telegram::terminal_text(status, result, error);
                telegram::finish(
                    self.state,
                    self.redis,
                    &self.telegram_turn_key(task_key),
                    subtask_id,
                    info,
                    &text,
                    status,
                )
                .await
            }
        }
    }
}

#[path = "telegram_stream.rs"]
mod telegram;

/// `_is_current_card_round`: a card-bound channel only accepts the card's
/// active round. Runtime addresses use subtask `0`, so the Source's
/// `card_subtask_id in (None, 0, subtask_id)` accepts a stored zero for every
/// turn.
fn is_current_card_round(info: Option<&serde_json::Value>, subtask_id: i64) -> bool {
    let Some(info) = info else {
        return true;
    };
    if !info.get("chat_card").is_some_and(truthy) {
        return true;
    }
    match info.get("card_subtask_id") {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Number(number)) => number
            .as_i64()
            .is_some_and(|card_subtask_id| card_subtask_id == 0 || card_subtask_id == subtask_id),
        Some(_) => false,
    }
}

/// `forward_event_to_channel_callbacks` for a runtime local-task key.
pub(crate) async fn forward_event_to_channel_callbacks_for_key<R: Redis, D: ChannelDelivery>(
    redis: &R,
    delivery: &D,
    task_key: &str,
    subtask_id: i64,
    event: &ExecutionEvent,
) -> bool {
    let mut forwarded = false;
    for channel in REGISTERED_CHANNELS {
        forwarded |= emit_to_channel(redis, delivery, channel, task_key, subtask_id, event).await;
    }
    forwarded
}

/// One service's `emit_event`: terminal skip, callback-info fast path, the
/// DingTalk card-round gate, then the channel emitter.
async fn emit_to_channel<R: Redis, D: ChannelDelivery>(
    redis: &R,
    delivery: &D,
    channel: Channel,
    task_key: &str,
    subtask_id: i64,
    event: &ExecutionEvent,
) -> bool {
    if is_terminal(&event.event_type) {
        return false;
    }
    let key = format!("channel:task_callback:{}:{task_key}", channel.name());
    let callback = match redis.get::<_, RedisBytes>(&key).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return false,
        Err(error) => {
            tracing::warn!(%error, channel_key = %key, "channel callback probe failed");
            return false;
        }
    };
    let info = if channel == Channel::DingTalk {
        let info = callback_info(redis, channel, task_key).await;
        if !is_current_card_round(info.as_ref(), subtask_id) {
            return false;
        }
        info
    } else {
        parse_callback_document(&callback)
    };
    delivery
        .emit_event(channel, task_key, subtask_id, info.as_ref(), event)
        .await
}

/// `ChannelCallbackRegistry.handle_task_completed`: probe every registered
/// service and send the terminal result to each one that has callback info.
pub(crate) async fn handle_task_completed<R: Redis, D: ChannelDelivery>(
    redis: &R,
    delivery: &D,
    task_key: &str,
    subtask_id: i64,
    status: &str,
    result: Option<&serde_json::Value>,
    error: Option<&str>,
) -> bool {
    let mut sent_any = false;
    for channel in REGISTERED_CHANNELS {
        let Some(info) = callback_info(redis, channel, task_key).await else {
            continue;
        };
        let base_info = if channel == Channel::DingTalk {
            let Some(info) = dingtalk_task_result_gates(redis, task_key, subtask_id).await else {
                continue;
            };
            Some(info)
        } else {
            Some(info)
        };
        if delivery
            .send_task_result(
                channel,
                task_key,
                subtask_id,
                base_info.as_ref(),
                status,
                result,
                error,
            )
            .await
        {
            sent_any = true;
        }
    }
    sent_any
}

/// `DingTalkCallbackService.send_task_result`'s read chain before the base
/// service runs: the active-round gate then the emitter lookup. The base
/// `send_task_result` reads the callback info again, so the Source performs
/// four reads for a bound card.
async fn dingtalk_task_result_gates<R: Redis>(
    redis: &R,
    task_key: &str,
    subtask_id: i64,
) -> Option<serde_json::Value> {
    let info = callback_info(redis, Channel::DingTalk, task_key).await;
    if !is_current_card_round(info.as_ref(), subtask_id) {
        return None;
    }
    let _emitter_info = callback_info(redis, Channel::DingTalk, task_key).await;
    callback_info(redis, Channel::DingTalk, task_key).await
}

/// Python truthiness for the JSON values the gates read.
fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(value) => !value.is_empty(),
        serde_json::Value::Object(value) => !value.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use brz_redis::{EncodeRedisArg, FromRedisBulk, RedisResult};
    use serde_json::json;

    /// One queued `GET` outcome.
    enum Read {
        Hit(&'static str),
        Miss,
    }

    /// Serves queue-ordered `GET` outcomes and records the keys-agnostic reads.
    struct QueueRedis {
        reads: Mutex<Vec<Read>>,
        count: Mutex<usize>,
    }

    impl QueueRedis {
        fn new(reads: Vec<Read>) -> Self {
            Self {
                reads: Mutex::new(reads),
                count: Mutex::new(0),
            }
        }
        fn reads(&self) -> usize {
            *self.count.lock().unwrap()
        }
    }

    impl Redis for QueueRedis {
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

        async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            *self.count.lock().unwrap() += 1;
            let next = {
                let mut reads = self.reads.lock().unwrap();
                if reads.is_empty() {
                    Read::Miss
                } else {
                    reads.remove(0)
                }
            };
            match next {
                Read::Miss => Ok(None),
                Read::Hit(value) => {
                    R::from_redis_bulk(RedisBytes::from(value.as_bytes().to_vec())).map(Some)
                }
            }
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            Ok(())
        }

        async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: brz_redis::EncodeRedisArgs + Send,
        {
            Ok(0)
        }
    }

    #[derive(Default)]
    struct RecordingDelivery {
        emitted: Mutex<Vec<(Channel, String)>>,
        sent: Mutex<Vec<(Channel, String)>>,
    }

    impl ChannelDelivery for RecordingDelivery {
        async fn emit_event(
            &self,
            channel: Channel,
            task_key: &str,
            _subtask_id: i64,
            _callback_info: Option<&serde_json::Value>,
            _event: &ExecutionEvent,
        ) -> bool {
            self.emitted
                .lock()
                .unwrap()
                .push((channel, task_key.to_string()));
            true
        }

        async fn send_task_result(
            &self,
            channel: Channel,
            task_key: &str,
            _subtask_id: i64,
            _callback_info: Option<&serde_json::Value>,
            _status: &str,
            _result: Option<&serde_json::Value>,
            _error: Option<&str>,
        ) -> bool {
            self.sent
                .lock()
                .unwrap()
                .push((channel, task_key.to_string()));
            true
        }
    }

    fn event(kind: crate::internal_callback::event::EventType) -> ExecutionEvent {
        ExecutionEvent::new(kind, 0, 7)
    }

    fn card_info(msg: &str, card_subtask: Option<i64>) -> String {
        let mut info = json!({
            "channel_type": "dingtalk",
            "channel_id": 2098751540,
            "card_instance_id": "card-1",
            "chat_card": {"content_key": "content"},
            "incoming_message_data": {"msgId": msg},
        });
        if let Some(id) = card_subtask {
            info["card_subtask_id"] = json!(id);
        }
        info.to_string()
    }

    #[tokio::test]
    async fn the_dingtalk_freshness_gate_compares_the_source_message_and_channel() {
        let redis = QueueRedis::new(vec![Read::Hit(Box::leak(
            card_info("msg-1", None).into_boxed_str(),
        ))]);
        let source = json!({"message_id": "msg-old", "channel_id": 2098751540});
        assert!(!accepts_runtime_source(&redis, Channel::DingTalk, "runtime:d:l", &source).await);

        let redis = QueueRedis::new(vec![Read::Hit(Box::leak(
            card_info("msg-1", None).into_boxed_str(),
        ))]);
        let source = json!({"message_id": "msg-1", "channel_id": 2098751540});
        assert!(accepts_runtime_source(&redis, Channel::DingTalk, "runtime:d:l", &source).await);

        // An unbound card has no freshness constraint.
        let redis = QueueRedis::new(vec![Read::Hit("{\"chat_card\": null}")]);
        assert!(accepts_runtime_source(&redis, Channel::DingTalk, "runtime:d:l", &source).await);
    }

    #[tokio::test]
    async fn non_terminal_events_probe_each_service_and_emit_through_the_dingtalk_card() {
        let info = Box::leak(card_info("msg-1", None).into_boxed_str());
        let redis = QueueRedis::new(vec![Read::Hit(info), Read::Hit(info)]);
        let delivery = RecordingDelivery::default();
        assert!(
            forward_event_to_channel_callbacks_for_key(
                &redis,
                &delivery,
                "runtime:d:l",
                7,
                &event(crate::internal_callback::event::EventType::Chunk),
            )
            .await
        );
        assert_eq!(redis.reads(), 3);
        assert_eq!(
            delivery.emitted.lock().unwrap().as_slice(),
            &[(Channel::DingTalk, "runtime:d:l".to_string())]
        );
    }

    #[tokio::test]
    async fn a_stale_card_round_skips_the_stream_and_terminal_fan_out_uses_the_base_info() {
        let info = Box::leak(card_info("msg-1", Some(99)).into_boxed_str());
        let redis = QueueRedis::new(vec![Read::Hit(info), Read::Hit(info)]);
        let delivery = RecordingDelivery::default();
        assert!(
            !forward_event_to_channel_callbacks_for_key(
                &redis,
                &delivery,
                "runtime:d:l",
                7,
                &event(crate::internal_callback::event::EventType::Chunk),
            )
            .await
        );
        assert!(delivery.emitted.lock().unwrap().is_empty());

        let info = Box::leak(card_info("msg-1", Some(7)).into_boxed_str());
        let redis = QueueRedis::new(vec![
            Read::Hit(info),
            Read::Hit(info),
            Read::Hit(info),
            Read::Hit(info),
        ]);
        assert!(
            handle_task_completed(
                &redis,
                &delivery,
                "runtime:d:l",
                7,
                "COMPLETED",
                Some(&json!({"value": "done"})),
                None,
            )
            .await
        );
        assert_eq!(redis.reads(), 5);
        assert_eq!(
            delivery.sent.lock().unwrap().as_slice(),
            &[(Channel::DingTalk, "runtime:d:l".to_string())]
        );
    }

    #[test]
    fn a_runtime_card_round_stored_as_zero_accepts_every_turn() {
        let info = json!({"chat_card": {"content_key": "content"}, "card_subtask_id": 0});
        assert!(is_current_card_round(Some(&info), 7));
        assert!(is_current_card_round(Some(&info), 12_345));
        let stale = json!({"chat_card": {"content_key": "content"}, "card_subtask_id": 99});
        assert!(!is_current_card_round(Some(&stale), 7));
        assert!(is_current_card_round(Some(&stale), 99));
    }

    #[test]
    fn the_callback_reader_unwraps_the_source_double_encoding() {
        let document = json!({
            "channel_type": "dingtalk",
            "channel_id": 2098751540,
            "card_instance_id": "card-1",
            "chat_card": {"content_key": "content"},
            "card_subtask_id": 0,
        });
        // `save_callback_info` -> `cache_manager.set` stores a JSON string
        // whose contents are the serialized document.
        let source = serde_json::to_vec(&serde_json::to_string(&document).unwrap()).unwrap();
        assert_eq!(parse_callback_document(&source), Some(document.clone()));

        // A natively stored object is still accepted.
        let plain = serde_json::to_vec(&document).unwrap();
        assert_eq!(parse_callback_document(&plain), Some(document));

        // A string that does not contain an object is not a callback document.
        assert_eq!(parse_callback_document(br#""plain text""#), None);
        assert_eq!(parse_callback_document(b"[]"), None);
    }
}
