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

use brz_socket_io::Server;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::BoxError;
use crate::state::AppState;

use super::session::{ConnectionRateLimiter, RegistrationDebounce, RegistrationFingerprint};

/// Namespace that receives chat-room device broadcasts.
pub const CHAT_NAMESPACE: &str = "/chat";
/// Namespace that owns device sessions and the capability sync call.
pub const EXECUTOR_NAMESPACE: &str = "/local-executor";
/// Namespace that relays browser terminal traffic.
pub const TERMINAL_NAMESPACE: &str = "/terminal";

/// Bound on follow-up work waiting for the worker; the source creates an
/// unbounded asyncio task per registration.
const JOB_QUEUE_CAPACITY: usize = 256;
/// Bound on inbound adapter broadcasts waiting for delivery.
///
/// This queue carries high-frequency streaming frames (`chat:chunk`,
/// `chat:block_*`, one per token/block), far above the other job classes, so
/// the control-plane bound of [`JOB_QUEUE_CAPACITY`] would overflow under a
/// long streamed turn. The Source's `emit` is awaited (backpressured) and never
/// drops, so a larger buffer reduces the drop probability of the fallible
/// non-blocking send; the send itself stays non-blocking because it runs in
/// the Redis adapter callback, where waiting could park the subscription loop.
const EMIT_QUEUE_CAPACITY: usize = 2048;
/// Bound on concurrent inbound `runtime:rpc` calls; the source dispatches each
/// inbound event independently, so one slow ACK must not block the others.
pub(crate) const RPC_WORKER_COUNT: usize = 4;

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

#[path = "runtime_emitters.rs"]
mod emitters;
pub use emitters::SocketEmitters;

/// The process's emitter handles for `AsyncPubSubManager._handle_emit`'s local
/// half. Production installs them once during service construction; tests may
/// replace them, so the slot is a plain mutex rather than a `OnceLock`.
static LOCAL_EMITTERS: std::sync::Mutex<Option<Arc<SocketEmitters>>> = std::sync::Mutex::new(None);

/// Registers the process's emitters for local first delivery.
pub(crate) fn set_local_emitters(emitters: Arc<SocketEmitters>) {
    *LOCAL_EMITTERS.lock().expect("local emitters lock") = Some(emitters);
}

/// `AsyncPubSubManager._handle_emit` for the migrated publishers: deliver the
/// frame to this process's room before it is published. The adapter's own
/// Redis echo is still ignored by `adapter_emit_job`, so a local subscriber
/// sees the frame exactly once.
pub(crate) async fn deliver_local_emit(
    namespace: &str,
    event: &str,
    room: &str,
    skip_sid: Option<&str>,
    payload: &Value,
) {
    let emitters = LOCAL_EMITTERS.lock().expect("local emitters lock").clone();
    let Some(emitters) = emitters else {
        return;
    };
    let args = [payload.clone()];
    let _ = emitters
        .emit_room(
            namespace,
            event,
            room,
            skip_sid,
            &super::device_sync::ArgsTuple(&args),
        )
        .await;
}

/// The `/local-executor` event one browser terminal relay emits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalRelay {
    /// `terminal:attach`: the attach `sio.call`.
    Attach,
    /// `terminal:input`: the fire-and-forget input relay.
    Input,
    /// `terminal:ack`: the acknowledged output acknowledgement.
    Ack,
    /// `terminal:resize`: the acknowledged PTY resize.
    Resize,
    /// `terminal:close`: the acknowledged PTY close.
    Close,
}

impl TerminalRelay {
    pub(crate) fn event_name(self) -> &'static str {
        match self {
            Self::Attach => "terminal:attach",
            Self::Input => "terminal:input",
            Self::Ack => "terminal:ack",
            Self::Resize => "terminal:resize",
            Self::Close => "terminal:close",
        }
    }
}

/// The `/local-executor` event one inbound adapter call delivers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeCallEvent {
    /// `runtime:rpc`: the executor's downlink call.
    RuntimeRpc,
    /// `device:sync_capabilities`: the capability-sync `sio.call`.
    SyncCapabilities,
    /// `device:execute_command`: the remote device command round trip.
    ExecuteCommand,
    StartTerminalSession,
    StartCodeServerSession,
    Terminal(TerminalRelay),
}

/// One inbound adapter `/local-executor` call waiting for the real client ACK.
pub struct RuntimeRpcCall {
    pub event: RuntimeCallEvent,
    pub room: String,
    pub namespace: String,
    pub host_id: String,
    pub id: u64,
    pub arg: Value,
}

impl RuntimeRpcCall {
    pub(crate) fn ack_timeout(&self) -> std::time::Duration {
        use crate::device_commands::{
            DEFAULT_COMMAND_TIMEOUT_SECONDS, MAX_COMMAND_TIMEOUT_SECONDS, SOCKET_ACK_GRACE_SECONDS,
        };
        if matches!(self.event, RuntimeCallEvent::Terminal(_)) {
            return super::terminal_relay::TERMINAL_ATTACH_TIMEOUT_SECONDS;
        }
        if matches!(
            self.event,
            RuntimeCallEvent::StartTerminalSession | RuntimeCallEvent::StartCodeServerSession
        ) {
            return std::time::Duration::from_secs(15);
        }
        if self.event != RuntimeCallEvent::ExecuteCommand {
            return super::device_sync::RUNTIME_RPC_TIMEOUT;
        }
        let seconds = self.arg["timeout_seconds"]
            .as_i64()
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS)
            .min(MAX_COMMAND_TIMEOUT_SECONDS);
        std::time::Duration::from_secs((seconds + SOCKET_ACK_GRACE_SECONDS) as u64)
    }
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

/// Redis adapter publisher for the per-socket ordered `runtime:rpc` callbacks.
///
/// Mirrors the Source's `_return_callback` publish; the sequencer decides when
/// each callback leaves so one socket's callbacks keep their callback-id order.
fn callback_sequencer_sink(
    redis: Option<brz_redis::RedisService>,
) -> super::callback_sequencer::PublishSink {
    Arc::new(
        move |callback: super::callback_sequencer::SequencedCallback| {
            let redis = redis.clone();
            Box::pin(async move {
                let Some(redis) = redis else {
                    tracing::warn!(
                        room = %callback.room,
                        id = callback.id,
                        "runtime:rpc Redis adapter is unavailable; no callback is published"
                    );
                    return;
                };
                use brz_redis::Redis as _;
                let message = super::device_sync::callback_message(
                    &callback.host_id,
                    &callback.room,
                    &callback.namespace,
                    callback.id,
                    callback.ack,
                );
                let message = crate::json_compat::python_json_value(&message);
                if let Err(error) = redis
                    .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
                    .await
                {
                    tracing::error!(
                        %error,
                        room = %callback.room,
                        id = callback.id,
                        "runtime:rpc callback publish failed"
                    );
                }
            })
        },
    )
}

/// Startup-owned handles shared by every Socket.IO handler.
pub struct SocketRuntime {
    emitters: std::sync::OnceLock<Arc<SocketEmitters>>,
    /// `_sync_global_capabilities_to_registered_device` (registration) jobs.
    /// The capability sync awaits the device's remote socket ACK, so it must
    /// never share a queue with the heartbeat's plugin-removal drain.
    jobs: mpsc::Sender<DeviceJob>,
    /// `sync_pending_plugin_removals` (heartbeat) jobs.
    ///
    /// Source `device_namespace.py:1815` and `:2191` schedule the registration
    /// capability sync and the plugin-removal drain as independent event-loop
    /// tasks; one registration parked on a device ACK must not delay the
    /// removal scan. One consumer keeps this class's own order.
    plugin_removal_jobs: mpsc::Sender<DeviceJob>,
    /// `reconcile_device_executions` after registration: its own bounded queue
    /// so the read is never queued behind the capability sync, exactly like
    /// the source's independent event-loop task.
    reconcile_jobs: mpsc::Sender<super::device_reconcile::ReconcileJob>,
    rpc_jobs: mpsc::Sender<RuntimeRpcCall>,
    /// Ordinary inbound adapter broadcasts, delivered locally to their room.
    emit_jobs: mpsc::Sender<super::device_sync::AdapterEmit>,
    /// `_sync_runtime_auth_for_heartbeat_device`: its own bounded queue so the
    /// read never queues behind the registration capability sync, exactly like
    /// the source's independent event-loop task.
    auth_sync_jobs: mpsc::Sender<super::device_auth_sync::RuntimeAuthSyncJob>,
    /// `_runtime_auth_sync_inflight`: one `(user, device, runtime)` key while
    /// the source's task is still running.
    auth_sync_inflight: Arc<Mutex<std::collections::HashSet<super::device_auth_sync::InflightKey>>>,
    rate_limiter: ConnectionRateLimiter,
    registrations: RegistrationDebounce,
    callback_ids: Arc<CallbackIds>,
    event_order: super::runtime_event_order::RuntimeEventOrder,
    response_event_order: super::runtime_event_order::RuntimeEventOrder<i64>,
    /// The callback registry shared with the sequencer, installed before the
    /// adapter sink accepts its first inbound `runtime:rpc` call.
    in_flight: std::sync::OnceLock<Arc<super::callback_sequencer::InFlightRegistry>>,
}

impl SocketRuntime {
    /// `/local-executor` `runtime:event` arrival-order positions.
    ///
    /// Source `_get_runtime_event_lock(sid)`: one session's Runtime events stay
    /// ordered even though the namespace dispatches them concurrently. The
    /// position is taken synchronously in the handler closure, before the
    /// transport spawns the frame's future, because only that receive point
    /// still sees arrival order.
    #[must_use]
    pub fn runtime_event_order(&self) -> &super::runtime_event_order::RuntimeEventOrder {
        &self.event_order
    }

    pub(super) fn response_event_order(
        &self,
    ) -> &super::runtime_event_order::RuntimeEventOrder<i64> {
        &self.response_event_order
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

/// The queues whose startup-owned workers [`SocketRuntime::install`] starts.
pub(crate) struct SocketRuntimeWorkers {
    pub jobs: mpsc::Receiver<DeviceJob>,
    /// The heartbeat's `sync_pending_plugin_removals` drain, consumed by its
    /// own worker so a registration capability sync parked on a device ACK
    /// cannot delay it.
    pub plugin_removal_jobs: mpsc::Receiver<DeviceJob>,
    pub rpc_jobs: mpsc::Receiver<RuntimeRpcCall>,
    pub reconcile_jobs: mpsc::Receiver<super::device_reconcile::ReconcileJob>,
    pub emit_jobs: mpsc::Receiver<super::device_sync::AdapterEmit>,
    pub auth_sync_jobs: mpsc::Receiver<super::device_auth_sync::RuntimeAuthSyncJob>,
}

impl SocketRuntime {
    /// Creates the handles shared by every Socket.IO handler.
    ///
    /// The follow-up workers start in [`SocketRuntime::install`] once the
    /// namespaces exist; the receivers stay here until then.
    pub(crate) fn new() -> (Arc<SocketRuntime>, SocketRuntimeWorkers) {
        let (jobs, receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        // Source `device_namespace.py:1815` schedules the registration
        // capability sync and `:2191` schedules the heartbeat's
        // `sync_pending_plugin_removals` as independent event-loop tasks. The
        // capability sync awaits the device's remote ACK, so the removal drain
        // gets its own bounded queue and consumer to keep that parallelism.
        let (plugin_removal_jobs, plugin_removal_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        let (reconcile_jobs, reconcile_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        // The remote RPC consumer is a separate startup-owned task: a
        // registration sync waiting on its ACK must not delay an inbound
        // `runtime:rpc` call.
        let (rpc_jobs, rpc_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        // Ordinary inbound adapter broadcasts get their own bounded queue: the
        // delivery is a local room emit, never a re-publish. Streaming frames
        // are high-frequency, so this queue uses the larger bound.
        let (emit_jobs, emit_receiver) = mpsc::channel(EMIT_QUEUE_CAPACITY);
        // The heartbeat runtime-auth read gets its own queue so it never waits
        // behind a registration capability sync that is parked on an ACK.
        let (auth_sync_jobs, auth_sync_receiver) = mpsc::channel(JOB_QUEUE_CAPACITY);
        (
            Arc::new(Self {
                emitters: std::sync::OnceLock::new(),
                jobs,
                plugin_removal_jobs,
                reconcile_jobs,
                rpc_jobs,
                emit_jobs,
                auth_sync_jobs,
                auth_sync_inflight: Arc::new(Mutex::new(std::collections::HashSet::new())),
                rate_limiter: ConnectionRateLimiter::default(),
                registrations: RegistrationDebounce::default(),
                callback_ids: Arc::new(CallbackIds::default()),
                event_order: super::runtime_event_order::RuntimeEventOrder::default(),
                response_event_order: super::runtime_event_order::RuntimeEventOrder::default(),
                in_flight: std::sync::OnceLock::new(),
            }),
            SocketRuntimeWorkers {
                jobs: receiver,
                plugin_removal_jobs: plugin_removal_receiver,
                rpc_jobs: rpc_receiver,
                reconcile_jobs: reconcile_receiver,
                emit_jobs: emit_receiver,
                auth_sync_jobs: auth_sync_receiver,
            },
        )
    }

    /// Builds the outgoing events after namespace registration and starts the
    /// follow-up worker.
    ///
    /// Called once during service construction, before the listener serves any
    /// request, so the worker is initialization-owned. The spawned task stops
    /// when the queue closes or the process begins shutting down.
    pub(crate) fn install(
        self: &Arc<Self>,
        state: Arc<AppState>,
        server: &Server,
        workers: SocketRuntimeWorkers,
    ) -> Result<(), BoxError> {
        let SocketRuntimeWorkers {
            jobs: receiver,
            plugin_removal_jobs: plugin_removal_receiver,
            rpc_jobs: rpc_receiver,
            reconcile_jobs: reconcile_receiver,
            emit_jobs: emit_receiver,
            auth_sync_jobs: auth_sync_receiver,
        } = workers;
        // `EventEmitter::new` requires the namespace to be registered, so this
        // runs after `handlers!` has exported every namespace.
        let emitters = Arc::new(
            SocketEmitters::new(server)
                .map_err(|error| -> BoxError { format!("Socket.IO emitters: {error}").into() })?,
        );
        if self.emitters.set(Arc::clone(&emitters)).is_err() {
            return Err("Socket.IO emitters installed twice".into());
        }
        // The migrated publishers deliver locally first (`_handle_emit`) and
        // then publish, so the process's own subscribers need these handles.
        set_local_emitters(Arc::clone(&emitters));
        // The callback registry shared by the adapter sink (which registers
        // every accepted inbound call) and the sequencer (which holds a later
        // acknowledgement behind an earlier accepted id). Installed before the
        // sink is handed to the RPC service.
        let in_flight = state
            .socketio_rpc
            .as_ref()
            .map_or_else(super::callback_sequencer::InFlightRegistry::shared, |rpc| {
                rpc.in_flight()
            });
        let _ = self.in_flight.set(Arc::clone(&in_flight));
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
        // The heartbeat's `sync_pending_plugin_removals` drain runs on its own
        // consumer, exactly like the source's independent `asyncio` task, so a
        // registration capability sync parked on the device ACK cannot delay
        // its `plugin_device_installations` scan.
        tokio::spawn(super::device_sync::run_plugin_removal_worker(
            plugin_removal_receiver,
            Arc::clone(&state),
            Arc::clone(&emitters),
            Arc::clone(&self.callback_ids),
        ));
        // The heartbeat's runtime-auth read is independent of the
        // registration capability sync, exactly like the source's
        // `asyncio.create_task`, so it gets its own startup-owned consumer.
        tokio::spawn(super::device_auth_sync::run_worker(
            auth_sync_receiver,
            Arc::clone(&state),
            Arc::clone(&self.auth_sync_inflight),
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
                Arc::downgrade(self),
            ));
        }
        // The source publishes each `runtime:rpc` acknowledgement on the event
        // loop, so callbacks leave in the order the device acknowledges them.
        // The worker pool completes concurrently, so the publish is ordered by
        // a per-socket sequencer; the downlink calls themselves stay
        // concurrent.
        let callback_sequencer = super::callback_sequencer::CallbackSequencer::new(
            callback_sequencer_sink(state.redis.clone()),
            in_flight,
        );
        // The source executor dispatches every inbound event to its own
        // handler task, so one slow acknowledgement must not head-of-line
        // block another call. A fixed, startup-owned pool of workers over one
        // bounded queue gives the same bounded concurrency without per-call
        // tasks.
        let rpc_receiver = Arc::new(tokio::sync::Mutex::new(rpc_receiver));
        for _ in 0..RPC_WORKER_COUNT {
            let receiver = Arc::clone(&rpc_receiver);
            let emitters = Arc::clone(&emitters);
            let sequencer = Arc::clone(&callback_sequencer);
            tokio::spawn(super::device_sync::run_rpc_worker(
                receiver, emitters, sequencer,
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
        let in_flight = self.in_flight.get().cloned();
        Arc::new(move |message: Value| {
            if let Some(call) = super::device_sync::inbound_rpc_job(message.clone()) {
                if !emitters.has_local_runtime_recipient(&call.room) {
                    return;
                }
                // The Source emits each callback in the order the device
                // acknowledges the calls it received, so an accepted call must
                // be registered before the worker hands it to the socket: a
                // later acknowledgement then waits for an earlier accepted id
                // instead of overtaking it. The budget is the worker's own
                // acknowledgement timeout, so an unacknowledged call never
                // holds anything past the point it can still answer.
                let identity = (
                    call.host_id.clone(),
                    call.namespace.clone(),
                    call.room.clone(),
                    call.id,
                );
                let ordered = in_flight
                    .as_ref()
                    .filter(|_| call.event != RuntimeCallEvent::SyncCapabilities);
                if let Some(registry) = ordered {
                    registry.register(
                        &identity.0,
                        &identity.1,
                        &identity.2,
                        identity.3,
                        tokio::time::Instant::now() + call.ack_timeout(),
                    );
                }
                if rpc_jobs.try_send(call).is_err() {
                    // No worker will acknowledge a dropped call, so it must not
                    // hold a later callback behind it.
                    if let Some(registry) = ordered {
                        registry.resolve(&identity.0, &identity.1, &identity.2, identity.3);
                    }
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

    /// Installs the callback registry the adapter sink registers accepted
    /// calls in. Production wires it during [`SocketRuntime::install`].
    #[cfg(test)]
    pub(crate) fn install_in_flight(
        &self,
        registry: Arc<super::callback_sequencer::InFlightRegistry>,
    ) {
        let _ = self.in_flight.set(registry);
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
    ///
    /// The registration capability sync and the heartbeat's plugin-removal
    /// drain are independent source tasks, so each class has its own queue and
    /// consumer; this keeps the drain parallel to a capability sync that is
    /// parked on the device's remote ACK.
    pub fn enqueue(&self, job: DeviceJob) {
        let (queue, class) = match &job {
            DeviceJob::RegisterSync { .. } => (&self.jobs, "registration"),
            DeviceJob::PluginRemoval { .. } => (&self.plugin_removal_jobs, "plugin removal"),
        };
        if let Err(error) = queue.try_send(job) {
            tracing::error!(
                %error,
                class,
                "Socket.IO device follow-up queue rejected work"
            );
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

    /// `_schedule_runtime_auth_sync_after_heartbeat`: dedupe one
    /// `(user, device, runtime)` key while the source's task is in flight, then
    /// hand the read to its own worker.
    pub fn enqueue_runtime_auth_sync(&self, user_id: i64, device_id: &str) {
        let key = (
            user_id,
            device_id.to_owned(),
            super::device_heartbeat::CODEX_RUNTIME.to_owned(),
        );
        let mut inflight = self
            .auth_sync_inflight
            .lock()
            .expect("runtime auth sync inflight");
        if !inflight.insert(key.clone()) {
            return;
        }
        drop(inflight);
        if let Err(error) =
            self.auth_sync_jobs
                .try_send(super::device_auth_sync::RuntimeAuthSyncJob {
                    user_id,
                    device_id: device_id.to_owned(),
                })
        {
            tracing::error!(%error, "Socket.IO runtime auth sync queue rejected work");
            self.auth_sync_inflight
                .lock()
                .expect("runtime auth sync inflight")
                .remove(&key);
        }
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
        let (runtime, workers) = SocketRuntime::new();
        let SocketRuntimeWorkers {
            jobs: mut register,
            rpc_jobs: mut rpc,
            ..
        } = workers;
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
                event: RuntimeCallEvent::RuntimeRpc,
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

    /// `_sync_global_capabilities_to_registered_device` (registration) awaits
    /// the device's remote ACK; the heartbeat's `sync_pending_plugin_removals`
    /// is an independent source task, so a parked registration sync must not
    /// delay the removal drain.
    #[tokio::test]
    async fn plugin_removal_is_not_blocked_by_a_pending_registration_sync() {
        let (runtime, workers) = SocketRuntime::new();
        let SocketRuntimeWorkers {
            jobs: mut register,
            plugin_removal_jobs: mut removals,
            ..
        } = workers;
        let (parked, parked_rx) = tokio::sync::oneshot::channel();
        runtime.enqueue_plugin_removal(1, "device-1");
        assert!(
            register.try_recv().is_err(),
            "the removal job never shares the registration queue"
        );
        tokio::spawn(async move {
            // Park on the registration job like a capability sync awaiting the
            // device's remote ACK.
            let _pending = register.recv().await;
            let _ = parked.send(());
            std::future::pending::<()>().await;
        });
        runtime.enqueue(DeviceJob::RegisterSync {
            user_id: 1,
            device_id: "device-1".into(),
        });
        parked_rx.await.expect("the registration sync started");
        let job = tokio::time::timeout(std::time::Duration::from_millis(200), removals.recv())
            .await
            .expect("the removal drain is not blocked by the parked registration")
            .expect("the removal job is delivered");
        assert!(matches!(job, DeviceJob::PluginRemoval { .. }));
    }

    /// Each class has its own queue and consumer, so both keep their own order
    /// and their own bound instead of one shared head-of-line.
    #[tokio::test]
    async fn each_device_job_class_keeps_its_own_order() {
        let (runtime, workers) = SocketRuntime::new();
        let SocketRuntimeWorkers {
            mut jobs,
            mut plugin_removal_jobs,
            ..
        } = workers;
        runtime.enqueue_plugin_removal(1, "removal-a");
        runtime.enqueue_plugin_removal(1, "removal-b");
        runtime.enqueue(DeviceJob::RegisterSync {
            user_id: 1,
            device_id: "register-c".into(),
        });
        runtime.enqueue(DeviceJob::RegisterSync {
            user_id: 1,
            device_id: "register-d".into(),
        });
        let first_removal = plugin_removal_jobs.recv().await;
        let second_removal = plugin_removal_jobs.recv().await;
        assert!(matches!(
            first_removal,
            Some(DeviceJob::PluginRemoval { ref device_id, .. }) if device_id == "removal-a"
        ));
        assert!(matches!(
            second_removal,
            Some(DeviceJob::PluginRemoval { ref device_id, .. }) if device_id == "removal-b"
        ));
        let first_register = jobs.recv().await;
        let second_register = jobs.recv().await;
        assert!(matches!(
            first_register,
            Some(DeviceJob::RegisterSync { ref device_id, .. }) if device_id == "register-c"
        ));
        assert!(matches!(
            second_register,
            Some(DeviceJob::RegisterSync { ref device_id, .. }) if device_id == "register-d"
        ));
    }

    /// `_runtime_auth_sync_inflight`: the same `(user, device, runtime)` key is
    /// not scheduled twice while its task is still running, and another device
    /// is independent.
    #[tokio::test]
    async fn runtime_auth_sync_dedupes_one_device_while_in_flight() {
        let (runtime, workers) = SocketRuntime::new();
        let SocketRuntimeWorkers {
            auth_sync_jobs: mut auth,
            ..
        } = workers;
        runtime.enqueue_runtime_auth_sync(7, "device-a");
        runtime.enqueue_runtime_auth_sync(7, "device-a");
        let first = auth.try_recv().expect("the first heartbeat is scheduled");
        assert_eq!(first.user_id, 7);
        assert_eq!(first.device_id, "device-a");
        assert!(
            auth.try_recv().is_err(),
            "the duplicate heartbeat is deduped while the first task runs"
        );
        runtime.enqueue_runtime_auth_sync(7, "device-b");
        let other = auth.try_recv().expect("another device is independent");
        assert_eq!(other.device_id, "device-b");
    }
}
