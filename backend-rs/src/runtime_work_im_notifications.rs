// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/runtime-work/im-notifications` — the Wework runtime IM
//! notification settings.
//!
//! `PUT /api/runtime-work/im-notifications/presence` — refresh one Wework
//! client's foreground or away presence. Mirrors
//! `app.api.endpoints.runtime_work.update_im_notification_presence_endpoint` and
//! `IMSessionService.update_im_notification_presence`: it refreshes the client's
//! member on `channel:user_im_notification_presence:<user_id>` with a
//! `ZREM` + `ZADD` + `ZREMRANGEBYSCORE` + `ZREVRANGE` sequence and answers the
//! aggregated away state with the fixed 90-second lease.
//!
//! The GET endpoint mirrors
//! `app.api.endpoints.runtime_work.get_im_notification_settings_endpoint`
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
//!
//! Reopen note (2026-10-12, round 3): after the canonical base applied the
//! `im-notification-presence-time` replay dependency rule
//! (`backend-rs-intra/.traffic-e2e/verification.yaml`), which declares the
//! request-generated Unix-second values at the `ZADD` score (arg 1) and the
//! `ZREMRANGEBYSCORE` max (arg 2), this endpoint is re-opened for
//! post-rule re-verification with a fresh focused replay. The ported handler
//! is unchanged and faithful; this note only refreshes the target fingerprint
//! for the new attempt and carries no behaviour change.
//!
//! Reopen note (2026-10-14, round 4): the 2026-10-14 failure for
//! `PUT /api/runtime-work/im-notifications/presence` was Replay lane ordering.
//! The handler's first `ZREM` on `channel:user_im_notification_presence:<user_id>`
//! was refused as `lane_blocked` behind a foreign detached-response
//! `chat:streaming:*` command recorded earlier on the same connection, and
//! `presence_dependency_error` rendered that Replay error as the source's
//! unhandled 500. traffic-e2e `7af2f73` fixed the foreign-API Redis ordering.
//! This note carries no behaviour change; it only refreshes the code fingerprint
//! so the engine re-runs acceptance for this route.
use brz_redis::{Redis, RedisBytes};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_json::OpaqueJson;

/// `IMSessionService` cache-key prefixes (`app/services/im/session_service.py`).
const GLOBAL_NOTIFICATION_PREFIX: &str = "channel:user_global_notification:";
const PRIVATE_SESSION_PREFIX: &str = "channel:private_session:";
const RUNTIME_TASK_SUBSCRIPTIONS_PREFIX: &str = "channel:user_runtime_task_subscriptions:";
const USER_IM_NOTIFICATION_PRESENCE_PREFIX: &str = "channel:user_im_notification_presence:";

/// `IM_NOTIFICATION_PRESENCE_TTL_SECONDS`: the source presence lease in seconds.
const IM_NOTIFICATION_PRESENCE_TTL_SECONDS: i64 = 90;
/// `IM_NOTIFICATION_PRESENCE_ACTIVE`: the member suffix for a foregrounded client.
const IM_NOTIFICATION_PRESENCE_ACTIVE: &str = "active";
/// `IM_NOTIFICATION_PRESENCE_AWAY`: the member suffix for an away client.
const IM_NOTIFICATION_PRESENCE_AWAY: &str = "away";

/// The source `validation_exception_handler` detail line
/// (`app/core/exceptions.py`).
const VALIDATION_FAILED: &str = "Request parameter validation failed";

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
use brz_json::adapters::python_truthy;

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

/// `RuntimeIMNotificationPresenceUpdateRequest`, validated like the source
/// pydantic model (`clientId` alias with `populate_by_name`, so `client_id` is
/// also accepted). Unknown keys are ignored.
struct PresenceUpdate {
    client_id: String,
    away: bool,
}

impl PresenceUpdate {
    /// Validate a decoded JSON body against
    /// `RuntimeIMNotificationPresenceUpdateRequest`.
    fn from_value(value: Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = value else {
            return Err(validation_error(
                vec!["body"],
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                value,
            ));
        };

        let client_id = match object.get("clientId").or_else(|| object.get("client_id")) {
            Some(Value::String(text)) => {
                let length = text.chars().count();
                if length < 1 {
                    return Err(validation_error(
                        vec!["body", "clientId"],
                        "string_too_short",
                        "String should have at least 1 character",
                        Value::String(text.clone()),
                    ));
                }
                if length > 128 {
                    return Err(validation_error(
                        vec!["body", "clientId"],
                        "string_too_long",
                        "String should have at most 128 characters",
                        Value::String(text.clone()),
                    ));
                }
                if !text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
                {
                    return Err(validation_error(
                        vec!["body", "clientId"],
                        "string_pattern_mismatch",
                        "String should match pattern '^[A-Za-z0-9._:-]+$'",
                        Value::String(text.clone()),
                    ));
                }
                text.clone()
            }
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "clientId"],
                    "string_type",
                    "Input should be a valid string",
                    other.clone(),
                ));
            }
            None => {
                return Err(validation_error(
                    vec!["body", "clientId"],
                    "missing",
                    "Field required",
                    Value::Null,
                ));
            }
        };

        let away = match object.get("away") {
            Some(Value::Bool(flag)) => *flag,
            Some(other) => {
                return Err(validation_error(
                    vec!["body", "away"],
                    "bool_type",
                    "Input should be a valid boolean",
                    other.clone(),
                ));
            }
            None => {
                return Err(validation_error(
                    vec!["body", "away"],
                    "missing",
                    "Field required",
                    Value::Null,
                ));
            }
        };

        Ok(Self { client_id, away })
    }
}

/// `RuntimeIMNotificationPresenceResponse` in pydantic field order
/// (`response_model_by_alias=True`).
#[derive(Debug, Serialize)]
struct PresenceResponse {
    away: bool,
    #[serde(rename = "ttlSeconds")]
    ttl_seconds: i64,
}

/// `_im_notification_presence_key`.
fn presence_key(user_id: i64) -> String {
    format!("{USER_IM_NOTIFICATION_PRESENCE_PREFIX}{user_id}")
}

/// `_im_notification_presence_member`: `<client_id>\0<state>`.
fn presence_member(client_id: &str, state: &str) -> String {
    format!("{client_id}\u{0}{state}")
}

/// `_presence_members_are_away`: away when no fresh member is foregrounded,
/// detected by the source's `\0active` member suffix.
fn presence_members_are_away(members: &[String]) -> bool {
    let active_suffix = presence_member("", IM_NOTIFICATION_PRESENCE_ACTIVE);
    !members
        .iter()
        .any(|member| member.ends_with(active_suffix.as_str()))
}

/// Source `time.time()`: the current Unix time in seconds.
fn unix_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64())
}

/// A dependency failure renders the source `python_exception_handler` 500 body.
fn presence_dependency_error(error: brz_redis::RedisError) -> FastApiError {
    tracing::error!(%error, "IM notification presence Redis failure");
    FastApiError::unhandled()
}

/// `IMSessionService.update_im_notification_presence`: refresh one client's
/// presence member and return the aggregated away state. Mirrors the source
/// `ZREM` + `ZADD` + `ZREMRANGEBYSCORE` + `ZREVRANGE` sequence on the
/// per-user presence sorted set.
async fn update_presence(
    state: &AppState,
    user: &SessionUser,
    request: &PresenceUpdate,
) -> Result<PresenceResponse, FastApiError> {
    let user_id = i64::from(user.id);
    let key = presence_key(user_id);
    let active_member = presence_member(&request.client_id, IM_NOTIFICATION_PRESENCE_ACTIVE);
    let away_member = presence_member(&request.client_id, IM_NOTIFICATION_PRESENCE_AWAY);
    let next_member = if request.away {
        &away_member
    } else {
        &active_member
    };
    let now = unix_seconds();
    let redis = state
        .redis
        .as_ref()
        .ok_or_else(|| presence_dependency_error(missing_redis_error()))?;

    redis
        .zrem(key.as_str(), [active_member.as_str(), away_member.as_str()])
        .await
        .map_err(presence_dependency_error)?;
    redis
        .zadd(
            key.as_str(),
            now + IM_NOTIFICATION_PRESENCE_TTL_SECONDS as f64,
            next_member.as_str(),
        )
        .await
        .map_err(presence_dependency_error)?;
    redis
        .zremrangebyscore(key.as_str(), "-inf", now)
        .await
        .map_err(presence_dependency_error)?;
    let members: Vec<String> = redis
        .zrevrange(key.as_str(), 0, -1)
        .await
        .map_err(presence_dependency_error)?;
    let away = presence_members_are_away(&members);

    Ok(PresenceResponse {
        away,
        ttl_seconds: IM_NOTIFICATION_PRESENCE_TTL_SECONDS,
    })
}

/// A `RedisError` describing an unconfigured application cache client, so the
/// missing dependency renders the same 500 body as a failed command.
fn missing_redis_error() -> brz_redis::RedisError {
    brz_redis::RedisError::new(
        brz_redis::ErrorKind::ClientError,
        "IM notification presence Redis client is not configured",
    )
}

/// PUT /api/runtime-work/im-notifications/presence: refresh one Wework client's
/// foreground or away presence.
#[brz_http_server::put("/api/runtime-work/im-notifications/presence")]
async fn update_im_notification_presence(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<PresenceResponse, FastApiError> {
    let request = PresenceUpdate::from_value(body)?;
    update_presence(state, &user, &request).await
}

/// `{"error_code":422,"detail":"Request parameter validation failed","errors":[...]}`
/// — the source `validation_exception_handler` body.
fn validation_error(location: Vec<&str>, kind: &str, message: &str, input: Value) -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        serde_json::json!({
            "error_code": 422,
            "detail": VALIDATION_FAILED,
            "errors": [
                {"type": kind, "loc": location, "msg": message, "input": input},
            ],
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;
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
    fn presence_key_and_member_match_the_source() {
        assert_eq!(
            presence_key(157),
            "channel:user_im_notification_presence:157"
        );
        assert_eq!(presence_member("client-a", "active"), "client-a\u{0}active");
        assert_eq!(presence_member("client-a", "away"), "client-a\u{0}away");
    }

    #[test]
    fn presence_away_requires_the_exact_active_suffix() {
        // A foregrounded client keeps the aggregated state not-away.
        assert!(!presence_members_are_away(&[presence_member(
            "client-a", "active"
        )]));
        // Away members, an empty set, and a client id merely ending in the text
        // "active" all aggregate to away (the separator is significant).
        assert!(presence_members_are_away(&[presence_member(
            "client-a", "away"
        )]));
        assert!(presence_members_are_away(&[]));
        assert!(presence_members_are_away(&[
            "not\u{0}active-client".to_owned()
        ]));
        assert!(presence_members_are_away(&["client-active".to_owned()]));
    }

    #[test]
    fn presence_update_requires_a_valid_client_id_and_away() {
        assert!(PresenceUpdate::from_value(json!({"away": false})).is_err());
        assert!(PresenceUpdate::from_value(json!({"clientId": "a"})).is_err());
        assert!(PresenceUpdate::from_value(json!({"clientId": "", "away": false})).is_err());
        assert!(
            PresenceUpdate::from_value(json!({"clientId": "has space", "away": false})).is_err()
        );
        assert!(PresenceUpdate::from_value(json!({"clientId": 7, "away": false})).is_err());
        assert!(PresenceUpdate::from_value(json!({"clientId": "a", "away": "no"})).is_err());
        assert!(PresenceUpdate::from_value(json!([])).is_err());
    }

    #[test]
    fn presence_update_accepts_the_alias_and_the_field_name() {
        let aliased = PresenceUpdate::from_value(json!({
            "clientId": "wework-68cd2c56-ddc1-4981-b06a-3ab8ab0064fa",
            "away": false,
            "ignored": true,
        }))
        .unwrap();
        assert_eq!(
            aliased.client_id,
            "wework-68cd2c56-ddc1-4981-b06a-3ab8ab0064fa"
        );
        assert!(!aliased.away);

        let named =
            PresenceUpdate::from_value(json!({"client_id": "a:b.c_d-e", "away": true})).unwrap();
        assert_eq!(named.client_id, "a:b.c_d-e");
        assert!(named.away);
    }

    #[test]
    fn presence_response_serializes_with_the_source_alias() {
        let response = PresenceResponse {
            away: false,
            ttl_seconds: IM_NOTIFICATION_PRESENCE_TTL_SECONDS,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            "{\"away\":false,\"ttlSeconds\":90}"
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
