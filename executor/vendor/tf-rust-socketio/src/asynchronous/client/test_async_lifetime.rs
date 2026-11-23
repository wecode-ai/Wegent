use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Weak,
    },
    task::Context,
};

use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::{JoinHandle, JoinSet},
    time::Duration,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use super::Client;
use crate::{asynchronous::ClientBuilder, TransportType};

const DEADLINE: Duration = Duration::from_secs(2);

struct Server {
    url: String,
    task: JoinHandle<Vec<String>>,
    messages: mpsc::UnboundedReceiver<String>,
}

impl Server {
    async fn rejecting() -> Self {
        Self::responding(r#"44/local-executor,{"message":"invalid token"}"#).await
    }

    async fn responding(response: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (tx, messages) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(tcp).await.unwrap();
            ws.send(Message::text(
                r#"0{"sid":"lifetime-test","upgrades":[],"pingInterval":100000,"pingTimeout":100000}"#,
            ))
            .await
            .unwrap();
            let mut received = Vec::new();
            while let Some(message) = ws.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if text == "3" && response == "close-on-pong" {
                            ws.send(Message::Close(None)).await.unwrap();
                        }
                        if text.starts_with("40/local-executor,") {
                            assert!(text.contains("invalid-token"));
                            ws.send(Message::text(response)).await.unwrap();
                        }
                        // Deliberately keep the rejected transport open, even
                        // after Engine.IO Close. Assert actual EOF/WS close.
                        let _ = tx.send(text.clone());
                        received.push(text);
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            received
        });
        Self {
            url,
            task,
            messages,
        }
    }

    async fn assert_released(&mut self) -> Vec<String> {
        tokio::time::timeout(DEADLINE, &mut self.task)
            .await
            .expect("rejected WebSocket remained open after client teardown")
            .expect("protocol server failed")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn builder(url: &str) -> (ClientBuilder, mpsc::UnboundedReceiver<()>, Weak<()>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let builder = base_builder(url).on("error", move |payload, _| {
        let capture = capture.clone();
        let tx = tx.clone();
        async move {
            assert!(format!("{payload:?}").contains("invalid token"));
            let _capture = capture;
            tx.send(()).unwrap();
        }
        .boxed()
    });
    (builder, rx, weak)
}

fn base_builder(url: &str) -> ClientBuilder {
    ClientBuilder::new(url)
        .namespace("/local-executor")
        .transport_type(TransportType::Websocket)
        .reconnect(false)
        .auth(json!({"token": "invalid-token"}))
}

async fn assert_callbacks_released(weak: Weak<()>) {
    tokio::time::timeout(DEADLINE, async {
        while weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reader or dispatch task retained callback captures");
}

#[tokio::test]
async fn rejected_namespace_disconnect_releases_websocket_and_callbacks() {
    let mut server = Server::rejecting().await;
    let (builder, mut rejected, weak) = builder(&server.url);
    let client = builder.connect().await.unwrap();
    tokio::time::timeout(DEADLINE, rejected.recv())
        .await
        .unwrap()
        .unwrap();
    let result = client.disconnect().await;
    drop(client);
    let packets = server.assert_released().await;
    assert!(
        packets.iter().any(|packet| packet == "1"),
        "Engine.IO Close was not sent"
    );
    assert_callbacks_released(weak).await;
    assert!(result.is_ok(), "disconnect after CONNECT_ERROR: {result:?}");
}

#[tokio::test]
async fn rejected_namespace_drop_releases_websocket_and_callbacks() {
    let mut server = Server::rejecting().await;
    let (builder, mut rejected, weak) = builder(&server.url);
    let client = builder.connect().await.unwrap();
    tokio::time::timeout(DEADLINE, rejected.recv())
        .await
        .unwrap()
        .unwrap();
    drop(client);
    let packets = server.assert_released().await;
    assert!(
        packets.iter().any(|packet| packet == "1"),
        "Engine.IO Close was not sent"
    );
    assert_callbacks_released(weak).await;
}

#[tokio::test]
async fn connected_disconnect_releases_websocket_while_client_is_retained() {
    let mut server = Server::responding(r#"40/local-executor,{"sid":"namespace"}"#).await;
    let (tx, mut connected) = mpsc::unbounded_channel();
    let client = base_builder(&server.url)
        .on(crate::Event::Connect, move |_, _| {
            let tx = tx.clone();
            async move { tx.send(()).unwrap() }.boxed()
        })
        .connect()
        .await
        .unwrap();
    tokio::time::timeout(DEADLINE, connected.recv())
        .await
        .unwrap()
        .unwrap();
    client.disconnect().await.unwrap();
    let packets = server.assert_released().await;
    assert!(packets.iter().any(|packet| packet == "41/local-executor,"));
    assert!(packets.iter().any(|packet| packet == "1"));
    assert!(client.emit("late", json!(null)).await.is_err());
    client
        .disconnect()
        .await
        .expect("repeated disconnect is harmless");
}

#[tokio::test]
async fn last_client_clone_drop_releases_websocket() {
    let mut server = Server::rejecting().await;
    let (builder, mut rejected, weak) = builder(&server.url);
    let client = builder.connect().await.unwrap();
    tokio::time::timeout(DEADLINE, rejected.recv())
        .await
        .unwrap()
        .unwrap();
    let clone = client.clone();
    drop(client);
    assert!(
        weak.upgrade().is_some(),
        "remaining client must retain callbacks"
    );
    drop(clone);
    server.assert_released().await;
    assert_callbacks_released(weak).await;
}

#[tokio::test]
async fn last_client_drop_aborts_pending_error_callback() {
    let mut server = Server::rejecting().await;
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let (tx, mut started) = mpsc::unbounded_channel();
    let client = base_builder(&server.url)
        .on("error", move |_, socket| {
            let capture = capture.clone();
            let tx = tx.clone();
            async move {
                let _capture = capture;
                let _socket = socket;
                tx.send(()).unwrap();
                std::future::pending::<()>().await;
            }
            .boxed()
        })
        .connect()
        .await
        .unwrap();
    tokio::time::timeout(DEADLINE, started.recv())
        .await
        .unwrap()
        .unwrap();
    drop(client);
    server.assert_released().await;
    assert_callbacks_released(weak).await;
}

#[tokio::test]
async fn error_callback_can_disconnect_its_own_client() {
    let mut server = Server::rejecting().await;
    let (tx, mut disconnected) = mpsc::unbounded_channel();
    let client = base_builder(&server.url)
        .on("error", move |_, socket| {
            let tx = tx.clone();
            async move {
                let result = socket.disconnect().await;
                tx.send(result).unwrap();
            }
            .boxed()
        })
        .connect()
        .await
        .unwrap();
    tokio::time::timeout(DEADLINE, disconnected.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    server.assert_released().await;
    drop(client);
}

#[tokio::test]
async fn cancelled_initial_connect_releases_transport_while_client_is_retained() {
    let mut server = Server::rejecting().await;
    let builder = base_builder(&server.url);
    let socket = builder.inner_create().await.unwrap();
    let client = Client::new(socket, builder).unwrap();
    let lock = client.socket.write().await;
    let mut connecting = Box::pin(client.connect());
    let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
    assert!(connecting.as_mut().poll(&mut context).is_pending());
    drop(connecting);
    drop(lock);
    server.assert_released().await;
    assert!(!client.socket.read().await.is_connected());
}

#[tokio::test]
async fn cancelled_disconnect_closes_transport_and_aborts_pending_dispatch() {
    let mut server = Server::rejecting().await;
    let (builder, mut rejected, _) = builder(&server.url);
    let client = builder.connect().await.unwrap();
    tokio::time::timeout(DEADLINE, rejected.recv())
        .await
        .unwrap()
        .unwrap();
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let (tx, mut started) = mpsc::unbounded_channel();
    let background = client.background_clone();
    client.spawn_dispatch(
        async move {
            let _capture = capture;
            let _client = background;
            tx.send(()).unwrap();
            std::future::pending::<()>().await;
        },
        true,
    );
    tokio::time::timeout(DEADLINE, started.recv())
        .await
        .unwrap()
        .unwrap();
    let lock = client.socket.write().await;
    let mut disconnecting = Box::pin(client.disconnect());
    let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
    assert!(disconnecting.as_mut().poll(&mut context).is_pending());
    drop(disconnecting);
    drop(lock);
    server.assert_released().await;
    assert_callbacks_released(weak).await;
    assert!(client.shutdown.load(std::sync::atomic::Ordering::Acquire));
    assert!(client.dispatch_tasks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn protocol_error_ends_poll_task_and_releases_transport() {
    let mut server = Server::responding("4invalid-socketio-packet").await;
    let (tx, mut error) = mpsc::unbounded_channel();
    let client = base_builder(&server.url)
        .on("error", move |_, _| {
            let tx = tx.clone();
            async move { tx.send(()).unwrap() }.boxed()
        })
        .connect()
        .await
        .unwrap();
    tokio::time::timeout(DEADLINE, error.recv())
        .await
        .unwrap()
        .unwrap();
    server.assert_released().await;
    tokio::time::timeout(DEADLINE, async {
        loop {
            if client
                .lifetime
                .as_ref()
                .unwrap()
                .poll_task
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .is_finished()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("poll task outlived the failed session");
    client.disconnect().await.unwrap();
}

async fn closing_socket(server: &Server) -> (crate::asynchronous::socket::Socket, Weak<()>) {
    use tf_rust_engineio::asynchronous::ClientBuilder as EngineBuilder;
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let mut engine = EngineBuilder::new(url::Url::parse(&server.url).unwrap())
        .on_error(move |_| {
            let capture = capture.clone();
            async move { drop(capture) }.boxed()
        })
        .build_websocket()
        .await
        .unwrap();
    let socket = crate::asynchronous::socket::Socket::new(engine.clone()).unwrap();
    socket.connect().await.unwrap();
    let error = tokio::time::timeout(DEADLINE, engine.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(error, tf_rust_engineio::Error::WebsocketClosed { .. }),
        "{error:?}"
    );
    drop(engine);
    (socket, weak)
}

#[tokio::test]
async fn failed_engineio_initial_pong_send_releases_engine_callback_captures() {
    let mut server = Server::responding("close-on-pong").await;
    let (socket, weak) = closing_socket(&server).await;
    let client = Client::new(socket, base_builder(&server.url)).unwrap();
    let error = client.connect().await.unwrap_err();
    assert!(
        matches!(error, crate::Error::IncompleteResponseFromEngineIo(_)),
        "{error:?}"
    );
    assert_callbacks_released(weak).await;
    server.assert_released().await;
    assert_eq!(client.session_epoch(), 0);
}

#[tokio::test]
async fn failed_namespace_and_engineio_close_sends_still_release_transport() {
    let mut server = Server::responding("close-on-pong").await;
    let (socket, weak) = closing_socket(&server).await;
    // The namespace send gate is open after transport connect. Both closing
    // sends now exercise the real SendAfterClosing failure after reading Close.
    let client = Client::new(socket, base_builder(&server.url)).unwrap();
    assert!(client.socket.read().await.is_connected());
    let result = client.disconnect().await;
    assert!(
        result.is_err(),
        "closed WebSocket should reject Engine.IO Close"
    );
    assert_callbacks_released(weak).await;
    server.assert_released().await;
    assert!(!client.socket.read().await.is_connected());
}

#[tokio::test]
async fn disconnect_cancelled_before_reason_lock_still_aborts_reader() {
    let mut server = Server::rejecting().await;
    let (builder, mut rejected, _) = builder(&server.url);
    let client = builder.connect().await.unwrap();
    tokio::time::timeout(DEADLINE, rejected.recv())
        .await
        .unwrap()
        .unwrap();
    let lock = client.disconnect_reason.write().await;
    let mut disconnecting = Box::pin(client.disconnect());
    let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
    assert!(disconnecting.as_mut().poll(&mut context).is_pending());
    drop(disconnecting);
    drop(lock);
    server.assert_released().await;
    assert!(client
        .lifetime
        .as_ref()
        .unwrap()
        .poll_task
        .lock()
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn explicit_callback_client_clone_keeps_transport_alive() {
    let mut server = Server::responding(r#"40/local-executor,{"sid":"namespace"}"#).await;
    let (tx, mut clones) = mpsc::unbounded_channel();
    let client = base_builder(&server.url)
        .on(crate::Event::Connect, move |_, socket| {
            let tx = tx.clone();
            async move { tx.send(socket.clone()).unwrap() }.boxed()
        })
        .connect()
        .await
        .unwrap();
    let clone = tokio::time::timeout(DEADLINE, clones.recv())
        .await
        .unwrap()
        .unwrap();
    drop(client);
    clone.emit("still-owned", json!(true)).await.unwrap();
    drop(clone);
    let packets = server.assert_released().await;
    assert!(packets.iter().any(|packet| packet.contains("still-owned")));
}

#[tokio::test]
async fn exhausted_reconnect_limit_ends_reader_and_releases_transport() {
    let mut server = Server::responding("4invalid-socketio-packet").await;
    let client = base_builder(&server.url)
        .reconnect(true)
        .max_reconnect_attempts(0)
        .connect()
        .await
        .unwrap();
    server.assert_released().await;
    tokio::time::timeout(DEADLINE, async {
        loop {
            if client
                .lifetime
                .as_ref()
                .unwrap()
                .poll_task
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .is_finished()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("exhausted retry loop retained the client");
}

#[tokio::test]
async fn engineio_disconnect_retains_websocket_until_engine_client_is_dropped() {
    use tf_rust_engineio::asynchronous::ClientBuilder as EngineBuilder;
    let mut server = Server::rejecting().await;
    let engine = EngineBuilder::new(url::Url::parse(&server.url).unwrap())
        .build_websocket()
        .await
        .unwrap();
    engine.connect().await.unwrap();
    engine.disconnect().await.unwrap();
    assert!(!engine.is_connected());
    tokio::time::timeout(DEADLINE, async {
        while server.messages.recv().await.unwrap() != "1" {}
    })
    .await
    .unwrap();
    assert!(
        !server.task.is_finished(),
        "Engine.IO Close should only send a packet"
    );
    drop(engine);
    server.assert_released().await;
}

struct PollingState {
    next_session: AtomicUsize,
    reconnected_poll: AtomicBool,
    fail_connect_send: bool,
    close_received: mpsc::UnboundedSender<()>,
    close_cancelled: mpsc::UnboundedSender<()>,
}

struct PollingServer {
    url: String,
    task: JoinHandle<()>,
    close_received: mpsc::UnboundedReceiver<()>,
    close_cancelled: mpsc::UnboundedReceiver<()>,
}

impl PollingServer {
    async fn start(fail_connect_send: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (received_tx, close_received) = mpsc::unbounded_channel();
        let (cancelled_tx, close_cancelled) = mpsc::unbounded_channel();
        let state = Arc::new(PollingState {
            next_session: AtomicUsize::new(1),
            reconnected_poll: AtomicBool::new(false),
            fail_connect_send,
            close_received: received_tx,
            close_cancelled: cancelled_tx,
        });
        let task = tokio::spawn(async move {
            let mut requests = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        requests.spawn(serve_polling_request(stream, state.clone()));
                    }
                    result = requests.join_next(), if !requests.is_empty() => {
                        result.unwrap().unwrap();
                    }
                }
            }
        });
        Self {
            url,
            task,
            close_received,
            close_cancelled,
        }
    }
}

impl Drop for PollingServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_polling_request(stream: &mut TcpStream) -> (String, url::Url, String) {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    let header_end = loop {
        let count = stream.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0, "polling request ended before its headers");
        request.extend_from_slice(&buffer[..count]);
        if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = std::str::from_utf8(&request[..header_end]).unwrap();
    let length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        .unwrap_or(0);
    let mut line = headers.lines().next().unwrap().split_whitespace();
    let method = line.next().unwrap().to_owned();
    let url = url::Url::parse(&format!("http://localhost{}", line.next().unwrap())).unwrap();
    while request.len() < header_end + length {
        let count = stream.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0, "polling request ended before its body");
        request.extend_from_slice(&buffer[..count]);
    }
    let body = std::str::from_utf8(&request[header_end..header_end + length])
        .unwrap()
        .to_owned();
    (method, url, body)
}

async fn serve_polling_request(mut stream: TcpStream, state: Arc<PollingState>) {
    let (method, url, body) = read_polling_request(&mut stream).await;
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        query.get("transport").map(|value| value.as_ref()),
        Some("polling")
    );
    assert_eq!(query.get("EIO").map(|value| value.as_ref()), Some("4"));
    let session = query.get("sid").map(|value| value.as_ref());
    if state.fail_connect_send
        && method == "POST"
        && session == Some("polling-1")
        && body.starts_with("40/local-executor,")
    {
        // Close without a response so the initial namespace send fails.
        return;
    }
    if method == "POST" && session == Some("polling-1") && body == "1" {
        state.close_received.send(()).unwrap();
        // Never answer this Close POST. Only cancellation can finish it.
        assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
        state.close_cancelled.send(()).unwrap();
        return;
    }
    let response = match (method.as_str(), session) {
        ("GET", None) => {
            let id = state.next_session.fetch_add(1, Ordering::SeqCst);
            format!(
                r#"0{{"sid":"polling-{id}","upgrades":[],"pingInterval":100000,"pingTimeout":100000}}"#
            )
        }
        ("GET", Some("polling-1")) => {
            "40/local-executor,{\"sid\":\"namespace-1\"}\u{1e}4invalid-socketio-packet".to_owned()
        }
        ("GET", Some("polling-2")) if !state.reconnected_poll.swap(true, Ordering::SeqCst) => {
            r#"40/local-executor,{"sid":"namespace-2"}"#.to_owned()
        }
        ("GET", Some("polling-2")) => {
            // A healthy long poll stays open until the client disconnects.
            assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
            return;
        }
        ("POST", Some("polling-1" | "polling-2")) => "ok".to_owned(),
        _ => panic!("unexpected polling request: {method} {url} {body}"),
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
        response.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
}

#[tokio::test]
async fn hanging_polling_close_does_not_block_terminal_callback_or_reconnect() {
    let mut server = PollingServer::start(false).await;
    let (connect_tx, mut connected) = mpsc::unbounded_channel();
    let (error_tx, mut errors) = mpsc::unbounded_channel();
    let (close_tx, mut closed) = mpsc::unbounded_channel();
    let client = ClientBuilder::new(&server.url)
        .namespace("/local-executor")
        .transport_type(TransportType::Polling)
        .reconnect(true)
        .max_reconnect_attempts(1)
        .on(crate::Event::Connect, move |_, _| {
            let tx = connect_tx.clone();
            async move { tx.send(()).unwrap() }.boxed()
        })
        .on("error", move |payload, _| {
            let tx = error_tx.clone();
            async move { tx.send(payload).unwrap() }.boxed()
        })
        .on_close_with_session(move |payload, epoch, _| {
            let tx = close_tx.clone();
            async move { tx.send((payload, epoch)).unwrap() }.boxed()
        })
        .connect()
        .await
        .unwrap();
    tokio::time::timeout(DEADLINE, connected.recv())
        .await
        .expect("initial polling namespace did not connect")
        .unwrap();
    let error = tokio::time::timeout(DEADLINE, errors.recv())
        .await
        .expect("malformed Socket.IO packet did not reach the error callback")
        .unwrap();
    assert_eq!(
        error,
        crate::Payload::from(crate::Error::InvalidPacketId('i').to_string())
    );
    tokio::time::timeout(DEADLINE, server.close_received.recv())
        .await
        .expect("old polling session never sent Engine.IO Close")
        .unwrap();
    let (reason, epoch) = tokio::time::timeout(DEADLINE + Duration::from_secs(1), closed.recv())
        .await
        .expect("hanging Close POST blocked the terminal close callback")
        .unwrap();
    assert_eq!(
        reason,
        crate::Payload::from(crate::CloseReason::TransportClose.as_str())
    );
    assert_eq!(epoch, 1, "close must belong to the failed session");
    tokio::time::timeout(DEADLINE, connected.recv())
        .await
        .expect("hanging Close POST blocked polling reconnect")
        .unwrap();
    assert_eq!(client.session_epoch(), 2);
    tokio::time::timeout(DEADLINE, client.emit("after-reconnect", json!(true)))
        .await
        .expect("reconnected polling session cannot send")
        .unwrap();
    tokio::time::timeout(DEADLINE, server.close_cancelled.recv())
        .await
        .expect("timed-out Close POST retained its HTTP connection")
        .unwrap();
    tokio::time::timeout(DEADLINE, client.disconnect())
        .await
        .expect("reconnected session did not disconnect")
        .unwrap();
}

#[tokio::test]
async fn failed_polling_connect_does_not_wait_for_an_unresponsive_close_request() {
    let mut server = PollingServer::start(true).await;
    let url = server.url.clone();
    let mut connecting = tokio::spawn(async move {
        ClientBuilder::new(url)
            .namespace("/local-executor")
            .transport_type(TransportType::Polling)
            .reconnect(false)
            .connect()
            .await
    });
    tokio::time::timeout(DEADLINE, server.close_received.recv())
        .await
        .expect("failed namespace send must reach Engine.IO cleanup")
        .unwrap();
    let result = tokio::time::timeout(DEADLINE, &mut connecting)
        .await
        .expect("failed setup must not wait indefinitely for Engine.IO Close")
        .expect("initial connection task panicked");
    assert!(result.is_err(), "the initial namespace POST must fail");
    tokio::time::timeout(DEADLINE, server.close_cancelled.recv())
        .await
        .expect("failed setup cleanup must cancel the unresponsive Close POST")
        .unwrap();
}
