// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Test-only provider boundary shared by the cloud and desktop polling tests.

use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    task::JoinHandle,
};

pub struct Provider {
    pub base: String,
    pub state: Arc<Mutex<State>>,
    task: JoinHandle<()>,
}

pub struct State {
    pub allowed: bool,
    pub requests: Vec<String>,
    source: &'static str,
    rows: HashMap<&'static str, Vec<Value>>,
    sequence: i64,
}

impl State {
    pub fn push(&mut self, kind: &str) {
        self.sequence += 1;
        let mut row = serde_json::json!({"id":self.sequence,"created_at":chrono::Utc::now().to_rfc3339(),"body":"External update","system":false});
        let stream = if self.source == "github" {
            row["event"] = serde_json::json!(match kind {
                "comment" => "commented",
                "status" => "closed",
                _ => "labeled",
            });
            row["label"] = serde_json::json!({"name":"wegent:assignee:user:8"});
            "timeline"
        } else {
            match kind {
                "comment" => {
                    row = serde_json::json!({"notes":[row]});
                    "discussions"
                }
                "status" => "resource_state_events",
                _ => {
                    row["label"] = serde_json::json!({"name":"wegent:assignee:user:8"});
                    "resource_label_events"
                }
            }
        };
        self.rows.entry(stream).or_default().push(row);
    }

    fn response(&mut self, target: &str, headers: &str) -> (u16, Value) {
        self.requests.push(target.into());
        let credential = if self.source == "github" {
            "authorization: bearer test-token"
        } else {
            "private-token: test-token"
        };
        if !headers.to_ascii_lowercase().contains(credential) {
            return (
                401,
                serde_json::json!({"message":"Invalid test credential"}),
            );
        }
        if !self.allowed {
            return (404, serde_json::json!({"message":"Issue access revoked"}));
        }
        let url = url::Url::parse(&format!("http://fixture{target}")).unwrap();
        let root = if self.source == "github" {
            "/repos/acme/repo/issues/7"
        } else {
            "/projects/acme%2Frepo/issues/7"
        };
        if url.path() == root {
            return (
                200,
                serde_json::json!({
                    "number":7,"iid":7,"id":7,"title":"External Issue",
                    "body":"Details","description":"Details",
                    "state":if self.source == "github" {"open"} else {"opened"},
                    "labels":[],"user":{"login":"author"},"author":{"username":"author"},
                    "html_url":"https://example.invalid/7","web_url":"https://example.invalid/7",
                    "comments":0,"user_notes_count":0,
                    "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"
                }),
            );
        }
        let Some(stream) = url.path().strip_prefix(&format!("{root}/")) else {
            return (404, serde_json::json!({}));
        };
        let page = url
            .query_pairs()
            .find(|(key, _)| key == "page")
            .map(|(_, value)| value.parse::<usize>().unwrap())
            .unwrap_or(1);
        let rows = self.rows.get(stream).map(Vec::as_slice).unwrap_or(&[]);
        let page: Vec<_> = rows.iter().skip((page - 1) * 100).take(100).collect();
        (200, serde_json::json!(page))
    }
}

impl Provider {
    pub async fn start(source: &'static str) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            allowed: true,
            requests: Vec::new(),
            source,
            rows: HashMap::new(),
            sequence: 0,
        }));
        let serving = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let state = serving.clone();
                tokio::spawn(async move {
                    let mut socket = BufReader::new(socket);
                    let mut line = String::new();
                    socket.read_line(&mut line).await.unwrap();
                    let target = line.split_whitespace().nth(1).unwrap().to_owned();
                    let mut headers = String::new();
                    loop {
                        line.clear();
                        if socket.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                        headers.push_str(&line);
                    }
                    let (status, body) = state.lock().unwrap().response(&target, &headers);
                    let body = body.to_string();
                    let response = format!(
                        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket
                        .get_mut()
                        .write_all(response.as_bytes())
                        .await
                        .unwrap();
                });
            }
        });
        Self { base, state, task }
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
