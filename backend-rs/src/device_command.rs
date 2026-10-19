// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/devices/{device_id}/commands`: execute one configured local
//! device command through the Socket.IO Redis adapter.
//!
//! Mirrors `app.api.endpoints.devices.execute_device_command` and the complete
//! service call graph:
//!
//! 1. `device_service.get_device_by_device_id` (any registered identity);
//! 2. `device_kind_type` and the internal-key guard;
//! 3. `resolve_local_device_command` (`LOCAL_DEVICE_COMMANDS` then defaults);
//! 4. `_resolve_dispatch_device_id` (remote-control policy, registered command
//!    scopes, and the cloud/remote online read);
//! 5. `LocalDeviceCommandService.execute_command`: the online read, the
//!    `device:execute_command` `sio.call` publish with its callback identity,
//!    and the acknowledgement;
//! 6. the configured post-processor and `DeviceCommandResponse` validation.

use std::time::Duration;

use brz_http_server::StatusCode;
use brz_mysql::MysqlError;
use brz_redis::{Redis as _, RedisBytes};
use serde_json::{Map, Value};

use crate::auth::SessionUser;
use crate::device_commands::{
    DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_MAX_OUTPUT_BYTES, DeviceCommandRequest,
    DeviceCommandResponse, MAX_COMMAND_TIMEOUT_SECONDS, MAX_OUTPUT_BYTES, SOCKET_ACK_GRACE_SECONDS,
    apply_command_post_processor, build_local_device_command_argv, executor_payload_carries_key,
    is_internal_command_key, python_str, python_truthy, registered_scope, remote_command_allowed,
    resolve_local_device_command, response_from_result, unhandled,
};
use crate::device_identity::{DeviceKindRow, resolve_owned_device_alias};
use crate::devices::online_key;
use crate::http_compat::FastApiError;
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message_with_callback};
use crate::socketio_rpc::RpcError;
use crate::state::AppState;

/// `DeviceNamespace("/local-executor")`.
const LOCAL_EXECUTOR_NAMESPACE: &str = "/local-executor";
/// `LocalDeviceCommandService.execute_command`'s event name.
const EXECUTE_COMMAND_EVENT: &str = "device:execute_command";
/// `REMOTE_CONTROL_DISABLED_MESSAGE`.
const REMOTE_CONTROL_DISABLED_MESSAGE: &str = "Remote control is disabled for this app device";

/// `app.schemas.device.DeviceType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceType {
    Local,
    App,
    Cloud,
    Remote,
}

impl DeviceType {
    /// `DeviceType(value)`: only the four lowercase members parse.
    fn parse(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "app" => Some(Self::App),
            "cloud" => Some(Self::Cloud),
            "remote" => Some(Self::Remote),
            _ => None,
        }
    }

    /// `DeviceType.value` (`str.title()` for the dispatch error messages).
    const fn title(self) -> &'static str {
        match self {
            Self::Local => "Local",
            Self::App => "App",
            Self::Cloud => "Cloud",
            Self::Remote => "Remote",
        }
    }

    const fn value(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::App => "app",
            Self::Cloud => "cloud",
            Self::Remote => "remote",
        }
    }
}

/// POST /api/devices/{device_id}/commands.
#[brz_http_server::post("/api/devices/:device_id/commands")]
async fn execute_device_command(
    #[inject(state)] state: &AppState,
    device_id: String,
    body: Value,
    #[auth] user: SessionUser,
) -> Result<DeviceCommandResponse, FastApiError> {
    let request = DeviceCommandRequest::validated(&body)?;
    execute_command(state, i64::from(user.0.id), &device_id, request).await
}

/// `execute_device_command`'s business body.
async fn execute_command(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    request: DeviceCommandRequest,
) -> Result<DeviceCommandResponse, FastApiError> {
    // `device_service.get_device_by_device_id`.
    let device = resolve_owned_device_alias(&state.mysql, user_id, device_id)
        .await
        .map_err(|error| mysql_failure(error, "device identity lookup failed"))?;
    let Some(device) = device else {
        tracing::warn!(user_id, device_id, "device command: device not found");
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Device not found or access denied",
        ));
    };

    let device_type = device_kind_type(&device)?;

    if is_internal_command_key(&request.command_key) {
        return Err(device_command_error(format!(
            "Device command key '{}' is not available through the command API",
            request.command_key
        )));
    }

    let definition = resolve_local_device_command(&request.command_key)
        .map_err(|error| FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.0))?;
    let Some(definition) = definition else {
        return Err(device_command_error(format!(
            "Device command key '{}' is not configured",
            request.command_key
        )));
    };

    let dispatch_device_id =
        resolve_dispatch_device_id(state, user_id, device_id, &request, &device, device_type)
            .await?;

    let online = read_online_state(state, user_id, &dispatch_device_id).await?;
    let Some(online) = online.filter(python_truthy) else {
        return Err(device_command_error(format!(
            "Device '{dispatch_device_id}' is offline"
        )));
    };
    let Some(online) = online.as_object() else {
        // The source indexes the decoded value as a dict.
        tracing::error!(user_id, device_id = %dispatch_device_id, "device command: invalid online payload");
        return Err(unhandled());
    };
    let Some(socket_id) = online
        .get("socket_id")
        .filter(|value| python_truthy(value))
        .map(python_str)
    else {
        return Err(device_command_error(format!(
            "Device '{dispatch_device_id}' has no socket information"
        )));
    };

    let argv =
        build_local_device_command_argv(&definition.command, &request.args).map_err(|error| {
            tracing::error!(%error, "device command: argv construction failed");
            unhandled()
        })?;
    let timeout_seconds = clamp_positive_int(
        request.timeout_seconds,
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
        MAX_COMMAND_TIMEOUT_SECONDS,
    );
    let max_output_bytes = clamp_positive_int(
        request.max_output_bytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES,
    );
    let payload = command_payload(
        &request,
        &definition.command,
        &argv,
        timeout_seconds,
        max_output_bytes,
    );

    let ack = call_device(
        state,
        user_id,
        &dispatch_device_id,
        &socket_id,
        payload,
        timeout_seconds,
    )
    .await?;

    let Value::Object(mut result) = ack_argument(ack) else {
        return Err(device_command_error(
            "Command RPC returned an invalid response",
        ));
    };
    apply_command_post_processor(&mut result, definition.post_processor.as_deref())
        .map_err(|error| FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.0))?;

    tracing::info!(
        user_id,
        device_id,
        exit_code = ?result.get("exit_code"),
        "device command completed"
    );
    response_from_result(result)
}

/// `_resolve_dispatch_device_id`: the remote-control policy, registered
/// command scopes, and the cloud/remote availability read.
async fn resolve_dispatch_device_id(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    request: &DeviceCommandRequest,
    device: &DeviceKindRow,
    device_type: Option<DeviceType>,
) -> Result<String, FastApiError> {
    let Some(device_type) = device_type else {
        return Err(device_command_error(
            "Device command RPC is not supported for unknown device type",
        ));
    };

    // `not allow_app_device and not remote_control_is_enabled(device_type)`.
    if device_type == DeviceType::App {
        return Err(device_command_error(REMOTE_CONTROL_DISABLED_MESSAGE));
    }

    if let Some(allowed) = registered_scope(&request.command_key)
        && !allowed.contains(&device_type.value())
    {
        return Err(unsupported_command_key(&request.command_key, device_type));
    }

    match device_type {
        DeviceType::Local => Ok(device_id.to_string()),
        DeviceType::App => unreachable!("app devices are rejected above"),
        DeviceType::Cloud | DeviceType::Remote => {
            if !remote_command_allowed(&request.command_key, device_type.value()) {
                return Err(unsupported_command_key(&request.command_key, device_type));
            }
            let dispatch_device_id = match device_type {
                DeviceType::Cloud => cloud_runtime_device_id(device)?,
                _ => device_id.to_string(),
            };
            if dispatch_device_id.is_empty() {
                return Err(device_command_error(format!(
                    "{} device '{device_id}' is unavailable",
                    device_type.title()
                )));
            }
            let online = read_online_state(state, user_id, &dispatch_device_id).await?;
            if !online.as_ref().is_some_and(python_truthy) {
                return Err(device_command_error(format!(
                    "{} device '{device_id}' is offline or unavailable",
                    device_type.title()
                )));
            }
            Ok(dispatch_device_id)
        }
    }
}

/// The `sio.call` round trip for one command: register the callback waiter,
/// publish the adapter emit, and wait for the acknowledgement.
async fn call_device(
    state: &AppState,
    user_id: i64,
    dispatch_device_id: &str,
    socket_id: &str,
    payload: Value,
    timeout_seconds: i64,
) -> Result<Value, FastApiError> {
    let Some(rpc) = state.socketio_rpc.as_ref() else {
        tracing::error!(user_id, "device command: no Socket.IO RPC subscriber");
        return Err(unhandled());
    };
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(user_id, "device command: no Redis service");
        return Err(unhandled());
    };

    let call = rpc
        .begin(socket_id, LOCAL_EXECUTOR_NAMESPACE)
        .map_err(|error| {
            tracing::error!(%error, user_id, "device command: callback registration failed");
            device_command_error(format!("Command RPC failed: {error}"))
        })?;
    let data = crate::internal_callback::py_json::python_dumps(&Value::Array(vec![payload]));
    let message = emit_message_with_callback(
        EXECUTE_COMMAND_EVENT,
        &data,
        LOCAL_EXECUTOR_NAMESPACE,
        socket_id,
        Some((socket_id, call.id())),
    );
    if let Err(error) = redis.publish(SOCKETIO_CHANNEL, message).await {
        tracing::error!(%error, user_id, "device command: RPC publish failed");
        return Err(device_command_error(format!("Command RPC failed: {error}")));
    }

    let acknowledgement_seconds = timeout_seconds.saturating_add(SOCKET_ACK_GRACE_SECONDS);
    match call
        .wait(Duration::from_secs(acknowledgement_seconds.max(0) as u64))
        .await
    {
        Ok(args) => {
            tracing::info!(
                user_id,
                device_id = dispatch_device_id,
                "device command: RPC acknowledged"
            );
            Ok(args)
        }
        Err(RpcError::Timeout) => Err(device_command_error(format!(
            "Command RPC timed out after {acknowledgement_seconds} seconds while waiting for \
             device '{dispatch_device_id}' to acknowledge {EXECUTE_COMMAND_EVENT}. \
             Reconnect or upgrade the local executor and retry."
        ))),
        Err(RpcError::Closed) => Err(device_command_error(format!(
            "Command RPC failed because device '{dispatch_device_id}' disconnected before \
             acknowledging {EXECUTE_COMMAND_EVENT}."
        ))),
        Err(RpcError::Unavailable(reason)) => Err(device_command_error(format!(
            "Command RPC failed: {reason}"
        ))),
    }
}

/// `sio.call`'s return value: the single positional ack argument.
fn ack_argument(args: Value) -> Value {
    match args {
        Value::Array(mut items) if items.len() == 1 => items.remove(0),
        other => other,
    }
}

/// `device_kind_type`: read `spec.deviceType` without inventing an unknown
/// type.
fn device_kind_type(device: &DeviceKindRow) -> Result<Option<DeviceType>, FastApiError> {
    let Value::Object(document) = &device.json else {
        return Ok(Some(DeviceType::Local));
    };
    match document.get("spec") {
        None => Ok(Some(DeviceType::Local)),
        Some(Value::Object(spec)) => match spec.get("deviceType") {
            None => Ok(Some(DeviceType::Local)),
            Some(Value::String(value)) => Ok(DeviceType::parse(value)),
            Some(_) => Ok(None),
        },
        // `"deviceType" in spec` succeeds for these containers, then
        // `spec.get(...)` raises.
        Some(Value::String(value)) if value.contains("deviceType") => Err(unhandled()),
        Some(Value::Array(items))
            if items.iter().any(|item| item.as_str() == Some("deviceType")) =>
        {
            Err(unhandled())
        }
        Some(Value::String(_)) | Some(Value::Array(_)) => Ok(Some(DeviceType::Local)),
        Some(_) => Err(unhandled()),
    }
}

/// `_resolve_cloud_runtime_device_id`: `spec.deviceId`,
/// `spec.cloudConfig.deviceId`, then the Kind name.
fn cloud_runtime_device_id(device: &DeviceKindRow) -> Result<String, FastApiError> {
    let Value::Object(document) = &device.json else {
        return Ok(device.name.clone());
    };
    let Some(Value::Object(spec)) = document.get("spec") else {
        if document.get("spec").is_some() {
            return Err(unhandled());
        }
        return Ok(device.name.clone());
    };
    if let Some(value) = spec.get("deviceId")
        && python_truthy(value)
    {
        return Ok(python_str(value));
    }
    if let Some(Value::Object(cloud_config)) = spec.get("cloudConfig")
        && let Some(value) = cloud_config.get("deviceId")
        && python_truthy(value)
    {
        return Ok(python_str(value));
    }
    Ok(device.name.clone())
}

/// `cache_manager.get`: one `GET device:online:<user_id>:<device_id>` decoded
/// as JSON. Missing/empty keys are `None`; failures are unhandled 500s.
async fn read_online_state(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Option<Value>, FastApiError> {
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!("device online state unavailable: no Redis service");
        return Err(unhandled());
    };
    match redis
        .get::<_, RedisBytes>(online_key(user_id, device_id))
        .await
    {
        Ok(None) => Ok(None),
        Ok(Some(bytes)) if bytes.as_ref().is_empty() => Ok(None),
        Ok(Some(bytes)) => serde_json::from_slice(bytes.as_ref())
            .map(Some)
            .map_err(|error| {
                tracing::error!(%error, "device online state decode failure");
                unhandled()
            }),
        Err(error) => {
            tracing::error!(%error, "device online state read failure");
            Err(unhandled())
        }
    }
}

/// The `execute_command` payload in the source dict's insertion order.
fn command_payload(
    request: &DeviceCommandRequest,
    command: &str,
    argv: &[String],
    timeout_seconds: i64,
    max_output_bytes: i64,
) -> Value {
    let mut payload = Map::new();
    payload.insert("command".to_string(), Value::String(command.to_string()));
    let cwd = request
        .path
        .as_deref()
        .filter(|path| !path.is_empty())
        .or_else(|| request.cwd.as_deref().filter(|cwd| !cwd.is_empty()));
    payload.insert(
        "cwd".to_string(),
        cwd.map_or(Value::Null, |cwd| Value::String(cwd.to_string())),
    );
    payload.insert(
        "args".to_string(),
        Value::Array(request.args.iter().cloned().map(Value::String).collect()),
    );
    payload.insert(
        "argv".to_string(),
        Value::Array(argv.iter().cloned().map(Value::String).collect()),
    );
    let mut env = Map::new();
    for (key, value) in &request.env {
        env.insert(key.clone(), Value::String(value.clone()));
    }
    payload.insert("env".to_string(), Value::Object(env));
    payload.insert(
        "timeout_seconds".to_string(),
        Value::Number(timeout_seconds.into()),
    );
    payload.insert(
        "max_output_bytes".to_string(),
        Value::Number(max_output_bytes.into()),
    );
    if executor_payload_carries_key(&request.command_key) {
        payload.insert(
            "command_key".to_string(),
            Value::String(request.command_key.clone()),
        );
    }
    Value::Object(payload)
}

/// `LocalDeviceCommandService._clamp_positive_int`.
fn clamp_positive_int(value: i64, default: i64, upper_bound: i64) -> i64 {
    if value <= 0 {
        default
    } else {
        value.min(upper_bound)
    }
}

/// `_format_rpc_error`'s `DeviceCommandError` mapping: `HTTPException(400,
/// detail=str(exc))`.
fn device_command_error(message: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, message)
}

fn unsupported_command_key(key: &str, device_type: DeviceType) -> FastApiError {
    device_command_error(format!(
        "Device command key '{key}' is not supported for {} devices",
        device_type.value()
    ))
}

fn mysql_failure(error: MysqlError, context: &'static str) -> FastApiError {
    tracing::error!(%error, "{context}");
    unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> DeviceCommandRequest {
        DeviceCommandRequest {
            command_key: "workspace_tree".to_string(),
            path: Some("/work/tree".to_string()),
            args: Vec::new(),
            cwd: Some("/ignored".to_string()),
            env: Vec::new(),
            timeout_seconds: 15,
            max_output_bytes: 524288,
        }
    }

    #[test]
    fn payload_matches_the_source_dict_order_and_shape() {
        let payload = command_payload(
            &request(),
            "python3 -c 'tree'",
            &["python3".to_string(), "-c".to_string(), "tree".to_string()],
            15,
            524288,
        );
        assert_eq!(
            crate::internal_callback::py_json::python_dumps(&payload),
            "{\"command\": \"python3 -c 'tree'\", \"cwd\": \"/work/tree\", \"args\": [], \
             \"argv\": [\"python3\", \"-c\", \"tree\"], \"env\": {}, \"timeout_seconds\": 15, \
             \"max_output_bytes\": 524288, \"command_key\": \"workspace_tree\"}"
        );
    }

    #[test]
    fn path_takes_precedence_and_empty_values_fall_back() {
        let mut request = request();
        request.path = Some(String::new());
        request.cwd = Some("/cwd".to_string());
        let payload = command_payload(&request, "pwd", &["pwd".to_string()], 60, 1024);
        assert_eq!(payload["cwd"], json!("/cwd"));

        request.path = None;
        request.cwd = None;
        let payload = command_payload(&request, "pwd", &["pwd".to_string()], 60, 1024);
        assert_eq!(payload["cwd"], Value::Null);
    }

    #[test]
    fn command_key_is_only_sent_for_the_source_payload_keys() {
        let mut request = request();
        request.command_key = "pwd".to_string();
        let payload = command_payload(&request, "pwd", &["pwd".to_string()], 60, 1024);
        assert!(payload.get("command_key").is_none());
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/devices/:device_id/commands"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/devices/:device_id/commands must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/devices/abc/commands"));
        assert!(!table.matches(&http::Method::GET, "/api/devices/abc/commands"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/devices/:device_id/commands" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/devices/:device_id/commands must be registered by the router"
        );
    }
}
