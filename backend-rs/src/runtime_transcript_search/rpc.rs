//! Dispatch through the process-lifetime Socket.IO callback subscriber.

use std::{io::Read, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use brz_http_server::StatusCode;
use brz_redis::{Redis as _, RedisBytes};
use serde_json::{Value, json};

use crate::device_identity::{
    DeviceKindRow, DeviceType, RuntimeRouteIdentity, identity_from_device,
    resolve_owned_device_alias,
};
use crate::http_compat::FastApiError;
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message_with_callback};
use crate::socketio_rpc::RpcError;
use crate::state::AppState;

use super::{access::Target, database_error, error};

const NAMESPACE: &str = "/local-executor";
const METHOD: &str = "runtime.tasks.transcript.search";
const ACK_TIMEOUT_SECONDS: u64 = 125;

#[tracing::instrument(name = "runtime_work.transcript.search", skip_all, fields(owner_id = target.owner_id, project_bound = target.project_bound))]
pub(super) async fn search(
    state: &AppState,
    target: &Target,
    device: &str,
    payload: Value,
) -> Result<Value, FastApiError> {
    let record = resolve_owned_device_alias(&state.mysql, target.owner_id, device)
        .await
        .map_err(database_error)?
        .ok_or_else(|| failure("Device not found or access denied"))?;
    let identity = identity_from_device(&record).ok_or_else(|| failure(
            "Device not found, access denied, or ambiguous historical identity; select a specific device"))?;
    let redis = state
        .redis
        .as_ref()
        .ok_or_else(|| failure("Runtime RPC is unavailable"))?;
    let online: Option<RedisBytes> = redis
        .get(crate::devices::online_key(
            target.owner_id,
            &identity.runtime_device_id,
        ))
        .await
        .map_err(|cause| {
            tracing::error!(%cause, "transcript search online lookup failed");
            failure("Runtime RPC is unavailable")
        })?;
    let online = online
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let socket = socket(&identity, &online)?;
    if !task_read_allowed(&record, &identity, target.project_bound) {
        return Err(failure("Remote control is disabled for this app device"));
    }
    let rpc = state
        .socketio_rpc
        .as_ref()
        .ok_or_else(|| failure("Runtime RPC is unavailable"))?;
    let call = rpc
        .begin(&socket, NAMESPACE)
        .map_err(|cause| failure(format!("Runtime RPC failed: {cause}")))?;
    let data = crate::internal_callback::py_json::python_dumps(
        &json!([{"method": METHOD, "payload": payload}]),
    );
    let message = emit_message_with_callback(
        "runtime:rpc",
        &data,
        NAMESPACE,
        &socket,
        Some((&socket, call.id())),
    );
    redis
        .publish(SOCKETIO_CHANNEL, message)
        .await
        .map_err(|cause| failure(format!("Runtime RPC failed: {cause}")))?;
    let args = call.wait(Duration::from_secs(ACK_TIMEOUT_SECONDS)).await.map_err(|cause| match cause {
        RpcError::Timeout => failure(format!("Runtime RPC '{METHOD}' timed out after {ACK_TIMEOUT_SECONDS} seconds waiting for device '{}'.", identity.logical_device_id)),
        RpcError::Closed => failure(format!("Runtime RPC '{METHOD}' failed because device '{}' disconnected before acknowledging the request.", identity.logical_device_id)),
        RpcError::Unavailable(cause) => failure(format!("Runtime RPC failed: {cause}")),
    })?;
    tracing::info!(
        owner_id = target.owner_id,
        project_bound = target.project_bound,
        "transcript search RPC acknowledged"
    );
    decode(match args {
        Value::Array(mut args) if args.len() == 1 => args.remove(0),
        result => result,
    })
}

pub(super) fn task_read_allowed(
    device: &DeviceKindRow,
    identity: &RuntimeRouteIdentity,
    project_bound: bool,
) -> bool {
    device.remote_control_enabled() || (project_bound && identity.device_type == DeviceType::App)
}

pub(super) fn socket(
    identity: &RuntimeRouteIdentity,
    online: &Value,
) -> Result<String, FastApiError> {
    if !online.is_object() {
        return Err(failure(format!(
            "Device '{}' is offline",
            identity.logical_device_id
        )));
    }
    let socket = online
        .get("socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            failure(format!(
                "Device '{}' has no current Runtime socket",
                identity.logical_device_id
            ))
        })?;
    if let Some(expected) = &identity.runtime_instance_id
        && online
            .get("runtime_instance_id")
            .and_then(Value::as_str)
            .map(str::trim)
            != Some(expected)
    {
        return Err(failure(format!(
            "Device '{}' reported a stale Runtime route",
            identity.logical_device_id
        )));
    }
    Ok(socket.to_owned())
}

pub(super) fn decode(result: Value) -> Result<Value, FastApiError> {
    let result =
        if result.get("__runtimeRpcEncoding").and_then(Value::as_str) == Some("gzip+base64+json") {
            let payload = result
                .get("payload")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Runtime RPC returned an invalid compressed payload"))?;
            let bytes = STANDARD
                .decode(payload)
                .map_err(|_| failure("Runtime RPC returned an unreadable payload"))?;
            let mut decoded = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .read_to_end(&mut decoded)
                .map_err(|_| failure("Runtime RPC returned an unreadable payload"))?;
            serde_json::from_slice(&decoded)
                .map_err(|_| failure("Runtime RPC returned an unreadable payload"))?
        } else {
            result
        };
    if !result.is_object() {
        return Err(failure("Runtime RPC returned an invalid response"));
    }
    Ok(result)
}

fn failure(detail: impl Into<String>) -> FastApiError {
    error(StatusCode::BAD_GATEWAY, detail)
}
