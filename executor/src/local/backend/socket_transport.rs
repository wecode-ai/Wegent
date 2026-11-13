// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    error::Error as StdError,
    fmt::Debug,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::FutureExt;
use serde_json::{json, Value};
use tf_rust_socketio::{
    asynchronous::{Client, ClientBuilder},
    Event, Payload, TransportType,
};
use tokio::sync::oneshot;

use super::{
    ConnectionClosedHandler, EventHandler, LocalBackendConfig, LocalBackendTransport,
    TransportFuture, DEVICE_SYNC_CAPABILITIES_EVENT,
};

const NAMESPACE: &str = "/local-executor";
const NAMESPACE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

mod completed_event_budget;

#[cfg(test)]
mod completed_event_tests;
#[cfg(test)]
mod correlation_tests;

/// The tf-rust-socketio client expects an HTTP(S) URL and upgrades the
/// connection itself. Normalize ws(s):// schemes so the Engine.IO handshake
/// reaches the server correctly.
fn normalize_socket_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("wss://") {
        return format!("https://{rest}");
    }
    if let Some(rest) = url.strip_prefix("ws://") {
        return format!("http://{rest}");
    }
    url.to_owned()
}

fn format_socket_error<E>(operation: &str, event: Option<&str>, error: &E) -> String
where
    E: StdError + Debug,
{
    let mut causes = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    let event = event
        .map(|event| format!(" event={event}"))
        .unwrap_or_default();
    let causes = if causes.is_empty() {
        "none".to_owned()
    } else {
        causes.join(" -> ")
    };
    format!(
        "socket operation failed operation={operation}{event} error={error} detail={error:?} causes={causes}"
    )
}

async fn dispatch_handler<F>(run_in_background: bool, future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    if run_in_background {
        // Capability publication includes synchronous filesystem verification.
        // Keep it off reactor workers so sockets, heartbeats and IPC stay live.
        let runtime = tokio::runtime::Handle::current();
        std::mem::drop(tokio::task::spawn_blocking(move || {
            runtime.block_on(future)
        }));
    } else {
        future.await;
    }
}

#[derive(Clone)]
struct ConnectedSocket {
    generation: u64,
    client: Client,
}

#[derive(Clone, Default)]
pub struct SocketIoTransport {
    namespace: Option<&'static str>,
    client: Arc<tokio::sync::Mutex<Option<ConnectedSocket>>>,
    generation: Arc<AtomicU64>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
    close_handlers: Arc<Mutex<Vec<ConnectionClosedHandler>>>,
}

impl SocketIoTransport {
    async fn acknowledge(
        &self,
        generation: u64,
        socket: &Client,
        event: &str,
        ack_id: i32,
        payload: Value,
    ) {
        if let Err(error) = socket.ack_with_id(ack_id, payload).await {
            eprintln!(
                "local backend {}",
                format_socket_error("ack", Some(event), &error)
            );
            self.invalidate_generation(generation).await;
        }
    }

    async fn connected_socket(&self) -> Result<ConnectedSocket, String> {
        self.client
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Socket.IO client is not connected".to_owned())
    }

    async fn invalidate_generation(&self, generation: u64) {
        let mut state = self.client.lock().await;
        if self.generation.load(Ordering::Acquire) != generation
            || state
                .as_ref()
                .is_some_and(|connected| connected.generation != generation)
        {
            return;
        }
        state.take();
        // Notify synchronously before a new generation can publish its client.
        let listeners = self
            .close_handlers
            .lock()
            .expect("close handler lock")
            .clone();
        for listener in listeners {
            listener();
        }
    }
}

impl SocketIoTransport {
    pub(crate) fn for_namespace(namespace: &'static str) -> Self {
        Self {
            namespace: Some(namespace),
            ..Self::default()
        }
    }

    pub(crate) async fn connect_authenticated(
        &self,
        socket_url: &str,
        token: &str,
    ) -> Result<(), String> {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let previous = self.client.lock().await.take();
        if let Some(previous) = previous {
            let _ = previous.client.disconnect().await;
        }
        let handlers = self.handlers.lock().expect("handler lock").clone();
        let socket_url = normalize_socket_url(socket_url);
        let (connect_sender, connect_receiver) = oneshot::channel();
        let connect_sender = Arc::new(Mutex::new(Some(connect_sender)));
        let closed = Arc::new(AtomicBool::new(false));
        let close_transport = self.clone();
        let close_flag = Arc::clone(&closed);
        let mut builder = ClientBuilder::new(socket_url)
            .namespace(self.namespace.unwrap_or(NAMESPACE))
            .auth(json!({ "token": token }))
            .transport_type(TransportType::Websocket)
            .reconnect(false)
            .reconnect_on_disconnect(false)
            .on(Event::Connect, move |_payload: Payload, _socket: Client| {
                let connect_sender = Arc::clone(&connect_sender);
                async move {
                    if let Some(sender) = connect_sender.lock().expect("connect lock").take() {
                        let _ = sender.send(());
                    }
                }
                .boxed()
            })
            .on("error", |payload: Payload, _socket: Client| {
                async move {
                    eprintln!("local backend socket error: {payload:?}");
                }
                .boxed()
            })
            .on(Event::Close, move |_payload: Payload, _socket: Client| {
                let close_transport = close_transport.clone();
                let close_flag = Arc::clone(&close_flag);
                async move {
                    close_flag.store(true, Ordering::Release);
                    close_transport.invalidate_generation(generation).await;
                }
                .boxed()
            });

        for (event, handler) in handlers {
            let run_in_background = event == DEVICE_SYNC_CAPABILITIES_EVENT;
            let handler_event = event.clone();
            let ack_transport = self.clone();
            builder = builder.on(event, move |payload: Payload, socket: Client| {
                let handler = Arc::clone(&handler);
                let handler_event = handler_event.clone();
                let ack_transport = ack_transport.clone();
                async move {
                    dispatch_handler(run_in_background, async move {
                        let ack_id = payload.ack_id();
                        let value = payload_to_value(payload);
                        let ack_payload = handler(value).await;
                        if let (Some(ack_id), Some(ack_payload)) = (ack_id, ack_payload) {
                            ack_transport
                                .acknowledge(
                                    generation,
                                    &socket,
                                    &handler_event,
                                    ack_id,
                                    ack_payload,
                                )
                                .await;
                        }
                    })
                    .await;
                }
                .boxed()
            });
        }

        let socket = builder
            .connect()
            .await
            .map_err(|error| format_socket_error("connect", None, &error))?;
        let namespace_result = tokio::time::timeout(NAMESPACE_CONNECT_TIMEOUT, connect_receiver)
            .await
            .map_err(|_| "Socket.IO namespace connection timed out".to_owned())?
            .map_err(|_| "Socket.IO namespace connection signal was dropped".to_owned());
        if let Err(error) = namespace_result {
            let _ = socket.disconnect().await;
            return Err(error);
        }
        let mut client_state = self.client.lock().await;
        if closed.load(Ordering::Acquire) || self.generation.load(Ordering::Acquire) != generation {
            drop(client_state);
            let _ = socket.disconnect().await;
            return Err("Socket.IO connection closed during namespace setup".to_owned());
        }
        *client_state = Some(ConnectedSocket {
            generation,
            client: socket,
        });
        Ok(())
    }
}

impl LocalBackendTransport for SocketIoTransport {
    fn connect<'a>(&'a self, config: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
        Box::pin(self.connect_authenticated(&config.socket_url, &config.auth_token))
    }

    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            self.generation.fetch_add(1, Ordering::AcqRel);
            if let Some(connected) = self.client.lock().await.take() {
                connected
                    .client
                    .disconnect()
                    .await
                    .map_err(|error| format_socket_error("disconnect", None, &error))?;
            }
            Ok(())
        })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            let connected = self.connected_socket().await?;
            let (event, payload) = completed_event_budget::fit_completed_event(event, payload)?;
            let (sender, receiver) = oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            let ack_sender = Arc::clone(&sender);

            if let Err(error) = connected
                .client
                .emit_with_ack(
                    event.to_owned(),
                    payload,
                    timeout,
                    move |payload: Payload, _socket: Client| {
                        let ack_sender = Arc::clone(&ack_sender);
                        async move {
                            if let Some(sender) = ack_sender.lock().expect("ack lock").take() {
                                let _ = sender.send(payload_to_value(payload));
                            }
                        }
                        .boxed()
                    },
                )
                .await
            {
                self.invalidate_generation(connected.generation).await;
                return Err(format_socket_error("call", Some(event), &error));
            }

            tokio::time::timeout(timeout, receiver)
                .await
                .map_err(|_| format!("{event} timed out"))?
                .map_err(|_| format!("{event} acknowledgment was dropped"))
        })
    }

    fn emit<'a>(&'a self, event: &'a str, payload: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let connected = self.connected_socket().await?;
            let (event, payload) = completed_event_budget::fit_completed_event(event, payload)?;
            if let Err(error) = connected.client.emit(event.to_owned(), payload).await {
                self.invalidate_generation(connected.generation).await;
                return Err(format_socket_error("emit", Some(event), &error));
            }
            Ok(())
        })
    }

    fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .lock()
            .expect("handler lock")
            .push((event.to_owned(), handler));
    }

    fn on_close(&self, handler: ConnectionClosedHandler) {
        self.close_handlers
            .lock()
            .expect("close handler lock")
            .push(handler);
    }
}

#[allow(deprecated)]
fn payload_to_value(payload: Payload) -> Value {
    match payload {
        Payload::Text(mut values, _) => {
            if values.len() == 1 {
                values.remove(0)
            } else {
                Value::Array(values)
            }
        }
        Payload::String(value, _) => serde_json::from_str(&value).unwrap_or(Value::String(value)),
        Payload::Binary(_, _) => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::{
        dispatch_handler, format_socket_error, normalize_socket_url, LocalBackendTransport,
        SocketIoTransport,
    };

    #[tokio::test]
    async fn stale_socket_closure_cannot_invalidate_current_connection_state() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        for (closed_generation, expected_connected) in [(0, true), (1, false)] {
            let transport = SocketIoTransport::default();
            transport.generation.store(1, Ordering::Release);
            let connected = Arc::new(AtomicBool::new(true));
            let close_state = Arc::clone(&connected);
            transport.on_close(Arc::new(move || {
                close_state.store(false, Ordering::Release);
            }));

            transport.invalidate_generation(closed_generation).await;

            assert_eq!(connected.load(Ordering::Acquire), expected_connected);
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("outer transport error")]
    struct OuterError {
        #[source]
        source: std::io::Error,
    }

    #[test]
    fn socket_url_normalizes_websocket_schemes_for_engine_io() {
        assert_eq!(
            normalize_socket_url("wss://socket.example.com"),
            "https://socket.example.com"
        );
        assert_eq!(
            normalize_socket_url("ws://localhost:8000"),
            "http://localhost:8000"
        );
    }

    #[test]
    fn socket_url_preserves_http_schemes() {
        assert_eq!(
            normalize_socket_url("https://socket.example.com"),
            "https://socket.example.com"
        );
        assert_eq!(
            normalize_socket_url("http://localhost:8000"),
            "http://localhost:8000"
        );
    }

    #[test]
    fn socket_error_preserves_operation_debug_detail_and_source_chain() {
        let error = OuterError {
            source: std::io::Error::new(std::io::ErrorKind::TimedOut, "server did not send a ping"),
        };

        let message = format_socket_error("emit", Some("device:heartbeat"), &error);

        assert!(message.contains("operation=emit"));
        assert!(message.contains("event=device:heartbeat"));
        assert!(message.contains("detail=OuterError"));
        assert!(message.contains("server did not send a ping"));
    }

    #[tokio::test]
    async fn background_handler_does_not_block_socket_callback() {
        let (started_sender, started_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (finished_sender, finished_receiver) = oneshot::channel();

        dispatch_handler(true, async move {
            let _ = started_sender.send(());
            let _ = release_receiver.await;
            let _ = finished_sender.send(());
        })
        .await;

        tokio::time::timeout(Duration::from_secs(1), started_receiver)
            .await
            .expect("background handler should start")
            .expect("started signal should be sent");
        release_sender
            .send(())
            .expect("background handler should still be running");
        tokio::time::timeout(Duration::from_secs(1), finished_receiver)
            .await
            .expect("background handler should finish")
            .expect("finished signal should be sent");
    }

    #[tokio::test]
    async fn synchronous_capability_work_does_not_starve_transport_reactor() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        };

        let (started, start) = oneshot::channel();
        let (released, release) = mpsc::channel();
        let (finished, finish) = oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let completed_work = completed.clone();
        dispatch_handler(true, async move {
            started.send(()).unwrap();
            // A bounded real blocking operation makes a reactor-thread regression
            // fail deterministically rather than hanging this current-thread test.
            let _ = release.recv_timeout(Duration::from_secs(2));
            completed_work.store(true, Ordering::Release);
            let _ = finished.send(());
        })
        .await;
        tokio::time::timeout(Duration::from_secs(1), start)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !completed.load(Ordering::Acquire),
            "The reactor must run while synchronous publication is still blocked"
        );
        released.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), finish)
            .await
            .unwrap()
            .unwrap();
    }
}
