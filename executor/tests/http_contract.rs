// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

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
