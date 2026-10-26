// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn broker(address: std::net::SocketAddr) -> crate::CeleryBroker {
    let config =
        crate::config::RedisConfig::from_urls(&format!("redis://{address}/1"), None).unwrap();
    crate::CeleryBroker::new(None).with_background_broker(config)
}

fn broker_runtime() -> &'static tokio::runtime::Runtime {
    // The SDK resolver is process-wide. Its owning runtime must outlive all
    // concurrent broker tests, including tests that finish after a refusal.
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    })
}

#[test]
fn concurrent_notifications_have_a_bounded_wait_for_a_stalled_broker_initializer() {
    broker_runtime().block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker = broker(listener.local_addr().unwrap());
        let stalled = tokio::spawn(async move {
            let mut connections = Vec::new();
            loop {
                // Accept the TCP handshake but never reply to Redis initialization.
                connections.push(listener.accept().await.unwrap().0);
            }
        });
        let cache = NoRedis::default();
        let kwargs = serde_json::Map::from_iter([("execution_id".to_owned(), 13.into())]);
        let sends = (0..3).map(|_| broker.dispatch_background(&cache, "notification", &kwargs));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            futures_util::future::join_all(sends),
        )
        .await;
        stalled.abort();
        let _ = stalled.await;
        assert!(
            result
                .expect("waiting callers must share the connection budget")
                .iter()
                .all(Result::is_err)
        );
        assert!(cache.commands.lock().unwrap().is_empty());
    });
}

#[test]
fn unavailable_explicit_broker_never_publishes_notifications_to_cache() {
    broker_runtime().block_on(async {
        // A bound, non-listening socket reserves the address while refusing connects.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let broker = broker(socket.local_addr().unwrap());
        let redis = NoRedis::default();
        for execution_id in [11, 12] {
            let kwargs =
                serde_json::Map::from_iter([("execution_id".to_owned(), execution_id.into())]);
            assert!(
                broker
                    .dispatch_background(&redis, "notification", &kwargs)
                    .await
                    .is_err()
            );
        }
        assert!(redis.commands.lock().unwrap().is_empty());
    });
}

async fn read_command(stream: &mut BufReader<tokio::net::TcpStream>) -> Option<Vec<String>> {
    let mut line = String::new();
    if stream.read_line(&mut line).await.unwrap() == 0 {
        return None;
    }
    assert!(line.starts_with('*'), "expected RESP array: {line}");
    let count: usize = line[1..].trim().parse().unwrap();
    let mut command = Vec::new();
    for _ in 0..count {
        line.clear();
        stream.read_line(&mut line).await.unwrap();
        assert!(line.starts_with('$'));
        let length: usize = line[1..].trim().parse().unwrap();
        let mut bytes = vec![0; length + 2];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes[length..], b"\r\n");
        command.push(String::from_utf8(bytes[..length].to_vec()).unwrap());
    }
    Some(command)
}

async fn redis_fixture(listener: tokio::net::TcpListener) -> Vec<Vec<String>> {
    let commands = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (pushed, mut push) = tokio::sync::mpsc::channel(1);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let mut stream = BufReader::new(accepted.unwrap().0);
                let commands = commands.clone();
                let pushed = pushed.clone();
                connections.spawn(async move {
                    while let Some(command) = read_command(&mut stream).await {
                        commands.lock().unwrap().push(command.clone());
                        let response: &[u8] = match command[0].as_str() {
                            "LPUSH" => b":1\r\n",
                            "PING" => b"+PONG\r\n",
                            "SELECT" | "AUTH" => b"+OK\r\n",
                            other => panic!("unexpected Redis command: {other}"),
                        };
                        stream.get_mut().write_all(response).await.unwrap();
                        if command[0] == "LPUSH" { pushed.send(()).await.unwrap(); }
                    }
                });
            }
            completed = connections.join_next(), if !connections.is_empty() => { completed.unwrap().unwrap(); }
            _ = push.recv() => break,
        }
    }
    connections.shutdown().await;
    std::sync::Arc::try_unwrap(commands)
        .unwrap()
        .into_inner()
        .unwrap()
}

#[test]
fn explicit_broker_recovers_for_a_new_notification_after_initial_connection_failure() {
    broker_runtime().block_on(async {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let broker = broker(socket.local_addr().unwrap());
        let cache = NoRedis::default();
        let first = serde_json::Map::from_iter([("execution_id".to_owned(), 11.into())]);
        assert!(
            broker
                .dispatch_background(&cache, "notification", &first)
                .await
                .is_err()
        );

        let server = tokio::spawn(redis_fixture(socket.listen(8).unwrap()));
        let next = serde_json::Map::from_iter([("execution_id".to_owned(), 12.into())]);
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            broker
                .clone()
                .dispatch_background(&cache, "notification", &next),
        )
        .await
        .unwrap()
        .unwrap();
        let commands = server.await.unwrap();
        assert!(commands.iter().any(|command| command == &["SELECT", "1"]));
        let messages: Vec<_> = commands
            .iter()
            .filter(|command| command[0] == "LPUSH")
            .collect();
        assert_eq!(
            messages.len(),
            1,
            "only the new notification should be published"
        );
        let message: Value = serde_json::from_str(&messages[0][2]).unwrap();
        use base64::Engine as _;
        let body = base64::engine::general_purpose::STANDARD
            .decode(message["body"].as_str().unwrap())
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body[1]["execution_id"], 12);
        assert!(cache.commands.lock().unwrap().is_empty());
    });
}
