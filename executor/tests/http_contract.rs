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
    response::IntoResponse,
    routing::{get, put},
    Router,
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
    assert_eq!(submitted[0].task_id, "123");
    assert_eq!(submitted[0].subtask_id, "456");
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
                    json!({"path": workspace_root.join("123"), "depth": 1}).to_string(),
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

    let stat_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/filesystem.Filesystem/Stat")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"path": workspace_root.join("123/README.md")}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stat_response.status(), StatusCode::OK);
    let stat_body: Value = serde_json::from_slice(
        &stat_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(stat_body["entry"]["name"], json!("README.md"));
    assert_eq!(stat_body["entry"]["type"], json!("FILE_TYPE_FILE"));

    let mkdir_target = workspace_root.join("123/generated/nested");
    let mkdir_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/filesystem.Filesystem/MakeDir")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({"path": mkdir_target}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mkdir_response.status(), StatusCode::OK);
    assert!(workspace_root.join("123/generated/nested").is_dir());

    let file_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/filesystem/file?path=/workspace/123/README.md")
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

    let directory_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/filesystem/file?path=/workspace/123/src")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(directory_response.status(), StatusCode::OK);
    assert_eq!(
        directory_response
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap(),
        "application/zip"
    );
    let archive = directory_response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    assert!(archive.starts_with(b"PK"));
    assert!(archive
        .windows(b"main.rs".len())
        .any(|window| window == b"main.rs"));

    let oversized_file = workspace_root.join("123/oversized.bin");
    fs::File::create(&oversized_file)
        .unwrap()
        .set_len(501 * 1024 * 1024)
        .unwrap();
    let oversized_file_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/filesystem/file?path=/workspace/123/oversized.bin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        oversized_file_response.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );

    let oversized_dir = workspace_root.join("123/oversized-dir");
    fs::create_dir_all(&oversized_dir).unwrap();
    fs::File::create(oversized_dir.join("data.bin"))
        .unwrap()
        .set_len(501 * 1024 * 1024)
        .unwrap();
    let oversized_dir_response = app
        .oneshot(
            Request::builder()
                .uri("/filesystem/file?path=/workspace/123/oversized-dir")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        oversized_dir_response.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_directory_download_rejects_symbolic_links() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("executor-http-workspace-symlink");
    let outside_dir = unique_dir("executor-http-outside-secret");
    fs::create_dir_all(workspace_root.join("123/src")).unwrap();
    fs::create_dir_all(&outside_dir).unwrap();
    let outside_secret = outside_dir.join("secret.txt");
    fs::write(&outside_secret, "outside secret").unwrap();
    std::os::unix::fs::symlink(&outside_secret, workspace_root.join("123/src/secret-link"))
        .unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/filesystem/file?path=/workspace/123/src")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
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

#[tokio::test]
async fn envd_compat_routes_report_health_metrics_and_envs() {
    let app = create_router(AppState::new(RecordingRunner::default()));
    let env_key = format!("WEGENT_TEST_ENVD_{}", unique_suffix());

    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::NO_CONTENT);

    let metrics = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(metrics.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&metrics.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["cpu_count"].as_u64().unwrap_or_default() >= 1);
    assert!(body["disk_total"].as_u64().unwrap_or_default() > 0);

    let init = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/init")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"envVars": {env_key.clone(): "present"}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(init.status(), StatusCode::NO_CONTENT);

    let envs = app
        .oneshot(Request::builder().uri("/envs").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&envs.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body[env_key], json!("present"));
}

#[tokio::test]
async fn envd_files_endpoint_accepts_multipart_uploads_under_home() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("executor-http-upload-workspace");
    let home = unique_dir("executor-http-upload-home");
    fs::create_dir_all(&workspace_root).unwrap();
    fs::create_dir_all(&home).unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));
    let target = home.join("123:executor:attachments/456/input.txt");
    let boundary = "wegent-boundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"input.txt\"\r\nContent-Type: text/plain\r\n\r\nhello envd\r\n--{boundary}--\r\n"
    );

    let upload = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/files?path={}", target.display()))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(upload.status(), StatusCode::OK);
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello envd");

    let download = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/files?path={}", target.display()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(
        download.into_body().collect().await.unwrap().to_bytes(),
        "hello envd"
    );

    let directory = home.join("bundle");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("hello.txt"), "hello zip").unwrap();
    let directory_download = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/files?path={}", directory.display()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(directory_download.status(), StatusCode::OK);
    assert_eq!(
        directory_download
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap(),
        "application/zip"
    );
    let archive = directory_download
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    assert!(archive.starts_with(b"PK"));
    assert!(archive
        .windows(b"hello.txt".len())
        .any(|window| window == b"hello.txt"));

    let oversized = home.join("oversized.bin");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(501 * 1024 * 1024)
        .unwrap();
    let oversized_download = app
        .oneshot(
            Request::builder()
                .uri(format!("/files?path={}", oversized.display()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized_download.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn envd_files_endpoint_uses_env_download_size_limit() {
    let _lock = env_lock().lock().await;
    let home = unique_dir("executor-http-envd-download-limit");
    fs::create_dir_all(&home).unwrap();
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _limit = EnvGuard::set("MAX_WORKSPACE_DOWNLOAD_MB", "1");
    let app = create_router(AppState::new(RecordingRunner::default()));
    let oversized = home.join("oversized.bin");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(2 * 1024 * 1024)
        .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/files?path={}", oversized.display()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn envd_files_endpoint_allows_absolute_paths_outside_home_like_python() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("executor-http-absolute-workspace");
    let process_home = unique_dir("executor-http-process-home");
    let outside_home = unique_dir("executor-http-outside-home");
    fs::create_dir_all(&workspace_root).unwrap();
    fs::create_dir_all(&process_home).unwrap();
    fs::create_dir_all(&outside_home).unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _home = EnvGuard::set("HOME", &process_home.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));
    let target = outside_home.join("123:executor:attachments/456/input.txt");
    let boundary = "wegent-boundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"input.txt\"\r\nContent-Type: text/plain\r\n\r\nabsolute path\r\n--{boundary}--\r\n"
    );

    let upload = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/files?path={}", target.display()))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(upload.status(), StatusCode::OK);
    assert_eq!(fs::read_to_string(&target).unwrap(), "absolute path");
}

#[tokio::test]
async fn envd_process_start_runs_foreground_command_via_connect_stream() {
    let _lock = env_lock().lock().await;
    let home = unique_dir("executor-http-process-home");
    fs::create_dir_all(&home).unwrap();
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));
    let source = home.join("x");
    let target = home.join("x.txt");
    fs::write(&source, "abx").unwrap();
    let payload = json!({
        "process": {
            "cmd": "/bin/bash",
            "args": ["-l", "-c", format!("mv {} {}", source.display(), target.display())],
            "cwd": home.display().to_string()
        },
        "stdin": false
    })
    .to_string();

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/process.Process/Start")
                .header(header::CONTENT_TYPE, "application/connect+json")
                .body(Body::from(connect_envelope(0, payload.as_bytes())))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(!source.exists());
    assert_eq!(fs::read_to_string(&target).unwrap(), "abx");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let messages = decode_connect_json_messages(&body);
    assert!(messages
        .iter()
        .any(|message| message["event"]["start"]["pid"]
            .as_u64()
            .unwrap_or_default()
            > 0));
    assert!(messages
        .iter()
        .any(|message| message["event"]["end"]["exitCode"] == json!(0)));
}

#[tokio::test]
async fn envd_archive_routes_upload_and_restore_executor_runtime_snapshot() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("executor-http-archive-workspace");
    let home = unique_dir("executor-http-archive-home");
    let workspace = workspace_root.join("789");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(workspace.join("README.md"), "archive me").unwrap();
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::write(home.join(".claude/home-memory.md"), "home note").unwrap();
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let app = create_router(AppState::new(RecordingRunner::default()));
    let stored_archive = Arc::new(Mutex::new(Vec::<u8>::new()));
    let storage_url = spawn_storage_server(Arc::clone(&stored_archive)).await;

    let archive = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/archive")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "task_id": 789,
                        "upload_url": format!("{storage_url}/upload"),
                        "runtime_type": "executor"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(archive.status(), StatusCode::OK);
    assert!(!stored_archive.lock().unwrap().is_empty());

    fs::remove_file(workspace.join("README.md")).unwrap();
    fs::remove_file(home.join(".claude/home-memory.md")).unwrap();

    let restore = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/restore")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "task_id": 789,
                        "download_url": format!("{storage_url}/download"),
                        "runtime_type": "executor"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(restore.status(), StatusCode::OK);
    assert_eq!(
        fs::read_to_string(workspace.join("README.md")).unwrap(),
        "archive me"
    );
    assert_eq!(
        fs::read_to_string(home.join(".claude/home-memory.md")).unwrap(),
        "home note"
    );
}

fn unique_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", unique_suffix()));
    let _ = fs::remove_dir_all(&path);
    path
}

fn unique_suffix() -> String {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{suffix}", std::process::id())
}

async fn spawn_storage_server(archive: Arc<Mutex<Vec<u8>>>) -> String {
    let upload_archive = Arc::clone(&archive);
    let download_archive = Arc::clone(&archive);
    let app = Router::new()
        .route(
            "/upload",
            put(move |body: Body| {
                let upload_archive = Arc::clone(&upload_archive);
                async move {
                    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
                    *upload_archive.lock().unwrap() = bytes;
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/download",
            get(move || {
                let download_archive = Arc::clone(&download_archive);
                async move {
                    let bytes = download_archive.lock().unwrap().clone();
                    ([(header::CONTENT_TYPE, "application/gzip")], bytes).into_response()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn connect_envelope(flags: u8, data: &[u8]) -> Vec<u8> {
    let mut envelope = Vec::with_capacity(5 + data.len());
    envelope.push(flags);
    envelope.extend_from_slice(&(data.len() as u32).to_be_bytes());
    envelope.extend_from_slice(data);
    envelope
}

fn decode_connect_json_messages(bytes: &[u8]) -> Vec<Value> {
    let mut offset = 0;
    let mut messages = Vec::new();
    while offset + 5 <= bytes.len() {
        let flags = bytes[offset];
        let len = u32::from_be_bytes([
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
            bytes[offset + 4],
        ]) as usize;
        offset += 5;
        if offset + len > bytes.len() {
            break;
        }
        let data = &bytes[offset..offset + len];
        offset += len;
        if flags & 0b0000_0010 != 0 {
            break;
        }
        messages.push(serde_json::from_slice(data).unwrap());
    }
    messages
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
