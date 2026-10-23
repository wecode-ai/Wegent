// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/runtime-work/transcript` — read a native runtime transcript from
//! the owning online local executor.
//!
//! Mirrors `app.api.endpoints.runtime_work.get_runtime_transcript_endpoint` ->
//! `runtime_work_service.get_runtime_transcript`:
//!
//! 1. `RuntimeTranscriptRequest` pydantic validation (aliases, bounds, the
//!    optional `projectSession` scope);
//! 2. with `projectSession`, `resolve_project_transcript` authorizes the
//!    durable session binding ([`crate::runtime_work_transcript_access`]);
//!    otherwise `_normalized_address`, `_ensure_owned_device` and
//!    `_touch_workspace_mapping`;
//! 3. `_runtime_transcript_payload` (address + optional paging flags);
//! 4. `runtime_rpc_service.call(method="runtime.tasks.transcript")` — the
//!    owned device route, its strict Redis online read, and the Socket.IO
//!    Redis-adapter emit with the acknowledgement budget;
//! 5. `_raise_runtime_rpc_failure`, the canonical-turns guard and
//!    `RuntimeTranscriptResponse.model_validate` (unknown executor keys are
//!    dropped and every model default is serialized).
//!
//! The executor response is large; the recorded acknowledgement uses the
//! `gzip+base64+json` envelope, which the shared RPC helper decodes.

use std::time::Instant;

use brz_http_server::StatusCode;
use chrono::{SecondsFormat, Timelike, Utc};
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::auth::SessionUser;
use crate::device_identity::{
    DeviceType as RouteDeviceType, resolve_owned_device_alias, resolve_runtime_route_identity,
};
use crate::device_online_state::read_online_state;
use crate::http_compat::FastApiError;
use crate::runtime_work::{
    RuntimeCallError, call_runtime_method, remote_control_is_enabled, runtime_instance_matches,
};
use crate::runtime_work_transcript_access::{ProjectScope, resolve_project_transcript};
use crate::runtime_work_transcript_request::{
    NormalizedAddress, TranscriptRequest, normalized_address, transcript_payload,
};
use crate::runtime_work_transcript_response::RuntimeTranscriptResponse;
use crate::state::AppState;

/// `RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS`.
const RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS: u64 = 30;
/// `runtime_rpc_service.call(method="runtime.tasks.transcript")`.
const RUNTIME_TASKS_TRANSCRIPT_METHOD: &str = "runtime.tasks.transcript";
/// `REMOTE_CONTROL_DISABLED_MESSAGE`.
const REMOTE_CONTROL_DISABLED_MESSAGE: &str = "Remote control is disabled for this app device";

/// POST /api/runtime-work/transcript.
#[brz_http_server::post("/api/runtime-work/transcript")]
async fn get_runtime_transcript_endpoint(
    #[inject(state)] state: &AppState,
    body: Value,
    #[auth] user: SessionUser,
) -> Result<RuntimeTranscriptResponse, FastApiError> {
    let request = TranscriptRequest::validated(&body)?;
    get_runtime_transcript(state, user.id, &request).await
}

/// `runtime_work_service.get_runtime_transcript`.
async fn get_runtime_transcript(
    state: &AppState,
    user_id: i32,
    request: &TranscriptRequest,
) -> Result<RuntimeTranscriptResponse, FastApiError> {
    let started_at = Instant::now();
    let numeric_user_id = i64::from(user_id);
    let (rpc_user_id, address) = match &request.project_session {
        Some(scope) => {
            let resolved = resolve_project_transcript(
                &state.mysql,
                numeric_user_id,
                &request.device_id,
                &request.local_task_id,
                &ProjectScope {
                    project_id: &scope.project_id,
                    issue_id: &scope.issue_id,
                },
            )
            .await?;
            (
                resolved.owner_user_id,
                NormalizedAddress {
                    device_id: resolved.device_id,
                    workspace_path: None,
                    task_id: resolved.task_id,
                    runtime_handle: None,
                },
            )
        }
        None => {
            let address = normalized_address(request);
            ensure_owned_device(state, numeric_user_id, &address.device_id).await?;
            touch_workspace_mapping(state, numeric_user_id, &address).await?;
            (numeric_user_id, address)
        }
    };
    let payload = transcript_payload(request, &address);
    let allow_app_device_task_reading = request.project_session.is_some();
    let result = call_transcript_rpc(
        state,
        rpc_user_id,
        &address.device_id,
        payload,
        allow_app_device_task_reading,
    )
    .await?;
    tracing::info!(
        user_id,
        device_id = address.device_id,
        local_task_id = address.task_id,
        elapsed_ms = started_at.elapsed().as_millis() as u64,
        "runtime transcript RPC completed"
    );
    raise_runtime_rpc_failure(&result)?;
    if !matches!(result.get("turns"), Some(Value::Array(_))) {
        return Err(FastApiError::detail(
            StatusCode::BAD_GATEWAY,
            "Runtime transcript response is missing canonical turns",
        ));
    }
    RuntimeTranscriptResponse::from_value(&result).map_err(|()| {
        tracing::error!(
            device_id = address.device_id,
            local_task_id = address.task_id,
            "invalid runtime transcript response"
        );
        FastApiError::detail(
            StatusCode::BAD_GATEWAY,
            "Runtime returned an invalid conversation response",
        )
    })
}

/// `_ensure_owned_device`: `device_service.get_device_by_device_id` (an
/// unambiguous owned alias) or the runtime route identity; both reduce to the
/// same alias resolution.
async fn ensure_owned_device(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<(), FastApiError> {
    match resolve_owned_device_alias(&state.mysql, user_id, device_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Device not found or access denied",
        )),
        Err(error) => {
            tracing::error!(%error, user_id, device_id, "device identity lookup failed");
            Err(FastApiError::unhandled())
        }
    }
}

/// `_touch_workspace_mapping` -> `touch_device_workspace_kind`: update the
/// `DeviceWorkspace` Kind's `lastSeenAt` when the mapping exists.
async fn touch_workspace_mapping(
    state: &AppState,
    user_id: i64,
    address: &NormalizedAddress,
) -> Result<(), FastApiError> {
    let Some(workspace_path) = address.workspace_path.as_deref() else {
        return Ok(());
    };
    let path_hash = hex_sha256(workspace_path.as_bytes());
    let kind_name = device_workspace_kind_name(&address.device_id, &path_hash);
    let row: Option<(i64, Value)> = state
        .mysql
        .fetch_optional(
            "SELECT kinds.id AS kinds_id, kinds.json AS kinds_json \nFROM kinds \n\
             WHERE kinds.user_id = ? AND kinds.kind = 'DeviceWorkspace' \
             AND kinds.namespace = 'runtime-work' AND kinds.name = ? \
             AND kinds.is_active IS true \n LIMIT 1",
            (i32::try_from(user_id).unwrap_or(i32::MAX), kind_name),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "device workspace mapping read failed");
            FastApiError::unhandled()
        })?;
    let Some((kind_id, resource)) = row else {
        return Ok(());
    };
    let mut resource = match resource {
        Value::Object(object) => object,
        _ => Map::new(),
    };
    let mut status = match resource.get("status") {
        Some(Value::Object(status)) => status.clone(),
        _ => Map::new(),
    };
    status.insert(
        "lastSeenAt".to_string(),
        Value::String(
            Utc::now()
                .with_nanosecond(0)
                .unwrap_or_else(Utc::now)
                .to_rfc3339_opts(SecondsFormat::Secs, false),
        ),
    );
    resource.insert("status".to_string(), Value::Object(status));
    let encoded = Value::Object(resource).to_string();
    state
        .mysql
        .execute(
            "UPDATE kinds SET kinds.json = ? WHERE kinds.id = ?",
            (encoded, kind_id),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "device workspace mapping update failed");
            FastApiError::unhandled()
        })?;
    Ok(())
}

/// `device_workspace_kind_name(device_id, workspace_path_hash)`.
fn device_workspace_kind_name(device_id: &str, workspace_path_hash: &str) -> String {
    let key = format!("{}:{workspace_path_hash}", device_id.trim());
    format!("device-workspace-{}", &hex_sha256(key.as_bytes())[..32])
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `runtime_rpc_service.call` plus `RuntimeRouteResolver.resolve`.
async fn call_transcript_rpc(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: Value,
    allow_app_device_task_reading: bool,
) -> Result<Value, FastApiError> {
    let identity = resolve_runtime_route_identity(&state.mysql, user_id, device_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, device_id, "runtime route identity read failed");
            FastApiError::unhandled()
        })?;
    let Some(identity) = identity else {
        return Err(rpc_failure(
            "Device not found, access denied, or ambiguous historical identity; \
             select a specific device",
        ));
    };
    let online: Option<Value> =
        read_online_state(state, user_id, &identity.runtime_device_id).await?;
    let Some(Value::Object(online)) = online else {
        return Err(rpc_failure(format!(
            "Device '{}' is offline",
            identity.logical_device_id
        )));
    };
    let Some(socket_id) = online
        .get("socket_id")
        .filter(|value| brz_json::adapters::python_truthy(value))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|socket_id| !socket_id.is_empty())
    else {
        return Err(rpc_failure(format!(
            "Device '{}' has no current Runtime socket",
            identity.logical_device_id
        )));
    };
    if !runtime_instance_matches(&identity.runtime_instance_id, &online) {
        return Err(rpc_failure(format!(
            "Device '{}' reported a stale Runtime route",
            identity.logical_device_id
        )));
    }
    // `allow_app_device_task_reading` only admits App devices for the
    // `runtime.tasks.transcript` method, which this endpoint always calls.
    let app_reading_allowed =
        allow_app_device_task_reading && identity.device_type == RouteDeviceType::App;
    if !remote_control_is_enabled(identity.device_type) && !app_reading_allowed {
        return Err(rpc_failure(REMOTE_CONTROL_DISABLED_MESSAGE));
    }

    let result = call_runtime_method(
        state,
        user_id,
        socket_id,
        RUNTIME_TASKS_TRANSCRIPT_METHOD,
        payload,
        RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
    )
    .await
    .map_err(|error| transcript_rpc_error(error, &identity.logical_device_id))?;
    let Some(mut result) = result.as_object().cloned() else {
        return Err(rpc_failure("Runtime RPC returned an invalid response"));
    };
    for key in ["deviceId", "device_id"] {
        if result.get(key).and_then(Value::as_str) == Some(identity.runtime_device_id.as_str()) {
            result.insert(
                key.to_string(),
                Value::String(identity.logical_device_id.clone()),
            );
        }
    }
    Ok(Value::Object(result))
}

/// `_classify_rpc_error` rendered as the endpoint's `502 {"detail": ...}`.
fn transcript_rpc_error(error: RuntimeCallError, logical_device_id: &str) -> FastApiError {
    let method = RUNTIME_TASKS_TRANSCRIPT_METHOD;
    let message = match error {
        RuntimeCallError::Timeout => format!(
            "Runtime RPC '{method}' timed out after {} seconds waiting for device \
             '{logical_device_id}'.",
            RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS + crate::runtime_work::SOCKET_ACK_GRACE_SECONDS
        ),
        RuntimeCallError::Closed => format!(
            "Runtime RPC '{method}' failed because device '{logical_device_id}' \
             disconnected before acknowledging the request."
        ),
        RuntimeCallError::Unavailable(reason) => {
            format!("Runtime RPC '{method}' failed: {reason}")
        }
        RuntimeCallError::Decode => "Runtime RPC returned an unreadable payload".to_string(),
    };
    rpc_failure(message)
}

fn rpc_failure(message: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_GATEWAY, message)
}

/// `_raise_runtime_rpc_failure`: only the literal `false` sentinel fails.
fn raise_runtime_rpc_failure(result: &Value) -> Result<(), FastApiError> {
    if result.get("success") != Some(&Value::Bool(false)) {
        return Ok(());
    }
    let detail = result
        .get("error")
        .filter(|value| brz_json::adapters::python_truthy(value))
        .map(crate::device_commands::python_str)
        .unwrap_or_else(|| "Runtime RPC failed".to_string());
    Err(FastApiError::detail(StatusCode::BAD_GATEWAY, detail))
}

/// `RuntimeTranscriptResponse`: the source model's field order, aliases and
/// defaults.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rpc_failure_only_accepts_the_literal_false_sentinel() {
        assert!(raise_runtime_rpc_failure(&json!({"success": true})).is_ok());
        assert!(raise_runtime_rpc_failure(&json!({"success": 0})).is_ok());
        assert!(raise_runtime_rpc_failure(&json!({})).is_ok());
        let error = raise_runtime_rpc_failure(&json!({"success": false, "error": "boom"}))
            .expect_err("failure");
        assert_eq!(error.detail_message(), Some("boom"));
    }

    #[test]
    fn workspace_kind_name_matches_the_source_hash_shape() {
        let name = device_workspace_kind_name(" device-1 ", "ab".repeat(32).as_str());
        assert!(name.starts_with("device-workspace-"));
        assert_eq!(name.len(), "device-workspace-".len() + 32);
    }

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/runtime-work/transcript"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/runtime-work/transcript must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/runtime-work/transcript"));
        assert!(!table.matches(&http::Method::GET, "/api/runtime-work/transcript"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/runtime-work/transcript" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/runtime-work/transcript must be registered"
        );
    }
}
