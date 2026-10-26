use super::*;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

async fn accept_connection(listener: TcpListener) -> WebSocketStream<TcpStream> {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(stream).await.unwrap();
    socket.send(Message::Text(
        r#"0{"sid":"correlation-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#.into(),
    )).await.unwrap();
    loop {
        let Message::Text(packet) = socket.next().await.unwrap().unwrap() else {
            panic!("expected a text packet");
        };
        if packet == "3" {
            continue;
        }
        assert!(packet.starts_with("40/local-executor,"));
        socket
            .send(Message::Text(
                r#"40/local-executor,{"sid":"correlation-test"}"#.into(),
            ))
            .await
            .unwrap();
        return socket;
    }
}

#[tokio::test]
async fn concurrent_calls_keep_unique_ack_ids_and_receive_their_own_response() {
    // More outstanding calls than the old random ID pool makes the regression
    // deterministic. Reply in reverse order so arrival order cannot correlate calls.
    const CALLS: usize = 1_000;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (ids_sender, ids_receiver) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_connection(listener).await;
        let mut calls = Vec::new();
        while calls.len() < CALLS {
            let Message::Text(packet) = socket.next().await.unwrap().unwrap() else {
                panic!("expected a text packet");
            };
            if packet == "3" {
                continue;
            }
            let packet = packet
                .strip_prefix("42/local-executor,")
                .unwrap_or_else(|| panic!("unexpected synthetic packet: {packet}"));
            let (id, arguments) = packet.split_at(packet.find('[').unwrap());
            let arguments: Value = serde_json::from_str(arguments).unwrap();
            calls.push((id.to_owned(), arguments[1].clone()));
        }
        ids_sender
            .send(
                calls
                    .iter()
                    .map(|(id, _)| id.clone())
                    .collect::<HashSet<_>>(),
            )
            .unwrap();
        for (id, response) in calls.into_iter().rev() {
            socket
                .send(Message::Text(format!("43/local-executor,{id}[{response}]")))
                .await
                .unwrap();
        }
        while let Some(message) = socket.next().await {
            if message.unwrap() == Message::Text("41/local-executor,".into()) {
                break;
            }
        }
    });
    let client = ClientBuilder::new(format!("http://{address}"))
        .namespace(NAMESPACE)
        .transport_type(TransportType::Websocket)
        .reconnect(false)
        .connect()
        .await
        .unwrap();
    let mut pending = tokio::task::JoinSet::new();
    for expected in 0..CALLS {
        let client = client.clone();
        pending.spawn(async move {
            let (sender, receiver) = oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            client
                .emit_with_ack(
                    "probe",
                    json!(expected),
                    Duration::from_secs(10),
                    move |payload, _| {
                        let sender = sender.clone();
                        async move {
                            if let Some(sender) = sender.lock().unwrap().take() {
                                sender.send(payload_to_value(payload)).unwrap();
                            }
                        }
                        .boxed()
                    },
                )
                .await
                .unwrap();
            let response = receiver.await.unwrap();
            assert_eq!(response, json!([expected]));
        });
    }
    let ids = tokio::time::timeout(Duration::from_secs(10), ids_receiver)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        ids.len(),
        CALLS,
        "outstanding calls must have distinct ACK IDs"
    );
    while let Some(result) = pending.join_next().await {
        result.unwrap();
    }
    client.disconnect().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn expired_and_failed_calls_release_their_captured_state() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_connection(listener).await;
        while let Some(message) = socket.next().await {
            if message.unwrap() == Message::Text("41/local-executor,".into()) {
                break;
            }
        }
    });
    let client = ClientBuilder::new(format!("http://{address}"))
        .namespace(NAMESPACE)
        .transport_type(TransportType::Websocket)
        .reconnect(false)
        .connect()
        .await
        .unwrap();
    let expired_state = Arc::new(());
    let captured = expired_state.clone();
    client
        .emit_with_ack("unanswered", json!({}), Duration::ZERO, move |_, _| {
            let captured = captured.clone();
            async move { drop(captured) }.boxed()
        })
        .await
        .unwrap();
    client
        .emit_with_ack("next", json!({}), Duration::from_secs(10), |_, _| {
            async {}.boxed()
        })
        .await
        .unwrap();
    let expired_references = Arc::strong_count(&expired_state);
    client.disconnect().await.unwrap();
    let failed_state = Arc::new(());
    let captured = failed_state.clone();
    let result = client
        .emit_with_ack(
            "after-close",
            json!({}),
            Duration::from_secs(10),
            move |_, _| {
                let captured = captured.clone();
                async move { drop(captured) }.boxed()
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(
        (expired_references, Arc::strong_count(&failed_state)),
        (1, 1)
    );
    server.await.unwrap();
}

#[tokio::test]
async fn closing_during_binary_attachments_delivers_transport_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_connection(listener).await;
        socket
            .send(Message::Text(
                r#"451-/local-executor,["event",{"_placeholder":true,"num":0}]"#.into(),
            ))
            .await
            .unwrap();
        socket.close(None).await.unwrap();
    });
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let _client = ClientBuilder::new(format!("http://{address}"))
        .namespace(NAMESPACE)
        .transport_type(TransportType::Websocket)
        .reconnect(false)
        .on(Event::Close, move |payload, _| {
            let sender = sender.clone();
            async move {
                if let Some(sender) = sender.lock().unwrap().take() {
                    sender.send(payload_to_value(payload)).unwrap();
                }
            }
            .boxed()
        })
        .connect()
        .await
        .unwrap();
    let reason = tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .expect("an incomplete attachment must close the transport")
        .unwrap();
    assert_eq!(reason, json!("transport close"));
    server.await.unwrap();
}
