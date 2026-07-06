// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env, fs,
    future::Future,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

mod config;

use axum::{
    body::{Body, Bytes},
    extract::{Multipart, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{process::Command, sync::Semaphore, time::timeout};

use crate::{
    agents::runtime_capabilities,
    agents::{AgentCommandPlanner, AgentProcessEngine},
    callback::CallbackSink,
    envd::archive::{
        create_runtime_archive, restore_runtime_archive, ArchiveError, ArchiveMode, ArchiveOptions,
    },
    heartbeat::start_heartbeat_from_env,
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
        .route("/health", get(envd_health_check))
        .route("/metrics", get(envd_metrics))
        .route("/init", post(envd_init))
        .route("/envs", get(envd_envs))
        .route("/v1/responses", post(openai_responses::<R>))
        .route("/v1/attachments/sync", post(sync_attachments))
        .route("/filesystem/list-dir", get(list_workspace_directory))
        .route("/filesystem/file", get(download_workspace_file))
        .route(
            "/filesystem.Filesystem/ListDir",
            post(connect_list_workspace_directory),
        )
        .route("/filesystem.Filesystem/Stat", post(connect_stat_path))
        .route("/filesystem.Filesystem/MakeDir", post(connect_make_dir))
        .route("/process.Process/List", post(connect_process_list))
        .route("/process.Process/Start", post(connect_process_start))
        .route(
            "/process.Process/SendSignal",
            post(connect_process_send_signal),
        )
        .route("/files", get(download_envd_file).post(upload_envd_file))
        .route("/api/archive", post(archive_workspace))
        .route("/api/restore", post(restore_workspace))
        .with_state(state)
}

async fn sync_attachments(Json(request): Json<ExecutionRequest>) -> Result<Json<Value>, HttpError> {
    let mut fields = task_fields(&request.task_id, &request.subtask_id);
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
    let _heartbeat = start_heartbeat_from_env();

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

async fn envd_health_check() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn envd_metrics() -> Json<MetricsResponse> {
    let disk = disk_usage_bytes(Path::new("/")).unwrap_or_default();
    let memory = memory_usage_bytes().unwrap_or_default();
    Json(MetricsResponse {
        ts: chrono::Utc::now().timestamp(),
        cpu_count: std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        cpu_used_pct: cpu_used_pct().await.unwrap_or_default(),
        mem_total: memory.total,
        mem_used: memory.used,
        disk_total: disk.total,
        disk_used: disk.used,
    })
}

async fn envd_init(Json(request): Json<InitRequest>) -> Result<Response, HttpError> {
    envd_state().lock().unwrap().init(request)?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(""));
    Ok((StatusCode::NO_CONTENT, headers).into_response())
}

async fn envd_envs() -> Json<HashMap<String, String>> {
    Json(envd_state().lock().unwrap().env_vars.clone())
}

async fn list_workspace_directory(
    Query(query): Query<WorkspacePathQuery>,
) -> Result<Json<Vec<WorkspaceEntry>>, HttpError> {
    let path = resolve_workspace_path(query.path.as_deref().unwrap_or("/workspace"))?;
    list_workspace_entries(&path).map(Json)
}

async fn connect_list_workspace_directory(
    Json(payload): Json<ConnectListDirRequest>,
) -> Result<Json<ConnectListDirResponse<FsEntryInfo>>, HttpError> {
    let raw_path = payload.path.as_deref().unwrap_or_default();
    let path = resolve_envd_filesystem_path(raw_path)?;
    log_executor_event(
        "envd filesystem list_dir request",
        &[
            ("raw_path", raw_path.to_owned()),
            ("resolved_path", path.to_string_lossy().to_string()),
            ("depth", payload.depth.unwrap_or(1).to_string()),
        ],
    );
    let entries = list_envd_filesystem_entries(&path, payload.depth.unwrap_or(1))?;
    Ok(Json(ConnectListDirResponse { entries }))
}

async fn connect_stat_path(
    Json(payload): Json<ConnectStatRequest>,
) -> Result<Json<ConnectStatResponse>, HttpError> {
    let path = resolve_envd_filesystem_path(&payload.path)?;
    log_executor_event(
        "envd filesystem stat request",
        &[
            ("raw_path", payload.path),
            ("resolved_path", path.to_string_lossy().to_string()),
        ],
    );
    Ok(Json(ConnectStatResponse {
        entry: envd_filesystem_entry(&path, &path)?,
    }))
}

async fn connect_make_dir(
    Json(payload): Json<ConnectMakeDirRequest>,
) -> Result<Json<ConnectMakeDirResponse>, HttpError> {
    let path = resolve_envd_filesystem_path(&payload.path)?;
    log_executor_event(
        "envd filesystem make_dir request",
        &[
            ("raw_path", payload.path),
            ("resolved_path", path.to_string_lossy().to_string()),
        ],
    );
    if path.exists() {
        if path.is_dir() {
            return Err(HttpError {
                status: StatusCode::CONFLICT,
                detail: format!("Directory already exists: {}", path.display()),
            });
        }
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!(
                "Path already exists but it is not a directory: {}",
                path.display()
            ),
        });
    }
    fs::create_dir_all(&path).map_err(|error| HttpError {
        status: if error.kind() == std::io::ErrorKind::PermissionDenied {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        },
        detail: format!("Failed to create directory: {error}"),
    })?;
    Ok(Json(ConnectMakeDirResponse {
        entry: envd_filesystem_entry(&path, &path)?,
    }))
}

async fn connect_process_list() -> Json<Value> {
    Json(json!({"processes": []}))
}

async fn connect_process_send_signal() -> Json<Value> {
    Json(json!({}))
}

async fn connect_process_start(body: Body) -> Result<Response, HttpError> {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .map_err(|error| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("failed to read process start request: {error}"),
        })?;
    let request: ProcessStartRequest = serde_json::from_slice(&connect_request_payload(&bytes)?)
        .map_err(|error| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("invalid process start request: {error}"),
        })?;
    let output = run_envd_process(&request).await;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/connect+json"),
    );
    Ok((
        StatusCode::OK,
        headers,
        Body::from(process_start_stream_body(&output)),
    )
        .into_response())
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
    if metadata.is_dir() {
        ensure_directory_download_size(&path)?;
        let content = zip_directory(&path).await?;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/zip"),
        );
        return Ok((headers, Body::from(content)).into_response());
    }
    if !metadata.is_file() {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Path is not a file".to_owned(),
        });
    }
    ensure_file_download_size(metadata.len())?;
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

async fn download_envd_file(
    headers: HeaderMap,
    Query(query): Query<WorkspacePathQuery>,
) -> Result<Response, HttpError> {
    log_executor_event(
        "envd file download request",
        &[
            ("path", query.path.clone().unwrap_or_default()),
            ("username", query.username.clone().unwrap_or_default()),
            ("content_type", header_value(&headers, header::CONTENT_TYPE)),
        ],
    );
    let path = resolve_envd_path(&query)?;
    let metadata = fs::metadata(&path).map_err(|_| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: format!(
            "File not found: {}",
            query.path.as_deref().unwrap_or_default()
        ),
    })?;
    if !has_read_access(&path) {
        return Err(HttpError {
            status: StatusCode::UNAUTHORIZED,
            detail: format!(
                "Permission denied: {}",
                query.path.as_deref().unwrap_or_default()
            ),
        });
    }
    if metadata.is_dir() {
        ensure_directory_download_size(&path)?;
        let content = zip_directory(&path).await?;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/zip"),
        );
        return Ok((headers, Body::from(content)).into_response());
    }
    if !metadata.is_file() {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!(
                "Path is not a file: {}",
                query.path.as_deref().unwrap_or_default()
            ),
        });
    }
    ensure_file_download_size(metadata.len())?;
    let mut file = fs::File::open(&path).map_err(|error| HttpError {
        status: if error.kind() == std::io::ErrorKind::PermissionDenied {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        },
        detail: format!("failed to read file: {error}"),
    })?;
    let mut content = Vec::new();
    file.read_to_end(&mut content).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("failed to read file: {error}"),
    })?;
    log_executor_event(
        "envd file download succeeded",
        &[
            ("path", path.to_string_lossy().to_string()),
            ("size", content.len().to_string()),
        ],
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok((headers, Body::from(content)).into_response())
}

fn ensure_file_download_size(size: u64) -> Result<(), HttpError> {
    let limit_bytes = workspace_download_limit_bytes();
    if size > limit_bytes {
        return Err(HttpError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            detail: format!("Download exceeds {} MiB limit", limit_bytes / 1024 / 1024),
        });
    }
    Ok(())
}

fn workspace_download_limit_bytes() -> u64 {
    std::env::var("MAX_WORKSPACE_DOWNLOAD_MB")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_WORKSPACE_DOWNLOAD_MB)
        .saturating_mul(1024 * 1024)
}

fn ensure_directory_download_size(path: &Path) -> Result<(), HttpError> {
    let mut total = 0;
    add_directory_download_size(path, &mut total)
}

fn add_directory_download_size(path: &Path, total: &mut u64) -> Result<(), HttpError> {
    for entry in fs::read_dir(path).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("failed to read directory: {error}"),
    })? {
        let entry = entry.map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("failed to read directory entry: {error}"),
        })?;
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("failed to read metadata: {error}"),
        })?;
        if metadata.file_type().is_symlink() {
            return Err(HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: "Directory archive cannot include symbolic links".to_owned(),
            });
        }
        if metadata.is_dir() {
            add_directory_download_size(&entry_path, total)?;
        } else if metadata.is_file() {
            *total = total.saturating_add(metadata.len());
            ensure_file_download_size(*total)?;
        }
    }
    Ok(())
}

async fn zip_directory(path: &Path) -> Result<Vec<u8>, HttpError> {
    let _permit = zip_download_semaphore()
        .try_acquire()
        .map_err(|_| HttpError {
            status: StatusCode::TOO_MANY_REQUESTS,
            detail: "Too many archive downloads in progress".to_owned(),
        })?;
    let parent = path.parent().ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "Directory parent not found".to_owned(),
    })?;
    let file_name = path.file_name().ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "Directory name not found".to_owned(),
    })?;

    let mut command = Command::new("zip");
    command
        .arg("-r")
        .arg("-q")
        .arg("-")
        .arg(file_name)
        .current_dir(parent)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = match timeout(
        Duration::from_secs(MAX_WORKSPACE_ZIP_TIMEOUT_SECONDS),
        command.output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(HttpError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: format!("failed to run zip: {error}"),
            });
        }
        Err(_) => {
            return Err(HttpError {
                status: StatusCode::REQUEST_TIMEOUT,
                detail: "Archive download timed out".to_owned(),
            });
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("zip failed: {stderr}"),
        });
    }

    Ok(output.stdout)
}

fn zip_download_semaphore() -> &'static Semaphore {
    static SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Semaphore::new(MAX_WORKSPACE_ZIP_CONCURRENCY))
}

async fn upload_envd_file(
    headers: HeaderMap,
    Query(query): Query<WorkspacePathQuery>,
    mut multipart: Multipart,
) -> Result<Json<Vec<EntryInfo>>, HttpError> {
    log_executor_event(
        "envd file upload request",
        &[
            ("path", query.path.clone().unwrap_or_default()),
            ("username", query.username.clone().unwrap_or_default()),
            ("content_type", header_value(&headers, header::CONTENT_TYPE)),
        ],
    );
    let path = resolve_envd_path(&query)?;
    let Some(parent) = path.parent() else {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Path is required".to_owned(),
        });
    };
    fs::create_dir_all(parent).map_err(|error| {
        log_executor_event(
            "envd file upload parent create failed",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("parent", parent.to_string_lossy().to_string()),
                ("error", error.to_string()),
            ],
        );
        HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("failed to create parent directory: {error}"),
        }
    })?;
    if let Some(usage) = disk_usage_bytes(parent) {
        let free = usage.total.saturating_sub(usage.used);
        log_executor_event(
            "envd file upload disk check",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("parent", parent.to_string_lossy().to_string()),
                ("free_bytes", free.to_string()),
                ("required_bytes", MIN_UPLOAD_FREE_SPACE_BYTES.to_string()),
            ],
        );
        if free < MIN_UPLOAD_FREE_SPACE_BYTES {
            return Err(HttpError {
                status: StatusCode::INSUFFICIENT_STORAGE,
                detail: "Not enough disk space".to_owned(),
            });
        }
    }

    while let Some(field) = multipart.next_field().await.map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("invalid multipart body: {error}"),
    })? {
        let field_name = field.name().unwrap_or_default().to_owned();
        let file_name = field.file_name().unwrap_or_default().to_owned();
        log_executor_event(
            "envd file upload multipart field",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("field_name", field_name.clone()),
                ("file_name", file_name),
            ],
        );
        if field_name != "file" {
            continue;
        }
        let bytes = field.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("failed to read uploaded file: {error}"),
        })?;
        let size = bytes.len();
        fs::write(&path, &bytes).map_err(|error| {
            log_executor_event(
                "envd file upload write failed",
                &[
                    ("path", path.to_string_lossy().to_string()),
                    ("size", size.to_string()),
                    ("error", error.to_string()),
                ],
            );
            HttpError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: format!("failed to write uploaded file: {error}"),
            }
        })?;
        log_executor_event(
            "envd file upload succeeded",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("size", size.to_string()),
            ],
        );
        return Ok(Json(vec![EntryInfo {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default(),
            entry_type: "file".to_owned(),
        }]));
    }

    Err(HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "multipart field 'file' is required".to_owned(),
    })
}

async fn archive_workspace(
    Json(request): Json<ArchiveRequest>,
) -> Result<Json<ArchiveResponse>, HttpError> {
    let mode = parse_archive_mode(&request.runtime_type)?;
    let archive = create_runtime_archive(ArchiveOptions {
        mode,
        workspace_path: task_workspace_path(request.task_id),
        home_path: runtime_home_path(mode),
        max_size_bytes: u64::from(request.max_size_mb) * 1024 * 1024,
    })
    .map_err(archive_error_to_http)?;

    reqwest::Client::new()
        .put(&request.upload_url)
        .header(header::CONTENT_TYPE.as_str(), "application/gzip")
        .body(archive.bytes.clone())
        .send()
        .await
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("failed to upload archive: {error}"),
        })?
        .error_for_status()
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("archive upload failed: {error}"),
        })?;

    Ok(Json(ArchiveResponse {
        task_id: request.task_id,
        size_bytes: archive.bytes.len() as u64,
        session_file_included: archive.session_file_included,
        git_included: archive.git_included,
    }))
}

async fn restore_workspace(
    Json(request): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, HttpError> {
    let mode = parse_archive_mode(&request.runtime_type)?;
    let bytes = reqwest::Client::new()
        .get(&request.download_url)
        .send()
        .await
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("failed to download archive: {error}"),
        })?
        .error_for_status()
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("archive download failed: {error}"),
        })?
        .bytes()
        .await
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("failed to read archive response: {error}"),
        })?;

    let result = restore_runtime_archive(
        &bytes,
        mode,
        &task_workspace_path(request.task_id),
        &runtime_home_path(mode),
    )
    .map_err(archive_error_to_http)?;

    Ok(Json(RestoreResponse {
        success: result.success,
        session_restored: result.session_restored,
        git_restored: result.git_restored,
    }))
}

async fn openai_responses<R>(
    State(state): State<AppState<R>>,
    body: Bytes,
) -> Result<Json<OpenAIBackgroundResponse>, HttpError>
where
    R: TaskRunner,
{
    let payload = serde_json::from_slice::<Value>(&body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: error.to_string(),
    })?;
    let payload_preview = sanitized_json_preview(&payload, REQUEST_PAYLOAD_PREVIEW_CHARS);
    let request = OpenAIResponsesRequest::from_value(payload)?;
    let background = request.background();
    let execution_request = request.to_execution_request();
    let response_id = format!("resp_{}", execution_request.subtask_id);
    let mut fields = task_fields(&execution_request.task_id, &execution_request.subtask_id);
    fields.push((
        "agent",
        format!("{:?}", execution_request.resolved_agent_kind()),
    ));
    fields.push(("background", background.to_string()));
    fields.push(("payload_preview", payload_preview));
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

const REQUEST_PAYLOAD_PREVIEW_CHARS: usize = 2_000;

fn sanitized_json_preview(value: &Value, max_chars: usize) -> String {
    let sanitized = sanitize_log_value(value);
    let serialized = serde_json::to_string(&sanitized).unwrap_or_default();
    truncate_log_value(&serialized, max_chars)
}

fn sanitize_log_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let value = if is_sensitive_log_key(key) {
                        Value::String("***".to_owned())
                    } else {
                        sanitize_log_value(value)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(sanitize_log_value).collect()),
        _ => value.clone(),
    }
}

fn is_sensitive_log_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("private_key")
        || normalized == "authorization"
}

fn truncate_log_value(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let truncated = value.chars().take(max_chars).collect::<String>();
    format!("{truncated}...")
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
    username: Option<String>,
    signature: Option<String>,
    signature_expiration: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct InitRequest {
    #[serde(default, rename = "hyperloopIP")]
    hyperloop_ip: Option<String>,
    #[serde(default, rename = "envVars")]
    env_vars: Option<HashMap<String, String>>,
    #[serde(default, rename = "accessToken")]
    access_token: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "defaultUser")]
    default_user: Option<String>,
    #[serde(default, rename = "defaultWorkdir")]
    default_workdir: Option<String>,
}

#[derive(Debug, Serialize)]
struct MetricsResponse {
    ts: i64,
    cpu_count: usize,
    cpu_used_pct: f64,
    mem_total: u64,
    mem_used: u64,
    disk_used: u64,
    disk_total: u64,
}

#[derive(Debug, Serialize)]
struct EntryInfo {
    path: String,
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

#[derive(Debug, Deserialize)]
struct ArchiveRequest {
    task_id: i64,
    upload_url: String,
    #[serde(default = "default_archive_max_size_mb")]
    max_size_mb: u32,
    #[serde(default = "default_runtime_type")]
    runtime_type: String,
}

#[derive(Debug, Serialize)]
struct ArchiveResponse {
    task_id: i64,
    size_bytes: u64,
    session_file_included: bool,
    git_included: bool,
}

#[derive(Debug, Deserialize)]
struct RestoreRequest {
    task_id: i64,
    download_url: String,
    #[serde(default = "default_runtime_type")]
    runtime_type: String,
}

#[derive(Debug, Serialize)]
struct RestoreResponse {
    success: bool,
    session_restored: bool,
    git_restored: bool,
}

#[derive(Debug, Deserialize)]
struct ConnectListDirRequest {
    path: Option<String>,
    #[allow(dead_code)]
    depth: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ConnectListDirResponse<T> {
    entries: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct ConnectStatRequest {
    path: String,
}

#[derive(Debug, Serialize)]
struct ConnectStatResponse {
    entry: FsEntryInfo,
}

#[derive(Debug, Deserialize)]
struct ConnectMakeDirRequest {
    path: String,
}

#[derive(Debug, Serialize)]
struct ConnectMakeDirResponse {
    entry: FsEntryInfo,
}

#[derive(Debug, Deserialize)]
struct ProcessStartRequest {
    process: ProcessStartConfig,
}

#[derive(Debug, Deserialize)]
struct ProcessStartConfig {
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    envs: HashMap<String, String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug)]
struct ProcessOutput {
    pid: u32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: i32,
    error: String,
}

#[derive(Debug, Serialize)]
struct FsEntryInfo {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
    path: String,
    size: u64,
    mode: u32,
    permissions: String,
    owner: String,
    group: String,
    modified_time: String,
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

fn list_envd_filesystem_entries(path: &Path, depth: usize) -> Result<Vec<FsEntryInfo>, HttpError> {
    let metadata = fs::metadata(path).map_err(|_| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: format!("Directory not found: {}", path.display()),
    })?;
    if !metadata.is_dir() {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("Path is not a directory: {}", path.display()),
        });
    }

    let max_depth = depth.max(1);
    let mut entries = Vec::new();
    collect_envd_filesystem_entries(path, path, max_depth, 0, &mut entries)?;
    entries.sort_by(|left, right| {
        let left_is_dir = left.entry_type == "FILE_TYPE_DIRECTORY";
        let right_is_dir = right.entry_type == "FILE_TYPE_DIRECTORY";
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

fn collect_envd_filesystem_entries(
    root: &Path,
    current: &Path,
    max_depth: usize,
    current_depth: usize,
    entries: &mut Vec<FsEntryInfo>,
) -> Result<(), HttpError> {
    if current_depth >= max_depth {
        return Ok(());
    }
    let children = fs::read_dir(current).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Error reading directory {}: {error}", current.display()),
    })?;
    for child in children {
        let child = child.map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Error reading directory entry: {error}"),
        })?;
        let child_path = child.path();
        entries.push(envd_filesystem_entry(root, &child_path)?);
        if child_path.is_dir() {
            collect_envd_filesystem_entries(
                root,
                &child_path,
                max_depth,
                current_depth + 1,
                entries,
            )?;
        }
    }
    Ok(())
}

fn envd_filesystem_entry(_root: &Path, path: &Path) -> Result<FsEntryInfo, HttpError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| HttpError {
        status: if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else if error.kind() == std::io::ErrorKind::PermissionDenied {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        },
        detail: format!("Failed to get file info: {error}"),
    })?;
    let mode = file_mode(&metadata);
    Ok(FsEntryInfo {
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        entry_type: if path.is_dir() {
            "FILE_TYPE_DIRECTORY".to_owned()
        } else {
            "FILE_TYPE_FILE".to_owned()
        },
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        mode,
        permissions: file_permissions(mode, metadata.is_dir()),
        owner: String::new(),
        group: String::new(),
        modified_time: metadata
            .modified()
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned()),
    })
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

fn resolve_envd_path(query: &WorkspacePathQuery) -> Result<PathBuf, HttpError> {
    let _ = (&query.signature, query.signature_expiration);
    let raw_path = query
        .path
        .as_deref()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Path is required".to_owned(),
        })?;
    let mut path = PathBuf::from(raw_path);
    if !path.is_absolute() {
        if let Some(username) = query.username.as_deref().filter(|value| !value.is_empty()) {
            let current_user = env::var("USER").unwrap_or_default();
            let user_home = if username == current_user {
                home_path()
            } else {
                PathBuf::from("/home").join(username)
            };
            path = user_home.join(path);
        } else {
            let default_workdir = envd_state().lock().unwrap().default_workdir.clone();
            if let Some(default_workdir) = default_workdir.filter(|value| !value.is_empty()) {
                path = PathBuf::from(default_workdir).join(path);
            } else {
                path = env::current_dir()
                    .map_err(|error| HttpError {
                        status: StatusCode::INTERNAL_SERVER_ERROR,
                        detail: format!("failed to resolve current directory: {error}"),
                    })?
                    .join(path);
            }
        }
    }
    log_executor_event(
        "envd path resolved",
        &[
            ("raw_path", raw_path.to_owned()),
            ("resolved_path", path.to_string_lossy().to_string()),
            ("username", query.username.clone().unwrap_or_default()),
        ],
    );
    Ok(path)
}

fn resolve_envd_filesystem_path(raw_path: &str) -> Result<PathBuf, HttpError> {
    let path = if raw_path.trim().is_empty() {
        PathBuf::from(".")
    } else if raw_path == "~" {
        home_path()
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        home_path().join(rest)
    } else {
        PathBuf::from(raw_path)
    };
    if path.is_absolute() {
        return Ok(path);
    }
    env::current_dir()
        .map(|current| current.join(path))
        .map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("failed to resolve current directory: {error}"),
        })
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

async fn run_envd_process(request: &ProcessStartRequest) -> ProcessOutput {
    let mut command = Command::new(&request.process.cmd);
    command
        .args(&request.process.args)
        .envs(&request.process.envs)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = request
        .process
        .cwd
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        command.current_dir(cwd);
    }
    log_executor_event(
        "envd process start request",
        &[
            ("cmd", request.process.cmd.clone()),
            ("arg_count", request.process.args.len().to_string()),
            ("cwd", request.process.cwd.clone().unwrap_or_default()),
        ],
    );
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ProcessOutput {
                pid: 0,
                stdout: Vec::new(),
                stderr: error.to_string().into_bytes(),
                exit_code: -1,
                error: error.to_string(),
            };
        }
    };
    let pid = child.id().unwrap_or_default();
    match child.wait_with_output().await {
        Ok(output) => {
            let exit_code = output.status.code().unwrap_or(-1);
            log_executor_event(
                "envd process finished",
                &[
                    ("pid", pid.to_string()),
                    ("exit_code", exit_code.to_string()),
                    ("stdout_len", output.stdout.len().to_string()),
                    ("stderr_len", output.stderr.len().to_string()),
                ],
            );
            ProcessOutput {
                pid,
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code,
                error: String::new(),
            }
        }
        Err(error) => ProcessOutput {
            pid,
            stdout: Vec::new(),
            stderr: error.to_string().into_bytes(),
            exit_code: -1,
            error: error.to_string(),
        },
    }
}

fn connect_request_payload(bytes: &[u8]) -> Result<Vec<u8>, HttpError> {
    if bytes.len() < CONNECT_ENVELOPE_HEADER_LEN {
        return Ok(bytes.to_vec());
    }
    let flags = bytes[0];
    let len = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
    if bytes.len() == CONNECT_ENVELOPE_HEADER_LEN + len {
        if flags & CONNECT_FLAG_COMPRESSED != 0 {
            return Err(HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: "compressed connect requests are not supported".to_owned(),
            });
        }
        return Ok(bytes[CONNECT_ENVELOPE_HEADER_LEN..].to_vec());
    }
    Ok(bytes.to_vec())
}

fn process_start_stream_body(output: &ProcessOutput) -> Vec<u8> {
    let mut stream = Vec::new();
    append_connect_json_message(
        &mut stream,
        json!({"event": {"start": {"pid": output.pid}}}),
    );
    if !output.stdout.is_empty() {
        append_connect_json_message(
            &mut stream,
            json!({"event": {"data": {"stdout": base64_encode(&output.stdout)}}}),
        );
    }
    if !output.stderr.is_empty() {
        append_connect_json_message(
            &mut stream,
            json!({"event": {"data": {"stderr": base64_encode(&output.stderr)}}}),
        );
    }
    append_connect_json_message(
        &mut stream,
        json!({
            "event": {
                "end": {
                    "exitCode": output.exit_code,
                    "exited": true,
                    "status": if output.exit_code == 0 { "success" } else { "error" },
                    "error": output.error,
                }
            }
        }),
    );
    append_connect_envelope(&mut stream, CONNECT_FLAG_END_STREAM, b"{}");
    stream
}

fn append_connect_json_message(stream: &mut Vec<u8>, value: Value) {
    append_connect_envelope(stream, 0, value.to_string().as_bytes());
}

fn append_connect_envelope(stream: &mut Vec<u8>, flags: u8, data: &[u8]) {
    stream.push(flags);
    stream.extend_from_slice(&(data.len() as u32).to_be_bytes());
    stream.extend_from_slice(data);
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

const CONNECT_ENVELOPE_HEADER_LEN: usize = 5;
const CONNECT_FLAG_COMPRESSED: u8 = 0b0000_0001;
const CONNECT_FLAG_END_STREAM: u8 = 0b0000_0010;

fn task_workspace_path(task_id: i64) -> PathBuf {
    workspace_root().join(task_id.to_string())
}

fn runtime_home_path(mode: ArchiveMode) -> PathBuf {
    match mode {
        ArchiveMode::Executor => home_path(),
        ArchiveMode::Sandbox => PathBuf::from("/home/user"),
    }
}

fn home_path() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/home/user"))
}

fn parse_archive_mode(value: &str) -> Result<ArchiveMode, HttpError> {
    match value {
        "executor" | "" => Ok(ArchiveMode::Executor),
        "sandbox" => Ok(ArchiveMode::Sandbox),
        other => Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("invalid runtime_type: {other}"),
        }),
    }
}

fn archive_error_to_http(error: ArchiveError) -> HttpError {
    let status = match error {
        ArchiveError::MissingWorkspace(_) | ArchiveError::EmptyArchiveRoots { .. } => {
            StatusCode::NOT_FOUND
        }
        ArchiveError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
        ArchiveError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    HttpError {
        status,
        detail: error.to_string(),
    }
}

#[derive(Debug, Default)]
struct EnvdState {
    env_vars: HashMap<String, String>,
    access_token: Option<String>,
    last_set_time: Option<SystemTime>,
    default_user: Option<String>,
    default_workdir: Option<String>,
    hyperloop_ip: Option<String>,
}

impl EnvdState {
    fn init(&mut self, request: InitRequest) -> Result<(), HttpError> {
        let request_time = request.timestamp.as_deref().and_then(parse_envd_timestamp);
        let should_update = request_time
            .map(|time| self.last_set_time.map_or(true, |last| time > last))
            .unwrap_or(true);
        if !should_update {
            return Ok(());
        }
        if let Some(access_token) = request
            .access_token
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            if self
                .access_token
                .as_ref()
                .is_some_and(|existing| existing != access_token)
            {
                return Err(HttpError {
                    status: StatusCode::CONFLICT,
                    detail: "Access token is already set".to_owned(),
                });
            }
            self.access_token = Some(access_token.clone());
        }
        if let Some(hyperloop_ip) = request.hyperloop_ip.filter(|value| !value.is_empty()) {
            self.hyperloop_ip = Some(hyperloop_ip);
        }
        if let Some(env_vars) = request.env_vars {
            self.env_vars.extend(env_vars);
        }
        if let Some(default_user) = request.default_user.filter(|value| !value.is_empty()) {
            self.default_user = Some(default_user);
        }
        if let Some(default_workdir) = request.default_workdir.filter(|value| !value.is_empty()) {
            self.default_workdir = Some(default_workdir);
        }
        if let Some(request_time) = request_time {
            self.last_set_time = Some(request_time);
        }
        Ok(())
    }
}

fn envd_state() -> &'static Mutex<EnvdState> {
    static STATE: OnceLock<Mutex<EnvdState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(EnvdState::default()))
}

fn parse_envd_timestamp(value: &str) -> Option<SystemTime> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(SystemTime::from)
}

fn default_archive_max_size_mb() -> u32 {
    500
}

fn default_runtime_type() -> String {
    "executor".to_owned()
}

const MIN_UPLOAD_FREE_SPACE_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_MAX_WORKSPACE_DOWNLOAD_MB: u64 = 500;
const MAX_WORKSPACE_ZIP_CONCURRENCY: usize = 2;
const MAX_WORKSPACE_ZIP_TIMEOUT_SECONDS: u64 = 120;

#[derive(Debug, Default)]
struct ByteUsage {
    total: u64,
    used: u64,
}

async fn cpu_used_pct() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        let first = read_cpu_times()?;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let second = read_cpu_times()?;
        let total = second.total.saturating_sub(first.total);
        if total == 0 {
            return Some(0.0);
        }
        let idle = second.idle.saturating_sub(first.idle);
        Some(((total.saturating_sub(idle)) as f64 / total as f64) * 100.0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy)]
struct CpuTimes {
    total: u64,
    idle: u64,
}

#[cfg(target_os = "linux")]
fn read_cpu_times() -> Option<CpuTimes> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().find(|line| line.starts_with("cpu "))?;
    let values = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<_>>();
    let total = values.iter().copied().sum::<u64>();
    let idle =
        values.get(3).copied().unwrap_or_default() + values.get(4).copied().unwrap_or_default();
    Some(CpuTimes { total, idle })
}

fn memory_usage_bytes() -> Option<ByteUsage> {
    #[cfg(target_os = "linux")]
    {
        let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
        let mut total_kb = None;
        let mut available_kb = None;
        for line in meminfo.lines() {
            if let Some(value) = line.strip_prefix("MemTotal:") {
                total_kb = value.split_whitespace().next()?.parse::<u64>().ok();
            } else if let Some(value) = line.strip_prefix("MemAvailable:") {
                available_kb = value.split_whitespace().next()?.parse::<u64>().ok();
            }
        }
        let total = total_kb?.saturating_mul(1024);
        let available = available_kb.unwrap_or(0).saturating_mul(1024);
        Some(ByteUsage {
            total,
            used: total.saturating_sub(available),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(unix)]
fn disk_usage_bytes(path: &Path) -> Option<ByteUsage> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let result = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    let stat = unsafe { stat.assume_init() };
    let block_size = unsigned_to_u64(stat.f_frsize);
    let total = unsigned_to_u64(stat.f_blocks).saturating_mul(block_size);
    let available = unsigned_to_u64(stat.f_bavail).saturating_mul(block_size);
    Some(ByteUsage {
        total,
        used: total.saturating_sub(available),
    })
}

#[cfg(unix)]
fn unsigned_to_u64<T>(value: T) -> u64
where
    T: Into<u64>,
{
    value.into()
}

#[cfg(not(unix))]
fn disk_usage_bytes(_path: &Path) -> Option<ByteUsage> {
    None
}

#[cfg(unix)]
fn has_read_access(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return true;
    };
    unsafe { libc::access(c_path.as_ptr(), libc::R_OK) == 0 }
}

#[cfg(not(unix))]
fn has_read_access(_path: &Path) -> bool {
    true
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;

    metadata.mode()
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata) -> u32 {
    0
}

fn file_permissions(mode: u32, is_dir: bool) -> String {
    let mut value = String::with_capacity(10);
    value.push(if is_dir { 'd' } else { '-' });
    for shift in [6, 3, 0] {
        value.push(if mode & (0o4 << shift) != 0 { 'r' } else { '-' });
        value.push(if mode & (0o2 << shift) != 0 { 'w' } else { '-' });
        value.push(if mode & (0o1 << shift) != 0 { 'x' } else { '-' });
    }
    value
}

fn header_value(headers: &HeaderMap, name: header::HeaderName) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
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
        log_executor_event(
            "http error response",
            &[
                ("status", self.status.as_u16().to_string()),
                ("detail", self.detail.clone()),
            ],
        );
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitized_json_preview_redacts_nested_secrets() {
        let preview = sanitized_json_preview(
            &json!({
                "input": "clone repo",
                "metadata": {
                    "auth_token": "task-jwt-secret",
                    "skill_identity_token": "skill-jwt-secret",
                    "user": {
                        "gitToken": "glpat-secret",
                        "git_login": "tester"
                    }
                },
                "headers": {
                    "Authorization": "Bearer auth-secret"
                },
                "tools": [
                    {
                        "env": {
                            "GITLAB_TOKEN": "gitlab-secret",
                            "repo": "message-flow"
                        }
                    }
                ]
            }),
            2_000,
        );

        assert!(preview.contains("\"input\":\"clone repo\""));
        assert!(preview.contains("\"repo\":\"message-flow\""));
        assert!(preview.contains("\"auth_token\":\"***\""));
        assert!(preview.contains("\"skill_identity_token\":\"***\""));
        assert!(preview.contains("\"gitToken\":\"***\""));
        assert!(preview.contains("\"Authorization\":\"***\""));
        assert!(preview.contains("\"GITLAB_TOKEN\":\"***\""));
        assert!(!preview.contains("task-jwt-secret"));
        assert!(!preview.contains("skill-jwt-secret"));
        assert!(!preview.contains("glpat-secret"));
        assert!(!preview.contains("auth-secret"));
        assert!(!preview.contains("gitlab-secret"));
    }

    #[test]
    fn sanitized_json_preview_truncates_long_payloads() {
        let preview =
            sanitized_json_preview(&json!({ "message": "abcdefghijklmnopqrstuvwxyz" }), 16);

        assert!(preview.ends_with("..."));
        assert!(preview.chars().count() <= 19);
    }
}
