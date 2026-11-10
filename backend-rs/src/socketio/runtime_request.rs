// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/wework_runtime_namespace.py::WeworkRuntimeNamespace`
//! `on_runtime_request` — the transparent app-IPC relay over Socket.IO.
//!
//! The relay keeps the source envelope contract exactly:
//!
//! 1. `method`/`device_id` (`deviceId`) are required non-empty strings and
//!    `params` (falling back to `payload`) must be an object;
//! 2. `has_runtime_execution_request` + `bind_authenticated_runtime_identity`
//!    bind the authenticated Wework user into every execution request so an
//!    IPC caller cannot impersonate another owner;
//! 3. `relay_ipc_request` dispatches `device.execute_command` to the
//!    configured local command service, the two transcript read methods with a
//!    `projectSession` scope to `_project_transcript_request`, and everything
//!    else to `RuntimeRpcService.call` ([`super::runtime_rpc`]);
//! 4. a `{"success": false}` runtime result becomes the source's error
//!    envelope (`runtime_rpc_failure`), except for `device.execute_command`
//!    whose `success` is the command exit status;
//! 5. `encode_runtime_rpc_response` compresses a large result and the ACK is
//!    `{"id": …, "ok": true, "result": …}`.
//!
//! Errors the source raises as `RuntimeRpcError`/`DeviceCommandError` become
//! the app-IPC error ACK; database and Redis failures escape unhandled.

use std::time::Duration;

use brz_redis::Redis as _;
use brz_socket_io::ClientError;
use serde_json::{Map, Value, json};

use super::mcp_app_ownership::{self, AppInstance, Ownership};
use crate::device_commands::{
    DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_MAX_OUTPUT_BYTES, MAX_COMMAND_TIMEOUT_SECONDS,
    MAX_OUTPUT_BYTES, build_local_device_command_argv, python_str, python_truthy,
    resolve_local_device_command,
};
use crate::http_compat::FastApiError;
use crate::runtime_transcript_search::request::SearchRequest;
use crate::runtime_work_transcript_access::{ProjectScope, resolve_project_transcript};
use crate::runtime_work_transcript_request::{
    NormalizedAddress, TranscriptRequest, transcript_payload,
};
use crate::socketio::auth::Identity;
use crate::socketio::runtime_rpc::{self, CallFailure, RuntimeRpcError};
use crate::state::AppState;

/// `DEFAULT_IPC_TIMEOUT_SECONDS`.
const DEFAULT_IPC_TIMEOUT_SECONDS: i64 = 75;
/// `RUNTIME_EXECUTION_REQUEST_KEYS`.
const RUNTIME_EXECUTION_REQUEST_KEYS: [&str; 4] = [
    "executionRequest",
    "execution_request",
    "friendlyTitleExecutionRequest",
    "friendly_title_execution_request",
];
/// `APP_DEVICE_TASK_READ_METHODS`.
const APP_DEVICE_TASK_READ_METHODS: [&str; 2] = [
    "runtime.tasks.transcript",
    "runtime.tasks.transcript.search",
];
/// `RUNTIME_TRANSCRIPT_SEARCH_METHOD`.
const TRANSCRIPT_SEARCH_METHOD: &str = "runtime.tasks.transcript.search";
/// The configured command relay method.
const EXECUTE_COMMAND_METHOD: &str = "device.execute_command";
/// `LocalDeviceCommandService.execute_command`'s event name.
const EXECUTE_COMMAND_EVENT: &str = "device:execute_command";
/// `DeviceNamespace("/local-executor")`.
const LOCAL_EXECUTOR_NAMESPACE: &str = "/local-executor";
/// `SOCKET_ACK_GRACE_SECONDS` of the command service.
const COMMAND_SOCKET_ACK_GRACE_SECONDS: i64 = 5;
/// `project_session_access_denied`.
const PROJECT_SESSION_ACCESS_DENIED: &str = "project_session_access_denied";

/// One failed command relay.
enum CommandFailure {
    /// A source `RuntimeRpcError` raised by the route/policy step.
    Rpc(RuntimeRpcError),
    /// A source `DeviceCommandError`, rendered with a fixed ACK code.
    Device(String),
    /// An unhandled source exception (database, Redis, argv construction).
    Internal,
}

/// `WeworkRuntimeNamespace.on_runtime_request`.
pub(super) async fn handle(
    app: &AppState,
    identity: &Identity,
    ownership: &Ownership,
    data: Value,
) -> Result<Value, ClientError> {
    let user_id = identity.user_id;
    let request_id = request_id_from(&data);

    let Some(method) = string_field(&data, "method") else {
        return Ok(ipc_error(
            &request_id,
            "bad_request",
            "method is required",
            None,
            None,
        ));
    };
    let device_id = string_field(&data, "device_id").or_else(|| string_field(&data, "deviceId"));
    let Some(device_id) = device_id else {
        return Ok(ipc_error(
            &request_id,
            "bad_request",
            "device_id is required",
            None,
            None,
        ));
    };
    let params = match data.get("params") {
        None | Some(Value::Null) => data
            .get("payload")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
        Some(value) => value.clone(),
    };
    let Value::Object(mut params) = params else {
        return Ok(ipc_error(
            &request_id,
            "bad_request",
            "params must be an object",
            None,
            None,
        ));
    };

    if has_runtime_execution_request(&params) {
        let user_name = identity.user_name.trim();
        if user_name.is_empty() {
            return Ok(ipc_error(
                &request_id,
                "unauthorized",
                "Authenticated runtime user identity is incomplete",
                None,
                None,
            ));
        }
        let user_email = identity.email.as_deref().unwrap_or("");
        bind_authenticated_runtime_identity(&mut params, user_id, user_name, user_email);
    }

    let timeout_seconds = timeout_seconds_from(&data);
    let (rpc_user_id, params, project_transcript) =
        match project_transcript_payload(app, user_id, &method, &device_id, &params).await {
            Ok(Some((owner_user_id, payload))) => (owner_user_id, payload, true),
            Ok(None) => (user_id, Value::Object(params), false),
            Err(CallFailure::Rpc(error)) => return Ok(ipc_rpc_error(&request_id, &error)),
            Err(CallFailure::Internal) => return Err(internal_error()),
        };

    let result = if method == EXECUTE_COMMAND_METHOD {
        // `device.execute_command` never takes the project-transcript branch,
        // so the relay parameters are still the client's object.
        let Some(params) = params.as_object() else {
            return Err(internal_error());
        };
        match execute_device_command(app, rpc_user_id, &device_id, params, timeout_seconds).await {
            Ok(result) => result,
            Err(CommandFailure::Device(message)) => {
                return Ok(ipc_error(
                    &request_id,
                    "device_command_failed",
                    &message,
                    None,
                    None,
                ));
            }
            Err(CommandFailure::Rpc(error)) => return Ok(ipc_rpc_error(&request_id, &error)),
            Err(CommandFailure::Internal) => return Err(internal_error()),
        }
    } else {
        let operation = params["method"]
            .as_str()
            .filter(|method| matches!(*method, "retain" | "release"));
        let owned_app = if method == mcp_app_ownership::METHOD {
            operation
                .zip(AppInstance::parse(&device_id, &params))
                .map(|(op, instance)| (op == "retain", instance))
        } else {
            None
        };
        let result = runtime_rpc::call(
            app,
            rpc_user_id,
            &device_id,
            &method,
            params,
            timeout_seconds,
            project_transcript,
        )
        .await;
        if let Some((retain, instance)) = owned_app {
            let succeeded = result.as_ref().is_ok_and(|value| value["success"] != false);
            if retain {
                let cleanup = if succeeded {
                    ownership.retain(instance)
                } else {
                    Some(instance)
                };
                if let Some(instance) = cleanup {
                    instance.release(app, rpc_user_id).await;
                }
            } else if succeeded {
                ownership.forget(&instance);
            }
        }
        match result {
            Ok(result) => result,
            Err(CallFailure::Rpc(error)) => return Ok(ipc_rpc_error(&request_id, &error)),
            Err(CallFailure::Internal) => return Err(internal_error()),
        }
    };

    // ``device.execute_command`` uses ``success`` for the command exit status,
    // so a non-zero exit remains a valid pass-through result.
    if method != EXECUTE_COMMAND_METHOD && result.get("success") == Some(&Value::Bool(false)) {
        let error = runtime_rpc_failure(&result, &method);
        return Ok(ipc_rpc_error(&request_id, &error));
    }

    let result = match runtime_rpc::encode_response(result, &method) {
        Ok(result) => result,
        Err(error) => return Ok(ipc_rpc_error(&request_id, &error)),
    };
    Ok(json!({"id": request_id, "ok": true, "result": result}))
}

fn internal_error() -> ClientError {
    ClientError::new("INTERNAL", "Internal server error")
}

/// `request_id_from`: the client's non-empty `id`, else a fresh UUIDv4.
fn request_id_from(data: &Value) -> String {
    if let Some(id) = data.get("id").and_then(Value::as_str)
        && !id.trim().is_empty()
    {
        return id.to_string();
    }
    uuid4()
}

/// `uuid.uuid4()`: 16 random bytes with the v4 version and RFC 4122 variant.
fn uuid4() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // `uuid.uuid4()` cannot fail; an exhausted entropy source is fatal for
        // the process, and an all-zero identity would collide across clients.
        tracing::error!("runtime request id random source failed");
        bytes = [0u8; 16];
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

/// `string_field`: only a non-blank string is accepted, trimmed.
fn string_field(data: &Value, key: &str) -> Option<String> {
    data.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// `timeout_seconds_from`: the positive integer timeout, else 75 seconds.
fn timeout_seconds_from(data: &Value) -> i64 {
    let value = data
        .get("timeout_seconds")
        .filter(|value| python_truthy(value))
        .or_else(|| {
            data.get("timeoutSeconds")
                .filter(|value| python_truthy(value))
        });
    let Some(value) = value else {
        return DEFAULT_IPC_TIMEOUT_SECONDS;
    };
    match python_int(value) {
        Some(parsed) if parsed > 0 => parsed,
        _ => DEFAULT_IPC_TIMEOUT_SECONDS,
    }
}

/// Python `int(value)` for the JSON scalars the relay accepts.
fn python_int(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(flag) => Some(i64::from(*flag)),
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.trunc() as i64)
        }),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// `has_runtime_execution_request`.
fn has_runtime_execution_request(params: &Map<String, Value>) -> bool {
    RUNTIME_EXECUTION_REQUEST_KEYS
        .iter()
        .any(|key| params.get(*key).is_some_and(Value::is_object))
}

/// `bind_authenticated_runtime_identity`: overwrite the execution request's
/// caller identity with the authenticated connection identity.
fn bind_authenticated_runtime_identity(
    params: &mut Map<String, Value>,
    user_id: i64,
    user_name: &str,
    user_email: &str,
) {
    for key in RUNTIME_EXECUTION_REQUEST_KEYS {
        let Some(raw) = params.get(key).filter(|value| value.is_object()) else {
            continue;
        };
        let Some(mut execution_request) = raw.as_object().cloned() else {
            continue;
        };
        let mut user = execution_request
            .get("user")
            .filter(|value| value.is_object())
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        user.insert("id".to_string(), Value::from(user_id));
        user.insert("name".to_string(), Value::String(user_name.to_string()));
        user.insert(
            "user_name".to_string(),
            Value::String(user_name.to_string()),
        );
        user.insert("email".to_string(), Value::String(user_email.to_string()));
        execution_request.insert("user".to_string(), Value::Object(user));
        execution_request.insert("user_id".to_string(), Value::from(user_id));
        execution_request.insert(
            "user_name".to_string(),
            Value::String(user_name.to_string()),
        );
        params.insert(key.to_string(), Value::Object(execution_request));
    }
}

/// `ipc_error`: the app-IPC error ACK; `retryable` and non-empty `details` are
/// only present when the source supplies them.
fn ipc_error(
    request_id: &str,
    code: &str,
    message: &str,
    retryable: Option<bool>,
    details: Option<&Value>,
) -> Value {
    let mut error = Map::new();
    error.insert("code".to_string(), Value::String(code.to_string()));
    error.insert("message".to_string(), Value::String(message.to_string()));
    if let Some(retryable) = retryable {
        error.insert("retryable".to_string(), Value::Bool(retryable));
    }
    if let Some(details) = details.filter(|details| python_truthy(details)) {
        error.insert("details".to_string(), details.clone());
    }
    json!({
        "id": request_id,
        "ok": false,
        "error": Value::Object(error),
    })
}

fn ipc_rpc_error(request_id: &str, error: &RuntimeRpcError) -> Value {
    ipc_error(
        request_id,
        &error.code,
        &error.message,
        error.retryable,
        error.details.as_ref(),
    )
}

/// `runtime_rpc_failure`: translate an executor failure envelope without
/// erasing its code.
fn runtime_rpc_failure(result: &Value, method: &str) -> RuntimeRpcError {
    let error = result.get("error");
    if let Some(error) = error.and_then(Value::as_str).map(str::trim)
        && !error.is_empty()
    {
        return RuntimeRpcError {
            code: non_blank(result.get("code")).unwrap_or_else(|| "runtime_rpc_failed".into()),
            message: error.to_string(),
            retryable: Some(false),
            details: None,
        };
    }
    if let Some(error) = error.and_then(Value::as_object)
        && let Some(message) = non_blank(error.get("message"))
    {
        return RuntimeRpcError {
            code: non_blank(error.get("code")).unwrap_or_else(|| "runtime_rpc_failed".into()),
            message,
            retryable: Some(error.get("retryable") == Some(&Value::Bool(true))),
            details: error
                .get("details")
                .filter(|details| details.is_object())
                .cloned(),
        };
    }
    RuntimeRpcError {
        code: "runtime_rpc_invalid_response".to_string(),
        message: format!("Runtime RPC '{method}' returned an invalid failure response"),
        retryable: Some(false),
        details: None,
    }
}

fn non_blank(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// `_project_transcript_request`: authorize a project-session read and build
/// its executor payload. `Ok(None)` when the relay method or scope does not
/// select this branch.
#[allow(clippy::result_large_err)]
async fn project_transcript_payload(
    app: &AppState,
    user_id: i64,
    method: &str,
    device_id: &str,
    params: &Map<String, Value>,
) -> Result<Option<(i64, Value)>, CallFailure> {
    if !APP_DEVICE_TASK_READ_METHODS.contains(&method)
        || params
            .get("projectSession")
            .is_none_or(|scope| scope.is_null())
    {
        return Ok(None);
    }
    let mut body = params.clone();
    body.insert("deviceId".to_string(), Value::String(device_id.to_string()));
    let body = Value::Object(body);
    let search = method == TRANSCRIPT_SEARCH_METHOD;

    if search {
        let request = SearchRequest::validated(&body).map_err(project_session_denied)?;
        let Some((project_id, issue_id)) = request.project_session.as_ref() else {
            return Err(CallFailure::Internal);
        };
        let resolved = resolve_project_transcript(
            &app.mysql,
            user_id,
            &request.device_id,
            &request.task_id,
            &ProjectScope {
                project_id,
                issue_id,
            },
        )
        .await
        .map_err(project_session_denied)?;
        let payload = request.payload(&resolved.task_id, true);
        return Ok(Some((resolved.owner_user_id, payload)));
    }

    let request = TranscriptRequest::validated(&body).map_err(project_session_denied)?;
    let Some(scope) = request.project_session.as_ref() else {
        return Err(CallFailure::Internal);
    };
    let resolved = resolve_project_transcript(
        &app.mysql,
        user_id,
        &request.device_id,
        &request.local_task_id,
        &ProjectScope {
            project_id: &scope.project_id,
            issue_id: &scope.issue_id,
        },
    )
    .await
    .map_err(project_session_denied)?;
    let payload = transcript_payload(
        &request,
        &NormalizedAddress {
            device_id: resolved.device_id,
            workspace_path: None,
            task_id: resolved.task_id,
            runtime_handle: None,
        },
    );
    Ok(Some((resolved.owner_user_id, payload)))
}

/// `str(exc.detail) if isinstance(exc, HTTPException) else str(exc)` under the
/// `project_session_access_denied` code.
///
/// Every authorization failure the resolver raises carries a plain detail
/// string; a pydantic validation listing has no exact Rust rendering, so it
/// keeps the application's validation detail text.
fn project_session_denied(error: FastApiError) -> CallFailure {
    let message = error
        .detail_message()
        .map(str::to_string)
        .unwrap_or_else(|| "Request parameter validation failed".to_string());
    CallFailure::Rpc(RuntimeRpcError {
        code: PROJECT_SESSION_ACCESS_DENIED.to_string(),
        message,
        retryable: None,
        details: None,
    })
}

/// Sync the saved auth file through the same owner-scoped device command path.
pub(super) async fn sync_runtime_auth_file(
    app: &AppState,
    user_id: i64,
    device_id: &str,
    runtime: &str,
    content: &str,
) -> bool {
    let params = Map::from_iter([
        ("command_key".to_string(), json!("sync_runtime_auth_file")),
        (
            "env".to_string(),
            json!({
                "WEGENT_RUNTIME_CONFIG_RUNTIME": runtime,
                "WEGENT_RUNTIME_CONFIG_CONTENT": content,
            }),
        ),
    ]);
    execute_device_command(
        app,
        user_id,
        device_id,
        &params,
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
    .await
    .is_ok_and(|ack| ack["success"] == true)
}

/// `relay_ipc_request`'s `device.execute_command` branch through
/// `LocalDeviceCommandService.execute_command`.
#[allow(clippy::result_large_err)]
async fn execute_device_command(
    app: &AppState,
    user_id: i64,
    device_id: &str,
    params: &Map<String, Value>,
    timeout_seconds: i64,
) -> Result<Value, CommandFailure> {
    let command_key = params
        .get("command_key")
        .filter(|value| python_truthy(value))
        .map(python_str)
        .unwrap_or_default();
    let definition = resolve_local_device_command(&command_key)
        .map_err(|error| CommandFailure::Device(error.0))?;
    let Some(definition) = definition else {
        return Err(CommandFailure::Device(
            "Device command key is not configured".to_string(),
        ));
    };

    let route = match runtime_rpc::resolve_route(app, user_id, device_id).await {
        Ok(route) => route,
        Err(CallFailure::Rpc(error)) => return Err(CommandFailure::Rpc(error)),
        Err(CallFailure::Internal) => return Err(CommandFailure::Internal),
    };
    if !crate::runtime_work::remote_control_is_enabled(route.device_type) {
        return Err(CommandFailure::Rpc(RuntimeRpcError {
            code: "remote_control_disabled".to_string(),
            message: runtime_rpc::REMOTE_CONTROL_DISABLED_MESSAGE.to_string(),
            retryable: Some(false),
            details: Some(json!({"deviceId": route.logical_device_id})),
        }));
    }

    let max_output_bytes = match params
        .get("max_output_bytes")
        .filter(|value| python_truthy(value))
    {
        None => DEFAULT_MAX_OUTPUT_BYTES,
        Some(value) => python_int(value).ok_or(CommandFailure::Internal)?,
    };
    let timeout_seconds = clamp_positive_int(
        timeout_seconds,
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
        MAX_COMMAND_TIMEOUT_SECONDS,
    );
    let max_output_bytes =
        clamp_positive_int(max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);

    let online = crate::device_online_state::read_online_state::<Value>(
        app,
        user_id,
        &route.runtime_device_id,
    )
    .await
    .map_err(|_| CommandFailure::Internal)?;
    let Some(online) = online.filter(python_truthy) else {
        return Err(CommandFailure::Device(format!(
            "Device '{}' is offline",
            route.runtime_device_id
        )));
    };
    let Some(socket_id) = online
        .get("socket_id")
        .filter(|value| python_truthy(value))
        .map(python_str)
    else {
        return Err(CommandFailure::Device(format!(
            "Device '{}' has no socket information",
            route.runtime_device_id
        )));
    };

    let payload = command_payload(
        &command_key,
        &definition,
        params,
        timeout_seconds,
        max_output_bytes,
    )
    .map_err(|error| {
        tracing::error!(%error, user_id, "device command argv construction failed");
        CommandFailure::Internal
    })?;

    let result = call_device_command(
        app,
        user_id,
        &route.runtime_device_id,
        &socket_id,
        payload,
        timeout_seconds,
    )
    .await?;
    if !result.is_object() {
        return Err(CommandFailure::Device(
            "Command RPC returned an invalid response".to_string(),
        ));
    }
    Ok(result)
}

fn command_payload(
    command_key: &str,
    definition: &crate::device_commands::CommandDefinition,
    params: &Map<String, Value>,
    timeout_seconds: i64,
    max_output_bytes: i64,
) -> Result<Value, crate::device_commands::CommandRegistryError> {
    let args = params
        .get("args")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let argv_args = args
        .as_array()
        .unwrap()
        .iter()
        .map(python_str)
        .collect::<Vec<_>>();
    let argv = build_local_device_command_argv(&definition.command, &argv_args)?;
    let cwd = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .or_else(|| params.get("cwd").and_then(Value::as_str));
    let mut payload = json!({
        "command": definition.command,
        "cwd": cwd,
        "args": args,
        "argv": argv,
        "env": params.get("env").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})),
        "timeout_seconds": timeout_seconds,
        "max_output_bytes": max_output_bytes,
    });
    if definition.native_git {
        payload["command_key"] = json!(command_key);
    }
    Ok(payload)
}

/// The `device:execute_command` `sio.call` round trip.
#[allow(clippy::result_large_err)]
async fn call_device_command(
    app: &AppState,
    user_id: i64,
    device_id: &str,
    socket_id: &str,
    payload: Value,
    timeout_seconds: i64,
) -> Result<Value, CommandFailure> {
    let Some(rpc) = app.socketio_rpc.as_ref() else {
        tracing::error!(user_id, "device command relay: no Socket.IO RPC subscriber");
        return Err(CommandFailure::Internal);
    };
    let Some(redis) = app.redis.as_ref() else {
        tracing::error!(user_id, "device command relay: no Redis service");
        return Err(CommandFailure::Internal);
    };
    let call = rpc
        .begin(socket_id, LOCAL_EXECUTOR_NAMESPACE)
        .map_err(|error| {
            tracing::error!(%error, user_id, "device command relay callback registration failed");
            CommandFailure::Device(format!("Command RPC failed: {error}"))
        })?;
    let data = crate::internal_callback::py_json::python_dumps(&Value::Array(vec![payload]));
    let message = crate::socketio_emit::emit_message_with_callback(
        EXECUTE_COMMAND_EVENT,
        &data,
        LOCAL_EXECUTOR_NAMESPACE,
        socket_id,
        Some((socket_id, call.id())),
    );
    if let Err(error) = redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        tracing::error!(%error, user_id, "device command relay publish failed");
        return Err(CommandFailure::Device(format!(
            "Command RPC failed: {error}"
        )));
    }

    let acknowledgement_seconds = timeout_seconds + COMMAND_SOCKET_ACK_GRACE_SECONDS;
    match call
        .wait(Duration::from_secs(acknowledgement_seconds.max(0) as u64))
        .await
    {
        Ok(args) => Ok(ack_argument(args)),
        Err(crate::socketio_rpc::RpcError::Timeout) => Err(CommandFailure::Device(format!(
            "Command RPC timed out after {acknowledgement_seconds} seconds while waiting for \
             device '{device_id}' to acknowledge {EXECUTE_COMMAND_EVENT}. \
             Reconnect or upgrade the local executor and retry."
        ))),
        Err(crate::socketio_rpc::RpcError::Closed) => Err(CommandFailure::Device(format!(
            "Command RPC failed because device '{device_id}' disconnected before acknowledging \
             {EXECUTE_COMMAND_EVENT}."
        ))),
        Err(crate::socketio_rpc::RpcError::Unavailable(reason)) => Err(CommandFailure::Device(
            format!("Command RPC failed: {reason}"),
        )),
    }
}

/// `sio.call`'s return value: the single positional acknowledgement argument.
fn ack_argument(args: Value) -> Value {
    match args {
        Value::Array(mut items) if items.len() == 1 => items.remove(0),
        other => other,
    }
}

/// `_clamp_positive_int`: a non-positive value is the default, and the result
/// is capped at the source's upper bound.
fn clamp_positive_int(value: i64, default: i64, upper_bound: i64) -> i64 {
    if value <= 0 {
        default
    } else {
        value.min(upper_bound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn method_and_device_fields_require_nonblank_strings() {
        assert_eq!(
            string_field(&json!({"method": "  runtime.tasks.list "}), "method").as_deref(),
            Some("runtime.tasks.list")
        );
        for value in [json!({}), json!({"method": ""}), json!({"method": 4})] {
            assert_eq!(string_field(&value, "method"), None);
        }
    }

    #[test]
    fn request_ids_prefer_the_client_identity() {
        assert_eq!(
            request_id_from(&json!({"id": " cloud-runtime-1 "})),
            " cloud-runtime-1 "
        );
        assert_eq!(request_id_from(&json!({"id": ""})).len(), 36);
        assert_eq!(request_id_from(&json!([])).len(), 36);
        let generated = request_id_from(&json!({}));
        assert_eq!(&generated[14..15], "4");
        assert!(matches!(
            generated.as_bytes()[19],
            b'8' | b'9' | b'a' | b'b'
        ));
    }

    #[test]
    fn timeouts_use_the_camel_and_snake_keys() {
        assert_eq!(timeout_seconds_from(&json!({})), 75);
        assert_eq!(timeout_seconds_from(&json!({"timeout_seconds": 12})), 12);
        assert_eq!(timeout_seconds_from(&json!({"timeoutSeconds": "30"})), 30);
        assert_eq!(timeout_seconds_from(&json!({"timeout_seconds": 0})), 75);
        assert_eq!(timeout_seconds_from(&json!({"timeout_seconds": -3})), 75);
        assert_eq!(timeout_seconds_from(&json!({"timeout_seconds": "abc"})), 75);
        assert_eq!(timeout_seconds_from(&json!({"timeout_seconds": 1.9})), 1);
    }

    #[test]
    fn execution_identity_binding_overwrites_the_caller_identity() {
        let mut params = object(json!({
            "executionRequest": {
                "user": {"id": 7, "name": "intruder", "extra": true},
                "user_id": 7,
                "prompt": "hello",
            },
            "other": 1,
        }));
        assert!(has_runtime_execution_request(&params));
        bind_authenticated_runtime_identity(&mut params, 225, "zhongwei9", "z@example.com");
        let bound = &params["executionRequest"];
        assert_eq!(
            bound["user"],
            json!({
                "id": 225, "name": "zhongwei9", "user_name": "zhongwei9",
                "email": "z@example.com", "extra": true,
            })
        );
        assert_eq!(bound["user_id"], json!(225));
        assert_eq!(bound["user_name"], json!("zhongwei9"));
        assert_eq!(bound["prompt"], json!("hello"));
        assert_eq!(params["other"], json!(1));
    }

    #[test]
    fn execution_request_detection_reads_every_alias() {
        for key in RUNTIME_EXECUTION_REQUEST_KEYS {
            assert!(has_runtime_execution_request(&object(json!({key: {}}))));
        }
        assert!(!has_runtime_execution_request(&object(json!({
            "executionRequest": "not-an-object"
        }))));
    }

    #[test]
    fn error_envelopes_keep_the_source_presence_rules() {
        assert_eq!(
            ipc_error("req-1", "bad_request", "method is required", None, None),
            json!({
                "id": "req-1",
                "ok": false,
                "error": {"code": "bad_request", "message": "method is required"},
            })
        );
        let full = ipc_error(
            "req-1",
            "runtime_rpc_timeout",
            "timed out",
            Some(true),
            Some(&json!({"deviceId": "d"})),
        );
        assert_eq!(full["error"]["retryable"], json!(true));
        assert_eq!(full["error"]["details"], json!({"deviceId": "d"}));
        let empty = ipc_error("req-1", "x", "y", Some(false), Some(&json!({})));
        assert!(empty["error"].get("details").is_none());
    }

    #[test]
    fn success_false_results_map_onto_the_failure_envelope() {
        let error = runtime_rpc_failure(
            &json!({"success": false, "error": "boom", "code": "runtime_busy"}),
            "runtime.tasks.list",
        );
        assert_eq!(error.code, "runtime_busy");
        assert_eq!(error.message, "boom");
        assert_eq!(error.retryable, Some(false));

        let error = runtime_rpc_failure(
            &json!({"success": false, "error": {"code": "runtime_busy", "message": " busy ", "retryable": true, "details": {"a": 1}}}),
            "runtime.tasks.list",
        );
        assert_eq!(error.code, "runtime_busy");
        assert_eq!(error.message, "busy");
        assert_eq!(error.retryable, Some(true));
        assert_eq!(error.details, Some(json!({"a": 1})));

        let error = runtime_rpc_failure(&json!({"success": false}), "runtime.tasks.list");
        assert_eq!(error.code, "runtime_rpc_invalid_response");
        assert_eq!(
            error.message,
            "Runtime RPC 'runtime.tasks.list' returned an invalid failure response"
        );
    }

    #[test]
    fn command_payload_preserves_the_resolved_command_key_for_executor_gates() {
        let payload = command_payload(
            "git_clone", &crate::device_commands::CommandDefinition {
                command: "git clone".into(), post_processor: None, native_git: true,
            }, &object(json!({
                "args":["--branch","invalid..branch","--single-branch","https://example.test/repo.git","/target"],
                "path":"/parent", "cwd":"/ignored", "env":{"GIT_TERMINAL_PROMPT":"0"},
            })), 300, 512,
        ).unwrap();
        assert_eq!(payload["command_key"], "git_clone");
        assert_eq!(
            payload["argv"],
            json!([
                "git",
                "clone",
                "--branch",
                "invalid..branch",
                "--single-branch",
                "https://example.test/repo.git",
                "/target"
            ])
        );
        assert_eq!(payload["cwd"], "/parent");
        assert_eq!(payload["env"]["GIT_TERMINAL_PROMPT"], "0");
        assert_eq!(payload["timeout_seconds"], 300);
        assert_eq!(payload["max_output_bytes"], 512);
    }

    #[test]
    fn overridden_commands_do_not_enter_native_git_execution() {
        let definition = crate::device_commands::CommandDefinition {
            command: "echo overridden".into(),
            post_processor: None,
            native_git: false,
        };
        let payload = command_payload("git_clone", &definition, &Map::new(), 60, 512).unwrap();
        assert!(payload.get("command_key").is_none());
        assert_eq!(payload["argv"], json!(["echo", "overridden"]));
    }

    #[test]
    fn command_payload_clamps_match_the_command_service() {
        assert_eq!(clamp_positive_int(0, 60, 600), 60);
        assert_eq!(clamp_positive_int(900, 60, 600), 600);
        assert_eq!(clamp_positive_int(30, 60, 600), 30);
    }

    #[test]
    fn socket_arguments_unwrap_one_positional_value() {
        assert_eq!(
            ack_argument(json!([{"exit_code": 0}])),
            json!({"exit_code": 0})
        );
        assert_eq!(ack_argument(json!([])), json!([]));
    }
}
