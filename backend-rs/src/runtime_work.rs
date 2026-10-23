// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/runtime-work` — the Wework runtime workbench tree.
//!
//! Mirrors `app.api.endpoints.runtime_work.list_runtime_work_endpoint` and
//! `runtime_work_service.list_runtime_work`:
//!
//! 1. `device_service.get_all_devices` — the `/api/devices` listing with its
//!    per-provider `kinds` reads, Redis online reads, and
//!    `executor:latest_version` lookups;
//! 2. `_list_online_runtime_workspaces` fans `runtime.tasks.list` out to every
//!    online/busy device through `runtime_rpc_service.call`: resolve the owned
//!    device route (`resolve_owned_device_alias` in a fresh session plus the
//!    strict Redis online read), reject App devices
//!    (`remote_control_is_enabled`), then publish the Socket.IO Redis-adapter
//!    `runtime:rpc` emit and await its acknowledgement (30 s timeout plus the
//!    5 s ack grace);
//! 3. the per-device workspace listings are merged by
//!    `(owner_device_id, workspace_path)`, ordered by device rank, the
//!    workspace order reported by the device, and the lowercased path, then
//!    rendered as `projects` and `chats`.
//!
//! A device failure (route, offline, timeout, invalid payload, or a task that
//! fails pydantic validation) drops that device's contribution instead of
//! failing the request, exactly like the source's
//! `asyncio.gather(return_exceptions=True)` fan-out.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use base64::Engine as _;
use brz_json::adapters::python_truthy;
use brz_redis::Redis as _;
use serde_json::{Map, Value};

use crate::auth::SessionUser;
use crate::device_identity::{DeviceType as RouteDeviceType, resolve_runtime_route_identity};
use crate::device_online_state::read_online_state;
use crate::devices::{DeviceItem, list_all_devices};
use crate::http_compat::FastApiError;
use crate::internal_callback::py_json::python_dumps;
use crate::runtime_work_projection::{
    RuntimeDeviceWorkspace, RuntimeProjectRef, RuntimeProjectWork, RuntimeWorkListResponse,
    WorkspaceEntry, WorkspaceListing, merge_listing, project_workspaces, runtime_device_order,
    runtime_workspace_kind_fields_from_tasks, workspace_order_key,
};
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message_with_callback};
use crate::state::AppState;

/// `RUNTIME_LIST_TIMEOUT_SECONDS`.
const RUNTIME_LIST_TIMEOUT_SECONDS: u64 = 30;
/// `SOCKET_ACK_GRACE_SECONDS` added to the `sio.call` budget.
pub(crate) const SOCKET_ACK_GRACE_SECONDS: u64 = 5;
/// `LOCAL_EXECUTOR_NAMESPACE`.
pub(crate) const LOCAL_EXECUTOR_NAMESPACE: &str = "/local-executor";
/// The adapter event carrying a `runtime:rpc` request.
pub(crate) const RUNTIME_RPC_EVENT: &str = "runtime:rpc";
/// `runtime_rpc_service.call(method="runtime.tasks.list", payload={})`.
const RUNTIME_TASKS_LIST_METHOD: &str = "runtime.tasks.list";
/// `RUNTIME_RPC_ENCODING_KEY`.
const RUNTIME_RPC_ENCODING_KEY: &str = "__runtimeRpcEncoding";
/// `RUNTIME_RPC_COMPRESSED_ENCODING`.
const RUNTIME_RPC_COMPRESSED_ENCODING: &str = "gzip+base64+json";
/// GET /api/runtime-work: the runtime workbench free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/runtime-work")]
async fn list_runtime_work_endpoint(
    #[inject(state)] state: &AppState,
    #[header("x-request-id")] request_id: Option<String>,
    #[auth] user: SessionUser,
) -> Result<RuntimeWorkListResponse, FastApiError> {
    list_runtime_work(state, user.id, request_id.as_deref()).await
}

/// `runtime_work_service.list_runtime_work`.
async fn list_runtime_work(
    state: &AppState,
    user_id: i32,
    request_id: Option<&str>,
) -> Result<RuntimeWorkListResponse, FastApiError> {
    let numeric_user_id = i64::from(user_id);
    let devices = list_all_devices(state, user_id, request_id).await?;
    let device_order = runtime_device_order(&devices);
    let devices_by_id: HashMap<&str, &DeviceItem> = devices
        .iter()
        .map(|device| (device.device_id(), device))
        .collect();

    // `asyncio.gather` over the online/busy devices: every device call is
    // independent, and one failure only drops that device's contribution.
    let online_devices: Vec<&DeviceItem> = devices
        .iter()
        .filter(|device| {
            !device.device_id().is_empty() && matches!(device.status(), "online" | "busy")
        })
        .collect();
    let results = futures_util::future::join_all(
        online_devices
            .iter()
            .map(|device| list_runtime_workspaces_for_device(state, numeric_user_id, device)),
    )
    .await;

    let mut grouped: HashMap<(String, String), WorkspaceListing> = HashMap::new();
    for (device, result) in online_devices.into_iter().zip(results) {
        match result {
            Ok(entries) => {
                for (key, listing) in entries {
                    merge_listing(&mut grouped, key, listing);
                }
            }
            Err(reason) => tracing::warn!(
                user_id = numeric_user_id,
                device_id = device.device_id(),
                reason,
                "runtime work device listing failed"
            ),
        }
    }

    let mut entries: Vec<((String, String), WorkspaceListing)> = grouped.into_iter().collect();
    entries.sort_by(|left, right| {
        workspace_order_key(left, &device_order).cmp(&workspace_order_key(right, &device_order))
    });

    let mut projects: Vec<RuntimeProjectWork> = Vec::new();
    let mut conversations: Vec<RuntimeDeviceWorkspace> = Vec::new();
    let mut total_tasks = 0_usize;
    for ((owner_device_id, workspace_path), listing) in entries {
        total_tasks += listing.tasks.len();
        let (workspace_kind, worktree_id) =
            runtime_workspace_kind_fields_from_tasks(&workspace_path, &listing.tasks);
        let WorkspaceListing {
            tasks,
            label,
            workspace_source,
            remote_host_id,
            ..
        } = listing;
        let workspace = RuntimeDeviceWorkspace::build(
            &owner_device_id,
            devices_by_id.get(owner_device_id.as_str()).copied(),
            &workspace_path,
            workspace_kind,
            worktree_id,
            tasks,
            label.clone(),
            workspace_source,
            remote_host_id,
        );
        if workspace.is_chat() {
            conversations.push(workspace);
            continue;
        }
        let project =
            RuntimeProjectRef::from_workspace(&owner_device_id, &workspace_path, label.as_deref());
        projects.push(RuntimeProjectWork {
            project,
            device_workspaces: vec![workspace],
        });
    }

    Ok(RuntimeWorkListResponse {
        projects,
        chats: conversations,
        total_tasks,
    })
}

/// `_list_runtime_workspaces_for_device`: resolve the device Runtime route,
/// call `runtime.tasks.list`, and project the reported workspaces.
async fn list_runtime_workspaces_for_device(
    state: &AppState,
    user_id: i64,
    device: &DeviceItem,
) -> Result<Vec<WorkspaceEntry>, String> {
    let identity = match resolve_runtime_route_identity(&state.mysql, user_id, device.device_id())
        .await
    {
        Ok(Some(identity)) => identity,
        Ok(None) => return Err("device_not_found".to_string()),
        Err(error) => {
            tracing::warn!(%error, user_id, device_id = device.device_id(), "runtime route identity read failed");
            return Err("device_not_found".to_string());
        }
    };
    let online = match read_online_state::<Value>(state, user_id, &identity.runtime_device_id).await
    {
        Ok(Some(Value::Object(online))) => online,
        Ok(_) => return Err("device_offline".to_string()),
        Err(_) => return Err("device_offline".to_string()),
    };
    let Some(socket_id) = online
        .get("socket_id")
        .filter(|value| python_truthy(value))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|socket_id| !socket_id.is_empty())
    else {
        return Err("runtime_route_missing".to_string());
    };
    if !runtime_instance_matches(&identity.runtime_instance_id, &online) {
        return Err("runtime_route_missing".to_string());
    }
    // `remote_control_is_enabled`: App devices keep their privileged controls
    // private.
    if !remote_control_is_enabled(identity.device_type) {
        return Err("remote_control_disabled".to_string());
    }

    let result = call_runtime_tasks_list(state, user_id, socket_id).await?;
    let mut result = match result {
        Value::Object(object) => object,
        _ => return Err("runtime_rpc_invalid_response".to_string()),
    };
    project_response_device_ids(
        &mut result,
        &identity.runtime_device_id,
        &identity.logical_device_id,
    );
    project_workspaces(device.device_id(), &result)
}

/// `runtime_rpc_service.call(method="runtime.tasks.list")`: register the
/// callback waiter, publish the adapter emit, and await the acknowledgement.
async fn call_runtime_tasks_list(
    state: &AppState,
    user_id: i64,
    socket_id: &str,
) -> Result<Value, String> {
    call_runtime_method(
        state,
        user_id,
        socket_id,
        RUNTIME_TASKS_LIST_METHOD,
        Value::Object(Map::new()),
        RUNTIME_LIST_TIMEOUT_SECONDS,
    )
    .await
    .map_err(|error| {
        tracing::warn!(%error, user_id, "runtime work RPC failed");
        match error {
            RuntimeCallError::Decode => "runtime_rpc_invalid_response".to_string(),
            RuntimeCallError::Unavailable(_) => "socketio_rpc_unavailable".to_string(),
            RuntimeCallError::Timeout | RuntimeCallError::Closed => {
                "runtime_rpc_failed".to_string()
            }
        }
    })
}

/// One failed runtime RPC round trip (`RuntimeRpcError` in the source).
#[derive(Debug)]
pub(crate) enum RuntimeCallError {
    /// The process subscriber, Redis client, or callback table is unavailable.
    Unavailable(String),
    /// `sio.call` expired without a device acknowledgement.
    Timeout,
    /// The subscription closed while the call was pending.
    Closed,
    /// The acknowledgement was not a readable `runtime:rpc` result.
    Decode,
}

impl std::fmt::Display for RuntimeCallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(formatter, "{reason}"),
            Self::Timeout => write!(formatter, "runtime rpc timed out"),
            Self::Closed => write!(formatter, "runtime rpc connection closed"),
            Self::Decode => write!(formatter, "runtime rpc returned an unreadable payload"),
        }
    }
}

/// `runtime_rpc_service.call`: register the callback waiter, publish the
/// adapter emit for one `runtime:rpc` method, and await the acknowledgement.
///
/// The caller owns the method-specific timeout; the source's
/// `SOCKET_ACK_GRACE_SECONDS` is added to the `sio.call` budget.
pub(crate) async fn call_runtime_method(
    state: &AppState,
    user_id: i64,
    socket_id: &str,
    method: &str,
    payload: Value,
    timeout_seconds: u64,
) -> Result<Value, RuntimeCallError> {
    let Some(rpc) = state.socketio_rpc.as_ref() else {
        return Err(RuntimeCallError::Unavailable(
            "socketio_rpc_unavailable".to_string(),
        ));
    };
    let Some(redis) = state.redis.as_ref() else {
        return Err(RuntimeCallError::Unavailable(
            "socketio_rpc_unavailable".to_string(),
        ));
    };
    let call = rpc
        .begin(socket_id, LOCAL_EXECUTOR_NAMESPACE)
        .map_err(|error| {
            tracing::warn!(%error, user_id, method, "runtime RPC callback registration failed");
            RuntimeCallError::Unavailable("socketio_rpc_unavailable".to_string())
        })?;
    let mut request = Map::new();
    request.insert("method".to_string(), Value::String(method.to_string()));
    request.insert("payload".to_string(), payload);
    let data = python_dumps(&Value::Array(vec![Value::Object(request)]));
    let message = emit_message_with_callback(
        RUNTIME_RPC_EVENT,
        &data,
        LOCAL_EXECUTOR_NAMESPACE,
        socket_id,
        Some((socket_id, call.id())),
    );
    if let Err(error) = redis.publish(SOCKETIO_CHANNEL, message).await {
        tracing::warn!(%error, user_id, method, "runtime RPC publish failed");
        return Err(RuntimeCallError::Unavailable(
            "socketio_rpc_unavailable".to_string(),
        ));
    }
    let deadline = timeout_seconds + SOCKET_ACK_GRACE_SECONDS;
    match call.wait(Duration::from_secs(deadline)).await {
        Ok(args) => {
            decode_runtime_rpc_response(ack_argument(args)).map_err(|_| RuntimeCallError::Decode)
        }
        Err(crate::socketio_rpc::RpcError::Timeout) => Err(RuntimeCallError::Timeout),
        Err(error) => {
            tracing::warn!(%error, user_id, method, "runtime RPC failed");
            Err(RuntimeCallError::Closed)
        }
    }
}

/// `sio.call`'s return value: the single positional ack argument.
fn ack_argument(args: Value) -> Value {
    match args {
        Value::Array(mut items) if items.len() == 1 => items.remove(0),
        other => other,
    }
}

/// `RuntimeRpcService._decode_response`: a large executor response may be
/// carried as the `gzip+base64+json` envelope.
fn decode_runtime_rpc_response(result: Value) -> Result<Value, String> {
    let Some(object) = result.as_object() else {
        return Ok(result);
    };
    if object.get(RUNTIME_RPC_ENCODING_KEY).and_then(Value::as_str)
        != Some(RUNTIME_RPC_COMPRESSED_ENCODING)
    {
        return Ok(result);
    }
    let Some(payload) = object.get("payload").and_then(Value::as_str) else {
        return Err("runtime_rpc_invalid_response".to_string());
    };
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|error| {
            tracing::warn!(%error, "runtime work RPC payload decode failed");
            "runtime_rpc_invalid_response".to_string()
        })?;
    let mut decoded = String::new();
    flate2::read::MultiGzDecoder::new(compressed.as_slice())
        .read_to_string(&mut decoded)
        .map_err(|error| {
            tracing::warn!(%error, "runtime work RPC payload decompression failed");
            "runtime_rpc_invalid_response".to_string()
        })?;
    serde_json::from_str(&decoded).map_err(|error| {
        tracing::warn!(%error, "runtime work RPC payload JSON decode failed");
        "runtime_rpc_invalid_response".to_string()
    })
}

/// `_project_response_device_ids` for non-worktree methods: only the top-level
/// device identity is normalized to the logical id.
fn project_response_device_ids(
    result: &mut Map<String, Value>,
    runtime_device_id: &str,
    logical_device_id: &str,
) {
    for key in ["deviceId", "device_id"] {
        if result.get(key).and_then(Value::as_str) == Some(runtime_device_id) {
            result.insert(
                key.to_string(),
                Value::String(logical_device_id.to_string()),
            );
        }
    }
}

/// `RuntimeRouteResolver.resolve`'s stale-installation guard.
pub(crate) fn runtime_instance_matches(
    expected: &Option<String>,
    online: &Map<String, Value>,
) -> bool {
    let Some(expected) = expected.as_deref() else {
        return true;
    };
    let reported = match online.get("runtime_instance_id") {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(value) if python_truthy(value) => {
            crate::device_commands::python_str(value).trim().to_string()
        }
        _ => String::new(),
    };
    !reported.is_empty() && reported == expected
}

/// `remote_control_is_enabled`.
pub(crate) fn remote_control_is_enabled(device_type: RouteDeviceType) -> bool {
    device_type != RouteDeviceType::App
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work_projection::{
        LocalTaskSummary, iter_runtime_workspaces, local_task_summary, normalize_workspace_path,
        runtime_task_kind_fields, runtime_workspace_kind_fields, task_workspace_path,
    };
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    fn task(value: Value) -> LocalTaskSummary {
        local_task_summary(&map(value), "/work/project").expect("task validates")
    }

    #[test]
    fn normalize_workspace_path_matches_the_source() {
        assert_eq!(
            normalize_workspace_path(" /a/b/ "),
            Some("/a/b".to_string())
        );
        assert_eq!(normalize_workspace_path("/"), Some("/".to_string()));
        assert_eq!(normalize_workspace_path("///"), Some("/".to_string()));
        assert_eq!(normalize_workspace_path("   "), None);
    }

    #[test]
    fn kind_fields_derive_from_the_processed_path() {
        assert_eq!(
            runtime_workspace_kind_fields("/home/.wegent-executor/workspace/chats"),
            ("chat".to_string(), None)
        );
        assert_eq!(
            runtime_workspace_kind_fields("/home/worktrees/enable-test/wegent"),
            ("worktree".to_string(), Some("enable-test".to_string()))
        );
        assert_eq!(
            runtime_workspace_kind_fields("/home/wegent"),
            ("workspace".to_string(), None)
        );
        // A worktree token must be a plain path segment.
        assert_eq!(
            runtime_workspace_kind_fields("/home/worktrees/bad id/wegent"),
            ("workspace".to_string(), None)
        );
    }

    #[test]
    fn task_kind_fields_prefer_the_reported_kind() {
        let object = map(json!({
            "workspaceKind": "worktree",
            "worktreeId": " wt-1 ",
        }));
        assert_eq!(
            runtime_task_kind_fields(&object, "/home/wegent"),
            ("worktree".to_string(), Some("wt-1".to_string()))
        );
        let chat = map(json!({"workspaceKind": "chat", "worktreeId": "ignored"}));
        assert_eq!(
            runtime_task_kind_fields(&chat, "/home/wegent"),
            ("chat".to_string(), None)
        );
        let fallback = map(json!({"workspaceKind": "unknown"}));
        assert_eq!(
            runtime_task_kind_fields(&fallback, "/home/worktrees/wt/wegent"),
            ("worktree".to_string(), Some("wt".to_string()))
        );
    }

    #[test]
    fn task_projection_copies_model_selection_from_the_runtime_handle() {
        let summary = task(json!({
            "taskId": "runtime-1",
            "title": "title",
            "runtime": "codex",
            "runtimeHandle": {"modelSelection": {"modelName": "gpt", "modelType": "runtime"}},
            "extra": "ignored",
        }));
        let value = crate::json_contract_tests::serialized(summary).unwrap();
        assert_eq!(value["taskId"], "runtime-1");
        assert_eq!(value["modelSelection"]["modelName"], "gpt");
        assert_eq!(value["modelSelection"]["options"], json!({}));
        assert!(value.get("runtimeHandle").is_none());
        assert!(value.get("extra").is_none());
        assert_eq!(value["workspacePath"], "/work/project");
        assert_eq!(value["workspaceKind"], "workspace");
        assert_eq!(value["children"], json!([]));
        assert_eq!(value["running"], false);
    }

    #[test]
    fn task_projection_rejects_invalid_contract_values() {
        assert!(local_task_summary(&map(json!({"title": "t", "runtime": "codex"})), "/p").is_err());
        assert!(
            local_task_summary(
                &map(json!({"taskId": "1", "title": "t", "runtime": "other"})),
                "/p"
            )
            .is_err()
        );
        assert!(
            local_task_summary(
                &map(json!({"taskId": "1", "title": "t", "runtime": "codex", "queuePosition": 0})),
                "/p"
            )
            .is_err()
        );
        assert!(
            local_task_summary(
                &map(
                    json!({"taskId": "1", "title": "t", "runtime": "codex", "modelSelection": {}})
                ),
                "/p"
            )
            .is_err()
        );
    }

    #[test]
    fn task_workspace_path_prefers_the_task_reported_path() {
        let object = map(json!({"workspacePath": "/task/path/"}));
        assert_eq!(
            task_workspace_path(&object, "/workspace").unwrap(),
            "/task/path"
        );
        let object = map(json!({"workspacePath": ""}));
        assert_eq!(
            task_workspace_path(&object, "/workspace").unwrap(),
            "/workspace"
        );
        let object = map(json!({"workspacePath": "   "}));
        assert!(task_workspace_path(&object, "/workspace").is_err());
    }

    #[test]
    fn workspace_iteration_skips_malformed_entries() {
        let result = map(json!({
            "workspaces": [
                {"workspacePath": " /a ", "tasks": [], "label": " a ", "workspaceSource": " LOCAL "},
                {"workspacePath": "", "tasks": []},
                {"workspacePath": "/b"},
                {"tasks": []},
                "ignored",
            ],
        }));
        let workspaces = iter_runtime_workspaces(&result);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].workspace_path, " /a ");
        assert_eq!(workspaces[0].label.as_deref(), Some("a"));
        assert_eq!(workspaces[0].workspace_source.as_deref(), Some("local"));
    }

    #[test]
    fn ack_argument_unwraps_a_single_positional_value() {
        assert_eq!(
            ack_argument(json!([{"success": true}])),
            json!({"success": true})
        );
        assert_eq!(ack_argument(json!([])), json!([]));
    }

    #[test]
    fn compressed_rpc_responses_are_decompressed() {
        let payload = json!({"success": true, "workspaces": []});
        let raw = serde_json::to_vec(&payload).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, &raw).unwrap();
        let compressed = encoder.finish().unwrap();
        let envelope = json!({
            "__runtimeRpcEncoding": "gzip+base64+json",
            "payload": base64::engine::general_purpose::STANDARD.encode(compressed),
        });
        assert_eq!(decode_runtime_rpc_response(envelope).unwrap(), payload);
    }

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/runtime-work"
                    && rule.methods.iter().any(|method| method == "GET")),
            "GET /api/runtime-work must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/runtime-work"));
        assert!(!table.matches(&http::Method::GET, "/api/runtime-work/other"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/runtime-work" && route.methods & GET != 0);
        assert!(registered, "GET /api/runtime-work must be registered");
    }
}
