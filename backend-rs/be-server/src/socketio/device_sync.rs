// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Registration-time device follow-up work.
//!
//! Source: `app/api/ws/device_namespace.py::
//! _sync_global_capabilities_to_registered_device` (`register` ACK first, then
//! a best-effort background sync). The source schedules it on the event loop;
//! this module runs it on one long-lived bounded worker started with the
//! Socket.IO service, so a registration never spawns detached work.
//!
//! The dispatch half mirrors `AsyncPubSubManager.emit`: the adapter message is
//! published for the other workers while the local `EventEmitter` delivers to
//! the socket and waits for the executor's ACK.

use std::sync::Arc;
use std::time::Duration;

use brz_socket_io::{AckError, EmitterError, SocketError};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::json_compat::python_json_value;
use crate::shutdown_state::ShutdownState;
use crate::state::AppState;
use wegent_plugin_runtime::{
    CapabilityDispatch, DispatchOutcome, PluginPreparation, has_pending_removals,
    prepare_plugins_for_registered_device, record_registration_sync_result,
    sync_registration_capabilities,
};

use super::runtime::{CallbackIds, DeviceJob, SocketEmitters};

/// `SYNC_EVENT`.
const SYNC_EVENT: &str = "device:sync_capabilities";
/// `SYNC_NAMESPACE`.
const SYNC_NAMESPACE: &str = "/local-executor";

/// The worker loop. Runs until the queue closes or the process shuts down.
pub(crate) async fn run_worker(
    jobs: mpsc::Receiver<DeviceJob>,
    state: Arc<AppState>,
    emitters: Arc<SocketEmitters>,
    callbacks: Arc<CallbackIds>,
) {
    run_jobs(jobs, state, emitters, callbacks).await;
}

/// The heartbeat's `sync_pending_plugin_removals` drain.
///
/// Source `device_namespace.py:2191` schedules it with
/// `_schedule_background_task`, independently of the registration capability
/// sync scheduled at `:1815`; a registration parked on the device's remote ACK
/// must not delay its `plugin_device_installations` scan. The dedicated queue
/// keeps the two classes independent, and each job still runs as its own
/// bounded in-flight task like the source's background task.
pub(crate) async fn run_plugin_removal_worker(
    jobs: mpsc::Receiver<DeviceJob>,
    state: Arc<AppState>,
    emitters: Arc<SocketEmitters>,
    callbacks: Arc<CallbackIds>,
) {
    run_jobs(jobs, state, emitters, callbacks).await;
}

/// The most jobs one queue keeps in flight at once. A registration sync can
/// wait out the source's 120 s callback deadline, so independent devices must
/// not queue behind it; the bound keeps the worker's memory and shutdown
/// latency finite.
const MAX_IN_FLIGHT_JOBS: usize = 64;

/// One job consumer. Each queue carries one job class; every job runs as its
/// own in-flight task, matching the source's `_schedule_background_task` per
/// event, with bounded admission. Dropping the `JoinSet` on shutdown cancels
/// every remaining task.
async fn run_jobs(
    mut jobs: mpsc::Receiver<DeviceJob>,
    state: Arc<AppState>,
    emitters: Arc<SocketEmitters>,
    callbacks: Arc<CallbackIds>,
) {
    let mut in_flight: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    loop {
        let job = tokio::select! {
            // A full set must not pull another item: the receive branch stays
            // disabled until a task finishes, so the completion and shutdown
            // branches are always reachable.
            job = jobs.recv(), if in_flight.len() < MAX_IN_FLIGHT_JOBS => job,
            finished = in_flight.join_next(), if !in_flight.is_empty() => {
                if let Some(Err(error)) = finished
                    && !error.is_cancelled()
                {
                    tracing::warn!(%error, "device background job failed");
                }
                continue;
            }
            () = tokio::time::sleep(Duration::from_secs(1)) => {
                if state.shutdown.is_shutting_down() {
                    in_flight.shutdown().await;
                    return;
                }
                continue;
            }
        };
        let Some(job) = job else {
            in_flight.shutdown().await;
            return;
        };
        if state.shutdown.is_shutting_down() {
            in_flight.shutdown().await;
            return;
        }
        let state = Arc::clone(&state);
        let emitters = Arc::clone(&emitters);
        let callbacks = Arc::clone(&callbacks);
        in_flight.spawn(async move {
            match job {
                DeviceJob::RegisterSync { user_id, device_id } => {
                    reconcile_device_capabilities(
                        &state, &emitters, &callbacks, user_id, device_id,
                    )
                    .await;
                }
                DeviceJob::PluginRemoval { user_id, device_id } => {
                    if has_pending_removals(&state.plugin_runtime_state(), user_id, &device_id)
                        .await
                    {
                        // The authoritative snapshot removes inactive plugins and records
                        // the device's acknowledgement using the existing sync protocol.
                        reconcile_device_capabilities(
                            &state, &emitters, &callbacks, user_id, device_id,
                        )
                        .await;
                    }
                }
            }
        });
    }
}

/// Reconcile a newly registered device or one with a persisted plugin removal.
async fn reconcile_device_capabilities(
    state: &AppState,
    emitters: &SocketEmitters,
    callbacks: &CallbackIds,
    user_id: i64,
    device_id: String,
) {
    let plugins = state.plugin_runtime_state();
    let include_plugins =
        match prepare_plugins_for_registered_device(&plugins, user_id, &device_id).await {
            PluginPreparation::Ready => true,
            PluginPreparation::Deferred => false,
            PluginPreparation::Failed => return,
        };
    let dispatch = LocalDispatch {
        state,
        emitters,
        callbacks,
    };
    let Some(result) =
        sync_registration_capabilities(&plugins, user_id, &device_id, include_plugins, &dispatch)
            .await
    else {
        return;
    };
    if !result.success {
        tracing::warn!(
            user_id,
            device_id,
            error = result.error,
            "device capability reconciliation failed"
        );
    }
    if include_plugins {
        record_registration_sync_result(&plugins, user_id, &result).await;
    }
}

/// The registration path's local socket plus adapter publish.
struct LocalDispatch<'a> {
    state: &'a AppState,
    emitters: &'a SocketEmitters,
    callbacks: &'a CallbackIds,
}

#[async_trait::async_trait]
impl CapabilityDispatch for LocalDispatch<'_> {
    async fn dispatch(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> DispatchOutcome {
        let callback_id = self.callbacks.next(socket_id);
        if !publish_sync_call(self.state, socket_id, callback_id, payload).await {
            return DispatchOutcome::Failure("Socket.IO Redis adapter is unavailable");
        }
        // `sio.call(..., timeout=120)` starts its callback waiter before the
        // emit and keeps it until the configured deadline, even when the
        // socket is already closed or this process has no local receiver.
        let deadline = tokio::time::Instant::now() + timeout;
        // The adapter frame above is the only send when the client has already
        // left: the source has no local receiver, so nothing is delivered to
        // the socket and the call merely awaits its remote callback.
        if !self.emitters.has_local_executor_socket(socket_id) {
            return match wait_for_deadline(deadline, &self.state.shutdown).await {
                DeadlineWait::Expired => DispatchOutcome::Failure(""),
                DeadlineWait::Cancelled => DispatchOutcome::Cancelled,
            };
        }
        match self
            .emitters
            .call_sync_capabilities(socket_id, payload, timeout)
            .await
        {
            Ok(args) => DispatchOutcome::Ack(args),
            // socketioxide reports `Timeout`/`SocketClosed` immediately when
            // the waiter disappears; the source still waits out its deadline.
            Err(error) if missing_ack(&error) => {
                match wait_for_deadline(deadline, &self.state.shutdown).await {
                    // A real expiry keeps the source's failure/persistence.
                    DeadlineWait::Expired => DispatchOutcome::Failure(emitter_error_text(&error)),
                    // Shutdown cancels the pending call: the source never
                    // produces a result, so nothing may be persisted.
                    DeadlineWait::Cancelled => DispatchOutcome::Cancelled,
                }
            }
            Err(error) => DispatchOutcome::Failure(emitter_error_text(&error)),
        }
    }
}

/// Why the pending callback wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeadlineWait {
    /// The source's configured ACK timeout expired.
    Expired,
    /// The process began shutting down; the source's task was cancelled.
    Cancelled,
}

/// An ACK result that means the source would keep waiting rather than fail
/// immediately: a closed socket or a missing local ACK waiter.
fn missing_ack(error: &EmitterError) -> bool {
    matches!(
        error,
        EmitterError::Ack(AckError::Timeout)
            | EmitterError::Ack(AckError::Socket(SocketError::Closed))
    )
}

/// Wait out the source's ACK deadline, polling the shutdown flag at most once
/// per second so a graceful stop is not blocked for the full timeout.
async fn wait_for_deadline(
    deadline: tokio::time::Instant,
    shutdown: &ShutdownState,
) -> DeadlineWait {
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return DeadlineWait::Expired;
        }
        if shutdown.is_shutting_down() {
            return DeadlineWait::Cancelled;
        }
        let step = (deadline - now).min(Duration::from_secs(1));
        tokio::time::sleep(step).await;
    }
}

/// `AsyncPubSubManager.emit`'s Redis half for one `sio.call`.
async fn publish_sync_call(
    state: &AppState,
    socket_id: &str,
    callback_id: u64,
    payload: &Value,
) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        return false;
    };
    use brz_redis::Redis as _;
    let data = python_json_value(&Value::Array(vec![payload.clone()]));
    let message = crate::socketio_emit::emit_message_with_callback(
        SYNC_EVENT,
        &data,
        SYNC_NAMESPACE,
        socket_id,
        Some((socket_id, callback_id)),
    );
    match redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "registration capability adapter publish failed");
            false
        }
    }
}

/// `str(exc)` for the mapped dispatch failure, matching the Redis-RPC path.
///
/// A socket that closed while the capability sync was still pending has no
/// recorded Source exception text: the recording's loaded
/// `plugin_device_installations.error_message` is the empty string and the
/// failure UPDATE omits the column, which only happens when SQLAlchemy's dirty
/// flush sees an assigned value equal to the loaded one. The inference is
/// therefore that Source's `str(exc)` for that disconnect was empty, not a
/// directly observed value. Only [`SocketError::Closed`] takes that mapping;
/// every other acknowledgement error keeps its current text.
fn emitter_error_text(error: &EmitterError) -> &'static str {
    match error {
        EmitterError::Ack(brz_socket_io::AckError::Timeout) => "",
        EmitterError::Ack(brz_socket_io::AckError::Socket(brz_socket_io::SocketError::Closed)) => {
            ""
        }
        EmitterError::Namespace(_) => "namespace is unavailable",
        EmitterError::InvalidTimeout => "invalid timeout",
        EmitterError::Broadcast(_) | EmitterError::Publish(_) => {
            "Socket.IO Redis adapter is unavailable"
        }
        EmitterError::Ack(_) => "connection closed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_failures_keep_the_source_text() {
        assert_eq!(
            emitter_error_text(&EmitterError::Namespace("/local-executor")),
            "namespace is unavailable"
        );
        assert_eq!(
            emitter_error_text(&EmitterError::InvalidTimeout),
            "invalid timeout"
        );
    }

    /// A socket closed while the capability sync was pending leaves the
    /// recorded `error_message` clean: Source's own text was empty, so the
    /// failed desired-install update must not dirty the column.
    #[test]
    fn a_socket_closed_ack_has_no_error_text() {
        assert_eq!(
            emitter_error_text(&EmitterError::Ack(brz_socket_io::AckError::Socket(
                brz_socket_io::SocketError::Closed
            ))),
            ""
        );
        assert_eq!(
            emitter_error_text(&EmitterError::Ack(brz_socket_io::AckError::Timeout)),
            ""
        );
    }

    /// Only the closed-socket acknowledgement is flattened; the rest of the
    /// acknowledgement class keeps its existing text.
    #[test]
    fn other_ack_errors_keep_their_text() {
        assert_eq!(
            emitter_error_text(&EmitterError::Ack(brz_socket_io::AckError::Socket(
                brz_socket_io::SocketError::InternalChannelFull
            ))),
            "connection closed"
        );
    }

    /// A closed socket and a missing local ACK waiter both keep the source's
    /// callback waiter alive; every other error is classified immediately.
    #[test]
    fn only_closed_and_missing_acks_wait_for_the_deadline() {
        assert!(missing_ack(&EmitterError::Ack(AckError::Timeout)));
        assert!(missing_ack(&EmitterError::Ack(AckError::Socket(
            SocketError::Closed
        ))));
        assert!(!missing_ack(&EmitterError::Ack(AckError::Socket(
            SocketError::InternalChannelFull
        ))));
        assert!(!missing_ack(&EmitterError::Namespace("/local-executor")));
        assert!(!missing_ack(&EmitterError::InvalidTimeout));
    }

    #[tokio::test]
    async fn a_disconnected_socket_waits_out_its_short_deadline() {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(40);
        let start = tokio::time::Instant::now();
        assert_eq!(
            wait_for_deadline(deadline, &ShutdownState::default()).await,
            DeadlineWait::Expired
        );
        assert!(start.elapsed() >= Duration::from_millis(40));
    }

    #[tokio::test]
    async fn an_already_elapsed_deadline_returns_immediately() {
        let start = tokio::time::Instant::now();
        assert_eq!(
            wait_for_deadline(start, &ShutdownState::default()).await,
            DeadlineWait::Expired
        );
        assert!(start.elapsed() < Duration::from_millis(20));
    }

    #[tokio::test]
    async fn shutdown_releases_the_deadline_wait() {
        let shutdown = ShutdownState::default();
        shutdown.initiate();
        let start = tokio::time::Instant::now();
        assert_eq!(
            wait_for_deadline(start + Duration::from_secs(60), &shutdown).await,
            DeadlineWait::Cancelled
        );
        assert!(start.elapsed() < Duration::from_millis(20));
    }
}
