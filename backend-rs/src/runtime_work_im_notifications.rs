// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/runtime-work/im-notifications` — the Wework runtime IM
//! notification settings.
//!
//! Mirrors `app.api.endpoints.runtime_work.get_im_notification_settings_endpoint`
//! (router prefix `/runtime-work` mounted under the app prefix `/api`) and
//! `runtime_work_service.get_im_notification_settings`. The endpoint reads only
//! Redis-backed private IM state:
//!
//! 1. `channel:user_global_notification:<user_id>` — the user switch and
//!    default private session key.
//! 2. `channel:private_session:<session_key>` — the private session of that
//!    default key (skipped when the key is absent or empty).
//! 3. `channel:user_runtime_task_subscriptions:<user_id>` — the runtime-task →
//!    session-key subscriptions.
//! 4. one `channel:private_session:<session_key>` read per subscribed key.
//!
//! `cache_manager.get` decodes a JSON document and degrades a missing key or a
//! read error to `None`, so every read here is best-effort: an absent,
//! unreadable, or non-object value renders the source's empty default instead
//! of failing the request. A private session whose payload is not a JSON object,
//! omits a required field, or belongs to another user is dropped, matching
//! `IMPrivateSession.from_dict` / `_load_user_im_session` returning `None`.
use brz_redis::{Redis, RedisBytes};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

/// `IMSessionService` cache-key prefixes (`app/services/im/session_service.py`).
const GLOBAL_NOTIFICATION_PREFIX: &str = "channel:user_global_notification:";
const PRIVATE_SESSION_PREFIX: &str = "channel:private_session:";
const RUNTIME_TASK_SUBSCRIPTIONS_PREFIX: &str = "channel:user_runtime_task_subscriptions:";

/// `get_channel_label`: the presentation label for a known channel type,
/// otherwise the channel type itself.
fn channel_label(channel_type: &str) -> &str {
    match channel_type {
        "dingtalk" => "钉钉",
        "telegram" => "Telegram",
        "discord" => "Discord",
        "weibo" => "微博",
        other => other,
    }
}

/// `cache_manager.get` value decoding: keep the cached value only when it is a
/// UTF-8 JSON document. A value that is not UTF-8 or not valid JSON is `None`,
/// matching `_decode` falling back to raw bytes that the callers then reject
/// through their `isinstance(..., dict)` / typed checks.
fn decode_json(value: &[u8]) -> Option<OpaqueJson> {
    std::str::from_utf8(value)
        .ok()
        .and_then(OpaqueJson::from_json_text)
}

/// Python truthiness of a JSON value, used by `bool(data.get("enabled"))`.
fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|float| float != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `IMGlobalNotificationSettings` parsed from the cached document.
#[derive(Debug, Default, PartialEq, Eq)]
struct GlobalNotification {
    enabled: bool,
    session_key: Option<String>,
}

impl GlobalNotification {
    /// A non-object cache value renders the source's dataclass defaults
    /// (`enabled=False`, `session_key=None`).
    fn from_value(value: Option<&OpaqueJson>) -> Self {
        let Some(object) = value.map(OpaqueJson::to_value) else {
            return Self::default();
        };
        let Some(object) = object.as_object() else {
            return Self::default();
        };
        let enabled = object.get("enabled").is_some_and(python_truthy);
        // `session_key if isinstance(session_key, str) else None`.
        let session_key = object
            .get("session_key")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Self {
            enabled,
            session_key,
        }
    }
}

/// The subset of `IMPrivateSession` the response needs. Its required fields are
/// the dataclass fields without defaults, so a payload missing one fails to
/// deserialize exactly like `IMPrivateSession(**values)` raising `TypeError`.
#[derive(Debug, Deserialize)]
struct PrivateSession {
    session_key: String,
    user_id: i64,
    channel_type: String,
    channel_id: i64,
    conversation_id: String,
    sender_id: String,
    #[serde(default)]
    display_name: String,
}

/// `RuntimeIMNotificationSession`, serialized with the source aliases and field
/// order (`response_model_by_alias=True`).
#[derive(Debug, Serialize)]
struct SessionView {
    #[serde(rename = "sessionKey")]
    session_key: String,
    #[serde(rename = "channelType")]
    channel_type: String,
    #[serde(rename = "channelLabel")]
    channel_label: String,
    #[serde(rename = "channelId")]
    channel_id: i64,
    #[serde(rename = "conversationId")]
    conversation_id: String,
    #[serde(rename = "senderId")]
    sender_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
}

impl SessionView {
    /// `_im_notification_session_out`, after `_load_user_im_session` has
    /// confirmed the session exists and is owned by `user_id`.
    fn from_session(session: &PrivateSession) -> Self {
        Self {
            session_key: session.session_key.clone(),
            channel_type: session.channel_type.clone(),
            channel_label: channel_label(&session.channel_type).to_owned(),
            channel_id: session.channel_id,
            conversation_id: session.conversation_id.clone(),
            sender_id: session.sender_id.clone(),
            display_name: session.display_name.clone(),
        }
    }
}

/// Parse one cached `channel:private_session` document into a view owned by
/// `user_id`. `None` mirrors `get_session`/`_load_user_im_session` rejecting a
/// non-object payload, an unparsable session, or a foreign owner.
fn session_view(value: Option<&OpaqueJson>, user_id: i64) -> Option<SessionView> {
    let session: PrivateSession = value?.project()?;
    (session.user_id == user_id).then(|| SessionView::from_session(&session))
}

/// `RuntimeTaskAddress` for a stored notification key.
/// `runtime_task_notification_key` joins `deviceId` and `localTaskId` with a
/// NUL, so a stored subscription always carries the separator; the
/// no-separator fallback mirrors `_runtime_task_address_from_notification_key`.
#[derive(Debug, Serialize)]
struct TaskAddress {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "workspacePath")]
    workspace_path: Option<String>,
    #[serde(rename = "taskId")]
    local_task_id: String,
    #[serde(rename = "runtimeHandle")]
    runtime_handle: Option<Value>,
}

impl TaskAddress {
    /// `_runtime_task_address_from_notification_key`: split on the first NUL.
    fn from_notification_key(task_key: &str) -> Self {
        let (device_id, local_task_id) = match task_key.split_once('\0') {
            Some((device_id, local_task_id)) => (device_id.to_owned(), local_task_id.to_owned()),
            None => (String::new(), task_key.to_owned()),
        };
        Self {
            device_id,
            workspace_path: None,
            local_task_id,
            runtime_handle: None,
        }
    }
}

/// `RuntimeTaskIMNotificationSubscription`.
#[derive(Debug, Serialize)]
struct TaskSubscription {
    address: TaskAddress,
    #[serde(rename = "sessionKeys")]
    session_keys: Vec<String>,
    sessions: Vec<SessionView>,
}

/// `RuntimeGlobalIMNotificationSettings`.
#[derive(Debug, Serialize)]
struct GlobalSettings {
    enabled: bool,
    #[serde(rename = "sessionKey")]
    session_key: Option<String>,
    session: Option<SessionView>,
}

/// `RuntimeIMNotificationSettingsResponse`.
#[derive(Debug, Serialize)]
struct SettingsResponse {
    global: GlobalSettings,
    #[serde(rename = "runtimeTaskSubscriptions")]
    runtime_task_subscriptions: Vec<TaskSubscription>,
}

/// `_get_runtime_task_subscriptions`: keep keys whose value is a list,
/// preserving document order and filtering non-string or empty items.
fn normalize_subscriptions(value: Option<&OpaqueJson>) -> Vec<(String, Vec<String>)> {
    let Some(document) = value.map(OpaqueJson::to_value) else {
        return Vec::new();
    };
    let Some(object) = document.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            let Value::Array(items) = value else {
                return None;
            };
            let session_keys = items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect();
            Some((key.clone(), session_keys))
        })
        .collect()
}

fn global_notification_key(user_id: i64) -> String {
    format!("{GLOBAL_NOTIFICATION_PREFIX}{user_id}")
}

fn private_session_key(session_key: &str) -> String {
    format!("{PRIVATE_SESSION_PREFIX}{session_key}")
}

fn runtime_task_subscriptions_key(user_id: i64) -> String {
    format!("{RUNTIME_TASK_SUBSCRIPTIONS_PREFIX}{user_id}")
}

/// One `cache_manager.get`: a missing key, a read error, or an undecodable
/// value all render `None`.
async fn cache_get(redis: Option<&brz_redis::RedisService>, key: &str) -> Option<OpaqueJson> {
    let redis = redis?;
    match redis.get::<_, RedisBytes>(key).await {
        Ok(Some(bytes)) => decode_json(bytes.as_ref()),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, key, "IM notification cache read failed");
            None
        }
    }
}

/// `_load_user_im_session`: an absent or empty key is not read.
async fn load_session(
    redis: Option<&brz_redis::RedisService>,
    user_id: i64,
    session_key: &str,
) -> Option<SessionView> {
    if session_key.is_empty() {
        return None;
    }
    let value = cache_get(redis, &private_session_key(session_key)).await;
    session_view(value.as_ref(), user_id)
}

/// `runtime_work_service.get_im_notification_settings`.
async fn get_settings(
    state: &AppState,
    user: &SessionUser,
) -> Result<SettingsResponse, FastApiError> {
    let user_id = i64::from(user.id);
    let redis = state.redis.as_ref();

    let global_value = cache_get(redis, &global_notification_key(user_id)).await;
    let global = GlobalNotification::from_value(global_value.as_ref());
    let global_session = match global.session_key.as_deref() {
        Some(session_key) => load_session(redis, user_id, session_key).await,
        None => None,
    };

    let subscriptions_value = cache_get(redis, &runtime_task_subscriptions_key(user_id)).await;
    let subscriptions = normalize_subscriptions(subscriptions_value.as_ref());

    let mut tasks = Vec::with_capacity(subscriptions.len());
    for (task_key, session_keys) in subscriptions {
        let mut sessions = Vec::with_capacity(session_keys.len());
        for session_key in &session_keys {
            if let Some(session) = load_session(redis, user_id, session_key).await {
                sessions.push(session);
            }
        }
        tasks.push(TaskSubscription {
            address: TaskAddress::from_notification_key(&task_key),
            session_keys,
            sessions,
        });
    }

    Ok(SettingsResponse {
        global: GlobalSettings {
            enabled: global.enabled,
            session_key: global.session_key,
            session: global_session,
        },
        runtime_task_subscriptions: tasks,
    })
}

/// GET /api/runtime-work/im-notifications: the runtime IM notification
/// settings free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/runtime-work/im-notifications")]
async fn get_im_notification_settings(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<SettingsResponse, FastApiError> {
    get_settings(state, &user).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_compat::OpaqueJson;
    use serde_json::json;

    fn opaque(value: Value) -> OpaqueJson {
        OpaqueJson::from(value)
    }

    #[test]
    fn decode_json_parses_objects_and_rejects_non_json() {
        assert_eq!(
            decode_json(br#"{"enabled": true}"#).unwrap().to_value(),
            json!({"enabled": true})
        );
        assert!(decode_json(b"not-json").is_none());
        assert!(decode_json(&[0xff, 0xfe]).is_none());
    }

    #[test]
    fn python_truthiness_matches_the_source_bool() {
        assert!(!python_truthy(&Value::Null));
        assert!(!python_truthy(&json!(false)));
        assert!(!python_truthy(&json!(0)));
        assert!(!python_truthy(&json!(0.0)));
        assert!(!python_truthy(&json!("")));
        assert!(!python_truthy(&json!([])));
        assert!(!python_truthy(&json!({})));
        assert!(python_truthy(&json!(true)));
        assert!(python_truthy(&json!(1)));
        assert!(python_truthy(&json!("x")));
        assert!(python_truthy(&json!([0])));
        assert!(python_truthy(&json!({"k": null})));
    }

    #[test]
    fn global_settings_default_when_absent_or_non_object() {
        assert_eq!(
            GlobalNotification::from_value(None),
            GlobalNotification::default()
        );
        let scalar = opaque(json!(42));
        assert_eq!(
            GlobalNotification::from_value(Some(&scalar)),
            GlobalNotification::default()
        );
    }

    #[test]
    fn global_settings_read_enabled_and_string_key() {
        let value = opaque(json!({"enabled": true, "session_key": "sess"}));
        assert_eq!(
            GlobalNotification::from_value(Some(&value)),
            GlobalNotification {
                enabled: true,
                session_key: Some("sess".to_owned()),
            }
        );
    }

    #[test]
    fn global_settings_reject_non_string_session_key() {
        let value = opaque(json!({"enabled": false, "session_key": 7}));
        assert_eq!(
            GlobalNotification::from_value(Some(&value)),
            GlobalNotification {
                enabled: false,
                session_key: None,
            }
        );
    }

    #[test]
    fn normalize_subscriptions_preserves_order_and_filters() {
        // Insertion order is significant: the response array mirrors it, so the
        // two tasks keep their document order and the non-list key is dropped.
        let value = opaque(json!({
            "device-a\u{0}task-1": ["sess-1", "", 5, "sess-2"],
            "bad": "not-a-list",
            "device-b\u{0}task-2": ["sess-3"],
        }));
        assert_eq!(
            normalize_subscriptions(Some(&value)),
            vec![
                (
                    "device-a\u{0}task-1".to_owned(),
                    vec!["sess-1".to_owned(), "sess-2".to_owned()],
                ),
                ("device-b\u{0}task-2".to_owned(), vec!["sess-3".to_owned()]),
            ]
        );
    }

    #[test]
    fn normalize_subscriptions_defaults_when_absent() {
        assert!(normalize_subscriptions(None).is_empty());
        let array = opaque(json!([]));
        assert!(normalize_subscriptions(Some(&array)).is_empty());
    }

    #[test]
    fn task_address_splits_on_the_first_nul() {
        let address = TaskAddress::from_notification_key("device-a\u{0}runtime-1");
        assert_eq!(address.device_id, "device-a");
        assert_eq!(address.local_task_id, "runtime-1");
        assert_eq!(address.workspace_path, None);
        assert_eq!(address.runtime_handle, None);
    }

    #[test]
    fn task_address_without_separator_keeps_the_key() {
        let address = TaskAddress::from_notification_key("runtime-1");
        assert_eq!(address.device_id, "");
        assert_eq!(address.local_task_id, "runtime-1");
    }

    #[test]
    fn session_view_drops_foreign_and_malformed_payloads() {
        let owned = opaque(json!({
            "session_key": "sess",
            "user_id": 157,
            "channel_type": "dingtalk",
            "channel_id": 42,
            "conversation_id": "conv",
            "sender_id": "sender",
            "display_name": "Name",
        }));
        let view = session_view(Some(&owned), 157).expect("owned session");
        assert_eq!(view.channel_label, "钉钉");
        assert_eq!(view.session_key, "sess");
        assert!(session_view(Some(&owned), 158).is_none());

        let missing_field = opaque(json!({
            "user_id": 157,
            "channel_type": "dingtalk",
            "channel_id": 42,
            "conversation_id": "conv",
            "sender_id": "sender",
        }));
        assert!(session_view(Some(&missing_field), 157).is_none());
        let text = opaque(json!("text"));
        assert!(session_view(Some(&text), 157).is_none());
        assert!(session_view(None, 157).is_none());
    }

    #[test]
    fn session_view_defaults_display_name() {
        let value = opaque(json!({
            "session_key": "sess",
            "user_id": 1,
            "channel_type": "telegram",
            "channel_id": 1,
            "conversation_id": "conv",
            "sender_id": "sender",
        }));
        let view = session_view(Some(&value), 1).expect("session");
        assert_eq!(view.display_name, "");
        assert_eq!(view.channel_label, "Telegram");
    }

    #[test]
    fn channel_labels_fall_back_to_the_channel_type() {
        assert_eq!(channel_label("dingtalk"), "钉钉");
        assert_eq!(channel_label("weibo"), "微博");
        assert_eq!(channel_label("custom"), "custom");
    }

    #[test]
    fn cache_keys_match_the_source_prefixes() {
        assert_eq!(
            global_notification_key(157),
            "channel:user_global_notification:157"
        );
        assert_eq!(private_session_key("abc"), "channel:private_session:abc");
        assert_eq!(
            runtime_task_subscriptions_key(157),
            "channel:user_runtime_task_subscriptions:157"
        );
    }

    #[test]
    fn response_serializes_with_source_field_order_and_nulls() {
        let session = |key: &str| SessionView {
            session_key: key.to_owned(),
            channel_type: "dingtalk".to_owned(),
            channel_label: "钉钉".to_owned(),
            channel_id: 42,
            conversation_id: "conv".to_owned(),
            sender_id: "sender".to_owned(),
            display_name: "姚四芳".to_owned(),
        };
        let response = SettingsResponse {
            global: GlobalSettings {
                enabled: true,
                session_key: Some("sess-1".to_owned()),
                session: Some(session("sess-1")),
            },
            runtime_task_subscriptions: vec![TaskSubscription {
                address: TaskAddress::from_notification_key("device-a\u{0}runtime-1"),
                session_keys: vec!["sess-1".to_owned()],
                sessions: vec![session("sess-1")],
            }],
        };
        let body = serde_json::to_string(&response).unwrap();
        assert_eq!(
            body,
            "{\"global\":{\"enabled\":true,\"sessionKey\":\"sess-1\",\
             \"session\":{\"sessionKey\":\"sess-1\",\"channelType\":\"dingtalk\",\
             \"channelLabel\":\"钉钉\",\"channelId\":42,\"conversationId\":\"conv\",\
             \"senderId\":\"sender\",\"displayName\":\"姚四芳\"}},\
             \"runtimeTaskSubscriptions\":[{\"address\":{\"deviceId\":\"device-a\",\
             \"workspacePath\":null,\"taskId\":\"runtime-1\",\"runtimeHandle\":null},\
             \"sessionKeys\":[\"sess-1\"],\"sessions\":[{\"sessionKey\":\"sess-1\",\
             \"channelType\":\"dingtalk\",\"channelLabel\":\"钉钉\",\"channelId\":42,\
             \"conversationId\":\"conv\",\"senderId\":\"sender\",\
             \"displayName\":\"姚四芳\"}]}]}"
        );
    }

    #[test]
    fn empty_response_serializes_null_global_session() {
        let response = SettingsResponse {
            global: GlobalSettings {
                enabled: false,
                session_key: None,
                session: None,
            },
            runtime_task_subscriptions: Vec::new(),
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            "{\"global\":{\"enabled\":false,\"sessionKey\":null,\"session\":null},\
             \"runtimeTaskSubscriptions\":[]}"
        );
    }
}
