// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Decode fixture rows through the real SDK without an external database.
use brz_mysql::MysqlRow;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};

use super::mysql_pool_server::{handshake, packet, read_packet};

fn encoded(output: &mut Vec<u8>, value: &[u8]) {
    if value.len() < 251 {
        output.push(value.len() as u8);
    } else {
        output.push(0xfc);
        output.extend_from_slice(&(value.len() as u16).to_le_bytes());
    }
    output.extend_from_slice(value);
}

fn definition(name: &str, value: &Value) -> Vec<u8> {
    let mut body = Vec::new();
    for text in ["def", "test", "fixture", "fixture", name, name] {
        encoded(&mut body, text.as_bytes());
    }
    body.push(12);
    body.extend_from_slice(&45_u16.to_le_bytes());
    body.extend_from_slice(&65535_u32.to_le_bytes());
    body.push(if value.is_number() { 8 } else { 0xfd });
    body.extend_from_slice(&[0; 5]);
    body
}

async fn serve(mut stream: TcpStream, values: Vec<(&str, Value)>) {
    handshake(&mut stream).await;
    let eof = [0xfe, 0, 0, 2, 0];
    while let Some(request) = read_packet(&mut stream).await {
        match request[0] {
            0x01 => break,
            0x16 => {
                let mut body = vec![0, 1, 0, 0, 0];
                body.extend_from_slice(&(values.len() as u16).to_le_bytes());
                body.extend_from_slice(&[0; 5]);
                packet(&mut stream, 1, &body).await;
                for (index, (name, value)) in values.iter().enumerate() {
                    packet(&mut stream, index as u8 + 2, &definition(name, value)).await;
                }
                packet(&mut stream, values.len() as u8 + 2, &eof).await;
            }
            0x17 => {
                packet(&mut stream, 1, &[values.len() as u8]).await;
                for (index, (name, value)) in values.iter().enumerate() {
                    packet(&mut stream, index as u8 + 2, &definition(name, value)).await;
                }
                let sequence = values.len() as u8 + 2;
                packet(&mut stream, sequence, &eof).await;
                let mut row = vec![0; 1 + (values.len() + 2).div_ceil(8)];
                for (index, (_, value)) in values.iter().enumerate() {
                    if value.is_null() {
                        row[1 + (index + 2) / 8] |= 1 << ((index + 2) % 8);
                    } else if let Some(number) = value.as_i64() {
                        row.extend_from_slice(&number.to_le_bytes());
                    } else {
                        encoded(&mut row, value.as_str().expect("fixture string").as_bytes());
                    }
                }
                packet(&mut stream, sequence + 1, &row).await;
                packet(&mut stream, sequence + 2, &eof).await;
            }
            0x19 => {}
            0x03 | 0x0e => packet(&mut stream, 1, &[0, 0, 0, 2, 0, 0, 0]).await,
            command => panic!("unexpected MySQL command {command}"),
        }
    }
}

pub(crate) async fn row(values: Vec<(&'static str, Value)>) -> MysqlRow {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mysql = crate::connect_mysql(&format!(
        "mysql://test:test@{}/test?ssl-mode=disabled",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let server =
        tokio::spawn(async move { serve(listener.accept().await.unwrap().0, values).await });
    let row = mysql.fetch_one("SELECT fixture", ()).await.unwrap();
    mysql.close().await;
    server.await.unwrap();
    row
}
