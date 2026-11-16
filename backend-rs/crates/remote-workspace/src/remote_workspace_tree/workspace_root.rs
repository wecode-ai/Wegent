// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Resolve the executor's logical task workspace alias to its physical root.

use brz_http::Client as HttpClient;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolveWorkspaceRootError {
    Unavailable,
    NotFound,
    Upstream,
    InvalidResponse,
}

impl ResolveWorkspaceRootError {
    pub(crate) fn detail(self) -> &'static str {
        match self {
            Self::Unavailable => "Failed to resolve remote workspace",
            Self::NotFound => "Workspace directory not found",
            Self::Upstream => "Failed to resolve remote workspace",
            Self::InvalidResponse => "Invalid workspace root response",
        }
    }
}

#[derive(Deserialize)]
struct StatResponse {
    entry: Option<StatEntry>,
}

#[derive(Deserialize)]
struct StatEntry {
    path: Option<String>,
    #[serde(rename = "type")]
    entry_type: Option<String>,
}

/// Resolve `/workspace/{task_id}` through the executor filesystem contract.
pub(crate) async fn resolve_executor_workspace_root(
    http: &HttpClient,
    base_url: &str,
    task_id: impl ToString,
) -> Result<String, ResolveWorkspaceRootError> {
    let task_id = task_id.to_string();
    let url = format!(
        "{}/filesystem.Filesystem/Stat",
        base_url.trim_end_matches('/')
    );
    let response = http
        .post(&url)
        .map_err(|error| {
            tracing::warn!(%error, url = %url, "[remote_workspace] root query build failed");
            ResolveWorkspaceRootError::Unavailable
        })?
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body(json!({"path": format!("/workspace/{task_id}")}).to_string())
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, url = %url, task_id, "[remote_workspace] root query failed");
            ResolveWorkspaceRootError::Unavailable
        })?;

    let status = response.status().as_u16();
    if status == 404 {
        return Err(ResolveWorkspaceRootError::NotFound);
    }
    if status >= 400 {
        tracing::warn!(status, url = %url, task_id, "[remote_workspace] root query upstream error");
        return Err(ResolveWorkspaceRootError::Upstream);
    }

    let body = response.bytes().await.map_err(|error| {
        tracing::warn!(%error, url = %url, task_id, "[remote_workspace] root query body read failed");
        ResolveWorkspaceRootError::InvalidResponse
    })?;
    let payload: StatResponse = serde_json::from_slice(&body).map_err(|error| {
        tracing::warn!(%error, url = %url, task_id, "[remote_workspace] root query invalid json");
        ResolveWorkspaceRootError::InvalidResponse
    })?;
    validate_workspace_root(payload.entry)
}

fn validate_workspace_root(entry: Option<StatEntry>) -> Result<String, ResolveWorkspaceRootError> {
    let entry = entry.ok_or(ResolveWorkspaceRootError::InvalidResponse)?;
    let path = entry
        .path
        .filter(|path| {
            path.starts_with('/')
                && !path.starts_with("//")
                && path != "/"
                && normalize_absolute_path(path) == *path
        })
        .ok_or(ResolveWorkspaceRootError::InvalidResponse)?;
    if entry.entry_type.as_deref() != Some("FILE_TYPE_DIRECTORY") {
        return Err(ResolveWorkspaceRootError::InvalidResponse);
    }
    Ok(path)
}

fn normalize_absolute_path(path: &str) -> String {
    let mut resolved: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    format!("/{}", resolved.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn server(
        status: u16,
        body: &'static str,
    ) -> (String, Arc<Mutex<Vec<u8>>>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let request = Arc::clone(&captured);
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let size = stream.read(&mut buffer).await.unwrap();
                if size == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..size]);
                let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or_default();
                if bytes.len() >= header_end + 4 + length {
                    break;
                }
            }
            *request.lock().unwrap() = bytes;
            let response = format!(
                "HTTP/1.1 {status} Test\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        (base_url, captured, task)
    }

    #[tokio::test]
    async fn resolves_logical_task_path_to_physical_repository_root() {
        let body = r#"{"entry":{"path":"/root/.wegent/workspace/feed-rpc-d02d49b6","type":"FILE_TYPE_DIRECTORY"}}"#;
        let (base_url, captured, task) = server(200, body).await;
        let client = HttpClient::builder().build().unwrap();

        let root = resolve_executor_workspace_root(&client, &base_url, 21852793754611_i64)
            .await
            .unwrap();

        task.await.unwrap();
        assert_eq!(root, "/root/.wegent/workspace/feed-rpc-d02d49b6");
        let request = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert!(request.starts_with("POST /filesystem.Filesystem/Stat HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("connect-protocol-version: 1")
        );
        assert!(request.contains(r#"{"path":"/workspace/21852793754611"}"#));
    }

    #[tokio::test]
    async fn maps_missing_workspace_to_not_found() {
        let (base_url, _, task) = server(404, r#"{"detail":"not found"}"#).await;
        let client = HttpClient::builder().build().unwrap();

        let error = resolve_executor_workspace_root(&client, &base_url, 42)
            .await
            .unwrap_err();

        task.await.unwrap();
        assert_eq!(error, ResolveWorkspaceRootError::NotFound);
    }

    #[test]
    fn rejects_non_canonical_or_non_directory_roots() {
        let non_canonical = StatEntry {
            path: Some("/workspace/../etc".to_string()),
            entry_type: Some("FILE_TYPE_DIRECTORY".to_string()),
        };
        assert_eq!(
            validate_workspace_root(Some(non_canonical)),
            Err(ResolveWorkspaceRootError::InvalidResponse)
        );

        let file = StatEntry {
            path: Some("/workspace/task/file".to_string()),
            entry_type: Some("FILE_TYPE_FILE".to_string()),
        };
        assert_eq!(
            validate_workspace_root(Some(file)),
            Err(ResolveWorkspaceRootError::InvalidResponse)
        );
    }
}
