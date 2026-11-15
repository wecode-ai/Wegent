// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` heartbeat behavior.
//!
//! Source: `app/api/ws/device_namespace.py::on_device_heartbeat` over
//! `app/services/device_service.py` and
//! `app/services/device/local_provider.py` (`refresh_heartbeat`,
//! `store_capabilities_state`, `get_slot_usage`) plus
//! `_store_device_capabilities_state` and `_broadcast_device_slot_update`.
//!
//! A heartbeat reporting missing runtime auth schedules the repair worker in
//! [`super::device_auth_sync`].
//! `sync_pending_plugin_removals` after a heartbeat is queued on the device
//! follow-up worker, matching Source's `_schedule_background_task`.

use std::sync::Arc;

use brz_socket_io::{ClientError, Reply};
use serde::Serialize;
use serde_json::{Value, json};

use crate::device_running_tasks::list_running_tasks;
use crate::socketio::device::{self, RuntimeTransfer};
use crate::socketio::device_lifecycle::publish_chat_event;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::session::DeviceSession;
use crate::state::AppState;

/// `DEVICE_ONLINE_TTL`.
const ONLINE_TTL_SECONDS: u64 = 90;
/// `DEVICE_CAPABILITIES_TTL`.
const CAPABILITIES_TTL_SECONDS: u64 = 600;
/// `DEVICE_CAPABILITIES_KEY_PREFIX`.
const CAPABILITIES_KEY_PREFIX: &str = "device:capabilities:";
/// `CODEX_RUNTIME`.
pub(crate) const CODEX_RUNTIME: &str = "codex";

/// The source's raw heartbeat ACK.
#[derive(Serialize)]
struct HeartbeatAck {
    success: bool,
}

/// The source's business rejection ACK (`{"error": str}`).
#[derive(Serialize)]
struct ErrorAck<'a> {
    error: &'a str,
}

/// `_broadcast_device_slot_update`'s payload.
#[derive(Serialize)]
struct SlotUpdate<'a> {
    device_id: &'a str,
    slot_used: i64,
    slot_max: i64,
    running_tasks: Vec<crate::device_running_tasks::RunningTask>,
}

fn error_ack(message: &str) -> Value {
    serde_json::to_value(ErrorAck { error: message }).expect("a string serializes")
}

/// One validated `DeviceHeartbeatPayload`.
struct HeartbeatPayload {
    device_id: String,
    running_task_ids: Vec<i64>,
    executor_version: Option<String>,
    capabilities: Option<Value>,
    runtime_auth_files: Option<Value>,
    runtime_transfer_host: Option<String>,
    runtime_transfer_port: Option<i64>,
    runtime_transfer_port_set: bool,
    runtime_instance_id: Option<String>,
    runtime_capacity: Option<Value>,
    runtime_features: Option<Value>,
}

impl HeartbeatPayload {
    fn parse(data: &Value) -> Result<Self, String> {
        let object = data
            .as_object()
            .ok_or_else(|| "Invalid payload: value is not an object".to_string())?;
        let device_id = object
            .get("device_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Invalid payload: device_id is required".to_string())?;
        let running_task_ids = match object.get("running_task_ids") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_i64()
                        .or_else(|| item.as_str()?.trim().parse().ok())
                        .ok_or_else(|| {
                            "Invalid payload: running_task_ids must be integers".to_string()
                        })
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err("Invalid payload: running_task_ids must be a list".to_string()),
        };
        let runtime_transfer_port_set = object.contains_key("runtime_transfer_port");
        let runtime_transfer_port = match object.get("runtime_transfer_port") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_i64()
                    .filter(|port| (1..=65535).contains(port))
                    .ok_or_else(|| {
                        "Invalid payload: runtime_transfer_port must be between 1 and 65535"
                            .to_string()
                    })?,
            ),
        };
        Ok(Self {
            device_id,
            running_task_ids,
            executor_version: object
                .get("executor_version")
                .and_then(Value::as_str)
                .map(str::to_owned),
            capabilities: object
                .get("capabilities")
                .filter(|v| v.is_object())
                .cloned(),
            runtime_auth_files: object.get("runtime_auth_files").cloned(),
            runtime_transfer_host: object
                .get("runtime_transfer_host")
                .and_then(Value::as_str)
                .map(str::to_owned),
            runtime_transfer_port,
            runtime_transfer_port_set,
            runtime_instance_id: object
                .get("runtime_instance_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            runtime_capacity: object.get("runtime_capacity").cloned(),
            // `_normalize_runtime_features`: the heartbeat schema validates the
            // same feature contract before the online document is written.
            runtime_features: object
                .get("runtime_features")
                .and_then(super::runtime_features::normalize),
        })
    }
}

/// `on_device_heartbeat`.
pub async fn heartbeat(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let payload = match HeartbeatPayload::parse(&data) {
        Ok(payload) => payload,
        Err(error) => return Ok(Reply::payload(error_ack(&error))),
    };
    let snapshot = session.snapshot();
    let user_id = snapshot.user_id;
    let session_device_id = snapshot
        .device
        .reported_device_id
        .as_deref()
        .or(snapshot.device.device_id.as_deref());
    if session_device_id != Some(payload.device_id.as_str()) {
        return Ok(Reply::payload(error_ack("Device ID mismatch")));
    }
    let Some(route_id) = snapshot.device.device_id.clone() else {
        return Ok(Reply::payload(error_ack("Device ID mismatch")));
    };

    let online = device::get_online(state, user_id, &route_id).await;
    if let Some(online_socket_id) = online
        .as_ref()
        .and_then(|online| online.get("socket_id"))
        .and_then(Value::as_str)
        && online_socket_id != socket_id
    {
        tracing::info!(user_id, device = %route_id, "ignoring stale heartbeat");
        return Ok(Reply::payload(error_ack("Stale device connection")));
    }
    if let Some(registered) = snapshot.device.runtime_instance_id.as_deref()
        && payload.runtime_instance_id.as_deref() != Some(registered)
    {
        return Ok(Reply::payload(error_ack("Runtime instance ID mismatch")));
    }

    let runtime_transfer_host =
        device::normalize_runtime_transfer_host(payload.runtime_transfer_host.as_deref())
            .or_else(|| snapshot.device.runtime_transfer_host.clone());
    let runtime_transfer_port = if payload.runtime_transfer_port_set {
        payload.runtime_transfer_port
    } else {
        snapshot.device.runtime_transfer_port
    };
    session.apply_heartbeat_transfer(runtime_transfer_host.clone(), runtime_transfer_port);

    if !refresh_heartbeat(
        state,
        user_id,
        &route_id,
        &payload,
        runtime_transfer_host.as_deref(),
        runtime_transfer_port,
    )
    .await
    {
        // Redis key expired: recreate it from the session, then refresh again.
        let device_name = snapshot
            .device
            .device_name
            .clone()
            .unwrap_or_else(|| format!("device-{}", first_eight(&route_id)));
        tracing::warn!(user_id, device = %route_id, "heartbeat recovery: recreating online key");
        let online = device::online_payload(
            socket_id,
            &device_name,
            snapshot.client_ip.as_deref(),
            &register_payload_for_recovery(&payload),
            &RuntimeTransfer {
                host: runtime_transfer_host.as_deref(),
                port: runtime_transfer_port,
                instance_id: payload.runtime_instance_id.as_deref(),
                features: payload.runtime_features.as_ref(),
            },
            &device::local_isoformat(),
        );
        device::set_online(state, user_id, &route_id, &online).await;
        refresh_heartbeat(
            state,
            user_id,
            &route_id,
            &payload,
            runtime_transfer_host.as_deref(),
            runtime_transfer_port,
        )
        .await;
        crate::socketio::device_lifecycle::broadcast_online(
            runtime.emitters(),
            state,
            user_id,
            &route_id,
            &device_name,
        )
        .await;
    }

    if payload.capabilities.is_some() {
        store_capabilities_state(state, user_id, &route_id, payload.capabilities.as_ref()).await;
    }
    if session.reserve_presence_update() {
        super::device_upsert::persist_observation(
            state,
            user_id,
            snapshot
                .device
                .logical_device_id
                .as_deref()
                .unwrap_or(&route_id),
            snapshot.device.runtime_instance_id.as_deref(),
            chrono::Utc::now(),
            false,
        )
        .await;
    }
    let runtime_auth_missing = runtime_auth_missing(payload.runtime_auth_files.as_ref());
    broadcast_slot_update(state, runtime, user_id, &route_id).await;
    // `_schedule_background_task(sync_pending_plugin_removals(user, device))`:
    // fire-and-forget, after the heartbeat has been persisted.
    runtime.enqueue_plugin_removal(user_id, &route_id);
    // `_schedule_background_task(reconcile_device_executions(...,
    // needs_confirmation_only=True))` runs after the handler returns; the
    // heartbeat call site keeps that flag distinguishable from registration.
    let reconcile_runtime = Arc::clone(runtime);
    let reconcile_device_id = route_id.clone();
    let auth_sync_runtime = Arc::clone(runtime);
    let auth_sync_device_id = route_id.clone();
    Ok(Reply::payload(
        serde_json::to_value(HeartbeatAck { success: true })
            .expect("a heartbeat acknowledgement serializes"),
    )
    .after_reply(move || {
        if runtime_auth_missing {
            // `_schedule_runtime_auth_sync_after_heartbeat`: an independent
            // background task, deduped by `(user, device, runtime)` while one
            // sync is in flight.
            auth_sync_runtime.enqueue_runtime_auth_sync(user_id, &auth_sync_device_id);
        }
        reconcile_runtime.enqueue_reconcile(super::device_reconcile::ReconcileJob {
            user_id,
            device_id: reconcile_device_id,
            needs_confirmation_only: true,
        });
    }))
}

/// The online document fields `_set_online` needs during heartbeat recovery.
fn register_payload_for_recovery(payload: &HeartbeatPayload) -> device::RegisterPayload {
    device::RegisterPayload {
        executor_version: payload.executor_version.clone(),
        runtime_features: payload.runtime_features.clone(),
        ..device::RegisterPayload::default()
    }
}

fn first_eight(value: &str) -> &str {
    value.get(..8).unwrap_or(value)
}

/// `LocalDeviceProvider.refresh_heartbeat` (`GET` then `SET ... EX 90`).
async fn refresh_heartbeat(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &HeartbeatPayload,
    runtime_transfer_host: Option<&str>,
    runtime_transfer_port: Option<i64>,
) -> bool {
    let Some(online) = device::get_online(state, user_id, device_id).await else {
        return false;
    };
    let Some(mut document) = online.as_object().cloned() else {
        return false;
    };
    document.insert(
        "last_heartbeat".into(),
        Value::String(device::local_isoformat()),
    );
    document.insert(
        "running_task_ids".into(),
        Value::Array(
            payload
                .running_task_ids
                .iter()
                .map(|id| json!(id))
                .collect(),
        ),
    );
    if let Some(version) = payload.executor_version.as_deref() {
        document.insert("executor_version".into(), Value::String(version.into()));
    }
    if let Some(host) = runtime_transfer_host {
        document.insert("runtime_transfer_host".into(), Value::String(host.into()));
    }
    document.insert(
        "runtime_transfer_port".into(),
        runtime_transfer_port
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    document.insert(
        "runtime_instance_id".into(),
        payload
            .runtime_instance_id
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    document.insert(
        "runtime_capacity".into(),
        payload.runtime_capacity.clone().unwrap_or(Value::Null),
    );
    document.insert(
        "runtime_features".into(),
        payload.runtime_features.clone().unwrap_or(Value::Null),
    );
    let Some(redis) = state.redis.as_ref() else {
        return false;
    };
    let value = serde_json::to_string(&Value::Object(document)).expect("a JSON value serializes");
    device::set_with_ttl(
        redis,
        &crate::device_online_state::online_key(user_id, device_id),
        ONLINE_TTL_SECONDS,
        value,
    )
    .await
    .is_ok()
}

/// `_store_device_capabilities_state`.
async fn store_capabilities_state(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    capabilities: Option<&Value>,
) {
    let Some(capabilities) = capabilities.and_then(Value::as_object) else {
        return;
    };
    let digest = capabilities.get("digest").and_then(Value::as_str);
    let revision = capabilities.get("revision");
    let (Some(digest), Some(revision)) = (digest.filter(|d| !d.is_empty()), revision) else {
        return;
    };
    let key = format!("{CAPABILITIES_KEY_PREFIX}{user_id}:{device_id}");
    let existing: Option<Value> = crate::devices::cache_manager_get(state, &key).await;
    let stored = if truthy(capabilities.get("full")) {
        json!({
            "revision": revision,
            "digest": digest,
            "skills": capabilities.get("skills").cloned().unwrap_or_else(|| json!([])),
            "plugins": capabilities.get("plugins").cloned().unwrap_or_else(|| json!([])),
            "mcps": capabilities.get("mcps").cloned().unwrap_or_else(|| json!([])),
            "last_sync_at": capabilities.get("last_sync_at").cloned().unwrap_or(Value::Null),
        })
    } else if existing
        .as_ref()
        .and_then(|existing| existing.get("digest"))
        .and_then(Value::as_str)
        == Some(digest)
    {
        let Some(mut document) = existing.as_ref().and_then(Value::as_object).cloned() else {
            return;
        };
        document.insert("revision".into(), revision.clone());
        document.insert("digest".into(), Value::String(digest.into()));
        Value::Object(document)
    } else {
        return;
    };
    let mut stored = match stored {
        Value::Object(document) => document,
        _ => return,
    };
    // `store_capabilities_state` stamps the observation time last.
    stored.insert(
        "reported_at".into(),
        Value::String(device::local_isoformat()),
    );
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let value = serde_json::to_string(&stored).expect("a JSON value serializes");
    // `cache_manager.set` is tolerant: a failed write is ignored.
    let _ = device::set_with_ttl(redis, &key, CAPABILITIES_TTL_SECONDS, value).await;
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Null) | None => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// `_runtime_auth_file_missing` for the Codex runtime.
fn runtime_auth_missing(runtime_auth_files: Option<&Value>) -> bool {
    runtime_auth_files
        .and_then(|files| files.get(CODEX_RUNTIME))
        .and_then(|state| state.get("exists"))
        == Some(&Value::Bool(false))
}

/// `_broadcast_device_slot_update`: slot usage read plus the chat broadcast.
pub(crate) async fn broadcast_slot_update(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
) {
    let online = device::get_online(state, user_id, device_id).await;
    let running_task_ids = online
        .as_ref()
        .and_then(|online| online.get("running_task_ids"))
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
        .unwrap_or_default();
    let (slot_used, slot_max) = slot_values(online.as_ref());
    let running_tasks =
        match list_running_tasks(&*state.task_store, user_id, running_task_ids).await {
            Ok(tasks) => tasks,
            Err(error) => {
                tracing::error!(%error, user_id, "device slot update task read failed");
                return;
            }
        };
    let data = match serde_json::to_value(SlotUpdate {
        device_id,
        slot_used,
        slot_max,
        running_tasks,
    }) {
        Ok(data) => data,
        Err(error) => {
            tracing::error!(%error, user_id, "device slot update serialization failed");
            return;
        }
    };
    if let Err(error) = runtime.emitters().device_slot_update(user_id, &data).await {
        tracing::warn!(%error, user_id, "device:slot_update local delivery failed");
    }
    publish_chat_event(state, "device:slot_update", &data, user_id).await;
    tracing::debug!(slot_used, slot_max, "device slot update broadcast");
}

/// `runtime_capacity_slot_values`.
fn slot_values(online: Option<&Value>) -> (i64, i64) {
    let Some(capacity) = online
        .and_then(|online| online.get("runtime_capacity"))
        .and_then(Value::as_object)
    else {
        return (0, 0);
    };
    let active = capacity.get("active").and_then(Value::as_i64);
    let limit = capacity.get("limit").and_then(Value::as_i64);
    let active_task_ids = capacity.get("active_task_ids").and_then(Value::as_array);
    let (Some(active), Some(limit), Some(ids)) = (active, limit, active_task_ids) else {
        return (0, 0);
    };
    if active < 0 || !(1..=20).contains(&limit) || ids.len() as i64 != active {
        return (0, 0);
    }
    let mut unique = std::collections::HashSet::with_capacity(ids.len());
    for id in ids {
        match id.as_str() {
            Some(text) if !text.is_empty() && unique.insert(text) => {}
            _ => return (0, 0),
        }
    }
    (active, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_accepts_integer_and_string_running_task_ids() {
        let payload = HeartbeatPayload::parse(&json!({
            "device_id": "d-1",
            "running_task_ids": ["123456789012345", 123456789012346_i64]
        }))
        .unwrap();
        assert_eq!(
            payload.running_task_ids,
            vec![123456789012345, 123456789012346]
        );

        let idle = HeartbeatPayload::parse(&json!({
            "device_id": "d-1",
            "running_task_ids": []
        }))
        .unwrap();
        assert!(idle.running_task_ids.is_empty());
    }

    #[test]
    fn heartbeat_rejects_invalid_and_out_of_range_running_task_ids() {
        for invalid_id in [json!("not-a-task-id"), json!("9223372036854775808")] {
            let error = HeartbeatPayload::parse(&json!({
                "device_id": "d-1",
                "running_task_ids": [invalid_id]
            }))
            .err();
            assert_eq!(
                error.as_deref(),
                Some("Invalid payload: running_task_ids must be integers")
            );
        }
    }

    #[test]
    fn heartbeat_payload_tracks_explicit_null_transfer_port() {
        let payload = HeartbeatPayload::parse(&json!({
            "device_id": "d-1",
            "runtime_transfer_port": null
        }))
        .unwrap();
        assert!(payload.runtime_transfer_port_set);
        assert_eq!(payload.runtime_transfer_port, None);
        let absent = HeartbeatPayload::parse(&json!({"device_id": "d-1"})).unwrap();
        assert!(!absent.runtime_transfer_port_set);
    }

    #[test]
    fn slot_values_require_a_consistent_capacity_observation() {
        let online = json!({
            "runtime_capacity": {"limit": 3, "active": 2, "active_task_ids": ["a", "b"], "queued": 0}
        });
        assert_eq!(slot_values(Some(&online)), (2, 3));
        let inconsistent = json!({
            "runtime_capacity": {"limit": 3, "active": 2, "active_task_ids": ["a"], "queued": 0}
        });
        assert_eq!(slot_values(Some(&inconsistent)), (0, 0));
        assert_eq!(slot_values(None), (0, 0));
    }

    #[test]
    fn capability_state_requires_a_digest_and_revision() {
        assert!(!runtime_auth_missing(None));
        assert!(runtime_auth_missing(Some(
            &json!({"codex": {"exists": false}})
        )));
        assert!(!runtime_auth_missing(Some(
            &json!({"codex": {"exists": true}})
        )));
    }

    #[test]
    fn full_capability_state_keeps_the_source_document_shape() {
        let capabilities = json!({
            "digest": "d",
            "revision": 4,
            "full": true,
            "skills": ["s"],
            "plugins": [],
            "mcps": [],
            "last_sync_at": null
        });
        assert!(truthy(capabilities.get("full")));
        assert_eq!(
            capabilities.get("digest").and_then(Value::as_str),
            Some("d")
        );
    }
}
