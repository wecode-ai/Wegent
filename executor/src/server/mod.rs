// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    future::Future,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

mod config;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    agents::runtime_capabilities,
    agents::{AgentCommandPlanner, AgentProcessEngine},
    callback::CallbackSink,
    logging::{executor_log_timestamp, log_executor_event, task_fields, write_executor_log_line},
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
        .route("/v1/attachments/sync", post(sync_attachments))
        .route("/filesystem/list-dir", get(list_workspace_directory))
        .route("/filesystem/file", get(download_workspace_file))
        .route(
            "/filesystem.Filesystem/ListDir",
            post(connect_list_workspace_directory),
        )
        .route("/files", get(download_workspace_file))
        .with_state(state)
}

async fn sync_attachments(Json(request): Json<ExecutionRequest>) -> Result<Json<Value>, HttpError> {
    let mut fields = task_fields(request.task_id, request.subtask_id);
    let attachment_count = request
        .extra
        .get("attachments")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    fields.push(("attachment_count", attachment_count.to_string()));
    fields.push((
        "has_auth_token",
        request
            .auth_token
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
            .to_string(),
    ));
    fields.push((
        "backend_url_present",
        request
            .backend_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
            .to_string(),
    ));
    log_executor_event("attachment sync request received", &fields);
    Ok(Json(
        runtime_capabilities::sync_attachments_for_request(request).await,
    ))
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
    write_executor_log_line(&startup_log_line(bind_addr));

    axum::serve(listener, create_docker_router_from_env()?)
        .await
        .map_err(|error| format!("executor server failed: {error}"))
}

pub fn startup_log_line(bind_addr: SocketAddr) -> String {
    format!("{} listening on {bind_addr}", executor_log_timestamp())
}

async fn health_check() -> Json<Value> {
    Json(json!({"status": "healthy", "service": "task_executor"}))
}

async fn list_workspace_directory(
    Query(query): Query<WorkspacePathQuery>,
) -> Result<Json<Vec<WorkspaceEntry>>, HttpError> {
    let path = resolve_workspace_path(query.path.as_deref().unwrap_or("/workspace"))?;
    list_workspace_entries(&path).map(Json)
}

async fn connect_list_workspace_directory(
    Json(payload): Json<ConnectListDirRequest>,
) -> Result<Json<ConnectListDirResponse>, HttpError> {
    let path = resolve_workspace_path(payload.path.as_deref().unwrap_or("/workspace"))?;
    let entries = list_workspace_entries(&path)?;
    Ok(Json(ConnectListDirResponse { entries }))
}

async fn download_workspace_file(
    Query(query): Query<WorkspacePathQuery>,
) -> Result<Response, HttpError> {
    let raw_path = query.path.as_deref().ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "missing path".to_owned(),
    })?;
    let path = resolve_workspace_path(raw_path)?;
    let metadata = fs::metadata(&path).map_err(|_| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "File not found".to_owned(),
    })?;
    if !metadata.is_file() {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Path is not a file".to_owned(),
        });
    }
    let content = fs::read(&path).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("failed to read file: {error}"),
    })?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok((headers, Body::from(content)).into_response())
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
    let mut fields = task_fields(execution_request.task_id, execution_request.subtask_id);
    fields.push((
        "agent",
        format!("{:?}", execution_request.resolved_agent_kind()),
    ));
    fields.push(("background", background.to_string()));
    log_executor_event("received request", &fields);

    let result = state.runner.submit(execution_request).await;
    let status = response_status(background, result.status);
    fields.push(("status", result.status.to_string()));
    log_executor_event("request submitted", &fields);

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

#[derive(Debug, Deserialize)]
struct WorkspacePathQuery {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConnectListDirRequest {
    path: Option<String>,
    #[allow(dead_code)]
    depth: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ConnectListDirResponse {
    entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Serialize)]
struct WorkspaceEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: u64,
    modified_at: Option<u64>,
    #[serde(rename = "type")]
    entry_type: String,
}

fn list_workspace_entries(path: &Path) -> Result<Vec<WorkspaceEntry>, HttpError> {
    let metadata = fs::metadata(path).map_err(|_| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "Path not found".to_owned(),
    })?;
    if !metadata.is_dir() {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Path is not a directory".to_owned(),
        });
    }

    let mut entries = fs::read_dir(path)
        .map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("failed to list directory: {error}"),
        })?
        .filter_map(|entry| workspace_entry(entry.ok()?))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

fn workspace_entry(entry: fs::DirEntry) -> Option<WorkspaceEntry> {
    let path = entry.path();
    let metadata = entry.metadata().ok()?;
    let is_directory = metadata.is_dir();
    Some(WorkspaceEntry {
        name: entry.file_name().to_string_lossy().to_string(),
        path: display_workspace_path(&path)?,
        is_directory,
        size: if is_directory { 0 } else { metadata.len() },
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs()),
        entry_type: if is_directory {
            "FILE_TYPE_DIRECTORY".to_owned()
        } else {
            "FILE_TYPE_FILE".to_owned()
        },
    })
}

fn resolve_workspace_path(raw_path: &str) -> Result<PathBuf, HttpError> {
    let workspace_root = workspace_root();
    let path = raw_path.trim();
    if path.is_empty() {
        return Ok(workspace_root);
    }

    let candidate = if path == "/workspace" {
        workspace_root.clone()
    } else if let Some(rest) = path.strip_prefix("/workspace/") {
        workspace_root.join(rest)
    } else {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            workspace_root.join(path)
        }
    };

    let root = fs::canonicalize(&workspace_root).map_err(|_| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "Workspace root not found".to_owned(),
    })?;
    let canonical = fs::canonicalize(&candidate).map_err(|_| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "Path not found".to_owned(),
    })?;
    if !canonical.starts_with(&root) {
        return Err(HttpError {
            status: StatusCode::FORBIDDEN,
            detail: "Path is outside workspace".to_owned(),
        });
    }
    Ok(canonical)
}

fn display_workspace_path(path: &Path) -> Option<String> {
    let root = fs::canonicalize(workspace_root()).ok()?;
    let relative = path.strip_prefix(root).ok()?;
    let suffix = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if suffix.is_empty() {
        Some("/workspace".to_owned())
    } else {
        Some(format!("/workspace/{suffix}"))
    }
}

fn workspace_root() -> PathBuf {
    env::var_os("WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/workspace"))
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
