// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Controlled prepared-statement results, decoded by the real MySQL SDK.
use super::mysql_pool_server::{handshake, packet, read_packet};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};

pub(crate) enum Value {
    I64(i64),
    I32(i32),
    I8(i8),
    Text(String),
    Bytes(Vec<u8>),
    DateTime,
    Null,
}

pub(crate) type Row = Vec<(&'static str, Value)>;
type Rows = Arc<dyn Fn(&str) -> Row + Send + Sync>;
const EOF: &[u8] = &[0xfe, 0, 0, 2, 0];

fn string(bytes: &[u8], output: &mut Vec<u8>) {
    match bytes.len() {
        0..=250 => output.push(bytes.len() as u8),
        251..=65535 => {
            output.push(0xfc);
            output.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        }
        _ => panic!("fixture value too large"),
    }
    output.extend_from_slice(bytes);
}

fn column(name: &str, value: &Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    for field in ["def", "test", "", "", name, ""] {
        string(field.as_bytes(), &mut bytes);
    }
    let (kind, charset, flags): (u8, u16, u16) = match value {
        Value::I64(_) => (8, 63, 0),
        Value::I32(_) => (3, 63, 0),
        Value::I8(_) => (1, 63, 0),
        Value::Bytes(_) => (0xfc, 63, 128),
        Value::DateTime => (12, 63, 0),
        Value::Text(_) | Value::Null => (0xfd, 45, 0),
    };
    bytes.push(0x0c);
    bytes.extend_from_slice(&charset.to_le_bytes());
    bytes.extend_from_slice(&65535_u32.to_le_bytes());
    bytes.push(kind);
    bytes.extend_from_slice(&flags.to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0]);
    bytes
}

async fn definitions(stream: &mut TcpStream, sequence: &mut u8, row: &Row) {
    for (name, value) in row {
        packet(stream, *sequence, &column(name, value)).await;
        *sequence += 1;
    }
    packet(stream, *sequence, EOF).await;
    *sequence += 1;
}

async fn result(stream: &mut TcpStream, row: Row) {
    packet(stream, 1, &[row.len() as u8]).await;
    let mut sequence = 2;
    definitions(stream, &mut sequence, &row).await;
    let bitmap_length = (row.len() + 2).div_ceil(8);
    let mut bytes = vec![0; 1 + bitmap_length];
    for (index, (_, value)) in row.iter().enumerate() {
        match value {
            Value::I64(value) => bytes.extend_from_slice(&value.to_le_bytes()),
            Value::I32(value) => bytes.extend_from_slice(&value.to_le_bytes()),
            Value::I8(value) => bytes.push(*value as u8),
            Value::Text(value) => string(value.as_bytes(), &mut bytes),
            Value::Bytes(value) => string(value, &mut bytes),
            Value::DateTime => bytes.extend_from_slice(&[7, 0xea, 7, 10, 23, 0, 0, 0]),
            Value::Null => bytes[1 + (index + 2) / 8] |= 1 << ((index + 2) % 8),
        }
    }
    packet(stream, sequence, &bytes).await;
    packet(stream, sequence + 1, EOF).await;
}

async fn connection(mut stream: TcpStream, rows: Rows) {
    stream.set_nodelay(true).unwrap();
    handshake(&mut stream).await;
    let mut statements = HashMap::new();
    while let Some(request) = read_packet(&mut stream).await {
        match request[0] {
            0x01 => return,
            0x16 => {
                let query = String::from_utf8(request[1..].to_vec()).unwrap();
                let row = rows(&query);
                let id = statements.len() as u32 + 1;
                let parameters = query.bytes().filter(|byte| *byte == b'?').count();
                let mut response = vec![0];
                response.extend_from_slice(&id.to_le_bytes());
                response.extend_from_slice(&(row.len() as u16).to_le_bytes());
                response.extend_from_slice(&(parameters as u16).to_le_bytes());
                response.extend_from_slice(&[0, 0, 0]);
                packet(&mut stream, 1, &response).await;
                let mut sequence = 2;
                if parameters > 0 {
                    let parameters = (0..parameters).map(|_| ("?", Value::Null)).collect();
                    definitions(&mut stream, &mut sequence, &parameters).await;
                }
                definitions(&mut stream, &mut sequence, &row).await;
                statements.insert(id, query);
            }
            0x17 => {
                let id = u32::from_le_bytes(request[1..5].try_into().unwrap());
                result(&mut stream, rows(&statements[&id])).await;
            }
            0x19 => {}
            0x03 | 0x0e => packet(&mut stream, 1, &[0, 0, 0, 2, 0, 0, 0]).await,
            command => panic!("unexpected MySQL fixture command: {command}"),
        }
    }
}

pub(crate) struct MysqlRows {
    pub mysql: brz_mysql::MysqlService,
    server: tokio::task::JoinHandle<()>,
}

impl MysqlRows {
    pub async fn start(rows: impl Fn(&str) -> Row + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("mysql://test:test@{}/test", listener.local_addr().unwrap());
        let rows: Rows = Arc::new(rows);
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        connections.spawn(connection(accepted.unwrap().0, rows.clone()));
                    }
                    completed = connections.join_next(), if !connections.is_empty() => {
                        completed.unwrap().unwrap();
                    }
                }
            }
        });
        Self {
            mysql: brz_mysql::MysqlService::connect_lazy(&url).unwrap(),
            server,
        }
    }
}

impl Drop for MysqlRows {
    fn drop(&mut self) {
        self.server.abort();
    }
}
