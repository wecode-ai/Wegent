// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! A minimal MySQL protocol server for tests: it accepts the SDK's
//! initialization and records the SQL it is asked to prepare, so a test can
//! assert what the driver rendered before any network round trip.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn packet(stream: &mut TcpStream, sequence: u8, body: &[u8]) {
    let length = (body.len() as u32).to_le_bytes();
    stream
        .write_all(&[length[0], length[1], length[2], sequence])
        .await
        .unwrap();
    stream.write_all(body).await.unwrap();
}

async fn read_packet(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.ok()?;
    let length = u32::from_le_bytes([header[0], header[1], header[2], 0]);
    let mut body = vec![0; length as usize];
    stream.read_exact(&mut body).await.ok()?;
    Some(body)
}

/// A minimal local server accepts initialization and records prepared SQL.
/// Returning a SQL error avoids needing a result schema and is intentional.
async fn serve_connection(
    mut stream: TcpStream,
    queries: tokio::sync::mpsc::UnboundedSender<String>,
) {
    let capabilities: u32 = 0x0008_a208; // protocol 4.1, transactions, auth, database
    let mut hello = vec![10];
    hello.extend_from_slice(b"8.0.0-test\0");
    hello.extend_from_slice(&1_u32.to_le_bytes());
    hello.extend_from_slice(b"12345678\0");
    hello.extend_from_slice(&(capabilities as u16).to_le_bytes());
    hello.push(45);
    hello.extend_from_slice(&2_u16.to_le_bytes());
    hello.extend_from_slice(&((capabilities >> 16) as u16).to_le_bytes());
    hello.push(21);
    hello.extend_from_slice(&[0; 10]);
    hello.extend_from_slice(b"abcdefghijkl\0mysql_native_password\0");
    packet(&mut stream, 0, &hello).await;
    read_packet(&mut stream).await.unwrap();
    packet(&mut stream, 2, &[0, 0, 0, 2, 0, 0, 0]).await;
    while let Some(request) = read_packet(&mut stream).await {
        if request.first() == Some(&0x01) {
            return;
        }
        if request[0] == 0x16 {
            // COM_STMT_PREPARE
            let query = String::from_utf8(request[1..].to_vec()).unwrap();
            let mut error = vec![0xff, 0x28, 0x04]; // ER_PARSE_ERROR
            error.extend_from_slice(b"#42000test captured SQL");
            packet(&mut stream, 1, &error).await;
            if queries.send(query).is_err() {
                return;
            }
        } else {
            // Session initialization and the pool's pre-acquire ping.
            assert!(
                matches!(request[0], 0x03 | 0x0e),
                "unexpected command: {}",
                request[0]
            );
            packet(&mut stream, 1, &[0, 0, 0, 2, 0, 0, 0]).await;
        }
    }
}

pub(crate) async fn capture_queries(listener: TcpListener, count: usize) -> Vec<String> {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut connections = tokio::task::JoinSet::new();
    let mut queries = Vec::new();
    while queries.len() < count {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.unwrap();
                connections.spawn(serve_connection(stream, sender.clone()));
            }
            query = receiver.recv() => queries.push(query.unwrap()),
        }
    }
    connections.abort_all();
    queries
}
