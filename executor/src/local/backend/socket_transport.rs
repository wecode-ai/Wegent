// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::FutureExt;
use serde_json::{json, Value};
use tf_rust_socketio::{
    asynchronous::{Client, ClientBuilder},
    Payload, TransportType,
};
use tokio::sync::oneshot;

use super::{EventHandler, LocalBackendConfig, LocalBackendTransport, TransportFuture};

const NAMESPACE: &str = "/local-executor";

#[derive(Clone, Default)]
pub struct SocketIoTransport {
    client: Arc<tokio::sync::Mutex<Option<Client>>>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
}

impl LocalBackendTransport for SocketIoTransport {
    fn connect<'a>(&'a self, config: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let handlers = self.handlers.lock().expect("handler lock").clone();
            let mut builder = ClientBuilder::new(config.backend_url.clone())
                .namespace(NAMESPACE)
                .auth(json!({ "token": config.auth_token }))
                .transport_type(TransportType::Websocket)
                .reconnect(true)
                .reconnect_on_disconnect(true)
                .reconnect_delay(
                    duration_to_millis(config.reconnect_delay),
                    duration_to_millis(config.reconnect_delay_max),
                )
                .on("error", |payload: Payload, _socket: Client| {
                    async move {
                        eprintln!("local backend socket error: {payload:?}");
                    }
                    .boxed()
                });

            for (event, handler) in handlers {
                builder = builder.on(event, move |payload: Payload, socket: Client| {
                    let handler = Arc::clone(&handler);
                    async move {
                        let ack_id = payload.ack_id();
                        let value = payload_to_value(payload);
                        let ack_payload = handler(value).await;
                        if let (Some(ack_id), Some(ack_payload)) = (ack_id, ack_payload) {
                            if let Err(error) = socket.ack_with_id(ack_id, ack_payload).await {
                                eprintln!("local backend socket ACK failed: {error}");
                            }
                        }
                    }
                    .boxed()
                });
            }

            let socket = builder.connect().await.map_err(|error| error.to_string())?;
            *self.client.lock().await = Some(socket);
            Ok(())
        })
    }

    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            if let Some(client) = self.client.lock().await.take() {
                client
                    .disconnect()
                    .await
                    .map_err(|error| error.to_string())?;
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
            let client = self
                .client
                .lock()
                .await
                .clone()
                .ok_or_else(|| "Socket.IO client is not connected".to_owned())?;
            let (sender, receiver) = oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            let ack_sender = Arc::clone(&sender);

            client
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
                .map_err(|error| error.to_string())?;

            tokio::time::timeout(timeout, receiver)
                .await
                .map_err(|_| format!("{event} timed out"))?
                .map_err(|_| format!("{event} acknowledgment was dropped"))
        })
    }

    fn emit<'a>(&'a self, event: &'a str, payload: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .await
                .clone()
                .ok_or_else(|| "Socket.IO client is not connected".to_owned())?;
            client
                .emit(event.to_owned(), payload)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .lock()
            .expect("handler lock")
            .push((event.to_owned(), handler));
    }
}

fn duration_to_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
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
