// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-owned Socket.IO business runtime for the migrated namespaces.
//!
//! The source backend emits through its `socketio.AsyncServer`: every emit is
//! first delivered to local sockets (`_handle_emit`) and then published to the
//! Redis adapter so other workers can deliver it too
//! (`socketio/async_pubsub_manager.py::emit`). The Rust process owns the
//! sockets now, so the local half is a startup-built [`EventEmitter`] and the
//! adapter half is the existing `socketio_emit` publish.
//!
//! Device registration also schedules in-process follow-up work after its ACK
//! (`_schedule_background_task`). This module owns that work on one long-lived
//! bounded worker instead of a per-request task.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use brz_socket_io::{EmitterError, EventEmitter, Server, SocketIo};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::BoxError;
use crate::state::AppState;

use super::session::{ConnectionRateLimiter, RegistrationDebounce, RegistrationFingerprint};

/// Namespace that receives chat-room device broadcasts.
pub const CHAT_NAMESPACE: &str = "/chat";
/// Namespace that owns device sessions and the capability sync call.
pub const EXECUTOR_NAMESPACE: &str = "/local-executor";

/// Bound on follow-up work waiting for the worker; the source creates an
/// unbounded asyncio task per registration.
const JOB_QUEUE_CAPACITY: usize = 256;
/// Bound on concurrent inbound `runtime:rpc` calls; the source dispatches each
/// inbound event independently, so one slow ACK must not block the others.
const RPC_WORKER_COUNT: usize = 4;

/// Deliver one event to every selected recipient, even after a peer fails.
///
/// The source's `_handle_emit` emits to each participant of the room; a closed
/// or saturated recipient must not stop the remaining peers. `deliver` returns
/// `None` for an excluded recipient and `Some(ok)` for an attempted delivery;
/// the returned `(sent, failed)` counts attempted deliveries.
fn fanout<T>(recipients: &[T], mut deliver: impl FnMut(&T) -> Option<bool>) -> (usize, usize) {
    let (mut sent, mut failed) = (0, 0);
    for recipient in recipients {
        match deliver(recipient) {
            Some(true) => sent += 1,
            Some(false) => failed += 1,
            None => {}
        }
    }
    (sent, failed)
}

#[cfg(test)]
mod fanout_tests {
    use super::fanout;

    /// A failed or excluded recipient never stops the remaining peers.
    #[test]
    fn a_failed_peer_does_not_stop_the_remaining_recipients() {
        let recipients = ["healthy-a", "failed", "excluded", "healthy-b"];
        let mut delivered = Vec::new();
        let (sent, failed) = fanout(&recipients, |peer| match *peer {
            "excluded" => None,
            "failed" => Some(false),
            peer => {
                delivered.push(peer);
                Some(true)
            }
        });
        assert_eq!((sent, failed), (2, 1));
        assert_eq!(delivered, vec!["healthy-a", "healthy-b"]);
    }
}

/// The startup-built outgoing events used by device handlers.
pub struct SocketEmitters {
    /// The native handle ordinary inbound adapter broadcasts are delivered
    /// through: one room per frame, never re-published.
    io: SocketIo,
    /// `device:online` in the user's chat rooms.
    online: EventEmitter,
    /// `device:offline` in the user's chat rooms.
    offline: EventEmitter,
    /// `device:slot_update` in the user's chat rooms.
    slot_update: EventEmitter,
    /// `chat:status_updated` to one chat socket.
    status_updated: EventEmitter,
    /// `auth_error` to one chat socket (`_handle_token_expired`).
    auth_error: EventEmitter,
    /// `chat:error` in one task room (`emit_chat_error`).
    chat_error: EventEmitter,
    /// `sio.call("device:sync_capabilities", ...)` to one device socket.
    sync_capabilities: EventEmitter,
    /// `runtime:event` in the user's Wework Runtime room.
    runtime_event: EventEmitter,
    /// `wework:project_chat:message:created` in a project chat room.
    project_chat_created: EventEmitter,
    /// `wework:project_chat:agent:chunk` in a project chat room.
    project_chat_chunk: EventEmitter,
    /// `runtime:rpc` to one `/local-executor` session (inbound adapter call).
    runtime_rpc: EventEmitter,
}

impl SocketEmitters {
    fn new(server: &Server) -> Result<Self, EmitterError> {
        Ok(Self {
            io: server.io().clone(),
            online: server.emitter(CHAT_NAMESPACE, "device:online")?,
            offline: server.emitter(CHAT_NAMESPACE, "device:offline")?,
            slot_update: server.emitter(CHAT_NAMESPACE, "device:slot_update")?,
            status_updated: server.emitter(CHAT_NAMESPACE, "chat:status_updated")?,
            auth_error: server.emitter(CHAT_NAMESPACE, "auth_error")?,
            chat_error: server.emitter(CHAT_NAMESPACE, "chat:error")?,
            sync_capabilities: server.emitter(EXECUTOR_NAMESPACE, "device:sync_capabilities")?,
            runtime_event: server.emitter(
                super::device_runtime_event::RUNTIME_NAMESPACE,
                super::device_runtime_event::RUNTIME_EVENT,
            )?,
            project_chat_created: server.emitter(
                super::device_runtime_event::RUNTIME_NAMESPACE,
                super::device_runtime_event::PROJECT_CHAT_CREATED_EVENT,
            )?,
            project_chat_chunk: server.emitter(
                super::device_runtime_event::RUNTIME_NAMESPACE,
                super::device_runtime_event::PROJECT_CHAT_AGENT_CHUNK_EVENT,
            )?,
            runtime_rpc: server.emitter(EXECUTOR_NAMESPACE, "runtime:rpc")?,
        })
    }

    /// `get_participants`: an adapter RPC is delivered only by the process
    /// that has a recipient in the addressed executor room.
    pub(crate) fn has_local_runtime_recipient(&self, room: &str) -> bool {
        self.io
            .of(EXECUTOR_NAMESPACE)
            .is_some_and(|namespace| !namespace.to(room.to_owned()).sockets().is_empty())
    }

    /// `_handle_emit`'s local half for a plain adapter broadcast: deliver the
    /// event to the frame's own room, honoring `skip_sid`.
    pub(crate) async fn emit_room(
        &self,
        namespace: &str,
        event: &str,
        room: &str,
        skip_sid: Option<&str>,
        args: &super::device_sync::ArgsTuple<'_>,
    ) -> (usize, usize) {
        let Some(operators) = self.io.of(namespace) else {
            // No such local namespace: the frame is not delivered anywhere.
            return (0, 1);
        };
        // `skip_sid` names the source socket, not a room: socketioxide keeps no
        // per-socket room for it, so the broadcast is delivered per recipient
        // and the excluded session is filtered by its socket id.
        let sockets = operators.to(room.to_owned()).sockets();
        fanout(&sockets, |socket| {
            if skip_sid.is_some_and(|sid| socket.id.to_string() == sid) {
                return None;
            }
            Some(socket.emit(event, args).is_ok())
        })
    }

    /// `_broadcast_device_online`'s local delivery.
    pub async fn device_online(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.online, user_id, data).await
    }

    /// `_broadcast_device_offline`'s local delivery.
    pub async fn device_offline(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.offline, user_id, data).await
    }

    /// `_broadcast_device_slot_update`'s local delivery.
    pub async fn device_slot_update(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.slot_update, user_id, data)
            .await
    }

    async fn emit_to_user_rooms(
        &self,
        emitter: &EventEmitter,
        user_id: i64,
        data: &Value,
    ) -> Result<(), EmitterError> {
        // `emit_chat_user_event` addresses the personal chat rooms.
        emitter
            .clone()
            .to(format!("user:{user_id}"))
            .emit(data)
            .await?;
        emitter
            .clone()
            .to(format!("wework:user:{user_id}"))
            .emit(data)
            .await
    }

    /// `chat:status_updated` to one socket (`task:join`'s cached metrics).
    pub async fn chat_status_updated(
        &self,
        socket_id: &str,
        data: &Value,
    ) -> Result<(), EmitterError> {
        self.status_updated
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// `emit_chat_error`'s local delivery to one task room.
    pub async fn chat_error(&self, task_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.chat_error
            .clone()
            .to(format!("task:{task_id}"))
            .emit(data)
            .await
    }

    /// `auth_error` to one socket (`_handle_token_expired`).
    pub async fn chat_auth_error(&self, socket_id: &str, data: &Value) -> Result<(), EmitterError> {
        self.auth_error
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// `sio.emit(PROJECT_CHAT_*, message, room=project_chat_room(...))`'s local
    /// delivery half.
    pub async fn project_chat_message(
        &self,
        room: &str,
        delta: bool,
        data: &Value,
    ) -> Result<(), EmitterError> {
        let emitter = if delta {
            &self.project_chat_chunk
        } else {
            &self.project_chat_created
        };
        emitter.clone().to(room.to_owned()).emit(data).await
    }

    /// `_forward_runtime_event`'s `sio.emit(WEWORK_RUNTIME_EVENT, ...)`.
    pub async fn runtime_event(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.runtime_event
            .clone()
            .to(super::device_runtime_event::runtime_user_room(user_id))
            .emit(data)
            .await
    }

    /// One inbound `runtime:rpc` call: `sio.call(event, data, to=sid)` against
    /// the real local session, awaiting the client's real acknowledgement.
    pub async fn runtime_rpc(
        &self,
        socket_id: &str,
        data: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        self.runtime_rpc
            .clone()
            .to(socket_id.to_owned())
            .request(data, timeout)
            .await
    }

    /// One `sio.call("device:sync_capabilities", payload, to=socket_id)`.
    pub async fn call_sync_capabilities(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        self.sync_capabilities
            .clone()
            .to(socket_id.to_owned())
            .request(payload, timeout)
            .await
    }
}

#[cfg(test)]
impl SocketEmitters {
    /// Test-only constructor: the wire tests need the production emitter
    /// handles without widening the production constructor's visibility.
    pub(crate) fn for_test(server: &Server) -> Result<Self, EmitterError> {
        Self::new(server)
    }
}

/// One inbound adapter `runtime:rpc` call waiting for the real client ACK.
pub struct RuntimeRpcCall {
    pub room: String,
    pub namespace: String,
    pub host_id: String,
    pub id: u64,
    pub arg: Value,
}

/// One deferred follow-up job for the device engine.
pub enum DeviceJob {
    /// `_sync_global_capabilities_to_registered_device`.
    ///
    /// Source `reconcile_device_executions` runs from the same scheduler but is
    /// not ported; its recorded query only proves the empty result path, which
    /// is documented in the migration record.
    RegisterSync { user_id: i64, device_id: String },
    /// `_schedule_background_task(sync_pending_plugin_removals(...))` at the end
    /// of the heartbeat handler.
    PluginRemoval { user_id: i64, device_id: String },
}

/// Startup-owned handles shared by every Socket.IO handler.
pub struct SocketRuntime {
    emitters: std::sync::OnceLock<Arc<SocketEmitters>>,
    jobs: mpsc::Sender<DeviceJob>,
    /// `reconcile_device_executions` after registration: its own bounded queue
    /// so the read is never queued behind the capability sync, exactly like
    /// the source's independent event-loop task.
    reconcile_jobs: mpsc::Sender<super::device_reconcile::ReconcileJob>,
    rpc_jobs: mpsc::Sender<RuntimeRpcCall>,
    /// Ordinary inbound adapter broadcasts, delivered locally to their room.
    emit_jobs: mpsc::Sender<super::device_sync::AdapterEmit>,
    rate_limiter: ConnectionRateLimiter,
    registrations: RegistrationDebounce,
    callback_ids: Arc<CallbackIds>,
    event_locks: Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl SocketRuntime {
    /// `_get_runtime_event_lock(sid)`: one lock per Socket.IO session.
    ///
    /// The source keeps the lock in `self._runtime_event_locks` for the life of
    /// the connection so one session's Runtime events stay ordered even though
    /// the namespace dispatches them concurrently.
    #[must_use]
    pub fn runtime_event_lock(&self, socket_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.event_locks.lock().expect("runtime event lock map");
        if locks.len() > 4096 {
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        Arc::clone(
            locks
                .entry(socket_id.to_owned())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }
}

/// `_generate_ack_id`'s process-local `itertools.count(1)` per socket.
#[derive(Default)]
pub struct CallbackIds {
    counters: Mutex<std::collections::HashMap<String, u64>>,
}

impl CallbackIds {
    /// Returns the next adapter callback id for one socket id.
    #[must_use]
    pub fn next(&self, socket_id: &str) -> u64 {
        let mut ids = self.counters.lock().expect("callback id lock");
        if ids.len() > 4096 {
            ids.clear();
        }
        let next = ids.entry(socket_id.to_owned()).or_insert(0);
        *next += 1;
        *next
    }
}

/// The runtime handle and the queues its startup-owned workers drain.
type SocketRuntimeChannels = (
    Arc<SocketRuntime>,
    mpsc::Receiver<DeviceJob>,
    mpsc::Receiver<RuntimeRpcCall>,
    mpsc::Receiver<super::device_reconcile::ReconcileJob>,
    mpsc::Receiver<super::device_sync::AdapterEmit>,
);

impl SocketRuntime {
    /// Creates the handles shared by every Socket.IO handler.
    ///
    /// The follow-up worker starts in [`SocketRuntime::install`] once the
    /// namespaces exist; the receiver stays here until then.
    pub(crate) fn new() -> SocketRuntimeChannels {
        let (jobs, receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        let (reconcile_jobs, reconcile_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        // The remote RPC consumer is a separate startup-owned task: a
        // registration sync waiting on its ACK must not delay an inbound
        // `runtime:rpc` call.
        let (rpc_jobs, rpc_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        // Ordinary inbound adapter broadcasts get their own bounded queue: the
        // delivery is a local room emit, never a re-publish.
        let (emit_jobs, emit_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        (
            Arc::new(Self {
                emitters: std::sync::OnceLock::new(),
                jobs,
                reconcile_jobs,
                rpc_jobs,
                emit_jobs,
                rate_limiter: ConnectionRateLimiter::default(),
                registrations: RegistrationDebounce::default(),
                callback_ids: Arc::new(CallbackIds::default()),
                event_locks: Mutex::new(std::collections::HashMap::new()),
            }),
            receiver,
            rpc_receiver,
            reconcile_receiver,
            emit_receiver,
        )
    }

    /// Builds the outgoing events after namespace registration and starts the
    /// follow-up worker.
    ///
    /// Called once during service construction, before the listener serves any
    /// request, so the worker is initialization-owned. The spawned task stops
    /// when the queue closes or the process begins shutting down.
    pub(crate) fn install(
        &self,
        state: Arc<AppState>,
        server: &Server,
        receiver: mpsc::Receiver<DeviceJob>,
        rpc_receiver: mpsc::Receiver<RuntimeRpcCall>,
        reconcile_receiver: mpsc::Receiver<super::device_reconcile::ReconcileJob>,
        emit_receiver: mpsc::Receiver<super::device_sync::AdapterEmit>,
    ) -> Result<(), BoxError> {
        // `EventEmitter::new` requires the namespace to be registered, so this
        // runs after `handlers!` has exported every namespace.
        let emitters = Arc::new(
            SocketEmitters::new(server)
                .map_err(|error| -> BoxError { format!("Socket.IO emitters: {error}").into() })?,
        );
        if self.emitters.set(Arc::clone(&emitters)).is_err() {
            return Err("Socket.IO emitters installed twice".into());
        }
        // Inbound adapter `runtime:rpc` calls get their own bounded queue and
        // consumer so they never queue behind a registration sync that waits
        // on its ACK. A full queue drops the call, which publishes no callback.
        if let Some(rpc) = state.socketio_rpc.as_ref() {
            rpc.set_emit_sink(self.adapter_emit_sink(Arc::clone(&emitters)));
        }
        let emit_receiver = Arc::new(tokio::sync::Mutex::new(emit_receiver));
        tokio::spawn(super::device_sync::run_adapter_emit_worker(
            emit_receiver,
            Arc::clone(&emitters),
        ));
        tokio::spawn(super::device_sync::run_worker(
            receiver,
            Arc::clone(&state),
            Arc::clone(&emitters),
            Arc::clone(&self.callback_ids),
        ));
        // The source schedules one `asyncio` task per registration/heartbeat,
        // so a slow reconcile RPC must not delay another device's initial
        // read. A fixed, startup-owned pool over one bounded queue gives the
        // same bounded concurrency without per-request spawning.
        let reconcile_receiver = Arc::new(tokio::sync::Mutex::new(reconcile_receiver));
        for _ in 0..super::device_reconcile::RECONCILE_WORKER_COUNT {
            tokio::spawn(super::device_reconcile::run_worker(
                Arc::clone(&reconcile_receiver),
                Arc::clone(&state),
            ));
        }
        // The source executor dispatches every inbound event to its own
        // handler task, so one slow acknowledgement must not head-of-line
        // block another call. A fixed, startup-owned pool of workers over one
        // bounded queue gives the same bounded concurrency without per-call
        // tasks.
        let rpc_receiver = Arc::new(tokio::sync::Mutex::new(rpc_receiver));
        for _ in 0..RPC_WORKER_COUNT {
            let receiver = Arc::clone(&rpc_receiver);
            let state = Arc::clone(&state);
            let emitters = Arc::clone(&emitters);
            tokio::spawn(super::device_sync::run_rpc_worker(
                receiver, state, emitters,
            ));
        }
        Ok(())
    }

    /// The Redis channel broadcasts to every process. Like Python's local
    /// participant iteration, an RPC without a local recipient does no work.
    pub(crate) fn adapter_emit_sink(
        &self,
        emitters: Arc<SocketEmitters>,
    ) -> crate::socketio_rpc::EmitSink {
        let rpc_jobs = self.rpc_jobs.clone();
        let emit_jobs = self.emit_jobs.clone();
        Arc::new(move |message: Value| {
            if let Some(call) = super::device_sync::inbound_rpc_job(message.clone()) {
                if !emitters.has_local_runtime_recipient(&call.room) {
                    return;
                }
                if rpc_jobs.try_send(call).is_err() {
                    tracing::warn!("runtime:rpc queue is full; the call is dropped");
                }
                return;
            }
            if let Some(emit) = super::device_sync::adapter_emit_job(message)
                && emit_jobs.try_send(emit).is_err()
            {
                tracing::warn!("inbound adapter broadcast queue is full; the frame is dropped");
            }
        })
    }

    /// The outgoing event handles.
    ///
    /// Panics only if a handler runs before service construction finished,
    /// which the framework's connect ordering makes impossible.
    #[must_use]
    pub fn emitters(&self) -> &Arc<SocketEmitters> {
        self.emitters
            .get()
            .expect("Socket.IO emitters are installed during service construction")
    }

    /// `_is_connection_rate_limited` for one peer address.
    #[must_use]
    pub fn allow_connection(&self, peer: Option<&str>) -> bool {
        let key = format!("ip:{}", peer.unwrap_or("unknown"));
        self.rate_limiter.allow(&key, Instant::now())
    }

    /// `_get_recent_registration_display_name`.
    #[must_use]
    pub fn recent_display_name(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: &RegistrationFingerprint,
    ) -> Option<String> {
        self.registrations
            .display_name(user_id, device_id, fingerprint, Instant::now())
    }

    /// `_remember_registration`.
    pub fn remember_registration(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: RegistrationFingerprint,
        display_name: String,
    ) {
        self.registrations.remember(
            user_id,
            device_id,
            fingerprint,
            display_name,
            Instant::now(),
        );
    }

    /// Queues one best-effort follow-up without blocking the handler.
    pub fn enqueue(&self, job: DeviceJob) {
        if let Err(error) = self.jobs.try_send(job) {
            tracing::error!(%error, "Socket.IO device follow-up queue rejected work");
        }
    }

    /// Queues the heartbeat's persisted-removal drain
    /// (`_schedule_background_task(sync_pending_plugin_removals(...))`).
    pub fn enqueue_plugin_removal(&self, user_id: i64, device_id: &str) {
        self.enqueue(DeviceJob::PluginRemoval {
            user_id,
            device_id: device_id.to_owned(),
        });
    }

    /// Queues one execution reconciliation
    /// (`_schedule_background_task(reconcile_device_executions(...))`).
    pub fn enqueue_reconcile(&self, job: super::device_reconcile::ReconcileJob) {
        if let Err(error) = self.reconcile_jobs.try_send(job) {
            tracing::error!(%error, "Socket.IO execution reconcile queue rejected work");
        }
    }

    /// `_generate_ack_id`: one counter per addressed socket, starting at 1.
    #[must_use]
    pub fn next_callback_id(&self, socket_id: &str) -> u64 {
        self.callback_ids.next(socket_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_ids_are_per_socket_and_monotonic() {
        let ids = CallbackIds::default();
        assert_eq!(ids.next("a"), 1);
        assert_eq!(ids.next("a"), 2);
        assert_eq!(ids.next("b"), 1);
    }

    /// A registration sync parked on its ACK owns the registration queue; the
    /// remote `runtime:rpc` call on its own queue must still be delivered.
    #[tokio::test]
    async fn runtime_rpc_is_not_blocked_by_a_pending_registration_sync() {
        let (runtime, mut register, mut rpc, _reconcile, _emit) = SocketRuntime::new();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            // Park on the first job like a registration sync awaiting its ACK;
            // the second job stays queued behind it.
            let _pending = register.recv().await;
            let queued = register.try_recv().is_ok();
            let _ = started.send(queued);
            std::future::pending::<()>().await;
        });
        runtime.enqueue(DeviceJob::RegisterSync {
            user_id: 1,
            device_id: "device-1".into(),
        });
        runtime.enqueue(DeviceJob::RegisterSync {
            user_id: 1,
            device_id: "device-2".into(),
        });
        assert!(
            started_rx.await.expect("the register consumer started"),
            "the second registration job stays queued"
        );
        runtime
            .rpc_jobs
            .try_send(RuntimeRpcCall {
                room: "sid-1".into(),
                namespace: "/local-executor".into(),
                host_id: "host-remote".into(),
                id: 1,
                arg: serde_json::json!({"method": "runtime.tasks.list", "payload": {}}),
            })
            .expect("the rpc queue accepts work");
        let call = tokio::time::timeout(std::time::Duration::from_millis(200), rpc.recv())
            .await
            .expect("the rpc consumer is independent of the registration sync")
            .expect("the call was queued");
        assert_eq!(call.room, "sid-1");
    }
}
