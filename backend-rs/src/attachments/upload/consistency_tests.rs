// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Use real SDK pools against deterministic primary/replica protocol fixtures.
//! The replica stays empty or stale until the test ends; no timing race is needed.

use std::time::Duration;

use brz_mysql::{MysqlService, MysqlServiceOptions};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use super::response::AttachmentResponse;
use super::store::{REFRESH_CONTEXT_QUERY, SubtaskContextRefreshRow, refresh_context};
use crate::sql_test_support::mysql_pool_server::{handshake, packet, read_packet};

const CONTEXT_ID: i64 = 73;
fn eof(in_transaction: bool) -> [u8; 5] {
    [0xfe, 0, 0, if in_transaction { 3 } else { 2 }, 0]
}

/// Column types and binary values for the production refresh projection.
struct Column {
    name: &'static str,
    kind: u8,
    value: Option<Vec<u8>>,
}

fn string_column(name: &'static str, value: &str) -> Column {
    let mut encoded = Vec::new();
    length_encoded(&mut encoded, value.as_bytes());
    Column {
        name,
        kind: 0xfd,
        value: Some(encoded),
    }
}

fn length_encoded(output: &mut Vec<u8>, value: &[u8]) {
    assert!(value.len() < 251, "fixture strings fit one length byte");
    output.push(value.len() as u8);
    output.extend_from_slice(value);
}

fn columns(status: &str) -> Vec<Column> {
    let integer = |name, value: i64| Column {
        name,
        kind: 0x08,
        value: Some(value.to_le_bytes().to_vec()),
    };
    let filename = if status == "ready" {
        "new.md"
    } else {
        "old.md"
    };
    vec![
        integer("id", CONTEXT_ID),
        integer("subtask_id", 0),
        integer("user_id", 7),
        string_column("context_type", "attachment"),
        string_column("name", filename),
        string_column("status", status),
        string_column("error_message", ""),
        string_column("binary_data", ""),
        string_column("image_base64", ""),
        string_column("extracted_text", "new content"),
        integer("text_length", 11),
        string_column(
            "type_data",
            r#"{"file_size":11,"file_extension":".md","mime_type":"text/markdown"}"#,
        ),
        Column {
            name: "created_at",
            kind: 0x0c,
            value: None,
        },
        Column {
            name: "updated_at",
            kind: 0x0c,
            value: None,
        },
    ]
}

fn definition(name: &str, kind: u8) -> Vec<u8> {
    let mut body = Vec::new();
    for value in [
        "def",
        "test",
        "subtask_contexts",
        "subtask_contexts",
        name,
        name,
    ] {
        length_encoded(&mut body, value.as_bytes());
    }
    body.push(0x0c);
    body.extend_from_slice(&45_u16.to_le_bytes());
    body.extend_from_slice(&1024_u32.to_le_bytes());
    body.push(kind);
    body.extend_from_slice(&[0; 5]);
    body
}

async fn prepare(stream: &mut TcpStream, columns: &[Column], in_transaction: bool) {
    let mut body = vec![0, 1, 0, 0, 0]; // statement id 1
    body.extend_from_slice(&(columns.len() as u16).to_le_bytes());
    body.extend_from_slice(&[1, 0, 0, 0, 0]); // one parameter, filler, warnings
    packet(stream, 1, &body).await;
    packet(stream, 2, &definition("context_id", 0x08)).await;
    packet(stream, 3, &eof(in_transaction)).await;
    for (index, column) in columns.iter().enumerate() {
        packet(
            stream,
            index as u8 + 4,
            &definition(column.name, column.kind),
        )
        .await;
    }
    packet(stream, columns.len() as u8 + 4, &eof(in_transaction)).await;
}

async fn result(stream: &mut TcpStream, columns: &[Column], present: bool, in_transaction: bool) {
    packet(stream, 1, &[columns.len() as u8]).await;
    for (index, column) in columns.iter().enumerate() {
        packet(
            stream,
            index as u8 + 2,
            &definition(column.name, column.kind),
        )
        .await;
    }
    let mut sequence = columns.len() as u8 + 2;
    packet(stream, sequence, &eof(in_transaction)).await;
    if present {
        let mut row = vec![0; 1 + (columns.len() + 2).div_ceil(8)];
        for (index, column) in columns.iter().enumerate() {
            match &column.value {
                Some(value) => row.extend_from_slice(value),
                None => row[1 + (index + 2) / 8] |= 1 << ((index + 2) % 8),
            }
        }
        sequence += 1;
        packet(stream, sequence, &row).await;
    }
    packet(stream, sequence + 1, &eof(in_transaction)).await;
}

async fn connection(mut stream: TcpStream, status: Option<&'static str>) {
    handshake(&mut stream).await;
    let columns = columns(status.unwrap_or("ready"));
    let mut in_transaction = false;
    while let Some(request) = read_packet(&mut stream).await {
        match request[0] {
            0x01 => break,
            0x16 => {
                assert_eq!(
                    String::from_utf8_lossy(&request[1..]),
                    REFRESH_CONTEXT_QUERY
                );
                prepare(&mut stream, &columns, in_transaction).await;
            }
            0x17 => result(&mut stream, &columns, status.is_some(), in_transaction).await,
            0x19 => {} // COM_STMT_CLOSE has no response.
            0x03 | 0x0e => {
                if request[0] == 0x03 {
                    let command = String::from_utf8_lossy(&request[1..]);
                    match command.trim().to_ascii_uppercase().as_str() {
                        "BEGIN" => in_transaction = true,
                        "COMMIT" | "ROLLBACK" => in_transaction = false,
                        _ => {}
                    }
                }
                packet(
                    &mut stream,
                    1,
                    &[0, 0, 0, if in_transaction { 3 } else { 2 }, 0, 0, 0],
                )
                .await;
            }
            command => panic!("unexpected MySQL command {command}"),
        }
    }
}

async fn server(
    listener: TcpListener,
    mut stop: oneshot::Receiver<()>,
    status: Option<&'static str>,
) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                connections.spawn(connection(accepted.unwrap().0, status));
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                completed.unwrap().unwrap();
            }
            _ = &mut stop => break,
        }
    }
    connections.abort_all();
}

async fn assert_refresh(primary: Option<&'static str>, replica: Option<&'static str>) {
    let writer = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reader = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = |address| format!("mysql://test:test@{address}/test?ssl-mode=disabled");
    let mysql = MysqlService::connect_lazy_read_write_named_with_options(
        &url(writer.local_addr().unwrap()),
        &url(reader.local_addr().unwrap()),
        "attachment-refresh-test",
        MysqlServiceOptions::default().with_query_timeout(Duration::from_secs(3)),
    )
    .unwrap();
    let (stop_writer, stopped_writer) = oneshot::channel();
    let (stop_reader, stopped_reader) = oneshot::channel();
    let writer = tokio::spawn(server(writer, stopped_writer, primary));
    let reader = tokio::spawn(server(reader, stopped_reader, replica));

    // Prove ordinary reads still see the replica's empty or stale state.
    let ordinary: Option<SubtaskContextRefreshRow> = mysql
        .fetch_optional(REFRESH_CONTEXT_QUERY, (CONTEXT_ID,))
        .await
        .unwrap();
    assert_eq!(ordinary.as_ref().map(|row| row.status.as_str()), replica);

    let refreshed = refresh_context(&mysql, CONTEXT_ID).await.unwrap();
    assert_eq!(refreshed.as_ref().map(|row| row.status.as_str()), primary);
    if let Some(row) = refreshed {
        let response = serde_json::to_value(AttachmentResponse::from_context(&row, None)).unwrap();
        assert_eq!(response["id"], CONTEXT_ID);
        assert_eq!(response["filename"], "new.md");
        assert_eq!(response["status"], "ready");
        assert_eq!(response["file_size"], 11);
        assert_eq!(response["text_length"], 11);
    }
    mysql.close().await;
    stop_writer.send(()).unwrap();
    stop_reader.send(()).unwrap();
    writer.await.unwrap();
    reader.await.unwrap();
}

#[tokio::test]
async fn upload_refresh_survives_a_replica_missing_the_new_attachment() {
    assert_refresh(Some("ready"), None).await;
}

#[tokio::test]
async fn upload_refresh_does_not_return_the_replicas_stale_attachment() {
    assert_refresh(Some("ready"), Some("uploading")).await;
}

#[tokio::test]
async fn upload_refresh_preserves_a_genuinely_missing_primary_record() {
    assert_refresh(None, Some("ready")).await;
}
