// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/im/private-sessions` — list the current user's private IM
//! sessions.
//!
//! Mirrors `app.api.endpoints.im_sessions.list_private_sessions` (the
//! `im_router` is mounted with prefix `/im` under the app prefix `/api`) and
//! `IMSessionService.list_user_sessions` / `get_channel_label`. The request
//! authenticates the bearer token (`get_current_user`, which loads the active
//! `users` row by name, handled by the shared authenticator), then reads only
//! Redis-backed private IM state:
//!
//! 1. `ZREVRANGE channel:user_private_sessions:<user_id> 0 -1` — the user's
//!    session keys, most recently seen first.
//! 2. one `GET channel:private_session:<session_key>` per key.
//!
//! `cache_manager.get` swallows read failures into a missing value, so each
//! session read is best-effort: a key whose value is absent, is not a JSON
//! object, or fails `IMPrivateSession.from_dict` is skipped and removed from
//! the user's sorted set with `ZREM`. The sorted-set read and the `ZREM` use
//! the client directly and fail the request, like the source.
//!
//! The response renders `IMPrivateSessionListResponse` in pydantic field
//! order: `total`, then `items` (`IMPrivateSessionOut`) with every field in
//! declaration order — `session_key`, `channel_type`, `channel_label`,
//! `channel_id`, `conversation_id`, `sender_id`, `display_name`, `mode`,
//! `state`, `active_task_id`, `last_seen_at`.

use brz_redis::{Redis, RedisBytes};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_json::OpaqueJson;

/// `IMSessionService` cache-key prefixes (`app/services/im/session_service.py`).
const PRIVATE_SESSION_PREFIX: &str = "channel:private_session:";
const USER_PRIVATE_SESSIONS_PREFIX: &str = "channel:user_private_sessions:";

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

/// `IMPrivateSession`, restricted to the stored document shape. The required
/// fields are the dataclass fields without defaults, so a payload that omits
/// one fails to deserialize exactly like `IMPrivateSession(**values)` raising
/// `TypeError`; `deny_unknown_fields` mirrors that an unexpected keyword also
/// raises.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSession {
    session_key: String,
    #[allow(dead_code, reason = "accepted to match the stored session shape")]
    user_id: i64,
    channel_type: String,
    channel_id: i64,
    conversation_id: String,
    sender_id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_state")]
    state: String,
    #[serde(default)]
    active_task_id: Option<i64>,
    // `from_dict` rewrites these four keys through `_parse_datetime`; a
    // non-empty string must be a parseable ISO 8601 datetime or the session is
    // dropped. They are read as opaque JSON so an absent key or a non-string
    // value stays `None` without a serde type error, matching `_parse_datetime`.
    #[serde(default)]
    last_seen_at: Option<Value>,
    #[serde(default)]
    state_expires_at: Option<Value>,
    #[serde(default)]
    created_at: Option<Value>,
    #[serde(default)]
    updated_at: Option<Value>,
    // Fields `from_dict` copies without validation; the response never reads
    // them, but an unexpected key would change the accepted shape.
    #[serde(default)]
    #[allow(dead_code, reason = "accepted to match the stored session shape")]
    proactive_recipient_id: Option<Value>,
    #[serde(default)]
    #[allow(dead_code, reason = "accepted to match the stored session shape")]
    active_runtime_task: Option<Value>,
    #[serde(default)]
    #[allow(dead_code, reason = "accepted to match the stored session shape")]
    pending_payload: Option<Value>,
}

fn default_mode() -> String {
    "chat".to_owned()
}

fn default_state() -> String {
    "idle".to_owned()
}

/// `IMPrivateSessionOut` in pydantic declaration order.
#[derive(Debug, Serialize)]
struct SessionOut {
    session_key: String,
    channel_type: String,
    channel_label: String,
    channel_id: i64,
    conversation_id: String,
    sender_id: String,
    display_name: String,
    mode: String,
    state: String,
    active_task_id: Option<i64>,
    last_seen_at: String,
}

/// `IMPrivateSessionListResponse`.
#[derive(Debug, Serialize)]
struct ListResponse {
    total: usize,
    items: Vec<SessionOut>,
}

fn user_sessions_key(user_id: i64) -> String {
    format!("{USER_PRIVATE_SESSIONS_PREFIX}{user_id}")
}

fn private_session_key(session_key: &str) -> String {
    format!("{PRIVATE_SESSION_PREFIX}{session_key}")
}

/// `_parse_datetime` acceptance for one stored value: an absent key, JSON
/// `null`, or a non-string value is `None`; an empty string is `None`; a
/// non-empty string must parse as an ISO 8601 datetime. `false` means
/// `datetime.fromisoformat` raised and `from_dict` drops the session.
fn valid_stored_datetime(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) if !text.is_empty() => parse_iso_datetime(text).is_some(),
        _ => true,
    }
}

/// Render a stored datetime the way pydantic serializes the parsed value.
/// `None` means the value cannot produce the required `last_seen_at: datetime`
/// response field.
fn render_stored_datetime(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => {
            Some(crate::device_running_tasks::python_datetime_isoformat(text))
        }
        _ => None,
    }
}

/// `datetime.fromisoformat` acceptance for the values `isoformat()` writes:
/// `YYYY-MM-DDTHH:MM:SS[.ffffff]`, optionally followed by a `±HH:MM` offset.
fn parse_iso_datetime(value: &str) -> Option<()> {
    if chrono::DateTime::parse_from_rfc3339(value).is_ok() {
        return Some(());
    }
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|_| ())
}

/// `cache_manager._decode`: keep a cached value only when it is a UTF-8 JSON
/// document. A value that is not UTF-8 or not valid JSON is `None`, which the
/// caller's object check then rejects, matching `_decode` handing back raw
/// bytes that `get_session` refuses.
fn decode_json(value: &[u8]) -> Option<OpaqueJson> {
    std::str::from_utf8(value)
        .ok()
        .and_then(OpaqueJson::from_json_text)
}

/// `get_session`: parse one cached document and drop it when it is not a valid
/// `IMPrivateSession` document. A non-object payload, a missing required field,
/// an unexpected field, or an unparsable stored datetime all render `None`.
fn stored_session(value: Option<&OpaqueJson>) -> Option<StoredSession> {
    let session: StoredSession = value?.project()?;
    let datetimes = [
        session.state_expires_at.as_ref(),
        session.last_seen_at.as_ref(),
        session.created_at.as_ref(),
        session.updated_at.as_ref(),
    ];
    if !datetimes.into_iter().all(valid_stored_datetime) {
        return None;
    }
    Some(session)
}

/// `_private_session_out`, including the `IMPrivateSessionOut` field
/// constraints. A required `last_seen_at` datetime, or a `mode`/`state` outside
/// its `Literal`, raises at response construction in the source.
fn render_session(session: &StoredSession) -> Result<SessionOut, FastApiError> {
    let Some(last_seen_at) = render_stored_datetime(session.last_seen_at.as_ref()) else {
        return Err(FastApiError::unhandled());
    };
    if !matches!(session.mode.as_str(), "chat" | "task")
        || !matches!(
            session.state.as_str(),
            "idle" | "pending_new_flow" | "pending_task_switch" | "pending_task_creation"
        )
    {
        return Err(FastApiError::unhandled());
    }
    Ok(SessionOut {
        session_key: session.session_key.clone(),
        channel_type: session.channel_type.clone(),
        channel_label: channel_label(&session.channel_type).to_owned(),
        channel_id: session.channel_id,
        conversation_id: session.conversation_id.clone(),
        sender_id: session.sender_id.clone(),
        display_name: session.display_name.clone(),
        mode: session.mode.clone(),
        state: session.state.clone(),
        active_task_id: session.active_task_id,
        last_seen_at,
    })
}

/// `IMSessionService.get_session` for one key: a read failure is a missing
/// value (`cache_manager.get` swallows it), which marks the key for removal.
async fn load_session(redis: &brz_redis::RedisService, session_key: &str) -> Option<StoredSession> {
    let key = private_session_key(session_key);
    let value = match redis.get::<_, RedisBytes>(key.as_str()).await {
        Ok(Some(bytes)) => decode_json(bytes.as_ref()),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, key, "private IM session cache read failed");
            None
        }
    };
    stored_session(value.as_ref())
}

/// `list_user_sessions`: read the user's session keys, load each session,
/// remove the keys whose sessions no longer resolve, and render the survivors.
async fn list_sessions(state: &AppState, user_id: i64) -> Result<ListResponse, FastApiError> {
    let redis = state
        .redis
        .as_ref()
        .ok_or_else(private_session_dependency_error)?;

    let user_key = user_sessions_key(user_id);
    let session_keys: Vec<String> =
        redis
            .zrevrange(user_key.as_str(), 0, -1)
            .await
            .map_err(|error| {
                tracing::error!(%error, "private IM sessions sorted-set read failed");
                FastApiError::unhandled()
            })?;

    let mut sessions = Vec::with_capacity(session_keys.len());
    let mut missing_keys = Vec::new();
    for session_key in &session_keys {
        match load_session(redis, session_key).await {
            Some(session) => sessions.push(session),
            None => missing_keys.push(session_key.clone()),
        }
    }
    if !missing_keys.is_empty() {
        let members: Vec<&str> = missing_keys.iter().map(String::as_str).collect();
        redis
            .zrem(user_key.as_str(), members)
            .await
            .map_err(|error| {
                tracing::error!(%error, "private IM sessions stale-key cleanup failed");
                FastApiError::unhandled()
            })?;
    }

    let mut items = Vec::with_capacity(sessions.len());
    for session in &sessions {
        items.push(render_session(session)?);
    }
    Ok(ListResponse {
        total: items.len(),
        items,
    })
}

/// A missing application cache client renders the same 500 body as a failed
/// Redis command (the source dependency is not optional).
fn private_session_dependency_error() -> FastApiError {
    tracing::error!("private IM sessions Redis client is not configured");
    FastApiError::unhandled()
}

/// GET /api/im/private-sessions: the private-session list free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/im/private-sessions")]
async fn list_private_sessions(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<ListResponse, FastApiError> {
    list_sessions(state, i64::from(user.id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;
    use serde_json::json;

    fn opaque(value: Value) -> OpaqueJson {
        OpaqueJson::from(value)
    }

    fn session_json() -> Value {
        json!({
            "session_key": "3aa5f9968e6a9672cf93ee327304cdc0cb88d26d359125c859f73c7bf7ce7f97",
            "user_id": 677,
            "channel_type": "dingtalk",
            "channel_id": 122459,
            "conversation_id": "cidOhK7IBUMuS2Fr+ZjDF6+zSlWocOPRE4syrD8nM3j5QA=",
            "sender_id": "$:LWCP_v1:$UZdOTDC0+r90kaXzIN7+zXeUUmggGLqK",
            "proactive_recipient_id": "230146",
            "display_name": "李浩楠",
            "mode": "chat",
            "state": "idle",
            "active_task_id": null,
            "active_runtime_task": null,
            "pending_payload": {},
            "state_expires_at": null,
            "last_seen_at": "2026-09-09T19:39:41.211672",
            "created_at": "2026-09-09T19:39:41.211672",
            "updated_at": "2026-09-09T19:39:41.221087"
        })
    }

    #[test]
    fn list_response_serializes_in_pydantic_field_order() {
        // Arrange
        let session = stored_session(Some(&opaque(session_json()))).unwrap();

        // Act
        let rendered = serde_json::to_string(&ListResponse {
            total: 1,
            items: vec![render_session(&session).unwrap()],
        })
        .unwrap();

        // Assert: the exact recorded body, including the null `active_task_id`.
        assert_eq!(
            rendered,
            "{\"total\":1,\"items\":[{\"session_key\":\
             \"3aa5f9968e6a9672cf93ee327304cdc0cb88d26d359125c859f73c7bf7ce7f97\",\
             \"channel_type\":\"dingtalk\",\"channel_label\":\"钉钉\",\
             \"channel_id\":122459,\"conversation_id\":\
             \"cidOhK7IBUMuS2Fr+ZjDF6+zSlWocOPRE4syrD8nM3j5QA=\",\"sender_id\":\
             \"$:LWCP_v1:$UZdOTDC0+r90kaXzIN7+zXeUUmggGLqK\",\"display_name\":\"李浩楠\",\
             \"mode\":\"chat\",\"state\":\"idle\",\"active_task_id\":null,\
             \"last_seen_at\":\"2026-09-09T19:39:41.211672\"}]}"
        );
    }

    #[test]
    fn channel_label_maps_known_and_unknown_types() {
        assert_eq!(channel_label("dingtalk"), "钉钉");
        assert_eq!(channel_label("telegram"), "Telegram");
        assert_eq!(channel_label("discord"), "Discord");
        assert_eq!(channel_label("weibo"), "微博");
        assert_eq!(channel_label("feishu"), "feishu");
    }

    #[test]
    fn stored_session_requires_structural_fields() {
        let mut missing = session_json();
        missing.as_object_mut().unwrap().remove("session_key");
        assert!(stored_session(Some(&opaque(missing))).is_none());

        // An unexpected key raises in `IMPrivateSession(**values)`.
        let mut extra = session_json();
        extra
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), json!(1));
        assert!(stored_session(Some(&opaque(extra))).is_none());

        // A non-object payload is rejected by `get_session`.
        assert!(stored_session(Some(&opaque(json!([1, 2])))).is_none());
    }

    #[test]
    fn stored_session_defaults_and_datetime_validation() {
        // Absent `mode`/`state`/`display_name` take the dataclass defaults.
        let mut minimal = session_json();
        let object = minimal.as_object_mut().unwrap();
        object.remove("mode");
        object.remove("state");
        object.remove("display_name");
        let session = stored_session(Some(&opaque(minimal))).unwrap();
        assert_eq!(session.mode, "chat");
        assert_eq!(session.state, "idle");
        assert_eq!(session.display_name, "");

        // A non-empty datetime that `fromisoformat` rejects drops the session.
        let mut bad = session_json();
        bad.as_object_mut()
            .unwrap()
            .insert("last_seen_at".to_owned(), json!("not-a-date"));
        assert!(stored_session(Some(&opaque(bad))).is_none());

        // A null or absent datetime is accepted (`_parse_datetime` -> None).
        let mut nulled = session_json();
        nulled
            .as_object_mut()
            .unwrap()
            .insert("last_seen_at".to_owned(), Value::Null);
        assert!(stored_session(Some(&opaque(nulled))).is_some());
    }

    #[test]
    fn render_rejects_unrenderable_last_seen_at() {
        let mut nulled = session_json();
        nulled
            .as_object_mut()
            .unwrap()
            .insert("last_seen_at".to_owned(), Value::Null);
        let session = stored_session(Some(&opaque(nulled))).unwrap();
        assert!(render_session(&session).is_err());
    }

    #[test]
    fn decode_json_matches_cache_manager() {
        assert!(decode_json(br#"{"a":1}"#).is_some());
        assert!(decode_json(b"not json").is_none());
        assert!(decode_json(&[0xff, 0xfe]).is_none());
    }

    /// The cutover and the handler registration must agree. An inactive route
    /// entry sends `GET /api/im/private-sessions` to the Python fallback, so
    /// the recorded session list is not served by this handler.
    #[test]
    fn selected_route_is_registered_in_the_shared_group() {
        const PATH: &str = "/api/im/private-sessions";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must be selected for Rust"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(table.matches(&http::Method::GET, PATH));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
