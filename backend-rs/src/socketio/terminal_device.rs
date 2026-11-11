// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` terminal output/exit forwarding.
//!
//! Source: `app/api/ws/device_namespace.py::on_terminal_output` /
//! `on_terminal_exit`, `_authorize_terminal_event` and
//! `app/services/device/terminal_protocol.py::parse_terminal_event`.
//!
//! `handlers/device.rs` wires both events to [`relay_device_event`]: it
//! validates the event, authorizes it against the terminal session record,
//! forwards it to the browser `terminal:<id>` room on `/terminal`, revokes the
//! record on exit, and dispatches the source's forced terminal-end rejection
//! when authorization fails.

use brz_socket_io::ClientError;
use serde_json::{Value, json};

use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::session::SessionSnapshot;
use crate::socketio::terminal_attach::{self, TerminalRecord, normalize_session_id};
use crate::socketio::terminal_relay::valid_consumer_id;
use crate::state::AppState;

/// `TERMINAL_END_DISPATCH_TIMEOUT_SECONDS`.
const TERMINAL_END_DISPATCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// `on_terminal_output` / `on_terminal_exit` on `/local-executor`.
///
/// Entry point for the device lane's `handlers/device.rs`: `snapshot` is the
/// executor connection's [`SessionSnapshot`], `socket_id` its socket id, and
/// `output` selects `terminal:output` (`true`) or `terminal:exit` (`false`).
/// The function validates the event, authorizes it against the terminal session
/// record, forwards it to the browser `terminal:<session_id>` room on
/// `/terminal` (local delivery plus the Redis adapter publish), and revokes the
/// record on exit.
pub(crate) async fn relay_device_event(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
    snapshot: &SessionSnapshot,
    socket_id: &str,
    data: &Value,
    output: bool,
) -> Result<Value, ClientError> {
    let user_id = snapshot.user_id;
    let device_id = snapshot
        .device
        .device_id
        .clone()
        .or_else(|| snapshot.device.reported_device_id.clone())
        .unwrap_or_default();
    let mut payload = match parse_device_terminal_event(data, output) {
        Ok(payload) => payload,
        Err(message) => return Ok(json!({"error": message})),
    };
    let record = match authorize_device_event(state, user_id, &device_id, socket_id, data).await {
        Ok(record) => record,
        Err(error) => {
            return Ok(rejection_for(state, runtime, data, error, !output).await);
        }
    };
    payload.insert(
        "session_id".into(),
        Value::String(record.session_id.clone()),
    );
    let room = format!("terminal:{}", record.session_id);
    let event_name = if output {
        "terminal:output"
    } else {
        "terminal:exit"
    };
    let payload = Value::Object(payload);
    crate::socketio::runtime::deliver_local_emit(
        crate::socketio::runtime::TERMINAL_NAMESPACE,
        event_name,
        &room,
        None,
        &payload,
    )
    .await;
    publish_room_event(
        state,
        event_name,
        &payload,
        crate::socketio::runtime::TERMINAL_NAMESPACE,
        &room,
    )
    .await;
    if output {
        tracing::info!(session_id = record.session_id, "terminal output forwarded");
    } else {
        // `on_terminal_exit` ACKs success only after `terminal_session_service`
        // `.delete` returns; a store failure propagates instead of a success.
        let revoked = match state.redis.as_ref() {
            Some(redis) => terminal_attach::revoke(redis, &record.session_id).await,
            None => Err(()),
        };
        if revoked.is_err() {
            tracing::error!(
                session_id = record.session_id,
                "terminal exit delete failed"
            );
            return Err(super::chat_support::internal_error());
        }
        tracing::info!(session_id = record.session_id, "terminal exit forwarded");
    }
    Ok(json!({"success": true}))
}

/// The source's authorization-error path: an exit that targets a durably
/// revoked session is acknowledged as a successful end; every other
/// dispatchable rejection is forwarded to the browser before the device ACK.
async fn rejection_for(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
    data: &Value,
    error: Value,
    output_complete: bool,
) -> Value {
    if !output_complete {
        return finish_terminal_event_rejection(state, runtime, data, error, false).await;
    }
    let not_found = error.get("code").and_then(Value::as_str) == Some("terminal_session_not_found");
    let session_id = normalize_session_id(data);
    if not_found && !session_id.is_empty() {
        match terminal_attach::is_durably_revoked(state.redis.as_ref(), &session_id).await {
            Ok(true) => {
                let dispatched =
                    finish_terminal_event_rejection(state, runtime, data, error, true).await;
                if dispatched.get("terminal_end_dispatched") == Some(&Value::Bool(true)) {
                    return json!({"success": true});
                }
                return dispatched;
            }
            Ok(false) => {}
            Err(()) => {
                return terminal_event_error(
                    "terminal_session_authorization_unavailable",
                    "Terminal session authorization is temporarily unavailable",
                    true,
                );
            }
        }
    }
    finish_terminal_event_rejection(state, runtime, data, error, true).await
}

/// `_finish_terminal_event_rejection`'s early gate: only a non-retryable error
/// with a dispatchable code is forwarded to the browser.
fn rejection_dispatch_code(error: &Value) -> Option<&'static str> {
    if error.get("retryable") != Some(&Value::Bool(false)) {
        return None;
    }
    match error.get("code").and_then(Value::as_str)? {
        "terminal_session_not_found" => Some("terminal_session_not_found"),
        "terminal_session_expired" => Some("terminal_session_expired"),
        "terminal_session_device_mismatch" => Some("terminal_session_device_mismatch"),
        _ => None,
    }
}

/// A prepared forced terminal end: either the browser call or the final ACK.
enum Rejection {
    Dispatch {
        browser_socket_id: String,
        payload: Value,
    },
    Final(Value),
}

/// `_finish_terminal_event_rejection`'s payload builder.
fn build_rejection(data: &Value, error: &Value, code: &str, output_complete: bool) -> Rejection {
    let session_id = normalize_session_id(data);
    let consumer_id = data
        .get("consumer_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| valid_consumer_id(value))
        .unwrap_or_default();
    let version = data
        .get("protocol_version")
        .and_then(Value::as_i64)
        .filter(|version| matches!(version, 1 | 2))
        .unwrap_or(if consumer_id.is_empty() { 1 } else { 2 });
    if session_id.is_empty() || !matches!(version, 1 | 2) {
        return Rejection::Final(error.clone());
    }
    let message = error
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Terminal session ended");
    let mut payload = serde_json::Map::new();
    payload.insert("session_id".into(), Value::String(session_id));
    payload.insert(
        "exit_code".into(),
        if output_complete {
            data.get("exit_code").cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );
    payload.insert("error".into(), Value::String(message.to_string()));
    payload.insert("reason_code".into(), Value::String(code.to_string()));
    payload.insert("output_complete".into(), Value::Bool(output_complete));
    if version == 2 {
        if consumer_id.is_empty() {
            return Rejection::Final(error.clone());
        }
        payload.insert("protocol_version".into(), Value::from(2));
        payload.insert("consumer_id".into(), Value::String(consumer_id.to_string()));
    }
    let Some(browser_socket_id) = data
        .get("browser_socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| valid_consumer_id(value))
    else {
        return Rejection::Final(terminal_event_error(
            "terminal_end_dispatch_failed",
            "Failed to dispatch terminal session end",
            true,
        ));
    };
    Rejection::Dispatch {
        browser_socket_id: browser_socket_id.to_string(),
        payload: Value::Object(payload),
    }
}

/// `_finish_terminal_event_rejection`: dispatch a session-scoped
/// `terminal:exit` before permanently retiring the record.
async fn finish_terminal_event_rejection(
    state: &AppState,
    runtime: &std::sync::Arc<SocketRuntime>,
    data: &Value,
    error: Value,
    output_complete: bool,
) -> Value {
    let Some(code) = rejection_dispatch_code(&error) else {
        return error;
    };
    let (browser_socket_id, payload) = match build_rejection(data, &error, code, output_complete) {
        Rejection::Dispatch {
            browser_socket_id,
            payload,
        } => (browser_socket_id, payload),
        Rejection::Final(ack) => return ack,
    };
    let sent = if runtime.emitters().has_local_socket(
        crate::socketio::runtime::TERMINAL_NAMESPACE,
        &browser_socket_id,
    ) {
        // `ignore_queue=True`: the browser is connected to this worker.
        match runtime
            .emitters()
            .terminal_exit_call(&browser_socket_id, &payload, TERMINAL_END_DISPATCH_TIMEOUT)
            .await
        {
            Ok(args) => {
                crate::socketio::terminal_relay::ack_argument(&args)
                    .get("success")
                    .and_then(Value::as_bool)
                    == Some(true)
            }
            Err(_) => false,
        }
    } else {
        // A remote browser: publish the adapter call and await its real ACK.
        adapter_terminal_exit(state, &browser_socket_id, &payload).await
    };
    if !sent {
        // The remote-ACK outcome is an uncovered gap until a recording proves
        // it; the source reports the dispatch failure shape either way.
        return terminal_event_error(
            "terminal_end_dispatch_failed",
            "Failed to dispatch terminal session end",
            true,
        );
    }
    let mut dispatched = terminal_event_error(code, message_of(&error), false);
    if let Value::Object(object) = &mut dispatched {
        object.insert("terminal_end_dispatched".into(), Value::Bool(true));
    }
    dispatched
}

/// `sio.call("terminal:exit", ..., to=remote_sid)` over the Redis adapter,
/// awaiting the browser's real callback.
async fn adapter_terminal_exit(state: &AppState, browser_socket_id: &str, payload: &Value) -> bool {
    let (Some(rpc), Some(redis)) = (state.socketio_rpc.as_ref(), state.redis.as_ref()) else {
        return false;
    };
    let Ok(call) = rpc.begin(
        browser_socket_id,
        crate::socketio::runtime::TERMINAL_NAMESPACE,
    ) else {
        return false;
    };
    let data = crate::json_compat::python_json_value(&Value::Array(vec![payload.clone()]));
    let message = crate::socketio_emit::emit_message_with_callback(
        "terminal:exit",
        &data,
        crate::socketio::runtime::TERMINAL_NAMESPACE,
        browser_socket_id,
        Some((browser_socket_id, call.id())),
    );
    use brz_redis::Redis as _;
    if redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
        .is_err()
    {
        return false;
    }
    match call.wait(TERMINAL_END_DISPATCH_TIMEOUT).await {
        Ok(args) => {
            crate::socketio::terminal_relay::ack_argument(&args)
                .get("success")
                .and_then(Value::as_bool)
                == Some(true)
        }
        Err(_) => false,
    }
}

/// `str(error.get("error") or "Terminal session ended")`.
fn message_of(error: &Value) -> &str {
    error
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Terminal session ended")
}

/// `_authorize_terminal_event`: executor/session ownership and socket binding.
async fn authorize_device_event(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    socket_id: &str,
    data: &Value,
) -> Result<TerminalRecord, Value> {
    if user_id == 0 || device_id.is_empty() {
        return Err(terminal_event_error(
            "terminal_not_registered",
            "Not authenticated or not registered",
            true,
        ));
    }
    let session_id = normalize_session_id(data);
    if session_id.is_empty() {
        return Err(terminal_event_error(
            "terminal_session_id_missing",
            "Missing session_id",
            false,
        ));
    }
    // `terminal_session_service.get(refresh=False)`: reuse the attach's cached
    // authorization and only fall back to the exact-key Redis GET on a miss.
    // Coherence, revocation, expiry, and epoch handling live in the cache.
    let record = match terminal_attach::get(state.redis.as_ref(), &session_id, false).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Err(terminal_event_error(
                "terminal_session_not_found",
                "Terminal session not found",
                false,
            ));
        }
        Err(()) => {
            return Err(terminal_event_error(
                "terminal_session_authorization_unavailable",
                "Terminal session authorization is temporarily unavailable",
                true,
            ));
        }
    };
    if record.is_expired(chrono::Utc::now()) {
        return Err(terminal_event_error(
            "terminal_session_expired",
            "Terminal session expired",
            false,
        ));
    }
    if record.user_id != user_id || record.device_id != device_id {
        return Err(terminal_event_error(
            "terminal_session_device_mismatch",
            "Terminal session does not belong to this device",
            false,
        ));
    }
    if record.socket_id == socket_id {
        return Ok(record);
    }
    let Some(redis) = state.redis.as_ref() else {
        return Err(terminal_event_error(
            "terminal_session_authorization_unavailable",
            "Terminal session authorization is temporarily unavailable",
            true,
        ));
    };
    let online =
        crate::device_online_state::read_online_state_with(redis, user_id, device_id).await;
    let online_socket = match online {
        Ok(Some(info)) => info
            .get("socket_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Ok(None) => String::new(),
        Err(()) => String::new(),
    };
    if online_socket != socket_id {
        return Err(terminal_event_error(
            "terminal_session_stale_socket",
            "Terminal session belongs to a stale device socket",
            true,
        ));
    }
    match terminal_attach::rebind(redis, &record, socket_id).await {
        Some(rebound) => Ok(rebound),
        None => Err(terminal_event_error(
            "terminal_session_rebind_failed",
            "Terminal session could not be rebound",
            true,
        )),
    }
}

/// `_terminal_event_error`.
fn terminal_event_error(code: &str, message: &str, retryable: bool) -> Value {
    json!({"error": message, "code": code, "retryable": retryable})
}

/// `parse_terminal_event` (`terminal_protocol.py`): validate the complete event,
/// returning the payload without `browser_socket_id`.
fn parse_device_terminal_event(
    data: &Value,
    output: bool,
) -> Result<serde_json::Map<String, Value>, String> {
    let Some(object) = data.as_object() else {
        return Err("Invalid terminal event".into());
    };
    let has_v2_fields = ["consumer_id", "sequence", "last_acked_sequence"]
        .iter()
        .any(|field| object.contains_key(*field));
    let version = match object.get("protocol_version") {
        Some(Value::Number(number)) => number.as_i64(),
        Some(_) => None,
        None => Some(if has_v2_fields { 2 } else { 1 }),
    };
    let Some(version) = version.filter(|version| matches!(version, 1 | 2)) else {
        return Err("Invalid terminal protocol_version".into());
    };
    if version == 1 && has_v2_fields {
        return Err("Invalid terminal protocol_version".into());
    }
    if version == 2
        && (output || object.contains_key("sequence"))
        && object
            .get("sequence")
            .and_then(Value::as_i64)
            .filter(|sequence| *sequence >= 1)
            .is_none()
    {
        return Err("Invalid terminal sequence".into());
    }
    let mut allowed: Vec<&str> = Vec::new();
    if output {
        if object.get("data").and_then(Value::as_str).is_none() {
            return Err("Invalid terminal output".into());
        }
        allowed.extend([
            "session_id",
            "data",
            "protocol_version",
            "browser_socket_id",
        ]);
    } else {
        let exit_ok = object.get("exit_code").is_some_and(|value| {
            value.is_null() || matches!(value, Value::Number(number) if number.is_i64())
        });
        if !exit_ok {
            return Err("Invalid terminal exit_code".into());
        }
        if object.get("error").is_some_and(|value| !value.is_string()) {
            return Err("Invalid terminal error".into());
        }
        allowed.extend([
            "session_id",
            "exit_code",
            "error",
            "protocol_version",
            "browser_socket_id",
        ]);
    }
    let mut payload = object.clone();
    if version == 2 {
        // `get_consumer_id`: trim, then the bounded `[A-Za-z0-9_-]+` pattern;
        // the normalized value is what the browser receives.
        let Some(consumer) = object
            .get("consumer_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| valid_consumer_id(value))
        else {
            return Err("Invalid terminal consumer".into());
        };
        payload.insert("consumer_id".into(), Value::String(consumer.to_string()));
        allowed.extend(["consumer_id", "sequence"]);
    }
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Invalid terminal event fields".into());
    }
    if let Some(browser) = object.get("browser_socket_id")
        && !browser.as_str().is_some_and(valid_consumer_id)
    {
        return Err("Invalid terminal browser socket".into());
    }
    payload.remove("browser_socket_id");
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_output_and_exit_payloads_validate_like_the_source() {
        let output = parse_device_terminal_event(
            &json!({
                "session_id": "terminal-0-abc",
                "consumer_id": "recording_1",
                "protocol_version": 2,
                "sequence": 1,
                "data": "recording-ok\r\n"
            }),
            true,
        )
        .expect("valid output");
        assert_eq!(output.get("data"), Some(&json!("recording-ok\r\n")));
        let exit = parse_device_terminal_event(
            &json!({
                "session_id": "terminal-0-abc",
                "consumer_id": "recording_1",
                "protocol_version": 2,
                "exit_code": 0
            }),
            false,
        )
        .expect("valid exit");
        assert_eq!(exit.get("exit_code"), Some(&json!(0)));
        assert!(parse_device_terminal_event(&json!({"data": 1}), true).is_err());
    }

    /// The forced-rejection gate: only non-retryable dispatchable codes build a
    /// browser call, and a missing browser socket reports the dispatch failure.
    #[test]
    fn the_rejection_dispatch_gates_follow_the_source() {
        assert_eq!(
            rejection_dispatch_code(&terminal_event_error(
                "terminal_session_not_found",
                "Terminal session not found",
                true
            )),
            None
        );
        assert_eq!(
            rejection_dispatch_code(&terminal_event_error(
                "terminal_session_stale_socket",
                "Terminal session belongs to a stale device socket",
                false
            )),
            None
        );
        assert_eq!(
            rejection_dispatch_code(&terminal_event_error(
                "terminal_session_not_found",
                "Terminal session not found",
                false
            )),
            Some("terminal_session_not_found")
        );
        let error = terminal_event_error(
            "terminal_session_not_found",
            "Terminal session not found",
            false,
        );
        match build_rejection(
            &json!({"session_id": "terminal-0-abc", "protocol_version": 1}),
            &error,
            "terminal_session_not_found",
            false,
        ) {
            Rejection::Final(ack) => {
                assert_eq!(ack["code"], "terminal_end_dispatch_failed");
                assert_eq!(ack["retryable"], true);
            }
            Rejection::Dispatch { .. } => panic!("no browser socket cannot dispatch"),
        }
        match build_rejection(
            &json!({
                "session_id": "terminal-0-abc",
                "protocol_version": 1,
                "browser_socket_id": "browser-1",
                "exit_code": 0
            }),
            &error,
            "terminal_session_not_found",
            true,
        ) {
            Rejection::Dispatch {
                browser_socket_id,
                payload,
            } => {
                assert_eq!(browser_socket_id, "browser-1");
                assert_eq!(payload["session_id"], "terminal-0-abc");
                assert_eq!(payload["exit_code"], 0);
                assert_eq!(payload["output_complete"], true);
                assert_eq!(payload["reason_code"], "terminal_session_not_found");
                assert!(payload.get("consumer_id").is_none());
            }
            Rejection::Final(_) => panic!("a browser socket dispatches"),
        }
    }
}
