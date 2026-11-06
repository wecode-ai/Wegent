// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.device.runtime_rpc_service` for the Wework runtime relay.
//!
//! [`call`] mirrors `RuntimeRpcService.call` and [`encode_response`] mirrors
//! `encode_runtime_rpc_response`. The source call graph is:
//!
//! 1. `runtime_route_resolver.resolve` — the owned-device alias read, the
//!    strict Redis online read, the socket-id check and the
//!    stale-installation guard (`_identity_from_device` + `RuntimeRoute`);
//! 2. `remote_control_is_enabled` for the App-device control policy, with the
//!    relay's `allow_app_device_task_reading` exception for the two transcript
//!    read methods;
//! 3. `negotiate_runtime_task_create_payload` for `runtime.tasks.create`;
//! 4. `_enforce_remote_runtime_proxy` for cloud/remote model configurations;
//! 5. the `runtime:rpc` `sio.call` through the process-owned Redis-adapter
//!    subscriber, with the 30 s default / 600 s cap plus the 5 s ack grace;
//! 6. `_decode_response` (the `gzip+base64+json` envelope) and
//!    `_project_response_device_ids` onto the stable logical device identity.
//!
//! Failures the source raises as `RuntimeRpcError` keep their code, message,
//! retryability and details; database/Redis failures escape as
//! [`CallFailure::Internal`] exactly like the unhandled source exception.

use std::io::{Read, Write};

use base64::Engine as _;
use brz_json::adapters::python_truthy;
use serde_json::{Map, Value, json};

use crate::device_identity::{DeviceType, resolve_runtime_route_identity};
use crate::device_online_state::read_online_state;
use crate::runtime_work::{
    RuntimeCallError, call_runtime_method, remote_control_is_enabled, runtime_instance_matches,
};
use crate::state::AppState;

/// `DEFAULT_RUNTIME_RPC_TIMEOUT_SECONDS`.
const DEFAULT_TIMEOUT_SECONDS: i64 = 30;
/// `MAX_RUNTIME_RPC_TIMEOUT_SECONDS`.
const MAX_TIMEOUT_SECONDS: i64 = 600;
/// `SOCKET_ACK_GRACE_SECONDS`.
const SOCKET_ACK_GRACE_SECONDS: i64 = 5;
/// `REMOTE_CONTROL_DISABLED_MESSAGE`.
pub(crate) const REMOTE_CONTROL_DISABLED_MESSAGE: &str =
    "Remote control is disabled for this app device";
/// `APP_DEVICE_TASK_READ_METHODS`.
const APP_DEVICE_TASK_READ_METHODS: [&str; 2] = [
    "runtime.tasks.transcript",
    "runtime.tasks.transcript.search",
];
/// `RUNTIME_MODEL_CONFIG_METHODS`.
const RUNTIME_MODEL_CONFIG_METHODS: [&str; 8] = [
    "runtime.text.generate",
    "runtime.tasks.create",
    "runtime.tasks.send",
    "runtime.tasks.rollback",
    "runtime.tasks.interrupt_and_send",
    "runtime.tasks.supervisor.set",
    "runtime.automations.create",
    "runtime.automations.update",
];
/// `REMOTE_RUNTIME_DEVICE_TYPES`.
const REMOTE_RUNTIME_DEVICE_TYPES: [DeviceType; 2] = [DeviceType::Cloud, DeviceType::Remote];
/// `RUNTIME_MODEL_CONFIG_KEYS`.
const RUNTIME_MODEL_CONFIG_KEYS: [&str; 2] = ["model_config", "modelConfig"];
/// `RUNTIME_RPC_ENCODING_KEY`.
const RUNTIME_RPC_ENCODING_KEY: &str = "__runtimeRpcEncoding";
/// `RUNTIME_RPC_COMPRESSED_ENCODING`.
const RUNTIME_RPC_COMPRESSED_ENCODING: &str = "gzip+base64+json";
/// `RUNTIME_RPC_COMPRESSION_THRESHOLD_BYTES`.
const COMPRESSION_THRESHOLD_BYTES: usize = 512 * 1024;
/// `RUNTIME_RPC_MAX_ENCODED_BYTES`.
const MAX_ENCODED_BYTES: usize = 980_000;
/// `RUNTIME_MODEL_CONFIG_METHODS`' task-create member.
const RUNTIME_TASK_CREATE_METHOD: &str = "runtime.tasks.create";
/// `__runtimeRpcEncoding`'s browser-visible proxy path.
const MODEL_GATEWAY_PATH: &str = "/api/runtime-work/llm-responses-proxy";

/// One `RuntimeRpcError`: the stable failure the relay renders as an app-IPC
/// error acknowledgement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeRpcError {
    pub(crate) code: String,
    pub(crate) message: String,
    /// `None` when the source raises without the `retryable` keyword.
    pub(crate) retryable: Option<bool>,
    /// `None` when the source raises without `details`.
    pub(crate) details: Option<Value>,
}

/// One failed `RuntimeRpcService.call`.
#[derive(Debug)]
pub(crate) enum CallFailure {
    /// A source `RuntimeRpcError`, rendered as an app-IPC error ACK.
    Rpc(RuntimeRpcError),
    /// A database, Redis or payload-shape failure the source lets escape.
    Internal,
}

/// The resolved `RuntimeRoute` for one submitted device id.
pub(crate) struct Route {
    pub(crate) logical_device_id: String,
    pub(crate) runtime_device_id: String,
    pub(crate) device_type: DeviceType,
    pub(crate) socket_id: String,
    pub(crate) online: Map<String, Value>,
}

fn rpc_error(code: &str, message: impl Into<String>) -> RuntimeRpcError {
    RuntimeRpcError {
        code: code.to_string(),
        message: message.into(),
        retryable: None,
        details: None,
    }
}

/// `RuntimeRpcError(code, message, retryable=..., details={...})`.
fn rpc_route_error(
    code: &str,
    message: impl Into<String>,
    retryable: bool,
    device_id: &str,
) -> RuntimeRpcError {
    RuntimeRpcError {
        code: code.to_string(),
        message: message.into(),
        retryable: Some(retryable),
        details: Some(json!({"deviceId": device_id})),
    }
}

/// `_normalize_timeout`: an unreadable, non-positive or absent value is the 30 s
/// default, and every accepted value is capped at 600 s.
fn normalize_timeout(timeout_seconds: i64) -> i64 {
    if timeout_seconds <= 0 {
        DEFAULT_TIMEOUT_SECONDS
    } else {
        timeout_seconds.min(MAX_TIMEOUT_SECONDS)
    }
}

/// `runtime_route_resolver.resolve`: resolve and validate one owned, online
/// Runtime route.
#[allow(clippy::result_large_err)]
pub(crate) async fn resolve_route(
    app: &AppState,
    user_id: i64,
    submitted_device_id: &str,
) -> Result<Route, CallFailure> {
    let identity = resolve_runtime_route_identity(&app.mysql, user_id, submitted_device_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "runtime route identity read failed");
            CallFailure::Internal
        })?;
    let Some(identity) = identity else {
        return Err(CallFailure::Rpc(rpc_route_error(
            "device_not_found",
            "Device not found, access denied, or ambiguous historical identity; \
             select a specific device",
            false,
            submitted_device_id,
        )));
    };
    let online = read_online_state::<Value>(app, user_id, &identity.runtime_device_id)
        .await
        .map_err(|_| CallFailure::Internal)?;
    // `if not isinstance(online_info, dict)` renders the offline route.
    let Some(Value::Object(online)) = online else {
        return Err(CallFailure::Rpc(rpc_route_error(
            "device_offline",
            format!("Device '{}' is offline", identity.logical_device_id),
            true,
            &identity.logical_device_id,
        )));
    };
    let Some(socket_id) = online
        .get("socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|socket_id| !socket_id.is_empty())
    else {
        return Err(CallFailure::Rpc(rpc_route_error(
            "runtime_route_missing",
            format!(
                "Device '{}' has no current Runtime socket",
                identity.logical_device_id
            ),
            true,
            &identity.logical_device_id,
        )));
    };
    if !runtime_instance_matches(&identity.runtime_instance_id, &online) {
        return Err(CallFailure::Rpc(rpc_route_error(
            "runtime_route_missing",
            format!(
                "Device '{}' reported a stale Runtime route",
                identity.logical_device_id
            ),
            true,
            &identity.logical_device_id,
        )));
    }
    Ok(Route {
        logical_device_id: identity.logical_device_id,
        runtime_device_id: identity.runtime_device_id,
        device_type: identity.device_type,
        socket_id: socket_id.to_string(),
        online,
    })
}

/// `RuntimeRpcService.call`.
#[allow(clippy::result_large_err)]
pub(crate) async fn call(
    app: &AppState,
    user_id: i64,
    submitted_device_id: &str,
    method: &str,
    payload: Value,
    timeout_seconds: i64,
    allow_app_device_task_reading: bool,
) -> Result<Value, CallFailure> {
    let normalized_timeout = normalize_timeout(timeout_seconds);
    let route = resolve_route(app, user_id, submitted_device_id).await?;

    let app_task_reading_allowed = allow_app_device_task_reading
        && route.device_type == DeviceType::App
        && APP_DEVICE_TASK_READ_METHODS.contains(&method);
    if !remote_control_is_enabled(route.device_type) && !app_task_reading_allowed {
        return Err(CallFailure::Rpc(RuntimeRpcError {
            code: "remote_control_disabled".to_string(),
            message: REMOTE_CONTROL_DISABLED_MESSAGE.to_string(),
            retryable: Some(false),
            details: Some(json!({"deviceId": route.logical_device_id})),
        }));
    }

    let payload = if method == RUNTIME_TASK_CREATE_METHOD {
        negotiate_runtime_task_create_payload(payload, route.online.get("runtime_features"))
            .map_err(|features| {
                let message = format!(
                    "Connected Executor does not support runtime task-create features: {}",
                    features.join(", ")
                );
                CallFailure::Rpc(RuntimeRpcError {
                    code: "unsupported_runtime_task_create_features".to_string(),
                    message,
                    retryable: Some(false),
                    details: Some(json!({
                        "deviceId": route.logical_device_id,
                        "features": features,
                    })),
                })
            })?
    } else {
        payload
    };

    let payload = enforce_remote_runtime_proxy(app, user_id, route.device_type, method, payload)
        .await
        .map_err(|()| {
            CallFailure::Rpc(RuntimeRpcError {
                code: "runtime_proxy_config_failed".to_string(),
                message: "Failed to resolve cloud device proxy configuration".to_string(),
                retryable: Some(false),
                details: Some(json!({"deviceId": route.logical_device_id})),
            })
        })?;

    let ack = call_runtime_method(
        app,
        user_id,
        &route.socket_id,
        method,
        payload,
        normalized_timeout as u64,
    )
    .await
    .map_err(|error| {
        CallFailure::Rpc(classify_call_error(
            error,
            method,
            &route,
            normalized_timeout,
        ))
    })?;

    let result = decode_response(ack).map_err(CallFailure::Rpc)?;
    let Some(result) = result.as_object() else {
        return Err(CallFailure::Rpc(RuntimeRpcError {
            code: "runtime_rpc_invalid_response".to_string(),
            message: "Runtime RPC returned an invalid response".to_string(),
            retryable: None,
            details: Some(json!({"deviceId": route.logical_device_id})),
        }));
    };
    Ok(Value::Object(project_response_device_ids(
        result,
        method,
        &route.runtime_device_id,
        &route.logical_device_id,
    )))
}

/// `_classify_rpc_error`: the acknowledgement failure categories the transport
/// can distinguish here are the expiry and the closed subscriber.
fn classify_call_error(
    error: RuntimeCallError,
    method: &str,
    route: &Route,
    normalized_timeout: i64,
) -> RuntimeRpcError {
    let acknowledgement_seconds = normalized_timeout + SOCKET_ACK_GRACE_SECONDS;
    let logical_device_id = &route.logical_device_id;
    let code = match error {
        RuntimeCallError::Timeout => {
            return RuntimeRpcError {
                code: "runtime_rpc_timeout".to_string(),
                message: format!(
                    "Runtime RPC '{method}' timed out after {acknowledgement_seconds} seconds \
                     waiting for device '{logical_device_id}'."
                ),
                retryable: Some(true),
                details: Some(json!({"deviceId": logical_device_id})),
            };
        }
        RuntimeCallError::Closed => "connection closed".to_string(),
        RuntimeCallError::Unavailable(reason) => reason,
        RuntimeCallError::Decode => {
            return rpc_error(
                "runtime_rpc_invalid_response",
                "Runtime RPC returned an unreadable payload",
            );
        }
    };
    RuntimeRpcError {
        code: "runtime_rpc_failed".to_string(),
        message: format!("Runtime RPC '{method}' failed: {code}"),
        retryable: Some(false),
        details: Some(json!({"deviceId": logical_device_id})),
    }
}

/// `_decode_response`: a large executor response may be carried as the
/// `gzip+base64+json` envelope.
#[allow(clippy::result_large_err)]
fn decode_response(result: Value) -> Result<Value, RuntimeRpcError> {
    let Some(object) = result.as_object() else {
        return Ok(result);
    };
    if object.get(RUNTIME_RPC_ENCODING_KEY).and_then(Value::as_str)
        != Some(RUNTIME_RPC_COMPRESSED_ENCODING)
    {
        return Ok(result);
    }
    let payload = object
        .get("payload")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            rpc_error(
                "runtime_rpc_invalid_response",
                "Runtime RPC returned an invalid compressed payload",
            )
        })?;
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| unreadable_payload())?;
    let mut decoded = Vec::new();
    flate2::read::MultiGzDecoder::new(compressed.as_slice())
        .read_to_end(&mut decoded)
        .map_err(|_| unreadable_payload())?;
    serde_json::from_slice(&decoded).map_err(|_| unreadable_payload())
}

fn unreadable_payload() -> RuntimeRpcError {
    rpc_error(
        "runtime_rpc_invalid_response",
        "Runtime RPC returned an unreadable payload",
    )
}

/// `_project_response_device_ids`: keep external Runtime responses on the
/// stable logical device identity. `runtime.worktrees.*` responses also carry
/// nested device identities.
fn project_response_device_ids(
    result: &Map<String, Value>,
    method: &str,
    runtime_device_id: &str,
    logical_device_id: &str,
) -> Map<String, Value> {
    let mut projected = result.clone();
    project_flat_device_ids(&mut projected, runtime_device_id, logical_device_id);
    if !method.starts_with("runtime.worktrees.") {
        return projected;
    }
    for value in projected.values_mut() {
        project_nested_device_ids(value, runtime_device_id, logical_device_id);
    }
    projected
}

fn project_flat_device_ids(
    object: &mut Map<String, Value>,
    runtime_device_id: &str,
    logical_device_id: &str,
) {
    for key in ["deviceId", "device_id"] {
        if object.get(key).and_then(Value::as_str) == Some(runtime_device_id) {
            object.insert(
                key.to_string(),
                Value::String(logical_device_id.to_string()),
            );
        }
    }
}

/// `_project_nested_device_ids`.
fn project_nested_device_ids(value: &mut Value, runtime_device_id: &str, logical_device_id: &str) {
    match value {
        Value::Array(items) => {
            for item in items {
                project_nested_device_ids(item, runtime_device_id, logical_device_id);
            }
        }
        Value::Object(object) => {
            for (key, item) in object.iter_mut() {
                if matches!(key.as_str(), "deviceId" | "device_id")
                    && item.as_str() == Some(runtime_device_id)
                {
                    *item = Value::String(logical_device_id.to_string());
                    continue;
                }
                project_nested_device_ids(item, runtime_device_id, logical_device_id);
            }
        }
        _ => {}
    }
}

/// `encode_runtime_rpc_response`: compress a large browser-facing Runtime RPC
/// result for Socket.IO.
#[allow(clippy::result_large_err)]
pub(crate) fn encode_response(response: Value, method: &str) -> Result<Value, RuntimeRpcError> {
    let raw = serde_json::to_vec(&response).map_err(|error| {
        tracing::error!(%error, method, "runtime RPC response serialization failed");
        unreadable_payload()
    })?;
    if raw.len() <= COMPRESSION_THRESHOLD_BYTES {
        return Ok(response);
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(&raw).map_err(|error| {
        tracing::error!(%error, method, "runtime RPC response compression failed");
        unreadable_payload()
    })?;
    let compressed = encoder.finish().map_err(|error| {
        tracing::error!(%error, method, "runtime RPC response compression failed");
        unreadable_payload()
    })?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&compressed);
    let envelope = json!({
        RUNTIME_RPC_ENCODING_KEY: RUNTIME_RPC_COMPRESSED_ENCODING,
        "payload": encoded,
        "rawBytes": raw.len(),
        "compressedBytes": compressed.len(),
    });
    let envelope_bytes = serde_json::to_vec(&envelope)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX);
    if envelope_bytes > MAX_ENCODED_BYTES {
        return Err(rpc_error(
            "runtime_rpc_response_too_large",
            "Runtime RPC response exceeded the Socket.IO payload limit",
        ));
    }
    tracing::info!(
        method,
        raw_bytes = raw.len(),
        compressed_bytes = compressed.len(),
        encoded_bytes = envelope_bytes,
        "runtime RPC response compressed for Wework"
    );
    Ok(envelope)
}

/// `FEATURE_FIELDS`: the payload field whose use requires each create feature.
const FEATURE_FIELDS: [(&str, &str); 7] = [
    ("attachments", "attachments"),
    ("goal", "initialGoal"),
    ("permissionMode", "runtimePermissionMode"),
    ("projectPlugins", "projectPlugins"),
    ("standaloneWorkspace", "standaloneChatWorkspace"),
    ("supervisor", "initialSupervisor"),
    ("workspaceInheritance", "workspaceSourceTask"),
];

/// `negotiate_runtime_task_create_payload`: select V2 or a lossless V1
/// representation for one connected Runtime. The failure carries the
/// unsupported feature names in the source's fixed order.
fn negotiate_runtime_task_create_payload(
    payload: Value,
    runtime_features: Option<&Value>,
) -> Result<Value, Vec<String>> {
    let requested_version = payload
        .get("schemaVersion")
        .and_then(positive_int)
        .unwrap_or(1);
    if requested_version == 1 {
        return Ok(without_schema_version(payload));
    }
    let protocol = runtime_features
        .and_then(|features| features.get("runtimeTaskCreate"))
        .filter(|value| value.is_object());
    let supported_versions = supported_versions(protocol);
    let advertised_features = advertised_features(protocol);
    let required_features = required_features(&payload);

    if supported_versions.contains(&2) {
        let unsupported: Vec<String> = required_features
            .iter()
            .filter(|feature| advertised_features.get(*feature) == Some(&Value::Bool(false)))
            .cloned()
            .collect();
        if !unsupported.is_empty() {
            return Err(unsupported);
        }
        return Ok(payload);
    }
    if !required_features.is_empty() {
        return Err(required_features);
    }
    if !supported_versions.is_empty() && !supported_versions.contains(&1) {
        return Err(vec!["schemaVersion:2".to_string()]);
    }
    Ok(without_schema_version(payload))
}

/// `_supported_versions`.
fn supported_versions(protocol: Option<&Value>) -> Vec<i64> {
    protocol
        .and_then(|protocol| protocol.get("schemaVersions"))
        .and_then(Value::as_array)
        .map(|versions| versions.iter().filter_map(positive_int).collect())
        .unwrap_or_default()
}

/// `_advertised_features`.
fn advertised_features(protocol: Option<&Value>) -> Map<String, Value> {
    protocol
        .and_then(|protocol| protocol.get("features"))
        .and_then(Value::as_object)
        .map(|features| {
            features
                .iter()
                .filter(|(_, value)| value.is_boolean())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// `_required_features`.
fn required_features(payload: &Value) -> Vec<String> {
    let mut required: Vec<String> = FEATURE_FIELDS
        .iter()
        .filter(|(_, field)| field_is_used(payload, field))
        .map(|(feature, _)| (*feature).to_string())
        .collect();
    if uses_skills(payload) {
        required.push("skills".to_string());
    }
    if uses_worktree(payload) {
        required.push("worktree".to_string());
    }
    required
}

/// `_field_is_used`: present and not `None`, `False`, `[]` or `{}`.
fn field_is_used(payload: &Value, field: &str) -> bool {
    match payload.get(field) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(object)) => !object.is_empty(),
        Some(_) => true,
    }
}

/// `_uses_skills`.
fn uses_skills(payload: &Value) -> bool {
    payload
        .get("executionRequest")
        .filter(|request| request.is_object())
        .is_some_and(|request| field_is_used(request, "preload_skills"))
}

/// `_uses_worktree`.
fn uses_worktree(payload: &Value) -> bool {
    payload
        .get("execution")
        .filter(|execution| execution.is_object())
        .and_then(|execution| execution.get("workspace"))
        .filter(|workspace| workspace.is_object())
        .and_then(|workspace| workspace.get("source"))
        .and_then(Value::as_str)
        == Some("git_worktree")
}

/// `_without_schema_version`.
fn without_schema_version(payload: Value) -> Value {
    let Value::Object(mut object) = payload else {
        return payload;
    };
    object.remove("schemaVersion");
    object.remove("schema_version");
    Value::Object(object)
}

/// `_positive_int`: a non-boolean integer of at least one.
fn positive_int(value: &Value) -> Option<i64> {
    value.as_i64().filter(|value| *value >= 1)
}

/// `_enforce_remote_runtime_proxy`: cloud and remote model configurations use
/// the account proxy unless the backend owns the model gateway.
async fn enforce_remote_runtime_proxy(
    app: &AppState,
    user_id: i64,
    device_type: DeviceType,
    method: &str,
    payload: Value,
) -> Result<Value, ()> {
    if !REMOTE_RUNTIME_DEVICE_TYPES.contains(&device_type)
        || !RUNTIME_MODEL_CONFIG_METHODS.contains(&method)
    {
        return Ok(payload);
    }
    let mut next_payload = payload.clone();
    if !next_payload_has_model_configs(&next_payload) {
        return Ok(payload);
    }
    let proxy_url = crate::users_me_proxy_config::execution_proxy_url(
        &app.mysql,
        i32::try_from(user_id).map_err(|_| ())?,
    )
    .await
    .map_err(|_| ())?;
    apply_runtime_proxy(&mut next_payload, &proxy_url);
    tracing::info!(
        user_id,
        method,
        configured = !proxy_url.is_empty(),
        "runtime RPC account proxy policy applied"
    );
    Ok(next_payload)
}

/// `if not model_configs`: whether any model configuration is addressable.
fn next_payload_has_model_configs(payload: &Value) -> bool {
    match payload {
        Value::Array(items) => items.iter().any(next_payload_has_model_configs),
        Value::Object(object) => object.iter().any(|(key, item)| {
            if RUNTIME_MODEL_CONFIG_KEYS.contains(&key.as_str()) && item.is_object() {
                return true;
            }
            next_payload_has_model_configs(item)
        }),
        _ => false,
    }
}

/// `_runtime_model_configs` over `_set_runtime_proxy`: apply the proxy to every
/// `model_config`/`modelConfig` object without descending into it.
fn apply_runtime_proxy(payload: &mut Value, proxy_url: &str) {
    walk_model_configs(payload, &mut |model_config| {
        set_runtime_proxy(model_config, proxy_url)
    });
}

fn walk_model_configs(value: &mut Value, apply: &mut impl FnMut(&mut Map<String, Value>)) {
    match value {
        Value::Array(items) => {
            for item in items {
                walk_model_configs(item, apply);
            }
        }
        Value::Object(object) => {
            for (key, item) in object.iter_mut() {
                if RUNTIME_MODEL_CONFIG_KEYS.contains(&key.as_str())
                    && let Value::Object(model_config) = item
                {
                    apply(model_config);
                    continue;
                }
                walk_model_configs(item, apply);
            }
        }
        _ => {}
    }
}

/// `_set_runtime_proxy`.
fn set_runtime_proxy(model_config: &mut Map<String, Value>, proxy_url: &str) {
    let proxy_url = if uses_backend_model_gateway(model_config) {
        ""
    } else {
        proxy_url
    };
    model_config.remove("proxy_url");
    model_config.remove("proxyUrl");
    if proxy_url.is_empty() {
        model_config.remove("proxy");
    } else {
        model_config.insert("proxy".to_string(), json!({"url": proxy_url}));
    }

    let runtime_config = model_config
        .remove("runtimeConfig")
        .filter(Value::is_object)
        .or_else(|| {
            model_config
                .get("runtime_config")
                .filter(|v| v.is_object())
                .cloned()
        })
        .unwrap_or_else(|| json!({}));
    let mut runtime_config = runtime_config.as_object().cloned().unwrap_or_default();
    let mut codex = runtime_config
        .get("codex")
        .filter(|value| value.is_object())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    codex.insert("use_proxy".to_string(), Value::Bool(!proxy_url.is_empty()));
    codex.insert(
        "proxy_configured".to_string(),
        Value::Bool(!proxy_url.is_empty()),
    );
    runtime_config.insert("codex".to_string(), Value::Object(codex));
    model_config.insert("runtime_config".to_string(), Value::Object(runtime_config));
}

/// `_uses_backend_model_gateway`: the backend already owns the provider
/// connection, so device traffic must not use the account proxy.
fn uses_backend_model_gateway(model_config: &Map<String, Value>) -> bool {
    let Some(headers) = model_config
        .get("default_headers")
        .filter(|v| v.is_object())
    else {
        return false;
    };
    let Some(base_url) = model_config
        .get("base_url")
        .filter(|value| python_truthy(value))
        .or_else(|| {
            model_config
                .get("baseUrl")
                .filter(|value| python_truthy(value))
        })
        .and_then(Value::as_str)
    else {
        return false;
    };
    url_path(base_url).is_some_and(|path| path == MODEL_GATEWAY_PATH)
        && headers.as_object().is_some_and(|headers| {
            headers
                .keys()
                .any(|key| key.to_lowercase() == "x-wegent-model-type")
        })
}

/// `urlsplit(base_url).path.rstrip("/")`; `None` is the source's `ValueError`.
fn url_path(base_url: &str) -> Option<String> {
    let after_scheme = match base_url.split_once("://") {
        Some((_, rest)) => rest,
        None => base_url,
    };
    // A URL without an authority (`//host/path`) keeps the source's split.
    let path = match after_scheme.find('/') {
        Some(index) => &after_scheme[index..],
        None => return Some(String::new()),
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let trimmed = path.trim_end_matches('/');
    // `urlsplit` rejects a netloc that cannot be parsed; the relay only ever
    // sees absolute model base URLs, so an empty result stays the root path.
    Some(if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timeouts_clamp_to_the_source_default_and_cap() {
        assert_eq!(normalize_timeout(0), 30);
        assert_eq!(normalize_timeout(-1), 30);
        assert_eq!(normalize_timeout(75), 75);
        assert_eq!(normalize_timeout(900), 600);
    }

    #[test]
    fn schema_version_one_drops_the_version_keys() {
        let negotiated = negotiate_runtime_task_create_payload(
            json!({"schemaVersion": 1, "schema_version": 1, "taskId": "t"}),
            None,
        )
        .unwrap();
        assert_eq!(negotiated, json!({"taskId": "t"}));
    }

    #[test]
    fn v2_payloads_require_an_advertising_runtime() {
        let payload = json!({"schemaVersion": 2, "attachments": [{"name": "a"}]});
        // Only an explicit `false` advertisement blocks the feature; a runtime
        // that omits it keeps the requested payload.
        let declined = json!({"runtimeTaskCreate": {"schemaVersions": [2], "features": {"attachments": false}}});
        assert_eq!(
            negotiate_runtime_task_create_payload(payload.clone(), Some(&declined)).unwrap_err(),
            vec!["attachments".to_string()]
        );
        let silent = json!({"runtimeTaskCreate": {"schemaVersions": [2], "features": {}}});
        assert_eq!(
            negotiate_runtime_task_create_payload(payload.clone(), Some(&silent)).unwrap(),
            payload
        );
        let advertised = json!({"runtimeTaskCreate": {"schemaVersions": [2], "features": {"attachments": true}}});
        assert_eq!(
            negotiate_runtime_task_create_payload(payload.clone(), Some(&advertised)).unwrap(),
            payload
        );
    }

    #[test]
    fn v1_runtimes_downgrade_a_feature_free_v2_payload() {
        let payload = json!({"schemaVersion": 2, "taskId": "t"});
        let v1 = json!({"runtimeTaskCreate": {"schemaVersions": [1]}});
        assert_eq!(
            negotiate_runtime_task_create_payload(payload, Some(&v1)).unwrap(),
            json!({"taskId": "t"})
        );
        let v3 = json!({"runtimeTaskCreate": {"schemaVersions": [3]}});
        assert_eq!(
            negotiate_runtime_task_create_payload(json!({"schemaVersion": 2}), Some(&v3))
                .unwrap_err(),
            vec!["schemaVersion:2".to_string()]
        );
    }

    #[test]
    fn nested_skill_and_worktree_uses_require_features() {
        let payload = json!({
            "schemaVersion": 2,
            "executionRequest": {"preload_skills": ["a"]},
            "execution": {"workspace": {"source": "git_worktree"}},
        });
        assert_eq!(
            negotiate_runtime_task_create_payload(payload, None).unwrap_err(),
            vec!["skills".to_string(), "worktree".to_string()]
        );
    }

    #[test]
    fn small_responses_are_returned_unencoded() {
        let response = json!({"success": true, "workspaces": []});
        assert_eq!(encode_response(response.clone(), "m").unwrap(), response);
    }

    #[test]
    fn large_responses_use_the_gzip_envelope() {
        let response = json!({"success": true, "payload": "x".repeat(COMPRESSION_THRESHOLD_BYTES)});
        let encoded = encode_response(response.clone(), "m").unwrap();
        assert_eq!(
            encoded
                .get(RUNTIME_RPC_ENCODING_KEY)
                .and_then(Value::as_str),
            Some(RUNTIME_RPC_COMPRESSED_ENCODING)
        );
        assert!(encoded.get("rawBytes").and_then(Value::as_u64).unwrap() > 0);
        assert_eq!(decode_response(encoded).unwrap(), response);
    }

    #[test]
    fn unreadable_envelopes_report_the_source_codes() {
        let error =
            decode_response(json!({RUNTIME_RPC_ENCODING_KEY: RUNTIME_RPC_COMPRESSED_ENCODING}))
                .unwrap_err();
        assert_eq!(error.code, "runtime_rpc_invalid_response");
        assert_eq!(
            error.message,
            "Runtime RPC returned an invalid compressed payload"
        );
        let error = decode_response(json!({
            RUNTIME_RPC_ENCODING_KEY: RUNTIME_RPC_COMPRESSED_ENCODING,
            "payload": "not-base64",
        }))
        .unwrap_err();
        assert_eq!(error.message, "Runtime RPC returned an unreadable payload");
    }

    #[test]
    fn device_identities_project_onto_the_logical_id() {
        let result = json!({"deviceId": "runtime-1", "device_id": "runtime-1", "items": [{"deviceId": "runtime-1"}]});
        let projected = project_response_device_ids(
            result.as_object().unwrap(),
            "runtime.tasks.list",
            "runtime-1",
            "logical-1",
        );
        assert_eq!(projected["deviceId"], json!("logical-1"));
        assert_eq!(projected["items"][0]["deviceId"], json!("runtime-1"));
    }

    #[test]
    fn worktree_responses_project_nested_device_identities() {
        let result =
            json!({"worktrees": [{"deviceId": "runtime-1", "meta": {"device_id": "runtime-1"}}]});
        let projected = project_response_device_ids(
            result.as_object().unwrap(),
            "runtime.worktrees.list",
            "runtime-1",
            "logical-1",
        );
        assert_eq!(projected["worktrees"][0]["deviceId"], json!("logical-1"));
        assert_eq!(
            projected["worktrees"][0]["meta"]["device_id"],
            json!("logical-1")
        );
    }

    #[test]
    fn model_configs_nested_in_the_payload_receive_the_account_proxy() {
        let mut payload = json!({
            "modelConfig": {"base_url": "http://provider"},
            "nested": {"model_config": {"base_url": "http://provider"}, "other": 1},
        });
        apply_runtime_proxy(&mut payload, "http://proxy:8080");
        assert_eq!(
            payload["modelConfig"]["proxy"],
            json!({"url": "http://proxy:8080"})
        );
        assert_eq!(
            payload["modelConfig"]["runtime_config"]["codex"]["use_proxy"],
            json!(true)
        );
        assert_eq!(
            payload["nested"]["model_config"]["proxy"],
            json!({"url": "http://proxy:8080"})
        );
    }

    #[test]
    fn backend_model_gateway_configurations_keep_the_device_off_the_proxy() {
        let mut model_config = json!({
            "base_url": "http://backend/api/runtime-work/llm-responses-proxy/",
            "default_headers": {"X-Wegent-Model-Type": "public"},
        });
        let Value::Object(ref mut object) = model_config else {
            unreachable!()
        };
        set_runtime_proxy(object, "http://proxy:8080");
        assert!(model_config.get("proxy").is_none());
        assert_eq!(
            model_config["runtime_config"]["codex"]["use_proxy"],
            json!(false)
        );
    }

    #[test]
    fn url_path_trims_the_gateway_suffix() {
        assert_eq!(
            url_path("https://wegent.example/api/runtime-work/llm-responses-proxy/").as_deref(),
            Some("/api/runtime-work/llm-responses-proxy")
        );
        assert_eq!(url_path("https://host").as_deref(), Some(""));
    }
}
