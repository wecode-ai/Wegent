// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local wire tests for the ordinary adapter broadcast bridge.
//!
//! A standalone local Socket.IO server with three polling clients proves the
//! production `ArgsTuple -> SocketEmitters::emit_room -> operators.to/except ->
//! parser` wiring: exact room delivery, `skip_sid` exclusion, self-echo
//! suppression, and the four argument shapes. The polling client is test-only
//! and lives under `tests/support/`.
#![cfg(test)]

#[path = "../../tests/support/engineio_poll_client.rs"]
mod engineio_poll_client;

use std::sync::Arc;
use std::time::Duration;

use brz_socket_io::extract::{Data, SocketRef};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::callback_sequencer::{
    CallbackSequencer, InFlightRegistry, PublishSink, SequencedCallback,
};
use super::device_sync::{ArgsTuple, adapter_emit_job, run_rpc_worker};
use super::runtime::{EXECUTOR_NAMESPACE, SocketEmitters, SocketRuntime, SocketRuntimeWorkers};

use engineio_poll_client::{EventPacket, PollClient};
use tokio::sync::Mutex as AsyncMutex;

/// The event name every broadcast in these tests uses.
const EVENT: &str = "device:slot_update";
/// How long a delivery or an absence is observed.
const WINDOW: Duration = Duration::from_millis(400);

/// One standalone server: address, production emitters and shutdown.
struct WireServer {
    addr: String,
    emitters: Arc<SocketEmitters>,
    stop: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
}

impl WireServer {
    /// Build the local server with the four namespaces `SocketEmitters` needs.
    async fn start() -> Self {
        let server = brz_socket_io::Server::builder()
            .build()
            .await
            .expect("local Socket.IO server");
        // `/chat`: the connect auth names the room. Test wiring only; the
        // production `/chat` admission is untouched.
        server.io().ns(
            "/chat",
            async |socket: SocketRef, Data(auth): Data<Value>| {
                if let Some(room) = auth.get("room").and_then(Value::as_str) {
                    socket.join(room.to_owned());
                }
            },
        );
        server
            .io()
            .ns(EXECUTOR_NAMESPACE, async |socket: SocketRef| {
                // Match the private room installed by `brz-socket-io` admission.
                socket.join(socket.id);
            });
        server.io().ns("/wework-runtime", async |_: SocketRef| {});
        // `/terminal`: the browser relay's connect takes the stored session.
        server
            .io()
            .ns(super::runtime::TERMINAL_NAMESPACE, async |_: SocketRef| {});
        let emitters = Arc::new(SocketEmitters::for_test(&server).expect("outgoing emitters"));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let addr = listener.local_addr().expect("address").to_string();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = server
                .serve(listener, async {
                    let _ = stopped.await;
                })
                .await;
        });
        Self {
            addr,
            emitters,
            stop,
            handle,
        }
    }

    async fn poller(&self, room: &str) -> Arc<engineio_poll_client::Poller> {
        let client = PollClient::connect(&self.addr, "/chat", &json!({"room": room}).to_string())
            .await
            .expect("polling client connects");
        Arc::new(client.into_poller())
    }
}

fn runtime_rpc_frame(sid: &str) -> Value {
    json!({
        "method": "emit",
        "event": "runtime:rpc",
        "namespace": EXECUTOR_NAMESPACE,
        "room": sid,
        "callback": [sid, EXECUTOR_NAMESPACE, 7],
        "host_id": "remote-host",
        "data": [{"method": "runtime.tasks.list", "payload": {}}],
    })
}

/// An accepted inbound call registers its callback identity before a worker
/// hands it to the device, so a later acknowledgement cannot overtake it
/// (`06040002` `b02e8ec6`).
#[tokio::test]
async fn runtime_rpc_admission_registers_the_accepted_callback_identity() {
    let server = WireServer::start().await;
    let (runtime, workers) = SocketRuntime::new();
    let registry = InFlightRegistry::shared();
    runtime.install_in_flight(Arc::clone(&registry));
    let SocketRuntimeWorkers {
        rpc_jobs: mut calls,
        ..
    } = workers;
    let sink = runtime.adapter_emit_sink(Arc::clone(&server.emitters));
    let local = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("the addressed local executor");
    sink(runtime_rpc_frame(local.socket_id()));
    let call = calls.try_recv().expect("the local RPC is queued");
    assert!(
        registry.pending(
            "remote-host",
            EXECUTOR_NAMESPACE,
            local.socket_id(),
            call.id
        ),
        "the accepted call holds later acknowledgements until it resolves"
    );
}

#[tokio::test]
async fn runtime_rpc_admission_ignores_nonlocal_sessions_before_queueing() {
    let server = WireServer::start().await;
    let other = WireServer::start().await;
    let (runtime, workers) = SocketRuntime::new();
    let SocketRuntimeWorkers {
        rpc_jobs: mut calls,
        ..
    } = workers;
    let sink = runtime.adapter_emit_sink(Arc::clone(&server.emitters));

    // More than the queue capacity: foreign broadcasts must consume no slots.
    for _ in 0..300 {
        sink(runtime_rpc_frame("not-a-local-session"));
    }
    assert!(matches!(
        calls.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    let chat = PollClient::connect(&server.addr, "/chat", "{}")
        .await
        .expect("a local connection in another namespace");
    let remote = PollClient::connect(&other.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("an executor connected to another process");
    sink(runtime_rpc_frame(chat.socket_id()));
    sink(runtime_rpc_frame(remote.socket_id()));
    assert!(matches!(
        calls.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    let local = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("the addressed local executor");
    sink(runtime_rpc_frame(local.socket_id()));
    let call = calls.try_recv().expect("the local RPC is queued");
    assert_eq!(call.room, local.socket_id());
    assert_eq!(call.namespace, EXECUTOR_NAMESPACE);
    assert_eq!(call.host_id, "remote-host");
    assert_eq!(call.id, 7);
    assert_eq!(
        call.arg,
        json!({"method": "runtime.tasks.list", "payload": {}})
    );

    local
        .post("41/local-executor,")
        .await
        .expect("the local executor disconnects");
    tokio::time::timeout(Duration::from_secs(1), async {
        while server
            .emitters
            .has_local_runtime_recipient(local.socket_id())
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("disconnected sessions leave their local room");
    sink(runtime_rpc_frame(local.socket_id()));
    assert!(matches!(
        calls.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));

    let _ = server.stop.send(());
    server.handle.await.expect("local server stopped");
    let _ = other.stop.send(());
    other.handle.await.expect("other server stopped");
}

#[tokio::test]
async fn runtime_rpc_keeps_the_local_clients_real_ack() {
    let server = WireServer::start().await;
    let client = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("local executor");
    let payload = json!({"method": "runtime.tasks.list", "payload": {}});
    let ack = json!({"success": true, "tasks": [{"id": "task-1"}]});
    let reply = async {
        let packets = client.poll_packets().await.expect("the RPC packet");
        let packet = packets
            .iter()
            .find_map(|packet| packet.strip_prefix("42/local-executor,"))
            .expect("an addressed event with an ACK id");
        let start = packet.find('[').expect("event arguments");
        let id: u64 = packet[..start].parse().expect("the ACK id");
        let args: Value = serde_json::from_str(&packet[start..]).expect("event JSON");
        assert_eq!(args, json!(["runtime:rpc", payload]));
        client
            .post(&format!("43/local-executor,{id}[{ack}]"))
            .await
            .expect("the client's real ACK");
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            server
                .emitters
                .runtime_rpc(client.socket_id(), &payload, Duration::from_secs(2)),
            reply
        )
    })
    .await
    .expect("the local RPC completes");
    assert_eq!(result.expect("successful ACK"), ack);

    let _ = server.stop.send(());
    server.handle.await.expect("server stopped");
}

#[tokio::test]
async fn runtime_rpc_keeps_real_local_ack_timeouts_as_errors() {
    let server = WireServer::start().await;
    let client = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("local executor");
    let result = server
        .emitters
        .runtime_rpc(
            client.socket_id(),
            &json!({"method": "runtime.tasks.list", "payload": {}}),
            Duration::from_millis(20),
        )
        .await;
    assert!(matches!(
        result,
        Err(brz_socket_io::EmitterError::Ack(
            brz_socket_io::AckError::Timeout
        ))
    ));

    let _ = server.stop.send(());
    server.handle.await.expect("server stopped");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_broadcasts_reach_only_their_room_and_argument_shape() {
    let server = WireServer::start().await;
    let a = server.poller("room1").await;
    let b = server.poller("room2").await;
    let c = server.poller("room1").await;
    let a_task = tokio::spawn(Arc::clone(&a).run());
    let b_task = tokio::spawn(Arc::clone(&b).run());
    let c_task = tokio::spawn(Arc::clone(&c).run());
    // The socket ids are the default rooms used for exclusion.
    let excluded = c.socket_id().to_owned();

    let shapes: Vec<Vec<Value>> = vec![
        vec![],
        vec![json!({"only": 1})],
        vec![json!({"a": 1}), json!({"b": 2})],
        vec![json!([1, 2])],
    ];
    let mut seen = 0;
    for args_in in &shapes {
        let (sent, failed) = server
            .emitters
            .emit_room(
                "/chat",
                EVENT,
                "room1",
                Some(&excluded),
                &ArgsTuple(args_in),
            )
            .await;
        assert_eq!(
            (sent, failed),
            (1, 0),
            "emit_room delivered to the room1 peer"
        );
        let event = a
            .next_event(seen, WINDOW)
            .await
            .unwrap_or_else(|| panic!("A receives {args_in:?}"));
        seen += 1;
        assert_eq!(
            event,
            EventPacket {
                namespace: "/chat".into(),
                event: EVENT.into(),
                args: args_in.clone(),
            }
        );
    }

    // Negative evidence over the same window with the transports still open:
    // B is in another room and C is the excluded socket.
    tokio::time::sleep(WINDOW).await;
    assert!(
        b.events().is_empty(),
        "room2 never receives a room1 broadcast"
    );
    assert!(
        c.events().is_empty(),
        "the excluded socket never receives a room1 broadcast"
    );

    // Self-echo: a frame carrying this manager's own host id is not a delivery.
    let own = json!({
        "method": "emit",
        "event": EVENT,
        "data": [{"device_id": "d-1"}],
        "binary": false,
        "namespace": "/chat",
        "room": "room1",
        "skip_sid": null,
        "callback": null,
        "host_id": crate::socketio_emit::host_id(),
    });
    assert!(
        adapter_emit_job(own).is_none(),
        "this manager's own frame is ignored"
    );
    tokio::time::sleep(WINDOW).await;
    assert_eq!(a.events().len(), seen, "self-echo delivers nothing");

    // Every transport stayed open through the observation window, so the empty
    // results above are genuine absence, not dropped connections.
    assert!(
        a.is_alive() && b.is_alive() && c.is_alive(),
        "transports stay open"
    );

    a.stop();
    b.stop();
    c.stop();
    let _ = a_task.await;
    let _ = b_task.await;
    let _ = c_task.await;
    let _ = server.stop.send(());
    let _ = server.handle.await;
}

/// `AsyncPubSubManager._handle_emit`: a migrated publisher delivers to this
/// process's room before it publishes, and its own adapter echo stays ignored,
/// so the local subscriber sees the frame exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_emits_reach_the_room_without_their_own_echo() {
    let server = WireServer::start().await;
    crate::socketio::runtime::set_local_emitters(Arc::clone(&server.emitters));
    let a = server.poller("room1").await;
    let a_task = tokio::spawn(Arc::clone(&a).run());

    crate::socketio::runtime::deliver_local_emit(
        "/chat",
        EVENT,
        "room1",
        None,
        &json!({"device_id": "d-2"}),
    )
    .await;
    let event = a
        .next_event(0, WINDOW)
        .await
        .expect("the local room receives the frame");
    assert_eq!(
        event,
        EventPacket {
            namespace: "/chat".into(),
            event: EVENT.into(),
            args: vec![json!({"device_id": "d-2"})],
        }
    );

    // The publisher's own adapter echo never re-delivers the frame.
    let own = json!({
        "method": "emit",
        "event": EVENT,
        "data": [{"device_id": "d-2"}],
        "binary": false,
        "namespace": "/chat",
        "room": "room1",
        "skip_sid": null,
        "callback": null,
        "host_id": crate::socketio_emit::host_id(),
    });
    assert!(
        adapter_emit_job(own).is_none(),
        "the publisher's own echo is not a local delivery"
    );
    assert!(
        a.next_event(1, WINDOW).await.is_none(),
        "no double delivery"
    );

    a.stop();
    let _ = a_task.await;
    let _ = server.stop.send(());
    let _ = server.handle.await;
}

/// One remote `device:sync_capabilities` adapter envelope addressed to a local
/// executor session.
fn capability_sync_frame(sid: &str, host_id: &str, callback_id: u64, payload: &Value) -> Value {
    json!({
        "method": "emit",
        "event": "device:sync_capabilities",
        "data": [payload],
        "binary": false,
        "namespace": EXECUTOR_NAMESPACE,
        "room": sid,
        "skip_sid": null,
        "callback": [sid, EXECUTOR_NAMESPACE, callback_id],
        "host_id": host_id,
    })
}

/// Answer one capability-sync call with the real client ACK.
async fn answer_capability_sync(client: &PollClient, payload: &Value, ack: &Value) {
    let packets = client
        .poll_packets()
        .await
        .expect("the capability sync packet");
    let packet = packets
        .iter()
        .find_map(|packet| packet.strip_prefix("42/local-executor,"))
        .expect("an addressed event with an ACK id");
    let start = packet.find('[').expect("event arguments");
    let id: u64 = packet[..start].parse().expect("the ACK id");
    let args: Value = serde_json::from_str(&packet[start..]).expect("event JSON");
    assert_eq!(args, json!(["device:sync_capabilities", payload]));
    client
        .post(&format!("43/local-executor,{id}[{ack}]"))
        .await
        .expect("the client's real ACK");
}

/// Wait until `expected` callbacks were published.
async fn wait_published(published: &Arc<AsyncMutex<Vec<SequencedCallback>>>, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if published.lock().await.len() >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the real ACK is published");
}

/// A recording sequencer sink plus a startup-owned RPC consumer.
fn install_capability_callbacks(
    rpc_jobs: tokio::sync::mpsc::Receiver<super::runtime::RuntimeRpcCall>,
    emitters: Arc<SocketEmitters>,
) -> Arc<AsyncMutex<Vec<SequencedCallback>>> {
    let published: Arc<AsyncMutex<Vec<SequencedCallback>>> = Arc::default();
    let recorder = Arc::clone(&published);
    let publish: PublishSink = Arc::new(move |callback| {
        let recorder = Arc::clone(&recorder);
        Box::pin(async move {
            recorder.lock().await.push(callback);
        })
    });
    let sequencer = CallbackSequencer::with_idle_timeout(
        publish,
        InFlightRegistry::shared(),
        Duration::from_secs(1),
    );
    tokio::spawn(run_rpc_worker(
        Arc::new(AsyncMutex::new(rpc_jobs)),
        emitters,
        sequencer,
    ));
    published
}

/// A real adapter envelope reaches the local WebSocket as one
/// `device:sync_capabilities` event, and its real ACK is published back exactly
/// once with the sender's original identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_capability_sync_reaches_the_socket_and_publishes_one_callback() {
    let server = WireServer::start().await;
    let client = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("local executor");
    let sid = client.socket_id().to_owned();
    let (runtime, workers) = SocketRuntime::new();
    let SocketRuntimeWorkers { rpc_jobs, .. } = workers;
    let sink = runtime.adapter_emit_sink(Arc::clone(&server.emitters));
    let published = install_capability_callbacks(rpc_jobs, Arc::clone(&server.emitters));

    let payload = json!({
        "mode": "replace",
        "skills": [],
        "mcps": [],
        "plugins": [{"installed_plugin_id": 448305, "name": "dingtalk"}],
    });
    let ack =
        json!({"success": true, "plugins": [{"installed_plugin_id": 448305, "status": "ok"}]});
    let frame = capability_sync_frame(&sid, "remote-source-host", 1, &payload);
    assert!(
        adapter_emit_job(frame.clone()).is_none(),
        "a callback-bearing frame stays off the plain broadcast path"
    );

    sink(frame);
    tokio::join!(
        answer_capability_sync(&client, &payload, &ack),
        wait_published(&published, 1),
    );

    let callbacks = published.lock().await.clone();
    assert_eq!(callbacks.len(), 1, "exactly one callback is published");
    assert_eq!(callbacks[0].host_id, "remote-source-host");
    assert_eq!(callbacks[0].room, sid);
    assert_eq!(callbacks[0].namespace, EXECUTOR_NAMESPACE);
    assert_eq!(callbacks[0].id, 1);
    assert_eq!(callbacks[0].ack, ack);

    // The worker publishes the callback only: the emit is never re-published,
    // so the socket receives it once and no second callback leaves.
    tokio::time::sleep(WINDOW).await;
    assert_eq!(published.lock().await.len(), 1, "no second publish");
    if let Ok(Ok(packets)) =
        tokio::time::timeout(Duration::from_millis(300), client.poll_packets()).await
    {
        assert!(
            packets
                .iter()
                .all(|packet| !packet.starts_with("42/local-executor,")),
            "the capability sync is delivered exactly once"
        );
    }

    let _ = server.stop.send(());
    let _ = server.handle.await;
}

/// Two publishers may each issue `id = 1` to the same device; their callbacks
/// keep their own sender identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_publishers_with_callback_id_one_do_not_overwrite_each_other() {
    let server = WireServer::start().await;
    let client = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("local executor");
    let sid = client.socket_id().to_owned();
    let (runtime, workers) = SocketRuntime::new();
    let SocketRuntimeWorkers { rpc_jobs, .. } = workers;
    let sink = runtime.adapter_emit_sink(Arc::clone(&server.emitters));
    let published = install_capability_callbacks(rpc_jobs, Arc::clone(&server.emitters));

    for (host, ack) in [
        ("host-a", json!({"success": true, "source": "a"})),
        ("host-b", json!({"success": true, "source": "b"})),
    ] {
        let payload = json!({"mode": "replace", "plugins": [], "host": host});
        sink(capability_sync_frame(&sid, host, 1, &payload));
        let expected = published.lock().await.len() + 1;
        tokio::join!(
            answer_capability_sync(&client, &payload, &ack),
            wait_published(&published, expected),
        );
    }

    let callbacks = published.lock().await.clone();
    assert_eq!(callbacks.len(), 2, "both senders' id 1 published");
    assert_eq!(callbacks[0].host_id, "host-a");
    assert_eq!(callbacks[0].id, 1);
    assert_eq!(callbacks[0].ack, json!({"success": true, "source": "a"}));
    assert_eq!(callbacks[1].host_id, "host-b");
    assert_eq!(callbacks[1].id, 1);
    assert_eq!(callbacks[1].ack, json!({"success": true, "source": "b"}));

    let _ = server.stop.send(());
    let _ = server.handle.await;
}

/// This process's own published capability-sync frame is an echo, not a second
/// delivery: it never reaches the local socket and publishes no callback.
#[tokio::test]
async fn a_capability_sync_self_echo_is_skipped() {
    let server = WireServer::start().await;
    let client = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("local executor");
    let sid = client.socket_id().to_owned();
    let (runtime, workers) = SocketRuntime::new();
    let SocketRuntimeWorkers { mut rpc_jobs, .. } = workers;
    let sink = runtime.adapter_emit_sink(Arc::clone(&server.emitters));

    let payload = json!({"mode": "replace", "plugins": []});
    let own = capability_sync_frame(&sid, crate::socketio_emit::host_id(), 1, &payload);
    sink(own);
    assert!(
        matches!(
            rpc_jobs.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ),
        "the self echo is never queued for delivery"
    );
    if let Ok(Ok(packets)) =
        tokio::time::timeout(Duration::from_millis(300), client.poll_packets()).await
    {
        assert!(
            packets
                .iter()
                .all(|packet| !packet.starts_with("42/local-executor,")),
            "the self echo is not delivered"
        );
    }

    let _ = server.stop.send(());
    let _ = server.handle.await;
}

/// Diagnostic repro for the replay lifetime race: a namespace DISCONNECT
/// delivered back-to-back with a no-ACK event must not drop the event's
/// already-spawned handler.
///
/// The production handler chain is exactly `recv_event -> handler.call ->
/// tokio::spawn`; the DISCONNECT packet then synchronously clears
/// `connected`, so a current-thread dispatcher processes both packets before
/// the spawned future can run. The handler still starts, but its first
/// framework step (`ensure_active`) is rejected, and a no-ACK event has no
/// client-visible failure. `20261106030002/8773853d` shows the application
/// consequence: the `runtime:event` projection reads and publishes never
/// happen while every preceding event's dependencies were consumed.
#[tokio::test(flavor = "current_thread")]
async fn a_back_to_back_namespace_disconnect_rejects_the_spawned_event() {
    use brz_socket_io::__private::{AckContext, NamespaceMetrics, ensure_active, prepare};
    use brz_socket_io::adapter::LocalAdapter;

    let server = brz_socket_io::Server::builder()
        .build()
        .await
        .expect("local Socket.IO server");
    let (seen, mut outcomes) = tokio::sync::mpsc::unbounded_channel::<bool>();
    server.io().ns(
        "/race",
        move |socket: SocketRef, Data(_auth): Data<Value>| {
            let seen = seen.clone();
            async move {
                // The production namespace registration installs this state
                // before any event can be dispatched.
                prepare(
                    &socket,
                    None,
                    brz_socket_io::Accept::default(),
                    NamespaceMetrics::new("/race"),
                    None,
                );
                socket.on(
                    "race",
                    move |socket: SocketRef<LocalAdapter>, _ack: AckContext<LocalAdapter>| {
                        let seen = seen.clone();
                        async move {
                            let accepted = ensure_active(&socket).is_ok();
                            let _ = seen.send(accepted);
                        }
                    },
                );
            }
        },
    );
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let addr = listener.local_addr().expect("address").to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = server
            .serve(listener, async {
                let _ = stopped.await;
            })
            .await;
    });
    let client = PollClient::connect(&addr, "/race", "{}")
        .await
        .expect("polling client connects");
    // One Engine.IO payload carries the event and the namespace DISCONNECT in
    // the same transport read, exactly like the recorded `42...` + `41...` pair.
    client
        .post("42/race,[\"race\",{}]\u{1e}41/race,")
        .await
        .expect("back-to-back packets are accepted");
    let observed = tokio::time::timeout(WINDOW, outcomes.recv()).await;
    let _ = stop.send(());
    let _ = handle.await;
    assert_eq!(
        observed,
        Ok(Some(false)),
        "the spawned handler must run and observe the disconnect"
    );
}

/// One accepted-before-close session for the lifecycle regression below.
#[derive(Debug)]
struct AcceptedSession {
    user_id: i64,
}

/// Regression for the transport fix: the event's session context must be
/// captured at the synchronous receive point. A namespace DISCONNECT in the
/// same Engine.IO payload must not cancel the already-accepted handler's
/// business effects, while the framework still rejects ACK/room mutations
/// because `complete_event`/`apply_reply` re-check liveness.
#[tokio::test(flavor = "current_thread")]
async fn an_accepted_event_runs_after_a_back_to_back_namespace_disconnect() {
    use brz_socket_io::__private::{AckContext, NamespaceMetrics, prepare, session};
    use brz_socket_io::adapter::LocalAdapter;

    let server = brz_socket_io::Server::builder()
        .build()
        .await
        .expect("local Socket.IO server");
    let (seen, mut outcomes) = tokio::sync::mpsc::unbounded_channel::<(i64, bool)>();
    // The production namespace registration installs `prepare` from its
    // middleware and then marks the prepared state online; using
    // `namespace_handler` here reproduces that ordering instead of a raw
    // socketioxide namespace.
    let middleware = move |input: brz_socket_io::__private::ConnectInput<LocalAdapter>| {
        let seen = seen.clone();
        async move {
            let socket = input.socket();
            prepare(
                &socket,
                None,
                brz_socket_io::Accept::new(AcceptedSession { user_id: 7 }),
                NamespaceMetrics::new("/race-accepted"),
                None,
            );
            socket.on(
                "race",
                move |socket: SocketRef<LocalAdapter>, _ack: AckContext<LocalAdapter>| {
                    // The fix: resolve the typed session synchronously, in
                    // the receive section, before the dispatcher can apply a
                    // following DISCONNECT packet.
                    let accepted = session::<AcceptedSession, _>(&socket);
                    let seen = seen.clone();
                    async move {
                        let accepted = accepted.expect("accepted before disconnect");
                        let _ = seen.send((accepted.user_id, socket.connected()));
                    }
                },
            );
            Ok::<(), Box<dyn std::fmt::Display + Send>>(())
        }
    };
    let handler = brz_socket_io::__private::namespace_handler(
        middleware,
        NamespaceMetrics::new("/race-accepted"),
    );
    server.io().ns("/race-accepted", handler);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let addr = listener.local_addr().expect("address").to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = server
            .serve(listener, async {
                let _ = stopped.await;
            })
            .await;
    });
    let client = PollClient::connect(&addr, "/race-accepted", "{}")
        .await
        .expect("polling client connects");
    client
        .post("42/race-accepted,[\"race\",{}]\u{1e}41/race-accepted,")
        .await
        .expect("back-to-back packets are accepted");
    let observed = tokio::time::timeout(WINDOW, outcomes.recv()).await;
    let _ = stop.send(());
    let _ = handle.await;
    assert_eq!(
        observed,
        Ok(Some((7, false))),
        "the accepted handler runs with its captured session after the disconnect"
    );
}

/// A background capability sync must not deliver locally when the client has
/// left: the source's `sio.call` has no local receiver then and only the
/// adopted adapter frame is sent.
#[tokio::test]
async fn a_missing_executor_socket_has_no_local_recipient() {
    let server = WireServer::start().await;
    assert!(!server.emitters.has_local_executor_socket("missing-sid"));
    let client = PollClient::connect(&server.addr, EXECUTOR_NAMESPACE, "{}")
        .await
        .expect("executor connects");
    assert!(
        server
            .emitters
            .has_local_executor_socket(client.socket_id())
    );
    let _ = server.stop.send(());
    let _ = server.handle.await;
}
