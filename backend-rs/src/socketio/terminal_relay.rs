// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/terminal` attach and browser relay events.
//!
//! Source: `app/api/ws/terminal_namespace.py` (`on_terminal_attach`,
//! `on_terminal_ack`, `on_terminal_input`, `on_terminal_resize`,
//! `on_terminal_close`, `_authorize_attached_session`) and
//! `app/services/device/terminal_protocol.py`.
//!
//! The browser socket's attached-session state lives in [`TerminalSession`]
//! (the source's connect-session fields). Executor calls are delivered to the
//! executor's `/local-executor` socket with the shared emitter request/emit.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use brz_socket_io::{ClientError, Reply};
use serde_json::{Value, json};

use crate::socketio::auth::Identity;
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::{EXECUTOR_NAMESPACE, SocketRuntime, TerminalRelay};
use crate::socketio::terminal_attach::{
    self, TerminalRecord, authorization_unavailable, normalize_session_id,
};
use crate::state::AppState;

/// The device-side `/local-executor` terminal entry point, kept at this path
/// so the device lane imports one module (wired by `handlers/device.rs`).
#[allow(unused_imports)]
pub(crate) use crate::socketio::terminal_device::relay_device_event;

/// `TERMINAL_ATTACH_TIMEOUT_SECONDS`.
const TERMINAL_ATTACH_TIMEOUT_SECONDS: Duration = Duration::from_secs(5);
/// `CONSUMER_ID_PATTERN` length bound.
const CONSUMER_ID_MAX_LENGTH: usize = 128;

/// The `/terminal` namespace connection's attached-session state
/// (`on_connect`'s `terminal_*` session fields).
#[derive(Debug)]
pub(crate) struct TerminalSession {
    user_id: i64,
    token_exp: Option<i64>,
    state: Mutex<TerminalState>,
}

/// The mutable half of one browser terminal connection.
#[derive(Debug, Default)]
struct TerminalState {
    session_id: Option<String>,
    consumer_id: Option<String>,
    protocol_version: Option<i64>,
    authorization: Option<TerminalRecord>,
}

impl TerminalSession {
    /// `on_connect`: bind the verified user and the token expiry.
    pub(crate) fn new(identity: &Identity, token: Option<&str>) -> Self {
        Self {
            user_id: identity.user_id,
            token_exp: token.and_then(super::auth::token_expiry),
            state: Mutex::new(TerminalState::default()),
        }
    }

    /// `_check_token_expiry`: a missing expiry is treated as expired.
    pub(crate) fn token_expired(&self, now_unix: i64) -> bool {
        match self.token_exp {
            Some(expiry) => now_unix > expiry,
            None => true,
        }
    }

    /// The authenticated user id.
    pub(crate) fn user_id(&self) -> i64 {
        self.user_id
    }

    fn state(&self) -> std::sync::MutexGuard<'_, TerminalState> {
        self.state.lock().expect("terminal session state lock")
    }
}

/// `on_terminal_attach`.
pub(crate) async fn attach(
    state: &Arc<AppState>,
    runtime: &Arc<SocketRuntime>,
    session: &TerminalSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    if session.token_expired(chrono::Utc::now().timestamp()) {
        return Ok(Reply::payload(
            token_expired(state, runtime, socket_id).await,
        ));
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(json!({"error": "Not authenticated"})));
    }
    let session_id = normalize_session_id(&data);
    if session_id.is_empty() {
        return Ok(Reply::payload(json!({"error": "Missing session_id"})));
    }
    let previous_session_id = session.state().session_id.clone();
    let pinned = {
        let current = session.state();
        if previous_session_id.as_deref() == Some(session_id.as_str()) {
            current
                .protocol_version
                .or_else(|| current.consumer_id.as_ref().map(|_| 2))
        } else {
            None
        }
    };
    let Some(request) = AttachRequest::parse(&data) else {
        return Ok(Reply::payload(invalid_attach(&data)));
    };
    let v2_enabled =
        crate::config::env_or_dotenv("TERMINAL_PROTOCOL_V2_ENABLED").is_none_or(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "f" | "no" | "n" | "off"
            )
        });
    let offered = match request.offer(v2_enabled, pinned) {
        Ok(offered) => offered,
        Err(message) => return Ok(Reply::payload(json!({"error": message}))),
    };
    let Some(redis) = state.redis.as_ref() else {
        return Ok(Reply::payload(authorization_unavailable()));
    };
    let record = match terminal_attach::authorize(redis, &session_id, user_id).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Ok(Reply::payload(
                json!({"error": "Terminal session not found or access denied"}),
            ));
        }
        Err(()) => return Ok(Reply::payload(authorization_unavailable())),
    };
    let executor_socket_id = match active_executor_socket(state, &record).await {
        Ok(socket_id) => socket_id,
        Err(()) => return Ok(Reply::payload(authorization_unavailable())),
    };
    if executor_socket_id.is_empty() {
        return Ok(Reply::payload(
            json!({"error": "Terminal executor is offline"}),
        ));
    }
    let attach_payload = request.payload(&record.session_id, offered, socket_id);
    let attach_result = runtime
        .emitters()
        .terminal_call(
            TerminalRelay::Attach,
            &executor_socket_id,
            &attach_payload,
            TERMINAL_ATTACH_TIMEOUT_SECONDS,
        )
        .await;
    let selected = match attach_result {
        Ok(args) => match request.select(&ack_argument(&args), offered, pinned) {
            Ok(selected) => selected,
            Err(message) => return Ok(Reply::payload(json!({"error": message}))),
        },
        Err(error) => {
            tracing::warn!(
                %error,
                session_id = record.session_id,
                "terminal attach RPC failed"
            );
            return Ok(Reply::payload(
                json!({"error": "Failed to attach terminal executor"}),
            ));
        }
    };
    let mut record = record;
    if executor_socket_id != record.socket_id {
        let Some(rebound) = terminal_attach::rebind(redis, &record, &executor_socket_id).await
        else {
            return Ok(Reply::payload(
                json!({"error": "Terminal session could not be rebound"}),
            ));
        };
        record = rebound;
    }
    {
        let mut current = session.state();
        current.session_id = Some(session_id.clone());
        current.protocol_version = Some(selected);
        current.consumer_id = (selected == 2).then(|| request.consumer_id.clone());
        current.authorization = Some(record.clone());
    }
    tracing::info!(user_id, session_id, "terminal attached");
    Ok(Reply::payload(json!({
        "success": true,
        "protocol_version": selected,
        "session_id": record.session_id,
        "device_id": record.device_id,
        "project_id": record.project_id,
        "path": record.path,
    }))
    .join(format!("terminal:{session_id}")))
}

/// `on_terminal_ack`.
pub(crate) async fn ack(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &TerminalSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let authorized = match authorize_attached(state, runtime, session, socket_id, &data).await {
        Ok(authorized) => authorized,
        Err(ack) => return Ok(Reply::payload(ack)),
    };
    if authorized.consumer_id.is_empty() {
        return Ok(Reply::payload(
            json!({"error": "Terminal ACK requires protocol v2"}),
        ));
    }
    let Some(sequence) = data.get("sequence").and_then(positive_integer) else {
        return Ok(Reply::payload(
            json!({"error": "Invalid terminal sequence"}),
        ));
    };
    let payload = json!({
        "session_id": authorized.record.session_id,
        "consumer_id": authorized.consumer_id,
        "sequence": sequence,
    });
    let result = runtime
        .emitters()
        .terminal_call(
            TerminalRelay::Ack,
            &authorized.record.socket_id,
            &payload,
            TERMINAL_ATTACH_TIMEOUT_SECONDS,
        )
        .await;
    match executor_success(result) {
        Some(error) => Ok(Reply::payload(
            json!({"error": error_of(error, "Failed to acknowledge terminal output")}),
        )),
        None => Ok(Reply::payload(json!({"success": true}))),
    }
}

/// `on_terminal_input`.
pub(crate) async fn input(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &TerminalSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let authorized = match authorize_attached(state, runtime, session, socket_id, &data).await {
        Ok(authorized) => authorized,
        Err(ack) => return Ok(Reply::payload(ack)),
    };
    let Some(text) = data.get("data").and_then(Value::as_str) else {
        return Ok(Reply::payload(json!({"error": "Invalid terminal input"})));
    };
    let payload = control_payload(&authorized.record.session_id, &authorized.consumer_id, None);
    let mut payload = payload;
    payload.insert("data".into(), Value::String(text.to_string()));
    if let Err(error) = runtime
        .emitters()
        .terminal_emit(
            TerminalRelay::Input,
            &authorized.record.socket_id,
            &Value::Object(payload),
        )
        .await
    {
        tracing::warn!(%error, "terminal:input delivery failed");
    }
    publish_room_event(
        state,
        "terminal:input",
        &Value::Object(control_payload(
            &authorized.record.session_id,
            &authorized.consumer_id,
            Some(text),
        )),
        EXECUTOR_NAMESPACE,
        &authorized.record.socket_id,
    )
    .await;
    Ok(Reply::payload(json!({"success": true})))
}

/// `on_terminal_resize`.
pub(crate) async fn resize(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &TerminalSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let authorized = match authorize_attached(state, runtime, session, socket_id, &data).await {
        Ok(authorized) => authorized,
        Err(ack) => return Ok(Reply::payload(ack)),
    };
    let (Some(rows), Some(cols)) = (
        data.get("rows").and_then(positive_integer),
        data.get("cols").and_then(positive_integer),
    ) else {
        return Ok(Reply::payload(
            json!({"error": "Invalid terminal dimensions"}),
        ));
    };
    let mut payload = control_payload(&authorized.record.session_id, &authorized.consumer_id, None);
    payload.insert("rows".into(), Value::from(rows));
    payload.insert("cols".into(), Value::from(cols));
    let result = runtime
        .emitters()
        .terminal_call(
            TerminalRelay::Resize,
            &authorized.record.socket_id,
            &Value::Object(payload),
            TERMINAL_ATTACH_TIMEOUT_SECONDS,
        )
        .await;
    match executor_success(result) {
        Some(error) => Ok(Reply::payload(json!({
            "error": error_of(error, "Failed to resize terminal executor"),
        }))),
        None => Ok(Reply::payload(json!({"success": true}))),
    }
}

/// `on_terminal_close`.
pub(crate) async fn close(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &TerminalSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let authorized = match authorize_attached(state, runtime, session, socket_id, &data).await {
        Ok(authorized) => authorized,
        Err(ack) => return Ok(Reply::payload(ack)),
    };
    let payload = Value::Object(control_payload(
        &authorized.record.session_id,
        &authorized.consumer_id,
        None,
    ));
    let result = runtime
        .emitters()
        .terminal_call(
            TerminalRelay::Close,
            &authorized.record.socket_id,
            &payload,
            TERMINAL_ATTACH_TIMEOUT_SECONDS,
        )
        .await;
    if let Some(error) = executor_success(result) {
        return Ok(Reply::payload(json!({
            "error": error_of(error, "Failed to close terminal executor"),
        })));
    }
    // `terminal_session_service.delete` re-raises a store failure; the source's
    // close handler maps it to this error and leaves the room/session intact.
    let revoked = match state.redis.as_ref() {
        Some(redis) => terminal_attach::revoke(redis, &authorized.record.session_id).await,
        None => Err(()),
    };
    if revoked.is_err() {
        return Ok(Reply::payload(
            json!({"error": "Failed to close terminal session"}),
        ));
    }
    {
        let mut current = session.state();
        if current.session_id.as_deref() == Some(authorized.record.session_id.as_str()) {
            current.session_id = None;
            current.consumer_id = None;
            current.protocol_version = None;
            current.authorization = None;
        }
    }
    Ok(Reply::payload(json!({"success": true}))
        .leave(format!("terminal:{}", authorized.record.session_id)))
}

/// The authorized attached-session tuple from `_authorize_attached_session`.
struct Authorized {
    record: TerminalRecord,
    consumer_id: String,
}

/// `_authorize_attached_session`: state, protocol and record checks.
async fn authorize_attached(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &TerminalSession,
    socket_id: &str,
    data: &Value,
) -> Result<Authorized, Value> {
    if session.token_expired(chrono::Utc::now().timestamp()) {
        return Err(token_expired(state, runtime, socket_id).await);
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Err(json!({"error": "Not authenticated"}));
    }
    let session_id = normalize_session_id(data);
    if session_id.is_empty() {
        return Err(json!({"error": "Missing session_id"}));
    }
    let (protocol_version, consumer_id, record) = {
        let current = session.state();
        if current.session_id.as_deref() != Some(session_id.as_str()) {
            return Err(json!({"error": "Terminal session is not attached"}));
        }
        let protocol_version = current.protocol_version;
        if !matches!(protocol_version, Some(1 | 2)) {
            return Err(json!({"error": "Terminal session must be reattached"}));
        }
        let record = current.authorization.clone();
        (
            protocol_version.unwrap_or(0),
            current.consumer_id.clone(),
            record,
        )
    };
    if data.get("protocol_version").is_some()
        && data.get("protocol_version").and_then(Value::as_i64) != Some(protocol_version)
    {
        return Err(json!({"error": "Terminal protocol does not match attachment"}));
    }
    let consumer_id = if protocol_version == 2 {
        let active = consumer_id
            .as_deref()
            .filter(|value| valid_consumer_id(value))
            .unwrap_or_default();
        if active.is_empty() {
            return Err(json!({"error": "Terminal consumer is no longer active"}));
        }
        if data.get("consumer_id").is_some()
            && data.get("consumer_id").and_then(Value::as_str) != Some(active)
        {
            return Err(json!({"error": "Terminal consumer does not match attachment"}));
        }
        active.to_string()
    } else {
        String::new()
    };
    let Some(record) = record else {
        return Err(json!({"error": "Terminal session is not attached"}));
    };
    if record.session_id != session_id || record.user_id != user_id {
        return Err(json!({"error": "Terminal session not found or access denied"}));
    }
    if record.is_expired(chrono::Utc::now()) {
        return Err(json!({"error": "Terminal session expired"}));
    }
    Ok(Authorized {
        record,
        consumer_id,
    })
}

/// `_control_payload` plus the optional input `data` field.
fn control_payload(
    session_id: &str,
    consumer_id: &str,
    text: Option<&str>,
) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert("session_id".into(), Value::String(session_id.to_string()));
    if !consumer_id.is_empty() {
        payload.insert("consumer_id".into(), Value::String(consumer_id.to_string()));
    }
    if let Some(text) = text {
        payload.insert("data".into(), Value::String(text.to_string()));
    }
    payload
}

/// `sio.call`'s single positional argument.
pub(crate) fn ack_argument(args: &Value) -> Value {
    match args {
        Value::Array(items) if items.len() == 1 => items[0].clone(),
        other => other.clone(),
    }
}

/// `None` for a successful executor ack, `Some(error)` otherwise.
fn executor_success(result: Result<Value, brz_socket_io::EmitterError>) -> Option<Value> {
    match result {
        Ok(args) => {
            let ack = ack_argument(&args);
            if ack.get("success").and_then(Value::as_bool) == Some(true) {
                None
            } else {
                Some(ack)
            }
        }
        Err(error) => {
            tracing::warn!(%error, "terminal executor RPC failed");
            Some(Value::Null)
        }
    }
}

/// The source's `str(error or fallback)`.
fn error_of(ack: Value, fallback: &str) -> String {
    ack.get("error")
        .map(source_text)
        .filter(|error| !error.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Python `str(value)` for a decoded JSON error.
fn source_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `_active_executor_socket`: the device's current socket id.
async fn active_executor_socket(state: &AppState, record: &TerminalRecord) -> Result<String, ()> {
    let Some(redis) = state.redis.as_ref() else {
        return Err(());
    };
    match crate::device_online_state::read_online_state_with(
        redis,
        record.user_id,
        &record.device_id,
    )
    .await
    {
        Ok(Some(info)) => Ok(info
            .get("socket_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()),
        Ok(None) => Ok(String::new()),
        Err(()) => Err(()),
    }
}

/// `on_terminal_attach`'s invalid payload details.
fn invalid_attach(data: &Value) -> Value {
    let version = data
        .get("protocol_version")
        .cloned()
        .unwrap_or(Value::from(1));
    match version.as_i64() {
        Some(2) => {
            let consumer_valid = data
                .get("consumer_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(valid_consumer_id);
            if consumer_valid {
                json!({"error": "Invalid last_acked_sequence"})
            } else {
                json!({"error": "Invalid consumer_id"})
            }
        }
        _ => json!({"error": "Invalid terminal protocol_version"}),
    }
}

/// `TerminalAttachRequest`.
struct AttachRequest {
    protocol_version: i64,
    consumer_id: String,
    last_acked_sequence: i64,
}

impl AttachRequest {
    fn parse(data: &Value) -> Option<Self> {
        let version = data
            .get("protocol_version")
            .cloned()
            .unwrap_or(Value::from(1));
        let version = version
            .as_i64()
            .filter(|version| matches!(version, 1 | 2))?;
        if version == 1 {
            return Some(Self {
                protocol_version: 1,
                consumer_id: String::new(),
                last_acked_sequence: 0,
            });
        }
        let consumer_id = data
            .get("consumer_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| valid_consumer_id(value))?
            .to_string();
        let sequence = data
            .get("last_acked_sequence")
            .and_then(Value::as_i64)
            .filter(|sequence| *sequence >= 0)?;
        Some(Self {
            protocol_version: version,
            consumer_id,
            last_acked_sequence: sequence,
        })
    }

    /// `TerminalAttachRequest.offer`.
    fn offer(&self, v2_enabled: bool, pinned: Option<i64>) -> Result<i64, &'static str> {
        if pinned.is_some_and(|pinned| pinned != self.protocol_version) {
            return Err("Terminal protocol is pinned; recreate terminal session");
        }
        let version = pinned.unwrap_or(if v2_enabled { self.protocol_version } else { 1 });
        if version == 1 && self.last_acked_sequence > 0 {
            return Err("Cannot downgrade terminal resume; recreate terminal session");
        }
        Ok(version)
    }

    /// `TerminalAttachRequest.payload`.
    fn payload(&self, session_id: &str, offered: i64, browser_socket_id: &str) -> Value {
        let mut payload = serde_json::Map::new();
        payload.insert("session_id".into(), Value::String(session_id.to_string()));
        payload.insert("protocol_version".into(), Value::from(offered));
        payload.insert(
            "browser_socket_id".into(),
            Value::String(browser_socket_id.to_string()),
        );
        if offered == 2 {
            payload.insert(
                "consumer_id".into(),
                Value::String(self.consumer_id.clone()),
            );
            payload.insert(
                "last_acked_sequence".into(),
                Value::from(self.last_acked_sequence),
            );
        }
        Value::Object(payload)
    }

    /// `TerminalAttachRequest.select`.
    fn select(
        &self,
        response: &Value,
        offered: i64,
        pinned: Option<i64>,
    ) -> Result<i64, &'static str> {
        let Some(version) = response
            .get("protocol_version")
            .and_then(Value::as_i64)
            .filter(|version| matches!(version, 1 | 2))
        else {
            return Err("Invalid executor terminal protocol_version");
        };
        if version > offered {
            return Err("Invalid executor terminal protocol_version");
        }
        if pinned.is_some_and(|pinned| pinned != version) {
            return Err("Terminal protocol is pinned; recreate terminal session");
        }
        if version == 1 && self.last_acked_sequence > 0 {
            return Err("Cannot downgrade terminal resume; recreate terminal session");
        }
        Ok(version)
    }
}

/// `CONSUMER_ID_PATTERN`/`BROWSER_SOCKET_ID_PATTERN` equivalence.
pub(crate) fn valid_consumer_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= CONSUMER_ID_MAX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// `_get_positive_int`.
fn positive_integer(value: &Value) -> Option<i64> {
    let parsed = match value {
        Value::Number(number) => number.as_i64()?,
        Value::String(text) => text.trim().parse().ok()?,
        _ => return None,
    };
    (parsed > 0).then_some(parsed)
}

/// `_handle_token_expired` on the `/terminal` namespace.
async fn token_expired(state: &AppState, runtime: &Arc<SocketRuntime>, socket_id: &str) -> Value {
    let payload = json!({"error": "Token expired", "code": "TOKEN_EXPIRED"});
    if let Err(error) = runtime
        .emitters()
        .terminal_auth_error(socket_id, &payload)
        .await
    {
        tracing::warn!(%error, "terminal auth_error local delivery failed");
    }
    publish_room_event(state, "auth_error", &payload, "/terminal", socket_id).await;
    // The source also disconnects the socket; the framework owns connection
    // lifetime, so the handler only reports the expired token.
    json!({"error": "Token expired"})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(version: i64) -> AttachRequest {
        AttachRequest {
            protocol_version: version,
            consumer_id: "consumer-1".into(),
            last_acked_sequence: 0,
        }
    }

    #[test]
    fn attach_request_parses_v2_and_rejects_invalid_consumers() {
        let parsed = AttachRequest::parse(&json!({
            "protocol_version": 2,
            "consumer_id": "recording_abc-DEF_1",
            "last_acked_sequence": 0
        }))
        .expect("valid v2");
        assert_eq!(parsed.consumer_id, "recording_abc-DEF_1");
        assert!(AttachRequest::parse(&json!({"protocol_version": 3})).is_none());
        assert!(
            AttachRequest::parse(&json!({
                "protocol_version": 2,
                "consumer_id": "bad id"
            }))
            .is_none()
        );
    }

    #[test]
    fn attach_payload_matches_the_source_v2_shape() {
        let payload = request(2).payload("terminal-0-abc", 2, "browser-1");
        assert_eq!(
            payload,
            json!({
                "session_id": "terminal-0-abc",
                "protocol_version": 2,
                "browser_socket_id": "browser-1",
                "consumer_id": "consumer-1",
                "last_acked_sequence": 0
            })
        );
    }

    #[test]
    fn the_pinned_protocol_cannot_change() {
        assert_eq!(
            request(2).offer(true, Some(1)),
            Err("Terminal protocol is pinned; recreate terminal session")
        );
        assert_eq!(request(2).offer(true, Some(2)), Ok(2));
        assert_eq!(request(2).offer(false, None), Ok(1));
        assert_eq!(request(2).offer(false, Some(2)), Ok(2));
    }

    #[test]
    fn executor_errors_keep_the_source_fallback() {
        let mut payload = serde_json::Map::new();
        payload.insert("session_id".into(), Value::String("terminal-0-abc".into()));
        payload.insert("consumer_id".into(), Value::String("consumer-1".into()));
        assert!(payload.contains_key("consumer_id"));
        assert_eq!(
            error_of(json!({"error": ""}), "Failed to close terminal executor"),
            "Failed to close terminal executor"
        );
        assert_eq!(
            error_of(
                json!({"error": "boom"}),
                "Failed to close terminal executor"
            ),
            "boom"
        );
    }
}
