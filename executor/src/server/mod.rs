// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, future::Future, io::Write, net::SocketAddr};

mod config;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    callback::CallbackSink,
    protocol::{ExecutionRequest, OpenAIResponsesRequest, ProtocolError, TaskStatus},
    runner::BackgroundTaskRunner,
};

pub use config::{ServerConfig, ServerConfigError};

pub trait TaskRunner: Clone + Send + Sync + 'static {
    type SubmitFuture: Future<Output = RunnerResult> + Send + 'static;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerResult {
    pub status: TaskStatus,
    pub message: Option<String>,
}

impl RunnerResult {
    pub fn accepted(status: TaskStatus) -> Self {
        Self {
            status,
            message: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppState<R> {
    runner: R,
}

impl<R> AppState<R> {
    pub fn new(runner: R) -> Self {
        Self { runner }
    }
}

pub fn create_router<R>(state: AppState<R>) -> Router
where
    R: TaskRunner,
{
    Router::new()
        .route("/", get(health_check))
        .route("/v1/responses", post(openai_responses::<R>))
        .with_state(state)
}

pub fn create_docker_router_from_env() -> Result<Router, String> {
    let engine = AgentProcessEngine::new(AgentCommandPlanner::from_env());
    let sink = CallbackSink::new(env::var("CALLBACK_URL").unwrap_or_default())?;
    Ok(create_router(AppState::new(BackgroundTaskRunner::new(
        engine, sink,
    ))))
}

pub async fn serve(config: ServerConfig) -> Result<(), String> {
    let bind_addr = config.bind_addr().map_err(|error| error.to_string())?;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|error| format!("failed to bind executor server at {bind_addr}: {error}"))?;
    println!("{}", startup_log_line(bind_addr));
    let _ = std::io::stdout().flush();

    axum::serve(listener, create_docker_router_from_env()?)
        .await
        .map_err(|error| format!("executor server failed: {error}"))
}

pub fn startup_log_line(bind_addr: SocketAddr) -> String {
    format!("Wegent executor listening on {bind_addr}")
}

async fn health_check() -> Json<Value> {
    Json(json!({"status": "healthy", "service": "task_executor"}))
}

async fn openai_responses<R>(
    State(state): State<AppState<R>>,
    Json(payload): Json<Value>,
) -> Result<Json<OpenAIBackgroundResponse>, HttpError>
where
    R: TaskRunner,
{
    let request = OpenAIResponsesRequest::from_value(payload)?;
    let background = request.background();
    let execution_request = request.to_execution_request();
    let response_id = format!("resp_{}", execution_request.subtask_id);
    let result = state.runner.submit(execution_request).await;
    let status = response_status(background, result.status);

    Ok(Json(OpenAIBackgroundResponse {
        id: response_id,
        status,
        message: format!("Task execution status: {}", result.status),
    }))
}

fn response_status(background: bool, status: TaskStatus) -> String {
    if background {
        "queued".to_owned()
    } else {
        status.as_str().to_owned()
    }
}

#[derive(Debug, Serialize)]
struct OpenAIBackgroundResponse {
    id: String,
    status: String,
    message: String,
}

#[derive(Debug)]
struct HttpError {
    status: StatusCode,
    detail: String,
}

impl From<ProtocolError> for HttpError {
    fn from(error: ProtocolError) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            detail: error.to_string(),
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}
