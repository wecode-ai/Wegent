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

use super::device_sync::{ArgsTuple, adapter_emit_job};
use super::runtime::{EXECUTOR_NAMESPACE, SocketEmitters, SocketRuntime};

use engineio_poll_client::{EventPacket, PollClient};

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
    /// Build the local server with the three namespaces `SocketEmitters` needs.
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

#[tokio::test]
async fn runtime_rpc_admission_ignores_nonlocal_sessions_before_queueing() {
    let server = WireServer::start().await;
    let other = WireServer::start().await;
    let (runtime, _register, mut calls, _reconcile, _emit) = SocketRuntime::new();
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
