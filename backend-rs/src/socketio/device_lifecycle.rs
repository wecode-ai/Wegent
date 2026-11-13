// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` registration and disconnect behavior.
//!
//! Source: `app/api/ws/device_namespace.py::on_device_register` /
//! `_register_device_session` and `on_disconnect`, over
//! `app/services/device_service.py` and
//! `app/services/device/local_provider.py`.
//!
//! Ported here: payload validation, the `workspace_runner` scope rejection,
//! cloud-device matching, the registration upsert plus its reconnect debounce,
//! session/room identity, the Redis online document, the `device:online`
//! broadcast, and the post-ACK capability-sync and execution-reconcile
//! hand-offs.
//!
//! The disconnect uses the strict `get_or_raise` online read, so a read or
//! document-type failure stops the cleanup before any explicit offline delete.

use std::sync::Arc;
use std::time::Duration;

use brz_socket_io::{ClientError, Reply};
use serde::Serialize;
use serde_json::{Value, json};

use crate::device_identity_lock::IdentityLock;
use crate::json_compat::python_json_value;
use crate::socketio::device::{self, DeviceType, RegisterPayload};
use crate::socketio::runtime::{DeviceJob, SocketEmitters, SocketRuntime};
use crate::socketio::session::{DeviceSession, RegistrationSession};
use crate::state::AppState;

/// `DEVICE_DISCONNECT_FAILURE_GRACE_SECONDS`.
const DISCONNECT_GRACE: Duration = Duration::from_secs(2);

/// The source's raw registration ACK (`_register_device_session`'s return).
///
/// Source `device_namespace.py:1840-1844` returns the reported `device_id` and
/// the canonical record-scoped `device_route_id` (`route_id`) alongside
/// `success`; recording `20261105033227` ACKs all ten successful registrations
/// with that third field.
#[derive(Serialize)]
struct RegisterAck<'a> {
    success: bool,
    device_id: &'a str,
    device_route_id: &'a str,
}

/// The source's business rejection ACK (`{"error": str}`).
#[derive(Serialize)]
struct ErrorAck<'a> {
    error: &'a str,
}

fn error_ack(message: &str) -> Value {
    serde_json::to_value(ErrorAck { error: message }).expect("a string serializes")
}

/// `on_device_register` -> `_register_device_session`.
pub async fn register(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let payload = match RegisterPayload::parse(&data) {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(Reply::payload(error_ack(&format!(
                "Invalid payload: {error}"
            ))));
        }
    };
    let snapshot = session.snapshot();
    if snapshot.auth_type == "workspace_runner"
        && (payload.device_id != snapshot.user_name || payload.device_type != DeviceType::Local)
    {
        return Ok(Reply::payload(error_ack(
            "Runner credential is scoped to its registered device",
        )));
    }
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!("device identity lock unavailable: no Redis service");
        return Ok(identity_lock_unavailable());
    };
    with_identity_lock(redis, snapshot.user_id, || {
        register_session(state, runtime, session, socket_id, payload)
    })
    .await
}

/// The source's unavailable ACK when the lock cannot be taken or released.
fn identity_lock_unavailable() -> Reply<Value> {
    Reply::payload(error_ack(
        "Device identity operation is temporarily unavailable; reconnect to retry",
    ))
}

/// Hold the shared identity lock across registration and online publication.
///
/// The body's error ACK is still produced under the lock, and the release
/// happens before the ACK is returned. Acquisition
/// exhaustion, a Redis failure, the 20 s body timeout and a failed release all
/// take the source's "temporarily unavailable" branch.
pub(super) async fn with_identity_lock<R, F, Fut>(
    redis: &R,
    user_id: i64,
    body: F,
) -> Result<Reply<Value>, ClientError>
where
    R: brz_redis::Redis,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Reply<Value>, ClientError>>,
{
    let lock = match IdentityLock::acquire(redis, user_id).await {
        Ok(Some(lock)) => lock,
        // `Lock.__aenter__` raises `LockError` (a `RedisError`) when the
        // blocking budget expires; `acquire` propagates a request failure.
        Ok(None) => {
            tracing::warn!(user_id, "device identity lock is held by another worker");
            return Ok(identity_lock_unavailable());
        }
        Err(error) => {
            tracing::error!(%error, user_id, "device identity lock acquisition failed");
            return Ok(identity_lock_unavailable());
        }
    };
    // `async with asyncio.timeout(20):` wraps only the session handler body.
    let outcome = tokio::time::timeout(
        crate::device_identity_lock::IDENTITY_LOCK_BODY_TIMEOUT,
        body(),
    )
    .await;
    // `Lock.__aexit__` releases before the body's outcome escapes; a release
    // failure is a `RedisError` and takes the source's unavailable branch.
    if let Err(error) = lock.release().await {
        tracing::warn!(%error, user_id, "device identity lock release failed");
        return Ok(identity_lock_unavailable());
    }
    match outcome {
        Ok(reply) => reply,
        Err(_) => {
            tracing::warn!(user_id, "device identity registration timed out");
            Ok(identity_lock_unavailable())
        }
    }
}

/// `_register_device_session`: the registration body (no identity lock).
async fn register_session(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
    payload: RegisterPayload,
) -> Result<Reply<Value>, ClientError> {
    let snapshot = session.snapshot();
    let user_id = snapshot.user_id;
    let client_ip = snapshot.client_ip.clone();
    let runtime_transfer_host = device::normalize_runtime_transfer_host(
        payload
            .runtime_transfer_host
            .as_deref()
            .or(payload.client_ip.as_deref()),
    );
    let runtime_transfer_port = payload.effective_transfer_port();

    let mut is_cloud_device = false;
    let mut route_id = payload.device_id.clone();
    let mut logical_device_id = None;
    let mut persisted_display_name = None;
    if payload.device_type == DeviceType::Cloud {
        match device::match_cloud_device(state, user_id, &payload, runtime_transfer_host.as_deref())
            .await
        {
            Ok(Some(row)) => {
                is_cloud_device = true;
                // Cloud registrations route by the executor's validated id.
                // Keep the Kind name for reads and writes to the owned record.
                let registered = device::registered(&row, &payload, true);
                route_id = registered.route_id;
                logical_device_id = Some(row.name);
                persisted_display_name = Some(registered.display_name);
            }
            Ok(None) => {}
            Err(mismatch) => {
                return Ok(Reply::payload(error_ack(&format!(
                    "Registration failed: {mismatch}"
                ))));
            }
        }
    }

    if !is_cloud_device {
        let fingerprint = registration_fingerprint(
            &payload,
            client_ip.as_deref(),
            runtime_transfer_host.as_deref(),
            runtime_transfer_port,
        );
        persisted_display_name =
            runtime.recent_display_name(user_id, &payload.device_id, &fingerprint);
        let requires_identity_check = state.unique_app_device_names
            || matches!(
                payload.device_type,
                DeviceType::App | DeviceType::Cloud | DeviceType::Remote
            );
        if persisted_display_name.is_none() || requires_identity_check {
            match device::upsert_device(
                state,
                user_id,
                &payload,
                runtime_transfer_host.as_deref(),
                client_ip.as_deref(),
            )
            .await
            {
                Ok(row) => {
                    // `upsert_device_crd` refreshes the committed row; the
                    // caller reads the fresh `displayName` (or name) and
                    // derives the route from it.
                    let registered = device::registered(&row, &payload, false);
                    route_id = registered.route_id.clone();
                    // `spec.displayName or payload.name`, without rewriting a
                    // non-empty stored value.
                    let display_name = row
                        .json
                        .get("spec")
                        .and_then(|spec| spec.get("displayName"))
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| payload.name.clone());
                    persisted_display_name = Some(display_name.clone());
                    runtime.remember_registration(
                        user_id,
                        &payload.device_id,
                        fingerprint,
                        display_name,
                    );
                }
                Err(error) => {
                    return Ok(Reply::payload(error_ack(&format!(
                        "Registration failed: {error}"
                    ))));
                }
            }
        }
    }

    let effective_device_name = persisted_display_name.unwrap_or_else(|| payload.name.clone());
    let execution_target_id = if payload.device_type == DeviceType::App {
        route_id.clone()
    } else {
        payload
            .app_device_id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| payload.device_id.clone())
    };
    let logical_device_id = logical_device_id.unwrap_or_else(|| route_id.clone());
    session.apply_registration(RegistrationSession {
        reported_device_id: payload.device_id.clone(),
        route_id: route_id.clone(),
        logical_device_id,
        device_name: effective_device_name.clone(),
        runtime_transfer_host: runtime_transfer_host.clone(),
        runtime_transfer_port,
        runtime_instance_id: payload.runtime_instance_id.clone(),
        app_device_id: payload.app_device_id.clone(),
        device_type: payload.device_type,
        execution_target_id: execution_target_id.clone(),
    });

    let last_heartbeat = device::local_isoformat();
    let online = device::online_payload(
        socket_id,
        &effective_device_name,
        snapshot.client_ip.as_deref(),
        &payload,
        &device::RuntimeTransfer {
            host: runtime_transfer_host.as_deref(),
            port: runtime_transfer_port,
            instance_id: payload.runtime_instance_id.as_deref(),
            features: payload.runtime_features.as_ref(),
        },
        &last_heartbeat,
    );
    // The source ignores this write's result; a stale online document is
    // repaired by the next heartbeat.
    device::set_online(state, user_id, &route_id, &online).await;

    broadcast_online(
        runtime.emitters(),
        state,
        user_id,
        &route_id,
        &effective_device_name,
    )
    .await;
    let ack = serde_json::to_value(RegisterAck {
        success: true,
        device_id: &payload.device_id,
        // `_register_device_session` returns the canonical record-scoped route
        // so the Runtime can address this exact installation even when
        // historical records share its name.
        device_route_id: &route_id,
    })
    .expect("a registration acknowledgement serializes");
    // Source `_schedule_background_task` runs the capability sync and then the
    // execution reconciliation before the handler returns its ACK
    // (`device_namespace.py:1815-1826`); `asyncio.create_task` does not depend
    // on ACK delivery. Scheduling them here, on the handler's guaranteed path,
    // reproduces that. Hanging them on `after_reply` instead would silently
    // drop them when the reply is applied after the socket closed, because
    // `complete_event` only runs those continuations for a completed reply
    // (`brz-socket-io business.rs:352-385`).
    enqueue_registration_follow_ups(runtime, user_id, &route_id);
    Ok(Reply::payload(ack)
        .join(format!("device:{user_id}:{route_id}"))
        .join(format!("execution-target:{user_id}:{execution_target_id}")))
}

/// `_schedule_background_task` after a successful registration: one capability
/// sync and one execution reconciliation, each on its own bounded queue.
///
/// The enqueue happens on the handler's guaranteed path rather than in
/// `after_reply`, because `brz-socket-io` only runs those continuations for a
/// reply that applied to a live session (`business.rs:352-385`), while Source
/// schedules them before the ACK is sent.
fn enqueue_registration_follow_ups(runtime: &Arc<SocketRuntime>, user_id: i64, route_id: &str) {
    runtime.enqueue(DeviceJob::RegisterSync {
        user_id,
        device_id: route_id.to_owned(),
    });
    // `reconcile_device_executions(...)` with the registration path's
    // `needs_confirmation_only=false`.
    runtime.enqueue_reconcile(super::device_reconcile::ReconcileJob {
        user_id,
        device_id: route_id.to_owned(),
        needs_confirmation_only: false,
    });
}

/// `DeviceRegistrationFingerprint` for the reconnect debounce.
fn registration_fingerprint(
    payload: &RegisterPayload,
    client_ip: Option<&str>,
    runtime_transfer_host: Option<&str>,
    runtime_transfer_port: Option<i64>,
) -> super::session::RegistrationFingerprint {
    super::session::RegistrationFingerprint {
        display_name: payload.name.trim().to_owned(),
        client_ip: client_ip.unwrap_or_default().trim().to_owned(),
        device_type: payload.device_type.value(),
        bind_shell: payload.bind_shell.value(),
        runtime_transfer_host: runtime_transfer_host.unwrap_or_default().trim().to_owned(),
        runtime_transfer_port,
        runtime_instance_id: payload
            .runtime_instance_id
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_owned(),
        app_device_id: payload
            .app_device_id
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_owned(),
    }
}

/// `_broadcast_device_online`: local delivery plus the adapter publish for
/// every other worker subscribed to the user's chat rooms.
pub async fn broadcast_online(
    emitters: &SocketEmitters,
    state: &AppState,
    user_id: i64,
    device_id: &str,
    name: &str,
) {
    let payload = json!({
        "device_id": device_id,
        "name": name,
        "status": "online",
    });
    if let Err(error) = emitters.device_online(user_id, &payload).await {
        tracing::warn!(%error, user_id, "device:online local delivery failed");
    }
    publish_chat_event(state, "device:online", &payload, user_id).await;
}

/// `_broadcast_device_offline`.
async fn broadcast_offline(
    emitters: &SocketEmitters,
    state: &AppState,
    user_id: i64,
    device_id: &str,
) {
    let payload = json!({ "device_id": device_id });
    if let Err(error) = emitters.device_offline(user_id, &payload).await {
        tracing::warn!(%error, user_id, "device:offline local delivery failed");
    }
    publish_chat_event(state, "device:offline", &payload, user_id).await;
}

/// `emit_chat_user_event`'s Redis-adapter half (`AsyncPubSubManager.emit` after
/// the local `_handle_emit`).
///
/// The local emit sends the payload as the event's single argument, while the
/// adapter message carries python-socketio's positional argument list
/// (`[payload]`).
pub async fn publish_chat_event(state: &AppState, event: &str, payload: &Value, user_id: i64) {
    for room in [format!("user:{user_id}"), format!("wework:user:{user_id}")] {
        publish_room_event(state, event, payload, super::runtime::CHAT_NAMESPACE, &room).await;
    }
}

/// `AsyncPubSubManager.emit`'s Redis half for one namespace room or socket id.
pub async fn publish_room_event(
    state: &AppState,
    event: &str,
    payload: &Value,
    namespace: &str,
    room: &str,
) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    use brz_redis::Redis as _;
    let data = python_json_value(&Value::Array(vec![payload.clone()]));
    let message = crate::socketio_emit::emit_message(event, &data, namespace, room);
    if let Err(error) = redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        tracing::error!(%error, event, namespace, room, "Socket.IO adapter publish failed");
    }
}

/// `on_disconnect`'s online-state gate.
///
/// The source reads `get_device_online_info` (a strict
/// `cache_manager.get_or_raise`) twice around
/// `DEVICE_DISCONNECT_FAILURE_GRACE_SECONDS`.
/// A transport, decode, or shape error aborts cleanup. A missing document
/// is a normal cache miss and permits the original disconnect flow.
async fn online_cleanup_permitted<R: brz_redis::Redis + ?Sized>(
    redis: &R,
    user_id: i64,
    device_id: &str,
    socket_id: &str,
) -> bool {
    let state = crate::device_online_state::read_online_state_with(redis, user_id, device_id)
        .await
        .and_then(|online| stale_online_state(online, socket_id));
    match state {
        Ok(stale) => !stale,
        Err(()) => {
            tracing::error!(
                user_id,
                device_id,
                "device online state could not be checked; disconnect cleanup skipped"
            );
            false
        }
    }
}

/// `online_socket_id = online_info.get("socket_id") if online_info else None`
/// followed by `if online_socket_id and online_socket_id != sid: return`.
///
/// `Err(())` is the source's `AttributeError` for a truthy non-dict document.
/// A falsy document, a missing/falsy `socket_id`, or a stored string equal to
/// the disconnecting session is not stale; any truthy value that is not the
/// same string (including a non-string) is.
fn stale_online_state(online: Option<Value>, socket_id: &str) -> Result<bool, ()> {
    let Some(online) = online else {
        return Ok(false);
    };
    if !crate::json_compat::python_truthy(&online) {
        return Ok(false);
    }
    let Value::Object(document) = online else {
        return Err(());
    };
    let Some(online_socket_id) = document.get("socket_id") else {
        return Ok(false);
    };
    if !crate::json_compat::python_truthy(online_socket_id) {
        return Ok(false);
    }
    Ok(match online_socket_id {
        Value::String(value) => value != socket_id,
        // A truthy non-string never equals the socket-id string.
        _ => true,
    })
}

/// `on_disconnect`.
pub async fn disconnect(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    session: &DeviceSession,
    socket_id: &str,
) {
    let snapshot = session.snapshot();
    let user_id = snapshot.user_id;
    let Some(device_id) = snapshot.device.device_id.clone() else {
        return;
    };

    let Some(redis) = state.redis.as_ref() else {
        // The source's `get_or_raise` raises without a cache client, so the
        // disconnect cleanup never reaches the delete.
        tracing::error!(
            user_id,
            device_id,
            "device online state unavailable: disconnect cleanup skipped"
        );
        return;
    };
    if !online_cleanup_permitted(redis, user_id, &device_id, socket_id).await {
        return;
    }
    // A replacement connection must be able to publish presence during grace.
    tokio::time::sleep(DISCONNECT_GRACE).await;
    if super::device_heartbeat::requires_current_app_binding(state, &snapshot) {
        let outcome = with_identity_lock(redis, user_id, || async {
            if online_cleanup_permitted(redis, user_id, &device_id, socket_id).await
                && matches!(
                    super::device_upsert::app_session_matches(state, &snapshot).await,
                    Ok(true)
                )
            {
                disconnect_registered(state, runtime, &snapshot, socket_id, &device_id).await;
            }
            Ok(Reply::payload(Value::Null))
        })
        .await;
        if let Err(error) = outcome {
            tracing::warn!(?error, user_id, "device disconnect failed");
        }
    } else if online_cleanup_permitted(redis, user_id, &device_id, socket_id).await {
        disconnect_registered(state, runtime, &snapshot, socket_id, &device_id).await;
    }
}

async fn disconnect_registered(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    snapshot: &super::session::SessionSnapshot,
    socket_id: &str,
    device_id: &str,
) {
    let user_id = snapshot.user_id;
    if let Some(online) = device::get_online(state, user_id, device_id).await
        && online["socket_id"] == socket_id
        && let Some(observed) = online["last_heartbeat"]
            .as_str()
            .and_then(crate::device_presence::parse_observed_time)
    {
        super::device_upsert::persist_observation(
            state,
            user_id,
            snapshot
                .device
                .logical_device_id
                .as_deref()
                .unwrap_or(device_id),
            snapshot.device.runtime_instance_id.as_deref(),
            observed,
            true,
        )
        .await;
    }
    if !device::clear_online(state, user_id, device_id).await {
        // `delete_or_raise` surfaces the failure to `on_disconnect`'s outer
        // handler, which skips the rest of the cleanup.
        return;
    }
    // `_handle_device_disconnect` fails the device's RUNNING subtasks and
    // their parent tasks; the per-subtask `chat:error` emissions follow the
    // committed database work, exactly like the source.
    let failed = super::device_disconnect::fail_running_subtasks(state, user_id, device_id).await;
    super::device_disconnect::emit_chat_errors(state, runtime, &failed).await;
    broadcast_offline(runtime.emitters(), state, user_id, device_id).await;
}

#[cfg(test)]
#[path = "device_lifecycle_tests.rs"]
mod tests;
