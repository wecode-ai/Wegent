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
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::json_compat::python_json_value;
use crate::plugins_installed::{
    CapabilityDispatch, DispatchOutcome, prepare_plugins_for_registered_device,
    record_registration_sync_result, sync_registration_capabilities,
};
use crate::shutdown_state::ShutdownState;
use crate::state::AppState;

use super::runtime::{CallbackIds, DeviceJob, RuntimeCallEvent, RuntimeRpcCall, SocketEmitters};

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
                    sync_after_register(&state, &emitters, &callbacks, user_id, device_id).await;
                }
                DeviceJob::PluginRemoval { user_id, device_id } => {
                    crate::plugins_installed::removal_sync::run_pending_removals(
                        &state, user_id, &device_id,
                    )
                    .await;
                }
            }
        });
    }
}

/// `_sync_global_capabilities_to_registered_device`.
async fn sync_after_register(
    state: &AppState,
    emitters: &SocketEmitters,
    callbacks: &CallbackIds,
    user_id: i64,
    device_id: String,
) {
    let include_plugins =
        match prepare_plugins_for_registered_device(state, user_id, &device_id).await {
            crate::plugins_installed::PluginPreparation::Ready => true,
            crate::plugins_installed::PluginPreparation::Deferred => false,
            crate::plugins_installed::PluginPreparation::Failed => return,
        };
    let dispatch = LocalDispatch {
        state,
        emitters,
        callbacks,
    };
    let Some(result) =
        sync_registration_capabilities(state, user_id, &device_id, include_plugins, &dispatch)
            .await
    else {
        return;
    };
    if !result.success {
        tracing::warn!(
            user_id,
            device_id,
            error = result.error,
            "capability sync after registration failed"
        );
    }
    if include_plugins {
        record_registration_sync_result(state, user_id, &result).await;
    }
}

/// The registration path's local socket plus adapter publish.
struct LocalDispatch<'a> {
    state: &'a AppState,
    emitters: &'a SocketEmitters,
    callbacks: &'a CallbackIds,
}

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

/// `socketio/async_pubsub_manager.py` inbound `emit`: an acknowledged
/// executor call addressed to one local session by the
/// translated Target SID, with the original three-element callback identity,
/// becomes a worker job.
///
/// A capability-sync frame this process published is skipped: its local
/// dispatcher already delivered it to the socket and published the frame only
/// for other hosts, so processing the echo would deliver it twice and publish
/// an unowned callback. `runtime:rpc` keeps accepting its own frame, because
/// that echo is how this process's outbound `sio.call` reaches its own socket.
pub(crate) fn inbound_rpc_job(message: Value) -> Option<RuntimeRpcCall> {
    if message.get("method").and_then(Value::as_str) != Some("emit") {
        return None;
    }
    let event = match message.get("event").and_then(Value::as_str)? {
        "runtime:rpc" => RuntimeCallEvent::RuntimeRpc,
        "device:sync_capabilities" => RuntimeCallEvent::SyncCapabilities,
        "device:execute_command" => RuntimeCallEvent::ExecuteCommand,
        "device:start_terminal_session" => RuntimeCallEvent::StartTerminalSession,
        "device:start_code_server_session" => RuntimeCallEvent::StartCodeServerSession,
        _ => return None,
    };
    if message.get("namespace").and_then(Value::as_str) != Some("/local-executor") {
        return None;
    }
    if event == RuntimeCallEvent::SyncCapabilities
        && message.get("host_id").and_then(Value::as_str) == Some(crate::socketio_emit::host_id())
    {
        return None;
    }
    let callback = message.get("callback")?.as_array()?;
    let [sid, namespace, id] = callback.as_slice() else {
        return None;
    };
    let room = message.get("room")?.as_str()?;
    let host_id = message.get("host_id")?.as_str()?;
    let arg = message.get("data")?.as_array()?.first()?.clone();
    if sid.as_str()? != room || namespace.as_str()? != "/local-executor" {
        return None;
    }
    Some(RuntimeRpcCall {
        event,
        room: room.to_owned(),
        namespace: namespace.as_str()?.to_owned(),
        host_id: host_id.to_owned(),
        id: id.as_u64()?,
        arg,
    })
}

/// Deliver one inbound `/local-executor` call to the real session and publish
/// the client's real acknowledgement as the source's `method: callback`
/// message.
///
/// A timeout or closed socket publishes nothing: the source's `sio.call`
/// failure path produces no callback, and an acknowledgement is never
/// synthesized.
async fn forward_runtime_rpc(
    emitters: &SocketEmitters,
    sequencer: &std::sync::Arc<super::callback_sequencer::CallbackSequencer>,
    call: RuntimeRpcCall,
) {
    let timeout = call.ack_timeout();
    let RuntimeRpcCall {
        event,
        room,
        namespace,
        host_id,
        id,
        arg,
    } = call;
    let ack = match event {
        RuntimeCallEvent::RuntimeRpc => emitters.runtime_rpc(&room, &arg, timeout).await,
        RuntimeCallEvent::SyncCapabilities => {
            emitters.call_sync_capabilities(&room, &arg, timeout).await
        }
        RuntimeCallEvent::ExecuteCommand => {
            emitters.call_execute_command(&room, &arg, timeout).await
        }
        RuntimeCallEvent::StartTerminalSession | RuntimeCallEvent::StartCodeServerSession => {
            emitters
                .call_start_session(event, &room, &arg, timeout)
                .await
        }
    };
    let ack = match ack {
        Ok(ack) => ack,
        Err(error) => {
            tracing::warn!(
                %error,
                ?event,
                room,
                id,
                "inbound adapter call failed; no callback is published"
            );
            return;
        }
    };
    let callback = super::callback_sequencer::SequencedCallback {
        host_id,
        room,
        namespace,
        id,
        ack,
    };
    // Capability sync calls prepare independent packages on the same device.
    // Return each result when ready, even if an earlier download is held.
    if event == RuntimeCallEvent::SyncCapabilities {
        sequencer.publish_unordered(callback).await;
    } else {
        sequencer.submit(callback);
    }
}

/// The source's `_return_callback` message: the original remote identity is
/// echoed and the client's acknowledgement is the single result item.
pub(crate) fn callback_message(
    host_id: &str,
    sid: &str,
    namespace: &str,
    id: u64,
    ack: Value,
) -> Value {
    json!({
        "method": "callback",
        "host_id": host_id,
        "sid": sid,
        "namespace": namespace,
        "id": id,
        "args": [ack],
    })
}

/// Startup-owned consumer for inbound `runtime:rpc` calls.
pub(crate) async fn run_rpc_worker(
    calls: Arc<tokio::sync::Mutex<mpsc::Receiver<RuntimeRpcCall>>>,
    emitters: Arc<SocketEmitters>,
    sequencer: Arc<super::callback_sequencer::CallbackSequencer>,
) {
    loop {
        let call = {
            let mut calls = calls.lock().await;
            calls.recv().await
        };
        let Some(call) = call else {
            return;
        };
        forward_runtime_rpc(&emitters, &sequencer, call).await;
    }
}

/// The Socket.IO argument tuple: `operators.emit` wraps a non-tuple value into
/// a single argument, so the frame's positional arguments must serialize
/// through `serialize_tuple` to reach the wire as `[event, a, b]` — including
/// a lone array argument, which stays one argument.
pub(crate) struct ArgsTuple<'a>(pub &'a [Value]);

impl serde::Serialize for ArgsTuple<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeTuple;
        let mut tuple = serializer.serialize_tuple(self.0.len())?;
        for argument in self.0 {
            tuple.serialize_element(argument)?;
        }
        tuple.end()
    }
}

/// One ordinary inbound adapter broadcast for local room delivery.
pub(crate) struct AdapterEmit {
    pub namespace: String,
    pub event: String,
    pub room: String,
    pub skip_sid: Option<String>,
    /// The frame's positional event arguments, unwrapped.
    pub args: Vec<Value>,
}

/// `AsyncPubSubManager._handle_emit` for a plain `emit` message: deliver the
/// event to this host's named room and never re-publish it.
///
/// `_listen` ignores every message whose `host_id` is this manager's own
/// identity, so a frame this process published is not delivered twice. Frames
/// that carry a callback identity stay on the inbound RPC path; the
/// `/local-executor` `runtime:rpc` guard is unchanged.
pub(crate) fn adapter_emit_job(message: Value) -> Option<AdapterEmit> {
    if message.get("method").and_then(Value::as_str) != Some("emit") {
        return None;
    }
    if message.get("host_id").and_then(Value::as_str) == Some(crate::socketio_emit::host_id()) {
        return None;
    }
    if message
        .get("callback")
        .is_some_and(|callback| !callback.is_null())
    {
        return None;
    }
    let event = message.get("event").and_then(Value::as_str)?.to_owned();
    let namespace = message.get("namespace").and_then(Value::as_str)?.to_owned();
    let room = message.get("room").and_then(Value::as_str)?.to_owned();
    if room.is_empty() {
        return None;
    }
    let skip_sid = message
        .get("skip_sid")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let args = match message.get("data")? {
        Value::Array(items) => items.clone(),
        data => vec![data.clone()],
    };
    Some(AdapterEmit {
        namespace,
        event,
        room,
        skip_sid,
        args,
    })
}

/// Startup-owned consumer for ordinary inbound adapter broadcasts.
pub(crate) async fn run_adapter_emit_worker(
    emits: Arc<tokio::sync::Mutex<mpsc::Receiver<AdapterEmit>>>,
    emitters: Arc<SocketEmitters>,
) {
    loop {
        let emit = {
            let mut emits = emits.lock().await;
            emits.recv().await
        };
        let Some(emit) = emit else {
            return;
        };
        let (sent, failed) = emitters
            .emit_room(
                &emit.namespace,
                &emit.event,
                &emit.room,
                emit.skip_sid.as_deref(),
                &ArgsTuple(&emit.args),
            )
            .await;
        if failed > 0 {
            tracing::warn!(
                namespace = emit.namespace,
                event = emit.event,
                room = emit.room,
                sent,
                failed,
                "inbound adapter broadcast delivery failures"
            );
        }
    }
}

/// `sio.call`'s default acknowledgement timeout.
pub(crate) const RUNTIME_RPC_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(test)]
mod runtime_rpc_tests {
    use super::*;

    fn frame(room: &str, callback_sid: &str) -> Value {
        json!({
            "method": "emit",
            "event": "runtime:rpc",
            "data": [{"method": "runtime.tasks.list", "payload": {}}],
            "binary": false,
            "namespace": "/local-executor",
            "room": room,
            "skip_sid": null,
            "callback": [callback_sid, "/local-executor", 1],
            "host_id": "fefecc7979634ba187ec89eaaabf1233",
        })
    }

    #[test]
    fn an_addressed_runtime_rpc_frame_becomes_a_job() {
        let job = inbound_rpc_job(frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9"))
            .expect("an addressed call");
        let RuntimeRpcCall {
            event,
            room,
            namespace,
            host_id,
            id,
            arg,
        } = job;
        assert_eq!(event, RuntimeCallEvent::RuntimeRpc);
        assert_eq!(room, "7xY2AeTaWTsb2AJ9");
        assert_eq!(namespace, "/local-executor");
        assert_eq!(host_id, "fefecc7979634ba187ec89eaaabf1233");
        assert_eq!(id, 1);
        assert_eq!(arg, json!({"method": "runtime.tasks.list", "payload": {}}));
    }

    #[test]
    fn a_remote_capability_sync_frame_becomes_a_job() {
        let mut message = frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9");
        message["event"] = json!("device:sync_capabilities");
        message["data"] = json!([{"mode": "replace", "skills": [], "plugins": []}]);
        let call = inbound_rpc_job(message).expect("a remote capability sync");
        assert_eq!(call.event, RuntimeCallEvent::SyncCapabilities);
        assert_eq!(call.room, "7xY2AeTaWTsb2AJ9");
        assert_eq!(call.namespace, "/local-executor");
        assert_eq!(call.host_id, "fefecc7979634ba187ec89eaaabf1233");
        assert_eq!(call.id, 1);
        assert_eq!(
            call.arg,
            json!({"mode": "replace", "skills": [], "plugins": []})
        );
    }

    #[test]
    fn a_device_command_echo_preserves_the_callback_identity() {
        let mut message = frame("device-socket", "device-socket");
        message["event"] = json!("device:execute_command");
        message["host_id"] = json!(crate::socketio_emit::host_id());
        message["data"] = json!([{"command": "pwd"}]);
        let call = inbound_rpc_job(message).expect("an addressed device command");
        assert_eq!(call.event, RuntimeCallEvent::ExecuteCommand);
        assert_eq!(call.room, "device-socket");
        assert_eq!(call.id, 1);
        assert_eq!(call.arg, json!({"command": "pwd"}));
    }

    #[test]
    fn session_start_calls_preserve_the_python_callback() {
        for (name, event) in [
            (
                "device:start_terminal_session",
                RuntimeCallEvent::StartTerminalSession,
            ),
            (
                "device:start_code_server_session",
                RuntimeCallEvent::StartCodeServerSession,
            ),
        ] {
            let mut message = frame("device-socket", "device-socket");
            message["event"] = json!(name);
            message["data"] = json!([{"session_id": "session"}]);
            let call = inbound_rpc_job(message).expect("an addressed session start call");
            assert_eq!(call.event, event);
            assert_eq!(call.room, "device-socket");
            assert_eq!(call.id, 1);
            assert_eq!(call.arg, json!({"session_id": "session"}));
            assert_eq!(call.ack_timeout(), Duration::from_secs(15));
        }
    }

    #[test]
    fn a_capability_sync_self_echo_is_not_a_job() {
        let mut message = frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9");
        message["event"] = json!("device:sync_capabilities");
        message["host_id"] = json!(crate::socketio_emit::host_id());
        assert!(inbound_rpc_job(message).is_none());
        // The runtime:rpc echo stays accepted: it is how this process's own
        // outbound `sio.call` reaches its local socket.
        let mut rpc = frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9");
        rpc["host_id"] = json!(crate::socketio_emit::host_id());
        assert!(inbound_rpc_job(rpc).is_some());
    }

    #[test]
    fn a_mismatched_or_unrelated_frame_is_ignored() {
        assert!(inbound_rpc_job(frame("room-1", "room-2")).is_none());
        let mut other = frame("room-1", "room-1");
        other["event"] = json!("device:slot_update");
        assert!(inbound_rpc_job(other).is_none());
        let mut no_callback = frame("room-1", "room-1");
        no_callback["callback"] = Value::Null;
        assert!(inbound_rpc_job(no_callback).is_none());
    }

    #[test]
    fn the_callback_echoes_the_remote_identity_with_one_result() {
        let callback = callback_message(
            "fefecc7979634ba187ec89eaaabf1233",
            "7xY2AeTaWTsb2AJ9",
            "/local-executor",
            1,
            json!({"success": true, "workspaces": []}),
        );
        assert_eq!(
            callback,
            json!({
                "method": "callback",
                "host_id": "fefecc7979634ba187ec89eaaabf1233",
                "sid": "7xY2AeTaWTsb2AJ9",
                "namespace": "/local-executor",
                "id": 1,
                "args": [{"success": true, "workspaces": []}],
            })
        );
    }
}

#[cfg(test)]
mod adapter_emit_tests {
    use super::*;
    use serde_json::json;

    fn frame(host: &str, room: &str) -> Value {
        json!({
            "method": "emit",
            "event": "device:slot_update",
            "data": [{"device_id": "d-1", "slot_used": 0}],
            "binary": false,
            "namespace": "/chat",
            "room": room,
            "skip_sid": null,
            "callback": null,
            "host_id": host,
        })
    }

    #[test]
    fn an_ordinary_broadcast_keeps_its_own_room_and_payload() {
        for room in ["user:2287", "wework:user:2287"] {
            let job = adapter_emit_job(frame("external-manager", room)).expect("a broadcast");
            assert_eq!(job.namespace, "/chat");
            assert_eq!(job.event, "device:slot_update");
            assert_eq!(job.room, room);
            assert_eq!(job.skip_sid, None);
            assert_eq!(job.args, vec![json!({"device_id": "d-1", "slot_used": 0})]);
        }
    }

    #[test]
    fn a_skip_sid_and_multi_argument_payload_survive() {
        let mut message = frame("external-manager", "user:1");
        message["skip_sid"] = json!("socket-7");
        message["data"] = json!([{"a": 1}, {"b": 2}]);
        let job = adapter_emit_job(message).expect("a broadcast");
        assert_eq!(job.skip_sid.as_deref(), Some("socket-7"));
        assert_eq!(job.args, vec![json!({"a": 1}), json!({"b": 2})]);
    }

    #[test]
    fn this_managers_own_frames_are_not_delivered_again() {
        assert!(adapter_emit_job(frame(crate::socketio_emit::host_id(), "user:1")).is_none());
    }

    #[test]
    fn callback_bearing_and_non_emit_frames_stay_off_the_broadcast_path() {
        let mut message = frame("external-manager", "user:1");
        message["callback"] = json!(["sid", "/local-executor", 1]);
        assert!(adapter_emit_job(message).is_none());
        let mut message = frame("external-manager", "user:1");
        message["method"] = json!("callback");
        assert!(adapter_emit_job(message).is_none());
        let mut message = frame("external-manager", "");
        message["room"] = json!("");
        assert!(adapter_emit_job(message).is_none());
    }
}

#[cfg(test)]
mod adapter_args_tests {
    use super::*;
    use serde::ser::{Impossible, SerializeTuple};
    use serde_json::json;
    use std::fmt;

    /// The error type for the shape recorder.
    #[derive(Debug)]
    struct ShapeError;

    impl fmt::Display for ShapeError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("unsupported serialization shape")
        }
    }

    impl std::error::Error for ShapeError {}
    impl serde::ser::Error for ShapeError {
        fn custom<T: fmt::Display>(_message: T) -> Self {
            Self
        }
    }

    /// Records which `serde::Serializer` entry point socketioxide's parser
    /// inspects: a tuple keeps its arity, a sequence/array is one argument.
    #[derive(Default)]
    struct Shape {
        tuple_len: Option<usize>,
        seq_len: Option<usize>,
    }

    impl serde::Serializer for &mut Shape {
        type Ok = ();
        type Error = ShapeError;
        type SerializeSeq = Impossible<(), ShapeError>;
        type SerializeTuple = TupleShape;
        type SerializeTupleStruct = Impossible<(), ShapeError>;
        type SerializeTupleVariant = Impossible<(), ShapeError>;
        type SerializeMap = Impossible<(), ShapeError>;
        type SerializeStruct = Impossible<(), ShapeError>;
        type SerializeStructVariant = Impossible<(), ShapeError>;

        fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
            self.seq_len = len;
            Err(ShapeError)
        }
        fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> {
            self.tuple_len = Some(len);
            Ok(TupleShape)
        }
        fn serialize_tuple_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleStruct, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_tuple_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleVariant, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStruct, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_struct_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStructVariant, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_bool(self, _: bool) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i8(self, _: i8) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i16(self, _: i16) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i32(self, _: i32) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i64(self, _: i64) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u8(self, _: u8) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u16(self, _: u16) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u32(self, _: u32) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u64(self, _: u64) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_f32(self, _: f32) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_f64(self, _: f64) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_char(self, _: char) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_str(self, _: &str) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_bytes(self, _: &[u8]) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_none(self) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_some<T: ?Sized + serde::Serialize>(
            self,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(self)
        }
        fn serialize_unit(self) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_unit_struct(self, _: &'static str) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_unit_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
        ) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_newtype_struct<T: ?Sized + serde::Serialize>(
            self,
            _: &'static str,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(self)
        }
        fn serialize_newtype_variant<T: ?Sized + serde::Serialize>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(self)
        }
    }

    struct TupleShape;

    impl SerializeTuple for TupleShape {
        type Ok = ();
        type Error = ShapeError;
        fn serialize_element<T: ?Sized + serde::Serialize>(
            &mut self,
            _value: &T,
        ) -> Result<(), Self::Error> {
            Ok(())
        }
        fn end(self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    /// The arity the parser sees and the JSON the tuple serializes to.
    fn arity(args: &[Value]) -> (Option<usize>, Option<usize>, String) {
        let mut shape = Shape::default();
        serde::Serialize::serialize(&ArgsTuple(args), &mut shape).expect("tuple serializes");
        let json = serde_json::to_string(&ArgsTuple(args)).expect("tuple json");
        (shape.tuple_len, shape.seq_len, json)
    }

    #[test]
    fn zero_one_two_and_nested_array_arguments_stay_positional() {
        // No argument: `[event]` on the wire, not `[event, []]`.
        assert_eq!(arity(&[]), (Some(0), None, "[]".to_owned()));
        assert_eq!(
            arity(&[json!({"a": 1})]),
            (Some(1), None, r#"[{"a":1}]"#.to_owned())
        );
        // Two arguments stay two positional arguments, not one array.
        assert_eq!(
            arity(&[json!({"a": 1}), json!({"b": 2})]),
            (Some(2), None, r#"[{"a":1},{"b":2}]"#.to_owned())
        );
        // A single nested array is still one argument.
        assert_eq!(
            arity(&[json!([1, 2])]),
            (Some(1), None, "[[1,2]]".to_owned())
        );
        // A bare array serializes as a sequence: the parser would wrap it as
        // one argument, which is why the tuple writer is required.
        let mut shape = Shape::default();
        let _ = serde::Serialize::serialize(&json!([1, 2]), &mut shape);
        assert_eq!(shape.tuple_len, None);
    }
}
