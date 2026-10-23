// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/robot-queue/emit-runtime-rpc` — emit one `runtime:rpc`
//! event to a device's executor from inside the request-serving process
//! (`app.api.endpoints.internal.robot_queue.emit_runtime_rpc`).
//!
//! Pipeline:
//! 1. the router-level `Depends(verify_internal_service_token)` bearer check
//!    (`crate::internal_auth::InternalService`, no database access);
//! 2. the whole JSON body is the source's `payload: Dict[str, Any]` parameter;
//!    `user_id`, `device_id`, and an object `payload` are required, otherwise
//!    the endpoint raises `HTTPException(422, "user_id/device_id/payload
//!    required")`;
//! 3. `device_service.get_device_online_info(int(user_id), str(device_id))`:
//!    one strict Redis `GET device:online:<user_id>:<device_id>`; a missing or
//!    empty value, a falsy payload, or a missing/falsy `socket_id` answers
//!    `{"emitted": false, "reason": "device_offline"}` without any RPC;
//! 4. without `wait_ack` the adapter `emit` for `runtime:rpc` on the
//!    `/local-executor` namespace is published to `socketio` and the handler
//!    answers `{"emitted": true}`;
//! 5. with `wait_ack` the handler performs the source's `sio.call`: register a
//!    callback waiter, publish the same adapter message with its callback
//!    identity, and wait `ack_timeout_seconds` (default 15) for the executor's
//!    acknowledgement. Any failure in that round trip is the source's broad
//!    `except`, which answers `emitted=true, accepted=false,
//!    outcome_unknown=true` with the timeout text.
//!
//! The response is a plain dict, so FastAPI's implicit `Dict[str, Any]`
//! response model renders `emitted`, then `accepted`/`response` or
//! `reason`/`outcome_unknown`/`error` in insertion order.

use std::time::Duration;

use brz_http_server::StatusCode;
use brz_redis::Redis as _;
use serde_json::{Map, Value};

use crate::device_online_state::read_online_state;
use crate::http_compat::FastApiError;
use crate::internal_callback::py_json::python_dumps;
use crate::json_compat::{python_str, python_truthy};
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message, emit_message_with_callback};
use crate::socketio_rpc::RpcError;
use crate::state::AppState;

/// `DeviceNamespace("/local-executor")`.
const LOCAL_EXECUTOR_NAMESPACE: &str = "/local-executor";
/// The event the executor's device socket registers for runtime RPCs.
const RUNTIME_RPC_EVENT: &str = "runtime:rpc";
/// `payload.get("method") or "runtime.tasks.create"`.
const DEFAULT_RUNTIME_METHOD: &str = "runtime.tasks.create";
/// `int(payload.get("ack_timeout_seconds") or 15)`.
const DEFAULT_ACK_TIMEOUT_SECONDS: i64 = 15;
/// The source's single validation message for the three required fields.
const REQUIRED_FIELDS_DETAIL: &str = "user_id/device_id/payload required";

/// `POST /api/internal/robot-queue/emit-runtime-rpc`.
#[brz_http_server::post("/api/internal/robot-queue/emit-runtime-rpc")]
async fn emit_runtime_rpc(
    #[inject(state)] state: &AppState,
    #[auth] _service: crate::internal_auth::InternalService,
    body: Value,
) -> Result<Value, FastApiError> {
    let request = RpcRequest::parse(&body)?;
    emit_runtime_rpc_value(state, &request).await
}

/// One validated dispatch request.
#[derive(Debug, PartialEq)]
struct RpcRequest {
    /// `int(payload.get("user_id"))`.
    user_id: i64,
    /// `str(payload.get("device_id"))`.
    device_id: String,
    /// `payload.get("method") or "runtime.tasks.create"`, kept as the source
    /// value so the published envelope carries it unchanged.
    method: Value,
    /// `payload.get("payload")`; required to be a JSON object.
    rpc_payload: Value,
    /// `bool(payload.get("wait_ack"))`.
    wait_ack: bool,
    /// `int(payload.get("ack_timeout_seconds") or 15)`, with the source's
    /// `(TypeError, ValueError)` fallback.
    ack_timeout: i64,
}

impl RpcRequest {
    /// FastAPI's `payload: Dict[str, Any]` binding followed by the endpoint's
    /// own required-field guard.
    fn parse(body: &Value) -> Result<Self, FastApiError> {
        let object = match body {
            Value::Object(object) => object,
            // A literal JSON `null` body is pydantic's required-body failure.
            Value::Null => {
                return Err(FastApiError::validation(vec![serde_json::json!({
                    "type": "missing",
                    "loc": ["body"],
                    "msg": "Field required",
                    "input": null,
                })]));
            }
            other => {
                return Err(FastApiError::validation(vec![serde_json::json!({
                    "type": "dict_type",
                    "loc": ["body"],
                    "msg": "Input should be a valid dictionary",
                    "input": other,
                })]));
            }
        };

        let user_id = object.get("user_id").filter(|value| python_truthy(value));
        let device_id = object.get("device_id").filter(|value| python_truthy(value));
        let (Some(user_id), Some(device_id), Some(Value::Object(rpc_payload))) =
            (user_id, device_id, object.get("payload"))
        else {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                REQUIRED_FIELDS_DETAIL,
            ));
        };

        // `int(user_id)`: a truthy value that does not convert raises in the
        // source and reaches the unhandled-exception handler.
        let Some(user_id) = python_int(user_id) else {
            tracing::error!(user_id = %python_str(user_id), "runtime RPC: user id is not an integer");
            return Err(FastApiError::unhandled());
        };

        Ok(Self {
            user_id,
            device_id: python_str(device_id),
            method: object
                .get("method")
                .filter(|value| python_truthy(value))
                .cloned()
                .unwrap_or_else(|| Value::String(DEFAULT_RUNTIME_METHOD.to_string())),
            rpc_payload: Value::Object(rpc_payload.clone()),
            wait_ack: object.get("wait_ack").is_some_and(python_truthy),
            ack_timeout: object
                .get("ack_timeout_seconds")
                .filter(|value| python_truthy(value))
                .and_then(python_int)
                .unwrap_or(DEFAULT_ACK_TIMEOUT_SECONDS),
        })
    }

    /// `{"method": method, "payload": payload}` — the source dict's order.
    fn envelope(&self) -> Value {
        let mut envelope = Map::new();
        envelope.insert("method".to_string(), self.method.clone());
        envelope.insert("payload".to_string(), self.rpc_payload.clone());
        Value::Object(envelope)
    }
}

/// The endpoint body after validation.
async fn emit_runtime_rpc_value(
    state: &AppState,
    request: &RpcRequest,
) -> Result<Value, FastApiError> {
    // `device_service.get_device_online_info`.
    let online = read_online_state::<Value>(state, request.user_id, &request.device_id).await?;
    let Some(socket_id) = socket_id(online)? else {
        return Ok(offline_response());
    };

    tracing::info!(
        method = %python_str(&request.method),
        user_id = request.user_id,
        device_id = request.device_id,
        socket_id = socket_id,
        payload_keys = ?rpc_payload_keys(&request.rpc_payload),
        task_id = ?rpc_task_id(&request.rpc_payload),
        "runtime RPC emitted to device"
    );

    if !request.wait_ack {
        publish_runtime_rpc(state, &socket_id, request, None).await?;
        let mut response = Map::new();
        response.insert("emitted".to_string(), Value::Bool(true));
        return Ok(Value::Object(response));
    }

    match call_runtime_rpc(state, &socket_id, request).await {
        Ok(acknowledgement) => Ok(acknowledged_response(ack_value(acknowledgement))),
        Err(error) => {
            // `except Exception`: every round-trip failure answers the same
            // "ACK timed out" body; only the log distinguishes it.
            tracing::warn!(
                method = %python_str(&request.method),
                user_id = request.user_id,
                device_id = request.device_id,
                %error,
                "runtime RPC acknowledgement failed"
            );
            Ok(unacknowledged_response(request.ack_timeout))
        }
    }
}

/// `(online or {}).get("socket_id") if online else None`, with the source's
/// `AttributeError` for a truthy non-dict online payload rendered as the
/// unhandled-exception body.
fn socket_id(online: Option<Value>) -> Result<Option<String>, FastApiError> {
    let Some(online) = online else {
        return Ok(None);
    };
    if !python_truthy(&online) {
        return Ok(None);
    }
    let Value::Object(object) = online else {
        tracing::error!("device online payload is not a dict");
        return Err(FastApiError::unhandled());
    };
    Ok(object
        .get("socket_id")
        .filter(|value| python_truthy(value))
        .map(python_str))
}

/// `sio.call`'s return: the acknowledgement's positional arguments reduced
/// like `callback_args[0] if len > 1 else callback_args[0][0] if len == 1 else
/// None`.
fn ack_value(arguments: Value) -> Value {
    match arguments {
        Value::Array(mut items) if items.len() == 1 => items.remove(0),
        Value::Array(items) if items.is_empty() => Value::Null,
        other => other,
    }
}

/// Publish the adapter `emit` for one runtime RPC.
///
/// `callback_id` carries the source's `(room, namespace, id)` callback identity
/// when the caller waits for an acknowledgement; the plain `sio.emit` path
/// passes none.
async fn publish_runtime_rpc(
    state: &AppState,
    socket_id: &str,
    request: &RpcRequest,
    callback_id: Option<u64>,
) -> Result<(), FastApiError> {
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!("runtime RPC: no Redis service");
        return Err(FastApiError::unhandled());
    };
    let data = python_dumps(&Value::Array(vec![request.envelope()]));
    let message = match callback_id {
        Some(id) => emit_message_with_callback(
            RUNTIME_RPC_EVENT,
            &data,
            LOCAL_EXECUTOR_NAMESPACE,
            socket_id,
            Some((socket_id, id)),
        ),
        None => emit_message(
            RUNTIME_RPC_EVENT,
            &data,
            LOCAL_EXECUTOR_NAMESPACE,
            socket_id,
        ),
    };
    redis
        .publish(SOCKETIO_CHANNEL, message)
        .await
        .map(|_| ())
        .map_err(|error| {
            tracing::error!(%error, "runtime RPC publish failure");
            FastApiError::unhandled()
        })
}

/// `sio.call("runtime:rpc", envelope, to=socket_id, namespace="/local-executor",
/// timeout=ack_timeout)`: the waiter registration, the callback emit, and the
/// acknowledgement wait. Failures stay distinguishable for the log only; the
/// endpoint maps every one of them to the same response.
async fn call_runtime_rpc(
    state: &AppState,
    socket_id: &str,
    request: &RpcRequest,
) -> Result<Value, RpcError> {
    let Some(rpc) = state.socketio_rpc.as_ref() else {
        return Err(RpcError::Unavailable(
            "no Socket.IO RPC subscriber".to_string(),
        ));
    };
    let call = rpc.begin(socket_id, LOCAL_EXECUTOR_NAMESPACE)?;
    publish_runtime_rpc(state, socket_id, request, Some(call.id()))
        .await
        .map_err(|_| RpcError::Unavailable("runtime RPC publish failed".to_string()))?;
    call.wait(Duration::from_secs(request.ack_timeout.max(0) as u64))
        .await
}

/// `{"emitted": false, "reason": "device_offline"}`.
fn offline_response() -> Value {
    let mut response = Map::new();
    response.insert("emitted".to_string(), Value::Bool(false));
    response.insert(
        "reason".to_string(),
        Value::String("device_offline".to_string()),
    );
    Value::Object(response)
}

/// `{"emitted": true, "accepted": accepted, "response": response}`.
fn acknowledged_response(result: Value) -> Value {
    let accepted = result
        .as_object()
        .is_some_and(|object| python_truthy(ack_verdict(object)));
    let response = match result {
        Value::Object(_) => result,
        other => {
            let mut value = Map::new();
            value.insert("value".to_string(), other);
            Value::Object(value)
        }
    };
    let mut body = Map::new();
    body.insert("emitted".to_string(), Value::Bool(true));
    body.insert("accepted".to_string(), Value::Bool(accepted));
    body.insert("response".to_string(), response);
    Value::Object(body)
}

/// `result.get("accepted", result.get("success", False))`.
fn ack_verdict(object: &Map<String, Value>) -> &Value {
    object
        .get("accepted")
        .or_else(|| object.get("success"))
        .unwrap_or(&Value::Bool(false))
}

/// The source's failure body: `emitted=true, accepted=false,
/// outcome_unknown=true` plus the fixed timeout text.
fn unacknowledged_response(ack_timeout: i64) -> Value {
    let mut response = Map::new();
    response.insert("emitted".to_string(), Value::Bool(true));
    response.insert("accepted".to_string(), Value::Bool(false));
    response.insert("outcome_unknown".to_string(), Value::Bool(true));
    response.insert(
        "error".to_string(),
        Value::String(format!("runtime RPC ACK timed out after {ack_timeout}s")),
    );
    Value::Object(response)
}

/// `sorted(rpc_payload.keys())` for the request log.
fn rpc_payload_keys(payload: &Value) -> Vec<String> {
    let mut keys: Vec<String> = payload
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    keys.sort();
    keys
}

/// `rpc_payload.get("taskId") or rpc_payload.get("task_id")` for the log.
fn rpc_task_id(payload: &Value) -> Option<Value> {
    let object = payload.as_object()?;
    object
        .get("taskId")
        .filter(|value| python_truthy(value))
        .or_else(|| object.get("task_id").filter(|value| python_truthy(value)))
        .cloned()
}

/// Python `int(value)` for a decoded JSON value. `int()` accepts integers,
/// floating-point truncation, booleans, and base-10 integer strings; every
/// other type is the source's `TypeError`, and a malformed string its
/// `ValueError`. Both fall back to the default timeout.
fn python_int(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(flag) => Some(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| number.as_f64().map(|value| value.trunc() as i64)),
        Value::String(text) => parse_int_literal(text),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

/// Python `int(str)`: surrounding whitespace is allowed, the rest must be a
/// base-10 integer literal with optional sign and single `_` group separators.
fn parse_int_literal(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    if digits.is_empty()
        || digits.starts_with('_')
        || digits.ends_with('_')
        || digits.contains("__")
        || !digits
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'_')
    {
        return None;
    }
    let normalized: String = digits
        .chars()
        .filter(|character| *character != '_')
        .collect();
    let magnitude: i128 = normalized.parse().ok()?;
    let signed = if negative { -magnitude } else { magnitude };
    Some(i64::try_from(signed).unwrap_or(if negative { i64::MIN } else { i64::MAX }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request_body() -> Value {
        json!({
            "user_id": 86,
            "device_id": "app-record-1",
            "method": "runtime.tasks.cancel",
            "payload": {"taskId": "queue-1", "deviceId": "app-record-1"},
            "wait_ack": true,
            "ack_timeout_seconds": 15,
        })
    }

    fn validation_detail(error: &FastApiError) -> String {
        error.validation_detail()
    }

    #[test]
    fn parses_the_recorded_dispatch_shape() {
        let request = RpcRequest::parse(&request_body()).unwrap();
        assert_eq!(request.user_id, 86);
        assert_eq!(request.device_id, "app-record-1");
        assert_eq!(request.method, json!("runtime.tasks.cancel"));
        assert_eq!(
            request.rpc_payload,
            json!({"taskId": "queue-1", "deviceId": "app-record-1"})
        );
        assert!(request.wait_ack);
        assert_eq!(request.ack_timeout, 15);
    }

    #[test]
    fn method_and_ack_timeout_defaults_follow_python_or() {
        let body = json!({
            "user_id": 1,
            "device_id": "dev",
            "payload": {},
        });
        let request = RpcRequest::parse(&body).unwrap();
        assert_eq!(request.method, json!(DEFAULT_RUNTIME_METHOD));
        assert!(!request.wait_ack);
        assert_eq!(request.ack_timeout, DEFAULT_ACK_TIMEOUT_SECONDS);

        // Falsy method/ack values fall back; falsy wait_ack stays false.
        let body = json!({
            "user_id": 1,
            "device_id": "dev",
            "method": "",
            "payload": {},
            "ack_timeout_seconds": 0,
            "wait_ack": 0,
        });
        let request = RpcRequest::parse(&body).unwrap();
        assert_eq!(request.method, json!(DEFAULT_RUNTIME_METHOD));
        assert_eq!(request.ack_timeout, DEFAULT_ACK_TIMEOUT_SECONDS);
        assert!(!request.wait_ack);
    }

    #[test]
    fn non_string_method_is_published_unchanged() {
        let mut body = request_body();
        body["method"] = json!(5);
        let request = RpcRequest::parse(&body).unwrap();
        assert_eq!(request.method, json!(5));
        assert_eq!(
            python_dumps(&request.envelope()),
            r#"{"method": 5, "payload": {"taskId": "queue-1", "deviceId": "app-record-1"}}"#
        );
    }

    #[test]
    fn required_field_guard_answers_the_source_detail() {
        for body in [
            json!({"device_id": "dev", "payload": {}}),
            json!({"user_id": 0, "device_id": "dev", "payload": {}}),
            json!({"user_id": 1, "payload": {}}),
            json!({"user_id": 1, "device_id": "", "payload": {}}),
            json!({"user_id": 1, "device_id": "dev"}),
            json!({"user_id": 1, "device_id": "dev", "payload": []}),
            json!({"user_id": 1, "device_id": "dev", "payload": "x"}),
        ] {
            let error = RpcRequest::parse(&body).unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(error.detail_message(), Some(REQUIRED_FIELDS_DETAIL));
        }
    }

    #[test]
    fn empty_payload_object_passes_the_dict_guard() {
        let request = RpcRequest::parse(&json!({
            "user_id": 1, "device_id": "dev", "payload": {}
        }))
        .unwrap();
        assert_eq!(request.rpc_payload, json!({}));
    }

    #[test]
    fn non_object_body_matches_fastapi_validation() {
        let error = RpcRequest::parse(&json!([1, 2])).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            validation_detail(&error),
            r#"[{"type":"dict_type","loc":["body"],"msg":"Input should be a valid dictionary","input":[1,2]}]"#
        );

        let null = RpcRequest::parse(&Value::Null).unwrap_err();
        assert_eq!(
            validation_detail(&null),
            r#"[{"type":"missing","loc":["body"],"msg":"Field required","input":null}]"#
        );
    }

    #[test]
    fn user_id_int_conversion_matches_python() {
        let request = RpcRequest::parse(&json!({
            "user_id": " 86 ", "device_id": "dev", "payload": {}
        }))
        .unwrap();
        assert_eq!(request.user_id, 86);

        let request = RpcRequest::parse(&json!({
            "user_id": 86.9, "device_id": "dev", "payload": {}
        }))
        .unwrap();
        assert_eq!(request.user_id, 86);

        let request = RpcRequest::parse(&json!({
            "user_id": true, "device_id": "dev", "payload": {}
        }))
        .unwrap();
        assert_eq!(request.user_id, 1);

        let error = RpcRequest::parse(&json!({
            "user_id": "86.0", "device_id": "dev", "payload": {}
        }))
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn device_id_uses_python_str() {
        let request = RpcRequest::parse(&json!({
            "user_id": 1, "device_id": 77, "payload": {}
        }))
        .unwrap();
        assert_eq!(request.device_id, "77");
    }

    #[test]
    fn ack_timeout_conversion_matches_python_int() {
        for (value, expected) in [
            (json!(20), Some(20)),
            (json!("20"), Some(20)),
            (json!(" 1_5 "), Some(15)),
            (json!(2.9), Some(2)),
            (json!(-3.9), Some(-3)),
            (json!(true), Some(1)),
            (json!("abc"), None),
            (json!([1]), None),
            (json!({"a": 1}), None),
        ] {
            assert_eq!(python_int(&value), expected, "int({value})");
        }
        // An unconvertible truthy value falls back to the default.
        let request = RpcRequest::parse(&json!({
            "user_id": 1, "device_id": "dev", "payload": {}, "ack_timeout_seconds": "abc"
        }))
        .unwrap();
        assert_eq!(request.ack_timeout, DEFAULT_ACK_TIMEOUT_SECONDS);
    }

    #[test]
    fn socket_id_requires_a_truthy_field_of_a_truthy_dict() {
        assert_eq!(socket_id(None).unwrap(), None);
        assert_eq!(socket_id(Some(json!({}))).unwrap(), None);
        assert_eq!(socket_id(Some(json!(null))).unwrap(), None);
        assert_eq!(socket_id(Some(json!([]))).unwrap(), None);
        assert_eq!(socket_id(Some(json!({"socket_id": ""}))).unwrap(), None);
        assert_eq!(socket_id(Some(json!({"socket_id": null}))).unwrap(), None);
        assert_eq!(
            socket_id(Some(json!({"socket_id": "sid-1", "status": "online"}))).unwrap(),
            Some("sid-1".to_string())
        );
        // A truthy non-dict online payload indexes like a dict in the source.
        let error = socket_id(Some(json!(["online"]))).unwrap_err();
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn acknowledgement_arguments_reduce_like_call() {
        assert_eq!(
            ack_value(json!([{"accepted": true}])),
            json!({"accepted": true})
        );
        assert_eq!(ack_value(json!([])), Value::Null);
        assert_eq!(ack_value(json!([1, 2])), json!([1, 2]));
        assert_eq!(ack_value(Value::Null), Value::Null);
    }

    #[test]
    fn single_object_acknowledgement_builds_the_accepted_body() {
        let ack = ack_value(json!([{
            "accepted": true,
            "success": true,
            "taskId": "queue-1"
        }]));
        assert_eq!(
            serde_json::to_string(&acknowledged_response(ack)).unwrap(),
            r#"{"emitted":true,"accepted":true,"response":{"accepted":true,"success":true,"taskId":"queue-1"}}"#
        );

        // `sio.call` returns `None` for an empty acknowledgement, and the
        // endpoint reports it as an unaccepted `value`.
        let ack = acknowledged_response(ack_value(json!([])));
        assert_eq!(
            serde_json::to_string(&ack).unwrap(),
            r#"{"emitted":true,"accepted":false,"response":{"value":null}}"#
        );
    }

    #[test]
    fn responses_match_the_source_dict_order() {
        assert_eq!(
            serde_json::to_string(&offline_response()).unwrap(),
            r#"{"emitted":false,"reason":"device_offline"}"#
        );
        assert_eq!(
            serde_json::to_string(&unacknowledged_response(15)).unwrap(),
            r#"{"emitted":true,"accepted":false,"outcome_unknown":true,"error":"runtime RPC ACK timed out after 15s"}"#
        );
        assert_eq!(
            serde_json::to_string(&acknowledged_response(json!({
                "accepted": true,
                "success": true,
                "taskId": "queue-1"
            })))
            .unwrap(),
            r#"{"emitted":true,"accepted":true,"response":{"accepted":true,"success":true,"taskId":"queue-1"}}"#
        );
    }

    #[test]
    fn acknowledgement_verdict_prefers_accepted_then_success() {
        assert!(
            !acknowledged_response(json!({}))["accepted"]
                .as_bool()
                .unwrap()
        );
        assert!(
            acknowledged_response(json!({"success": true}))["accepted"]
                .as_bool()
                .unwrap()
        );
        // A present but falsy `accepted` wins over a truthy `success`.
        assert!(
            !acknowledged_response(json!({"accepted": null, "success": true}))["accepted"]
                .as_bool()
                .unwrap()
        );
        // A non-object acknowledgement is reported under `value`.
        assert_eq!(
            serde_json::to_string(&acknowledged_response(json!("ok"))).unwrap(),
            r#"{"emitted":true,"accepted":false,"response":{"value":"ok"}}"#
        );
    }

    #[test]
    fn emitted_payload_matches_the_source_adapter_message() {
        let request = RpcRequest::parse(&request_body()).unwrap();
        let data = python_dumps(&Value::Array(vec![request.envelope()]));
        assert_eq!(
            data,
            r#"[{"method": "runtime.tasks.cancel", "payload": {"taskId": "queue-1", "deviceId": "app-record-1"}}]"#
        );
        let message = emit_message_with_callback(
            RUNTIME_RPC_EVENT,
            &data,
            LOCAL_EXECUTOR_NAMESPACE,
            "sid-1",
            Some(("sid-1", 7)),
        );
        assert!(message.starts_with(
            "{\"method\": \"emit\", \"event\": \"runtime:rpc\", \"data\": \
             [{\"method\": \"runtime.tasks.cancel\", \"payload\": {\"taskId\": \"queue-1\", \
             \"deviceId\": \"app-record-1\"}}], \"binary\": false, \"namespace\": \
             \"/local-executor\", \"room\": \"sid-1\", \"skip_sid\": null, \"callback\": \
             [\"sid-1\", \"/local-executor\", 7], \"host_id\": \""
        ));
    }

    #[test]
    fn plain_emit_has_no_callback_identity() {
        let request = RpcRequest::parse(&request_body()).unwrap();
        let data = python_dumps(&Value::Array(vec![request.envelope()]));
        let message = emit_message(RUNTIME_RPC_EVENT, &data, LOCAL_EXECUTOR_NAMESPACE, "sid-1");
        assert!(message.contains("\"callback\": null"));
    }

    #[test]
    fn payload_log_projection_matches_the_source() {
        assert_eq!(
            rpc_payload_keys(&json!({"taskId": "t", "deviceId": "d"})),
            vec!["deviceId".to_string(), "taskId".to_string()]
        );
        assert_eq!(rpc_task_id(&json!({"taskId": "t"})), Some(json!("t")));
        assert_eq!(rpc_task_id(&json!({"task_id": "t"})), Some(json!("t")));
        assert_eq!(rpc_task_id(&json!({"taskId": ""})), None);
        assert_eq!(rpc_task_id(&json!({})), None);
    }

    #[test]
    fn registered_route_is_selected_for_rust() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(table.matches(
            &http::Method::POST,
            "/api/internal/robot-queue/emit-runtime-rpc"
        ));
        assert!(!table.matches(
            &http::Method::GET,
            "/api/internal/robot-queue/emit-runtime-rpc"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| {
                    route.path == "/api/internal/robot-queue/emit-runtime-rpc"
                        && route.methods & POST != 0
                });
        assert!(
            registered,
            "POST /api/internal/robot-queue/emit-runtime-rpc must be registered"
        );
    }
}
