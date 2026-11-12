// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `IMNotificationDispatcher._runtime_notification_sessions`: resolve the IM
//! sessions that should receive one terminal native Runtime event.
//!
//! Source: `app/services/im/notification_dispatcher.py::_runtime_notification_sessions`
//! plus the `IMSessionService` reads it performs
//! (`app/services/im/session_service.py`):
//!
//! 1. `get_global_notification_settings(user_id)` — one
//!    `channel:user_global_notification:<user_id>` read. A disabled switch
//!    returns no sessions and issues no further query.
//! 2. `list_active_runtime_task_sessions` — the user's private-session index
//!    (`ZREVRANGE channel:user_private_sessions:<user_id>`) and one
//!    `channel:private_session:<key>` read per indexed key, keeping the
//!    sessions whose `active_runtime_task` names this device and task. Stale
//!    index members are removed with `ZREM`.
//! 3. `list_runtime_task_notification_sessions` — the runtime-task
//!    subscription document plus one session read per subscribed key.
//! 4. The user's default private session, only when a key is configured, the
//!    user is away, and the session belongs to that user.
//!
//! Every returning branch deduplicates by `session_key`, keeping the first
//! occurrence (`_dedupe_sessions`). Delivery to those sessions is a separate
//! concern; this module stops at the resolution the source performs first.

use std::collections::HashSet;
use std::fmt;

use async_trait::async_trait;
use brz_json::OpaqueJson;
use brz_redis::{Redis as _, RedisError, RedisService};
use serde_json::{Map, Value};

use crate::json_compat::{python_str, python_strip, python_truthy};
use crate::runtime_work_im_notifications::{
    GlobalNotification, PrivateSession, global_notification_key, missing_redis_error,
    normalize_subscriptions, parse_private_session, presence_key, presence_members_are_away,
    private_session_key, runtime_task_subscriptions_key, unix_seconds,
};
use crate::state::AppState;

/// `USER_PRIVATE_SESSIONS_PREFIX` (`IMSessionService._user_sessions_key`).
const USER_PRIVATE_SESSIONS_PREFIX: &str = "channel:user_private_sessions:";

/// Resolution failures reject the event ACK so the executor retains it until
/// recipient settings can be read successfully.
#[derive(Debug)]
pub(crate) enum NotificationSessionError {
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
    /// A missing document is distinct from a failed read: only the former may
    /// suppress notification delivery and acknowledge a terminal event.
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
        // Recipient decisions must observe the writer, including a preference
        // or private session saved just before this completion event.
        let value: Option<String> = self
            .redis()?
            .eval("return redis.call('GET', KEYS[1])", [key], [] as [&str; 0])
            .await?;
        value
            .map(|value| {
                OpaqueJson::from_json_text(&value).ok_or_else(|| {
                    RedisError::new(
                        brz_redis::ErrorKind::ClientError,
                        "Invalid notification settings document",
                    )
                })
            })
            .transpose()
    }

    async fn user_session_keys(&self, key: &str) -> Result<Vec<String>, RedisError> {
        self.redis()?
            .eval(
                "return redis.call('ZREVRANGE', KEYS[1], 0, -1)",
                [key],
                [] as [&str; 0],
            )
            .await
    }

    async fn remove_user_sessions(&self, key: &str, members: &[String]) -> Result<(), RedisError> {
        if members.is_empty() {
            return Ok(());
        }
        self.redis()?.zrem(key, members.to_vec()).await.map(|_| ())
    }

    async fn fresh_presence_members(&self, key: &str) -> Result<Vec<String>, RedisError> {
        self.redis()?
            .eval(
                "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); \
                 return redis.call('ZREVRANGE', KEYS[1], 0, -1)",
                [key],
                [unix_seconds()],
            )
            .await
    }
}

/// `_runtime_notification_sessions` over the application state.
pub(crate) async fn runtime_notification_sessions(
    state: &AppState,
    user_id: i64,
    address: &Value,
) -> Result<Vec<PrivateSession>, NotificationSessionError> {
    let cache = RedisNotificationSessionCache {
        redis: state.redis.as_ref(),
    };
    resolve(&cache, user_id, address).await
}

/// `_runtime_notification_sessions`: the ordered session resolution.
async fn resolve<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
    address: &Value,
) -> Result<Vec<PrivateSession>, NotificationSessionError> {
    let settings_value = cache.get_json(&global_notification_key(user_id)).await?;
    let settings = GlobalNotification::from_value(settings_value.as_ref());
    if !settings.enabled {
        return Ok(Vec::new());
    }

    // `runtime_task_notification_key` runs first in
    // `list_active_runtime_task_sessions`; an incomplete identity raises
    // `ValueError`, which `_notify_runtime_event` swallows.
    let Some(task_key) = runtime_task_notification_key(address) else {
        return Err(NotificationSessionError::InvalidTaskAddress);
    };

    let active = list_active_runtime_task_sessions(cache, user_id, &task_key).await?;
    if !active.is_empty() {
        return Ok(dedupe_sessions(active));
    }

    let subscribed = list_runtime_task_notification_sessions(cache, user_id, &task_key).await?;
    if !subscribed.is_empty() {
        return Ok(dedupe_sessions(subscribed));
    }

    let Some(session_key) = settings
        .session_key
        .as_deref()
        .filter(|key| !key.is_empty())
    else {
        return Ok(Vec::new());
    };
    if !is_user_away(cache, user_id).await? {
        return Ok(Vec::new());
    }
    let Some(session) = get_session(cache, session_key).await? else {
        return Ok(Vec::new());
    };
    if session.user_id != user_id {
        return Ok(Vec::new());
    }
    Ok(vec![session])
}

/// `runtime_task_notification_key`: `deviceId`/`device_id` and
/// `localTaskId`/`taskId`/`local_task_id`, stripped. `None` mirrors the
/// source's `ValueError` for an incomplete identity.
pub(crate) fn runtime_task_notification_key(task: &Value) -> Option<String> {
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

/// `list_active_runtime_task_sessions`: sessions whose stored
/// `active_runtime_task` names the same device and local task.
async fn list_active_runtime_task_sessions<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
    task_key: &str,
) -> Result<Vec<PrivateSession>, RedisError> {
    let sessions = list_user_sessions(cache, user_id).await?;
    Ok(sessions
        .into_iter()
        .filter(|session| {
            session.user_id == user_id
                && session
                    .active_runtime_task_object()
                    .and_then(notification_key_from_map)
                    .as_deref()
                    == Some(task_key)
        })
        .collect())
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
            Some(session) => sessions.push(session),
            None => missing.push(session_key),
        }
    }
    if !missing.is_empty() {
        cache.remove_user_sessions(&key, &missing).await?;
    }
    Ok(sessions)
}

/// `list_runtime_task_notification_sessions`: the sessions subscribed to the
/// runtime task, filtered to this user.
async fn list_runtime_task_notification_sessions<C: NotificationSessionCache + ?Sized>(
    cache: &C,
    user_id: i64,
    task_key: &str,
) -> Result<Vec<PrivateSession>, RedisError> {
    let subscriptions_value = cache
        .get_json(&runtime_task_subscriptions_key(user_id))
        .await?;
    let subscriptions = normalize_subscriptions(subscriptions_value.as_ref());
    let Some((_, session_keys)) = subscriptions.into_iter().find(|(key, _)| key == task_key) else {
        return Ok(Vec::new());
    };

    let mut sessions = Vec::with_capacity(session_keys.len());
    for session_key in session_keys {
        if let Some(session) = get_session(cache, &session_key).await?
            && session.user_id == user_id
        {
            sessions.push(session);
        }
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
#[path = "runtime_work_im_notification_session_protocol_tests.rs"]
mod protocol_tests;

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
        user_sessions: Vec<String>,
        presence: Vec<String>,
        calls: Mutex<Vec<String>>,
        fail_key: Option<String>,
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
            if self.fail_key.as_deref() == Some(key) {
                return Err(RedisError::new(
                    brz_redis::ErrorKind::ClientError,
                    "Injected read failure",
                ));
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
    async fn read_failures_require_retry_and_never_remove_a_live_session() {
        for failed in [global_notification_key(273), private_session_key("sess-1")] {
            let mut cache = RecordingCache {
                fail_key: Some(failed),
                ..Default::default()
            };
            cache
                .values
                .insert(global_notification_key(273), json!({"enabled":true}));
            cache.user_sessions = vec!["sess-1".to_owned()];
            assert!(resolve(&cache, 273, &address()).await.is_err());
            assert!(cache.calls().iter().all(|call| !call.starts_with("zrem ")));
        }
    }

    #[tokio::test]
    async fn an_active_session_in_another_users_index_cannot_receive_the_task() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            global_notification_key(273),
            json!({"enabled":true,"session_key":"own"}),
        );
        cache.user_sessions = vec!["foreign".to_owned()];
        cache.values.insert(
            private_session_key("foreign"),
            session("foreign", 274, Some(address())),
        );
        cache
            .values
            .insert(private_session_key("own"), session("own", 273, None));
        let sessions = resolve(&cache, 273, &address()).await.unwrap();
        assert_eq!(session_key(&sessions), vec!["own"]);
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

    #[tokio::test]
    async fn a_missing_switch_document_is_disabled() {
        let cache = RecordingCache::default();

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert!(sessions.is_empty());
        assert_eq!(
            cache.calls(),
            vec!["get channel:user_global_notification:273".to_owned()]
        );
    }

    #[tokio::test]
    async fn an_active_runtime_task_session_short_circuits_later_branches() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true, "session_key": "default"}),
        );
        cache.user_sessions = vec!["sess-1".into(), "sess-2".into()];
        cache.values.insert(
            "channel:private_session:sess-1".into(),
            session(
                "sess-1",
                273,
                Some(json!({"deviceId": "app-record-267161", "localTaskId": "runtime-151001115"})),
            ),
        );
        cache.values.insert(
            "channel:private_session:sess-2".into(),
            session(
                "sess-2",
                273,
                Some(json!({"deviceId": "app-record-267161", "localTaskId": "runtime-other"})),
            ),
        );

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert_eq!(session_key(&sessions), vec!["sess-1"]);
        // Active sessions win, so the subscription document, presence, and the
        // default session are never read.
        assert_eq!(
            cache.calls(),
            vec![
                "get channel:user_global_notification:273".to_owned(),
                "zrevrange channel:user_private_sessions:273".to_owned(),
                "get channel:private_session:sess-1".to_owned(),
                "get channel:private_session:sess-2".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn a_stale_session_index_member_is_removed() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true}),
        );
        cache.user_sessions = vec!["gone".into()];
        cache.values.insert(
            "channel:user_runtime_task_subscriptions:273".into(),
            json!({}),
        );

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert!(sessions.is_empty());
        assert_eq!(
            cache.calls(),
            vec![
                "get channel:user_global_notification:273".to_owned(),
                "zrevrange channel:user_private_sessions:273".to_owned(),
                "get channel:private_session:gone".to_owned(),
                "zrem channel:user_private_sessions:273 gone".to_owned(),
                "get channel:user_runtime_task_subscriptions:273".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn subscribed_sessions_win_over_the_default_session() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true, "session_key": "default"}),
        );
        cache.values.insert(
            "channel:user_runtime_task_subscriptions:273".into(),
            json!({
                "app-record-267161\u{0}runtime-151001115": ["sess-1", "sess-1", "foreign"],
                "app-record-267161\u{0}runtime-other": ["sess-9"],
            }),
        );
        cache.values.insert(
            "channel:private_session:sess-1".into(),
            session("sess-1", 273, None),
        );
        cache.values.insert(
            "channel:private_session:foreign".into(),
            session("foreign", 999, None),
        );

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        // The duplicate subscription key is read twice, then deduplicated; the
        // foreign session is dropped by its owner check.
        assert_eq!(session_key(&sessions), vec!["sess-1"]);
        assert_eq!(
            cache.calls(),
            vec![
                "get channel:user_global_notification:273".to_owned(),
                "zrevrange channel:user_private_sessions:273".to_owned(),
                "get channel:user_runtime_task_subscriptions:273".to_owned(),
                "get channel:private_session:sess-1".to_owned(),
                "get channel:private_session:sess-1".to_owned(),
                "get channel:private_session:foreign".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn the_default_session_requires_an_away_user() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true, "session_key": "default"}),
        );
        cache.presence = vec!["client-a\u{0}away".into()];
        cache.values.insert(
            "channel:private_session:default".into(),
            session("default", 273, None),
        );

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert_eq!(session_key(&sessions), vec!["default"]);
        assert_eq!(
            cache.calls(),
            vec![
                "get channel:user_global_notification:273".to_owned(),
                "zrevrange channel:user_private_sessions:273".to_owned(),
                "get channel:user_runtime_task_subscriptions:273".to_owned(),
                "presence channel:user_im_notification_presence:273".to_owned(),
                "get channel:private_session:default".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn a_foregrounded_user_gets_no_default_session() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true, "session_key": "default"}),
        );
        cache.presence = vec!["client-a\u{0}active".into()];

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert!(sessions.is_empty());
        // The presence check is the last read: the default session is skipped.
        assert_eq!(
            cache.calls().last().map(String::as_str),
            Some("presence channel:user_im_notification_presence:273")
        );
    }

    #[tokio::test]
    async fn a_missing_default_session_key_stops_before_presence() {
        let mut cache = RecordingCache::default();
        cache.values.insert(
            "channel:user_global_notification:273".into(),
            json!({"enabled": true, "session_key": ""}),
        );

        let sessions = resolve(&cache, 273, &address()).await.unwrap();

        assert!(sessions.is_empty());
        assert_eq!(
            cache.calls(),
            vec![
                "get channel:user_global_notification:273".to_owned(),
                "zrevrange channel:user_private_sessions:273".to_owned(),
                "get channel:user_runtime_task_subscriptions:273".to_owned(),
            ]
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
                active_runtime_task: None,
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
                active_runtime_task: None,
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
                active_runtime_task: None,
            },
        ];

        let deduped = dedupe_sessions(sessions);

        assert_eq!(session_key(&deduped), vec!["a", "b"]);
        assert_eq!(deduped[0].channel_type, "dingtalk");
    }
}
