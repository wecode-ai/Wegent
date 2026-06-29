// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use wegent_executor::{
    protocol::{ExecutionRequest, TaskStatus},
    server::{create_router, AppState, RunnerResult, TaskRunner},
};

fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Clone, Default)]
struct RecordingRunner {
    submitted: Arc<Mutex<Vec<ExecutionRequest>>>,
}

impl RecordingRunner {
    fn submitted(&self) -> Vec<ExecutionRequest> {
        self.submitted.lock().unwrap().clone()
    }
}

impl TaskRunner for RecordingRunner {
    type SubmitFuture = std::future::Ready<RunnerResult>;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        self.submitted.lock().unwrap().push(request);
        std::future::ready(RunnerResult::accepted(TaskStatus::Running))
    }
}

#[tokio::test]
async fn health_check_matches_executor_readiness_contract() {
    let app = create_router(AppState::new(RecordingRunner::default()));

    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();

    assert_eq!(
        body,
        json!({"status": "healthy", "service": "task_executor"})
    );
}

#[tokio::test]
async fn responses_endpoint_accepts_openai_background_requests() {
    let runner = RecordingRunner::default();
    let app = create_router(AppState::new(runner.clone()));
    let payload = json!({
        "model": "ignored",
        "input": "run this task",
        "background": true,
        "model_config": {"model": "anthropic", "model_id": "claude-sonnet-4"},
        "metadata": {
            "task_id": 123,
            "subtask_id": 456,
            "bot": [{"shell_type": "ClaudeCode"}]
        }
    });

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/responses")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body,
        json!({
            "id": "resp_456",
            "status": "queued",
            "message": "Task execution status: RUNNING"
        })
    );

    let submitted = runner.submitted();
    assert_eq!(submitted.len(), 1);
    assert_eq!(submitted[0].task_id, 123);
    assert_eq!(submitted[0].subtask_id, 456);
    assert_eq!(submitted[0].prompt, json!("run this task"));
}

#[tokio::test]
async fn workspace_routes_list_and_download_task_files() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("executor-http-workspace");
    fs::create_dir_all(workspace_root.join("123/src")).unwrap();
    fs::write(workspace_root.join("123/README.md"), "hello workspace").unwrap();
    fs::write(workspace_root.join("123/src/main.rs"), "fn main() {}\n").unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));

    let list_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/filesystem/list-dir?path=/workspace/123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(list_response.status(), StatusCode::OK);
    let entries: Value = serde_json::from_slice(
        &list_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(entries[0]["name"], json!("src"));
    assert_eq!(entries[0]["is_directory"], json!(true));
    assert_eq!(entries[0]["path"], json!("/workspace/123/src"));
    assert_eq!(entries[1]["name"], json!("README.md"));

    let connect_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/filesystem.Filesystem/ListDir")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"path": "/workspace/123", "depth": 1}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(connect_response.status(), StatusCode::OK);
    let connect_body: Value = serde_json::from_slice(
        &connect_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(connect_body["entries"][0]["name"], json!("src"));

    let file_response = app
        .oneshot(
            Request::builder()
                .uri("/files?path=/workspace/123/README.md")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(file_response.status(), StatusCode::OK);
    assert_eq!(
        file_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
        "hello workspace"
    );
}

#[tokio::test]
async fn workspace_routes_reject_paths_outside_workspace() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("executor-http-workspace-guard");
    fs::create_dir_all(&workspace_root).unwrap();
    let outside = unique_dir("executor-http-outside");
    fs::create_dir_all(&outside).unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/filesystem/list-dir?path={}", outside.display()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

fn unique_dir(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!("{name}-{}-{suffix}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    path
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}
