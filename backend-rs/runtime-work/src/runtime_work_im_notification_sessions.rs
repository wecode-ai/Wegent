// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tasks and stand-ins share the account's registered private IM connections.
//! Task subscriptions control foreground delivery, never the recipient list.

use std::collections::HashSet;
use std::fmt;

use async_trait::async_trait;
use brz_json::OpaqueJson;
use brz_redis::{Redis as _, RedisBytes, RedisError, RedisService};
use serde_json::{Map, Value};

use crate::json_compat::{python_str, python_strip, python_truthy};
use crate::runtime_work_im_notifications::{
    GlobalNotification, PrivateSession, decode_json, global_notification_key, missing_redis_error,
    normalize_subscriptions, parse_private_session, presence_key, presence_members_are_away,
    private_session_key, runtime_task_subscriptions_key, unix_seconds,
};

/// `USER_PRIVATE_SESSIONS_PREFIX` (`IMSessionService._user_sessions_key`).
const USER_PRIVATE_SESSIONS_PREFIX: &str = "channel:user_private_sessions:";

/// Resolution failures reach the source's best-effort `except Exception`
/// boundary in `_notify_runtime_event`: the caller logs and stops.
#[derive(Debug)]
pub enum NotificationSessionError {
    /// `runtime_task_notification_key` raising `ValueError` for an incomplete
    /// device/task identity.
    InvalidTaskAddress,
    /// A sorted-set read or write raised.
    Redis(RedisError),
}

impl fmt::Display for NotificationSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTaskAddress => formatter
                .write_str("Runtime task notification identity requires deviceId and localTaskId"),
            Self::Redis(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for NotificationSessionError {}

impl From<RedisError> for NotificationSessionError {
    fn from(error: RedisError) -> Self {
        Self::Redis(error)
    }
}

/// The cache operations `_runtime_notification_sessions` depends on.
///
/// The production implementation is the application's shared Redis service;
/// tests substitute a recorder so the read order — in particular that a
/// disabled switch stops before every session query — is observable without a
/// live server.
#[async_trait]
pub(crate) trait NotificationSessionCache: Send + Sync {
    /// Missing keys are distinct from read failures so an unreadable off switch
    /// cannot enable delivery through the default-on setting.
    async fn get_json(&self, key: &str) -> Result<Option<OpaqueJson>, RedisError>;

    /// `_list_user_session_keys`: `ZREVRANGE key 0 -1`.
    async fn user_session_keys(&self, key: &str) -> Result<Vec<String>, RedisError>;

    /// `_remove_user_sessions`: `ZREM` of the indexed keys without a session.
    async fn remove_user_sessions(&self, key: &str, members: &[String]) -> Result<(), RedisError>;

    /// `_fresh_im_notification_presence_members`: `ZREMRANGEBYSCORE key -inf
    /// now`, then `ZREVRANGE key 0 -1`.
    async fn fresh_presence_members(&self, key: &str) -> Result<Vec<String>, RedisError>;
}

/// `cache_manager` over the process-lifetime Redis service.
struct RedisNotificationSessionCache<'a> {
    redis: Option<&'a RedisService>,
}

impl RedisNotificationSessionCache<'_> {
    fn redis(&self) -> Result<&RedisService, RedisError> {
        self.redis.ok_or_else(missing_redis_error)
    }
}

#[async_trait]
impl NotificationSessionCache for RedisNotificationSessionCache<'_> {
    async fn get_json(&self, key: &str) -> Result<Option<OpaqueJson>, RedisError> {
        let bytes: Option<RedisBytes> = self.redis()?.get(key).await?;
        bytes
            .map(|bytes| {
                decode_json(bytes.as_ref()).ok_or_else(|| {
                    RedisError::new(
                        brz_redis::ErrorKind::ClientError,
                        "Invalid private IM cache document",
                    )
                })
            })
            .transpose()
    }

    async fn user_session_keys(&self, key: &str) -> Result<Vec<String>, RedisError> {
        self.redis()?.zrevrange(key, 0, -1).await
    }

    async fn remove_user_sessions(&self, key: &str, members: &[String]) -> Result<(), RedisError> {
        if members.is_empty() {
            return Ok(());
        }
        self.redis()?.zrem(key, members.to_vec()).await.map(|_| ())
    }

    async fn fresh_presence_members(&self, key: &str) -> Result<Vec<String>, RedisError> {
        let redis = self.redis()?;
        redis.zremrangebyscore(key, "-inf", unix_seconds()).await?;
        redis.zrevrange(key, 0, -1).await
    }
}

/// `_runtime_notification_sessions` over the shared Redis connection.
pub async fn runtime_notification_sessions(
    redis: Option<&RedisService>,
    user_id: i64,
    address: &Value,
) -> Result<Vec<PrivateSession>, NotificationSessionError> {
    let cache = RedisNotificationSessionCache { redis };
    resolve(&cache, user_id, address).await
}

/// Questions reach existing connections even while the desktop is active.
pub async fn runtime_question_sessions(
    redis: Option<&RedisService>,
    user_id: i64,
    address: &Value,
) -> Result<Vec<PrivateSession>, NotificationSessionError> {
    let cache = RedisNotificationSessionCache { redis };
    resolve_with_presence(&cache, user_id, address, false).await
}

/// `_runtime_notification_sessions`: the ordered session resolution.
async fn resolve<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
    address: &Value,
) -> Result<Vec<PrivateSession>, NotificationSessionError> {
    resolve_with_presence(cache, user_id, address, true).await
}

async fn resolve_with_presence<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
    address: &Value,
    require_away: bool,
) -> Result<Vec<PrivateSession>, NotificationSessionError> {
    let settings_value = cache.get_json(&global_notification_key(user_id)).await?;
    let settings = GlobalNotification::from_value(settings_value.as_ref());
    if !settings.enabled {
        return Ok(Vec::new());
    }

    let Some(task_key) = runtime_task_notification_key(address) else {
        return Err(NotificationSessionError::InvalidTaskAddress);
    };

    let subscriptions = cache
        .get_json(&runtime_task_subscriptions_key(user_id))
        .await?;
    let foreground = normalize_subscriptions(subscriptions.as_ref())
        .iter()
        .any(|(key, sessions)| key == &task_key && !sessions.is_empty());
    if require_away && !foreground && !is_user_away(cache, user_id).await? {
        return Ok(Vec::new());
    }
    Ok(dedupe_sessions(list_user_sessions(cache, user_id).await?))
}

/// `runtime_task_notification_key`: `deviceId`/`device_id` and
/// `localTaskId`/`taskId`/`local_task_id`, stripped. `None` mirrors the
/// source's `ValueError` for an incomplete identity.
pub fn runtime_task_notification_key(task: &Value) -> Option<String> {
    task.as_object().and_then(notification_key_from_map)
}

/// The mapping half of `runtime_task_notification_key`, used for a stored
/// `active_runtime_task` document.
fn notification_key_from_map(task: &Map<String, Value>) -> Option<String> {
    let device_id = first_truthy_field(task, &["deviceId", "device_id"]);
    let local_task_id = first_truthy_field(task, &["localTaskId", "taskId", "local_task_id"]);
    (!device_id.is_empty() && !local_task_id.is_empty())
        .then(|| format!("{device_id}\u{0}{local_task_id}"))
}

/// `value.get(first) or value.get(second) or ""` followed by `str(...)` and
/// `.strip()`. The `or` chain selects on truthiness before stripping, so a
/// whitespace-only value yields an empty string instead of falling through.
fn first_truthy_field(task: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = task.get(*key)
            && python_truthy(value)
        {
            return python_strip(&python_str(value));
        }
    }
    String::new()
}

/// `list_user_sessions`: the user's private-session index and one session read
/// per member, dropping (and un-indexing) members whose session is gone.
async fn list_user_sessions<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
) -> Result<Vec<PrivateSession>, RedisError> {
    let key = user_sessions_key(user_id);
    let session_keys = cache.user_session_keys(&key).await?;
    let mut sessions = Vec::with_capacity(session_keys.len());
    let mut missing = Vec::new();
    for session_key in session_keys {
        match get_session(cache, &session_key).await? {
            Some(session) if session.user_id == user_id => sessions.push(session),
            _ => missing.push(session_key),
        }
    }
    if !missing.is_empty() {
        cache.remove_user_sessions(&key, &missing).await?;
    }
    Ok(sessions)
}

/// `is_user_away_for_im_notifications`: away when no fresh presence member is
/// foregrounded.
async fn is_user_away<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
) -> Result<bool, RedisError> {
    let members = cache.fresh_presence_members(&presence_key(user_id)).await?;
    Ok(presence_members_are_away(&members))
}

/// `get_session`: one cached private session, `None` when missing or
/// unparsable.
async fn get_session<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    session_key: &str,
) -> Result<Option<PrivateSession>, RedisError> {
    let value = cache.get_json(&private_session_key(session_key)).await?;
    Ok(parse_private_session(value.as_ref()))
}

/// `_dedupe_sessions`: keep the first session per `session_key`.
fn dedupe_sessions(sessions: Vec<PrivateSession>) -> Vec<PrivateSession> {
    let mut seen = HashSet::with_capacity(sessions.len());
    sessions
        .into_iter()
        .filter(|session| seen.insert(session.session_key.clone()))
        .collect()
}

/// `IMSessionService._user_sessions_key`.
fn user_sessions_key(user_id: i64) -> String {
    format!("{USER_PRIVATE_SESSIONS_PREFIX}{user_id}")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    /// Records every cache touch so the resolution order is observable.
    #[derive(Default)]
    struct RecordingCache {
        values: HashMap<String, Value>,
        failed_key: Option<String>,
        user_sessions: Vec<String>,
        presence: Vec<String>,
        calls: Mutex<Vec<String>>,
    }

    impl RecordingCache {
        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl NotificationSessionCache for RecordingCache {
        async fn get_json(&self, key: &str) -> Result<Option<OpaqueJson>, RedisError> {
            self.record(format!("get {key}"));
            if self.failed_key.as_deref() == Some(key) {
                return Err(missing_redis_error());
            }
            Ok(self
                .values
                .get(key)
                .map(|value| OpaqueJson::from(value.clone())))
        }

        async fn user_session_keys(&self, key: &str) -> Result<Vec<String>, RedisError> {
            self.record(format!("zrevrange {key}"));
            Ok(self.user_sessions.clone())
        }

        async fn remove_user_sessions(
            &self,
            key: &str,
            members: &[String],
        ) -> Result<(), RedisError> {
            self.record(format!("zrem {key} {}", members.join(",")));
            Ok(())
        }

        async fn fresh_presence_members(&self, key: &str) -> Result<Vec<String>, RedisError> {
            self.record(format!("presence {key}"));
            Ok(self.presence.clone())
        }
    }

    fn session(session_key: &str, user_id: i64, active_runtime_task: Option<Value>) -> Value {
        let mut object = json!({
            "session_key": session_key,
            "user_id": user_id,
            "channel_type": "dingtalk",
            "channel_id": 42,
            "conversation_id": "conv",
            "sender_id": "sender",
            "display_name": "Name",
        });
        if let Some(active_runtime_task) = active_runtime_task {
            object
                .as_object_mut()
                .unwrap()
                .insert("active_runtime_task".into(), active_runtime_task);
        }
        object
    }

    fn address() -> Value {
        json!({"deviceId": "app-record-267161", "localTaskId": "runtime-151001115"})
    }

    fn session_key(sessions: &[PrivateSession]) -> Vec<&str> {
        sessions
            .iter()
            .map(|session| session.session_key.as_str())
            .collect()
    }

    #[tokio::test]
    async fn a_disabled_switch_stops_before_any_session_query() {
        // The recorded case: the user's switch is off, so the source reads it
        // once and returns [] without indexing sessions, reading subscriptions,
        // or checking presence.
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": false, "session_key": "sess-1"}),
        );
        cache.user_sessions = vec!["sess-1".into()];
        cache.presence = vec!["client-a\u{0}active".into()];

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert!(sessions.is_empty());
        assert_eq!(
            cache.calls(),
            vec!["get channel:user_global_notification:273".to_owned()]
        );
    }

    fn shared_cache() -> RecordingCache {
        let mut cache = RecordingCache {
            user_sessions: vec!["telegram".into(), "dingtalk".into()],
            ..RecordingCache::default()
        };
        for key in ["telegram", "dingtalk"] {
            cache.values.insert(
                format!("channel:private_session:{key}"),
                session(key, 273, None),
            );
        }
        cache
    }

    #[tokio::test]
    async fn existing_connections_work_without_settings_or_target_selection() {
        let cache = shared_cache();
        assert_eq!(
            session_key(&resolve(&cache, 273, &address()).await.unwrap()),
            vec!["telegram", "dingtalk"]
        );
    }

    #[tokio::test]
    async fn unreadable_settings_do_not_enable_default_delivery() {
        let mut cache = shared_cache();
        cache.failed_key = Some("channel:user_global_notification:273".into());
        assert!(
            resolve_with_presence(&cache, 273, &address(), false)
                .await
                .is_err()
        );
        assert_eq!(
            cache.calls(),
            vec!["get channel:user_global_notification:273"]
        );
    }

    #[tokio::test]
    async fn legacy_target_and_active_task_do_not_limit_shared_connections() {
        let mut cache = shared_cache();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled":true,"session_key":"telegram"}),
        );
        cache.values.insert(
            "channel:private_session:telegram".into(),
            session("telegram", 273, Some(address())),
        );
        assert_eq!(
            session_key(&resolve(&cache, 273, &address()).await.unwrap()),
            vec!["telegram", "dingtalk"]
        );
    }

    #[tokio::test]
    async fn foreground_notifications_require_subscription_but_not_a_selected_recipient() {
        let mut cache = shared_cache();
        cache.presence = vec!["client-a\u{0}active".into()];
        assert!(resolve(&cache, 273, &address()).await.unwrap().is_empty());
        cache.values.insert(
            "channel:user_runtime_task_subscriptions:273".into(),
            json!({"app-record-267161\u{0}runtime-151001115":["telegram"]}),
        );
        assert_eq!(
            session_key(&resolve(&cache, 273, &address()).await.unwrap()),
            vec!["telegram", "dingtalk"]
        );
    }

    #[tokio::test]
    async fn questions_reach_all_existing_connections_while_desktop_is_active() {
        let mut cache = shared_cache();
        cache.presence = vec!["client-a\u{0}active".into()];
        assert_eq!(
            session_key(
                &resolve_with_presence(&cache, 273, &address(), false)
                    .await
                    .unwrap()
            ),
            vec!["telegram", "dingtalk"]
        );
        assert!(
            !cache
                .calls()
                .iter()
                .any(|call| call.starts_with("presence "))
        );
    }

    #[tokio::test]
    async fn stale_and_foreign_connections_are_removed_and_duplicates_deliver_once() {
        let mut cache = shared_cache();
        cache.user_sessions = vec![
            "telegram".into(),
            "foreign".into(),
            "gone".into(),
            "telegram".into(),
        ];
        cache.values.insert(
            "channel:private_session:foreign".into(),
            session("foreign", 999, None),
        );
        assert_eq!(
            session_key(&resolve(&cache, 273, &address()).await.unwrap()),
            vec!["telegram"]
        );
        assert!(
            cache
                .calls()
                .contains(&"zrem channel:user_private_sessions:273 foreign,gone".to_owned())
        );
    }

    #[tokio::test]
    async fn questions_respect_an_explicitly_disabled_switch() {
        let mut cache = shared_cache();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled":false}),
        );
        assert!(
            resolve_with_presence(&cache, 273, &address(), false)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            cache.calls(),
            vec!["get channel:user_global_notification:273"]
        );
    }

    #[tokio::test]
    async fn an_incomplete_address_is_an_error_after_the_switch_read() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true}),
        );

        let error = resolve(&cache, 273, &json!({"deviceId": "d"})).await;
        assert!(matches!(
            error,
            Err(NotificationSessionError::InvalidTaskAddress)
        ));
        assert_eq!(
            cache.calls(),
            vec!["get channel:user_global_notification:273".to_owned()]
        );
    }

    #[test]
    fn the_task_key_accepts_the_source_aliases() {
        assert_eq!(
            runtime_task_notification_key(&json!({
                "deviceId": "device-a",
                "localTaskId": "runtime-1",
            })),
            Some("device-a\u{0}runtime-1".to_owned())
        );
        assert_eq!(
            runtime_task_notification_key(&json!({
                "device_id": "device-a",
                "taskId": "runtime-1",
            })),
            Some("device-a\u{0}runtime-1".to_owned())
        );
        assert_eq!(
            runtime_task_notification_key(&json!({
                "deviceId": "device-a",
                "local_task_id": "runtime-1",
            })),
            Some("device-a\u{0}runtime-1".to_owned())
        );
    }

    #[test]
    fn the_task_key_strips_and_rejects_incomplete_identities() {
        assert_eq!(
            runtime_task_notification_key(&json!({
                "deviceId": "  device-a  ",
                "localTaskId": "  runtime-1  ",
            })),
            Some("device-a\u{0}runtime-1".to_owned())
        );
        assert_eq!(
            runtime_task_notification_key(&json!({"deviceId": "device-a"})),
            None
        );
        assert_eq!(
            runtime_task_notification_key(&json!({"localTaskId": "runtime-1"})),
            None
        );
        assert_eq!(
            runtime_task_notification_key(&json!({"deviceId": "  ", "localTaskId": "runtime-1"})),
            None
        );
        assert_eq!(runtime_task_notification_key(&json!("text")), None);
    }

    #[test]
    fn dedupe_keeps_the_first_session_per_key() {
        let sessions = vec![
            PrivateSession {
                session_key: "a".into(),
                user_id: 1,
                channel_type: "dingtalk".into(),
                channel_id: 1,
                conversation_id: "c".into(),
                sender_id: "s".into(),
                display_name: String::new(),
                proactive_recipient_id: None,
            },
            PrivateSession {
                session_key: "a".into(),
                user_id: 1,
                channel_type: "telegram".into(),
                channel_id: 2,
                conversation_id: "c".into(),
                sender_id: "s".into(),
                display_name: String::new(),
                proactive_recipient_id: None,
            },
            PrivateSession {
                session_key: "b".into(),
                user_id: 1,
                channel_type: "dingtalk".into(),
                channel_id: 3,
                conversation_id: "c".into(),
                sender_id: "s".into(),
                display_name: String::new(),
                proactive_recipient_id: None,
            },
        ];

        let deduped = dedupe_sessions(sessions);

        assert_eq!(session_key(&deduped), vec!["a", "b"]);
        assert_eq!(deduped[0].channel_type, "dingtalk");
    }
}
