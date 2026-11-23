// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Controlled text and prepared results, decoded by the real MySQL SDK.
use super::mysql_pool_server::{handshake, is_text_read, packet, read_packet};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone)]
pub enum Value {
    I64(i64),
    I32(i32),
    I8(i8),
    Text(String),
    Bytes(Vec<u8>),
    DateTime,
    Null,
}

pub type Row = Vec<(&'static str, Value)>;
type Rows = Arc<dyn Fn(&str) -> (Row, Vec<Row>) + Send + Sync>;
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
        *sequence = sequence.wrapping_add(1);
    }
    packet(stream, *sequence, EOF).await;
    *sequence = sequence.wrapping_add(1);
}

fn text_row(row: &Row) -> Vec<u8> {
    let mut bytes = Vec::new();
    for (_, value) in row {
        match value {
            Value::I64(value) => string(value.to_string().as_bytes(), &mut bytes),
            Value::I32(value) => string(value.to_string().as_bytes(), &mut bytes),
            Value::I8(value) => string(value.to_string().as_bytes(), &mut bytes),
            Value::Text(value) => string(value.as_bytes(), &mut bytes),
            Value::Bytes(value) => string(value, &mut bytes),
            Value::DateTime => string(b"2026-10-23 00:00:00", &mut bytes),
            Value::Null => bytes.push(0xfb),
        }
    }
    bytes
}

fn binary_row(row: &Row) -> Vec<u8> {
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
    bytes
}

async fn result(
    stream: &mut TcpStream,
    columns: Row,
    rows: Vec<Row>,
    status: u8,
    encode_row: fn(&Row) -> Vec<u8>,
) {
    packet(stream, 1, &[columns.len() as u8]).await;
    let mut sequence = 2;
    definitions(stream, &mut sequence, &columns).await;
    for row in rows {
        packet(stream, sequence, &encode_row(&row)).await;
        sequence = sequence.wrapping_add(1);
    }
    packet(stream, sequence, &[0xfe, 0, 0, status, 0]).await;
}

async fn connection(
    mut stream: TcpStream,
    rows: Rows,
    queries: Arc<Mutex<Vec<String>>>,
    requests: Arc<Mutex<Vec<super::Query>>>,
) {
    stream.set_nodelay(true).unwrap();
    handshake(&mut stream).await;
    let mut statements = HashMap::new();
    let mut bound_types = HashMap::<u32, Vec<u8>>::new();
    let mut status = 2;
    while let Some(request) = read_packet(&mut stream).await {
        match request[0] {
            0x01 => return,
            0x16 => {
                let query = String::from_utf8(request[1..].to_vec()).unwrap();
                let (row, _) = rows(&query);
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
                if !row.is_empty() {
                    definitions(&mut stream, &mut sequence, &row).await;
                }
                statements.insert(id, query);
            }
            0x17 => {
                let id = u32::from_le_bytes(request[1..5].try_into().unwrap());
                let query = &statements[&id];
                queries.lock().unwrap().push(query.clone());
                let parameters = query.bytes().filter(|byte| *byte == b'?').count();
                let first_integer =
                    first_bound_integer(&request, parameters, bound_types.entry(id).or_default());
                requests.lock().unwrap().push(super::Query {
                    sql: query.clone(),
                    args: parameters,
                    first_integer,
                });
                let (columns, results) = rows(query);
                if columns.is_empty() && query.starts_with("UPDATE ") {
                    packet(&mut stream, 1, &[0, 1, 0, status, 0, 0, 0]).await;
                } else {
                    result(&mut stream, columns, results, status, binary_row).await;
                }
            }
            0x19 => {}
            0x03 => {
                let sql = String::from_utf8_lossy(&request[1..]);
                if is_text_read(&sql) {
                    queries.lock().unwrap().push(sql.to_string());
                    let (columns, results) = rows(&sql);
                    result(&mut stream, columns, results, status, text_row).await;
                    continue;
                }
                // SQLx checks SERVER_STATUS_IN_TRANS in the BEGIN response.
                if sql.eq_ignore_ascii_case("BEGIN") {
                    status = 3;
                } else if sql.eq_ignore_ascii_case("COMMIT") || sql.eq_ignore_ascii_case("ROLLBACK")
                {
                    status = 2;
                }
                packet(&mut stream, 1, &[0, 0, 0, status, 0, 0, 0]).await;
                requests.lock().unwrap().push(super::Query {
                    sql: sql.to_string(),
                    args: 0,
                    first_integer: None,
                });
            }
            0x0e => packet(&mut stream, 1, &[0, 0, 0, status, 0, 0, 0]).await,
            command => panic!("unexpected MySQL fixture command: {command}"),
        }
    }
}

pub struct MysqlRows {
    pub mysql: brz_mysql::MysqlService,
    pub url: String,
    server: tokio::task::JoinHandle<()>,
    queries: Arc<Mutex<Vec<String>>>,
    requests: Arc<Mutex<Vec<super::Query>>>,
}

impl MysqlRows {
    pub async fn start(rows: impl Fn(&str) -> Row + Send + Sync + 'static) -> Self {
        Self::start_results(move |sql| {
            let row = rows(sql);
            (row.clone(), vec![row])
        })
        .await
    }

    /// Controlled empty or multi-row results, retaining a schema for empty sets.
    pub async fn start_results(
        rows: impl Fn(&str) -> (Row, Vec<Row>) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("mysql://test:test@{}/test", listener.local_addr().unwrap());
        let rows: Rows = Arc::new(rows);
        let queries = Arc::new(Mutex::new(Vec::new()));
        let captured = queries.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured_requests = requests.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        connections.spawn(connection(
                            accepted.unwrap().0, rows.clone(), captured.clone(), captured_requests.clone(),
                        ));
                    }
                    completed = connections.join_next(), if !connections.is_empty() => {
                        completed.unwrap().unwrap();
                    }
                }
            }
        });
        Self {
            mysql: brz_mysql::MysqlService::connect_lazy(&url).unwrap(),
            url,
            server,
            queries,
            requests,
        }
    }

    pub fn queries(&self) -> Vec<String> {
        self.queries.lock().unwrap().clone()
    }

    pub fn requests(&self) -> Vec<super::Query> {
        self.requests.lock().unwrap().clone()
    }
}

/// COM_STMT_EXECUTE's first parameter when integer and non-null, including cached types.
fn first_bound_integer(request: &[u8], parameters: usize, types: &mut Vec<u8>) -> Option<i64> {
    if parameters == 0 {
        return None;
    }
    let bitmap = parameters.div_ceil(8);
    let mut value = 10 + bitmap + 1;
    if *request.get(10 + bitmap)? == 1 {
        *types = request.get(value..value + 2 * parameters)?.to_vec();
        value += 2 * parameters;
    }
    if request.get(10)? & 1 != 0 {
        return None;
    }
    match types.first()? {
        8 => {
            let bytes = request.get(value..value + 8)?.try_into().ok()?;
            if types.get(1)? & 0x80 != 0 {
                u64::from_le_bytes(bytes).try_into().ok()
            } else {
                Some(i64::from_le_bytes(bytes))
            }
        }
        3 => Some(i32::from_le_bytes(request.get(value..value + 4)?.try_into().ok()?).into()),
        2 => Some(i16::from_le_bytes(request.get(value..value + 2)?.try_into().ok()?).into()),
        1 => Some(i64::from(*request.get(value)?)),
        _ => None,
    }
}

impl Drop for MysqlRows {
    fn drop(&mut self) {
        self.server.abort();
    }
}
