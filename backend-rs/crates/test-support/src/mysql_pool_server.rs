// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! A minimal MySQL protocol server for tests: it accepts the SDK's
//! initialization and records the SQL it is asked to prepare, so a test can
//! assert what the driver rendered before any network round trip.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub async fn packet(stream: &mut TcpStream, sequence: u8, body: &[u8]) {
    let length = (body.len() as u32).to_le_bytes();
    stream
        .write_all(&[length[0], length[1], length[2], sequence])
        .await
        .unwrap();
    stream.write_all(body).await.unwrap();
}

pub async fn read_packet(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.ok()?;
    let length = u32::from_le_bytes([header[0], header[1], header[2], 0]);
    let mut body = vec![0; length as usize];
    stream.read_exact(&mut body).await.ok()?;
    Some(body)
}

/// Complete the SDK's protocol 4.1 authentication against a local fixture.
pub async fn handshake(stream: &mut TcpStream) {
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
    packet(stream, 0, &hello).await;
    read_packet(stream).await.unwrap();
    packet(stream, 2, &[0, 0, 0, 2, 0, 0, 0]).await;
}

/// A minimal local server accepts initialization and records prepared SQL.
/// Returning a SQL error avoids needing a result schema and is intentional.
async fn serve_connection(
    mut stream: TcpStream,
    queries: tokio::sync::mpsc::UnboundedSender<String>,
    record_controls: bool,
) {
    handshake(&mut stream).await;
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
            let sql = String::from_utf8_lossy(&request[1..]).trim().to_string();
            // SQLx verifies SERVER_STATUS_IN_TRANS after START TRANSACTION.
            let begins_transaction = request[0] == 0x03 && sql.eq_ignore_ascii_case("BEGIN");
            // A nested savepoint begins and releases like the source's
            // session: the connection keeps its in-transaction status.
            let savepoint_control =
                record_controls && request[0] == 0x03 && is_savepoint_control(&sql);
            if record_controls
                && (begins_transaction || savepoint_control)
                && queries.send(sql).is_err()
            {
                return;
            }
            let status = if begins_transaction || savepoint_control {
                3
            } else {
                2
            };
            packet(&mut stream, 1, &[0, 0, 0, status, 0, 0, 0]).await;
        }
    }
}

/// The transaction-control statements a nested SQLx scope issues.
fn is_savepoint_control(sql: &str) -> bool {
    let keyword = sql.split_whitespace().next().unwrap_or_default();
    ["SAVEPOINT", "RELEASE", "ROLLBACK"]
        .iter()
        .any(|control| keyword.eq_ignore_ascii_case(control))
}

/// Keep transaction connections alive through rollback; the caller stops the
/// server after its operation completes, rather than after its first query.
pub async fn capture_queries_until(
    listener: TcpListener,
    stop: tokio::sync::oneshot::Receiver<()>,
) -> Vec<String> {
    capture_until(listener, stop, false).await
}

/// Like [`capture_queries_until`], but also records the transaction-control
/// `COM_QUERY` statements (`BEGIN`, `SAVEPOINT`, ...) in wire order, so a test
/// can assert how the SDK enters and releases a nested savepoint scope.
#[allow(
    dead_code,
    reason = "the internal crate includes this module only for the routed pool check"
)]
pub async fn capture_controls_until(
    listener: TcpListener,
    stop: tokio::sync::oneshot::Receiver<()>,
) -> Vec<String> {
    capture_until(listener, stop, true).await
}

async fn capture_until(
    listener: TcpListener,
    mut stop: tokio::sync::oneshot::Receiver<()>,
    record_controls: bool,
) -> Vec<String> {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut connections = tokio::task::JoinSet::new();
    let mut queries = Vec::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.unwrap();
                connections.spawn(serve_connection(stream, sender.clone(), record_controls));
            }
            query = receiver.recv() => queries.push(query.unwrap()),
            _ = &mut stop => break,
        }
    }
    while let Ok(query) = receiver.try_recv() {
        queries.push(query);
    }
    connections.abort_all();
    queries
}
