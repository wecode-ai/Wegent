// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[cfg(windows)]
use std::path::Path;
use std::{
    collections::HashMap, env, future::Future, net::SocketAddr, path::PathBuf, pin::Pin, sync::Arc,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{broadcast, mpsc},
    time::{Duration, Instant},
};

use crate::{
    agents::resolve_codex_binary,
    local::command::{CommandHandler, CommandRequest, CommandResult, DeviceCommandHandler},
    local::git_commit_message::generate_commit_message,
    local::local_skills::list_local_skills,
    local::workspace_files::{
        execute_workspace_file_command_with_input, is_workspace_file_command,
    },
    logging::{format_executor_log, write_executor_log_line},
    runtime_work::RuntimeWorkRpcHandler,
    version::get_version,
};

#[cfg(windows)]
use crate::local::command::build_env;

const DEFAULT_DEVICE_ID: &str = "local-device";
const DEFAULT_APP_IPC_ADDR: &str = "127.0.0.1:0";
const APP_IPC_ADDR_FILE_NAME: &str = "app-ipc.addr";
const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const APP_IPC_REQUEST_TIMEOUT_SECONDS: u64 = 75;
const GIT_PUSH_SCRIPT: &str = r#"branch=$(git branch --show-current)
if [ -z "$branch" ]; then
  echo "Cannot push detached HEAD" >&2
  exit 64
fi
exec git push -u origin "$branch""#;
const RUNTIME_AUTH_STATUS_SCRIPT: &str = r#"
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def iso_mtime(path_stat):
    return datetime.fromtimestamp(path_stat.st_mtime, timezone.utc).isoformat()


codex_home = Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex")).expanduser()
target = codex_home / "auth.json"
result = {
    "runtime": "codex",
    "target_path": str(target),
    "exists": target.exists(),
    "updated_at": None,
    "sha256": None,
    "size_bytes": None,
    "error": None,
}

if target.exists() and target.is_file():
    try:
        target_stat = target.stat()
        digest = hashlib.sha256()
        with target.open("rb") as auth_file:
            for chunk in iter(lambda: auth_file.read(1024 * 1024), b""):
                digest.update(chunk)
        result.update(
            {
                "updated_at": iso_mtime(target_stat),
                "sha256": digest.hexdigest(),
                "size_bytes": target_stat.st_size,
            }
        )
    except OSError as exc:
        result["error"] = str(exc)

print(json.dumps(result, ensure_ascii=False))
"#;
const GIT_BRANCH_DIFF_SHORTSTAT_SCRIPT: &str = r#"base=""; for candidate in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main main origin/master master; do [ -n "$candidate" ] || continue; if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then base="$candidate"; break; fi; done; [ -n "$base" ] || { git diff --shortstat HEAD --; exit 0; }; merge_base=$(git merge-base "$base" HEAD 2>/dev/null || true); [ -n "$merge_base" ] || { git diff --shortstat HEAD --; exit 0; }; git diff --shortstat "$merge_base" --"#;
const GIT_WORKSPACE_DIFF_SCRIPT: &str = r#"if git rev-parse --verify --quiet HEAD >/dev/null; then git diff --binary HEAD --; else git diff --binary --; fi; git ls-files --others --exclude-standard -z | while IFS= read -r -d "" file; do git diff --binary --no-index -- /dev/null "$file" || true; done"#;
const GIT_BRANCH_DIFF_SCRIPT: &str = r#"base=""; for candidate in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main main origin/master master; do [ -n "$candidate" ] || continue; if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then base="$candidate"; break; fi; done; if [ -n "$base" ]; then merge_base=$(git merge-base "$base" HEAD 2>/dev/null || true); fi; if [ -n "$merge_base" ]; then git diff --binary "$merge_base" --; elif git rev-parse --verify --quiet HEAD >/dev/null; then git diff --binary HEAD --; else git diff --binary --; fi; git ls-files --others --exclude-standard -z | while IFS= read -r -d "" file; do git diff --binary --no-index -- /dev/null "$file" || true; done"#;
const TURN_FILE_CHANGES_SCRIPT: &str = r#"
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_PATCH_BYTES = 20 * 1024 * 1024
ARTIFACT_PATTERN = re.compile(r"turn-file-changes/([0-9]+)/([0-9]+)")


def finish(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def fail(message, code=64, status=None):
    payload = {"success": False, "error": message}
    if status:
        payload["status"] = status
    finish(payload, code)


if len(sys.argv) != 3:
    fail("mode and artifact id are required")

mode = sys.argv[1]
artifact_id = sys.argv[2]
if mode not in {"review", "revert"}:
    fail("invalid mode")

match = ARTIFACT_PATTERN.fullmatch(artifact_id)
if not match:
    fail("invalid artifact id")

task_id = int(match.group(1))
subtask_id = int(match.group(2))
executor_home = Path(os.environ.get("WEGENT_EXECUTOR_HOME", "~/.wegent-executor")).expanduser()
artifact_root = (executor_home / "artifacts").resolve()
artifact_dir = (artifact_root / artifact_id).resolve()
if artifact_root not in artifact_dir.parents:
    fail("invalid artifact id")

metadata_path = artifact_dir / "metadata.json"
patch_path = artifact_dir / "changes.patch.gz"
if not metadata_path.is_file() or not patch_path.is_file():
    finish({"success": False, "status": "artifact_missing", "error": "turn file changes artifact is missing"})

try:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    fail(f"invalid artifact metadata: {exc}", code=65)

if not isinstance(metadata, dict):
    fail("invalid artifact metadata", code=65)
if metadata.get("task_id") != task_id or metadata.get("subtask_id") != subtask_id:
    fail("artifact metadata id mismatch", code=65)

workspace = Path.cwd().resolve()
try:
    metadata_workspace = Path(str(metadata["workspace_path"])).resolve()
except (KeyError, OSError):
    fail("invalid artifact workspace", code=65)
if metadata_workspace != workspace:
    fail("artifact workspace mismatch", code=65)

try:
    with gzip.open(patch_path, "rb") as patch_file:
        patch = patch_file.read(MAX_PATCH_BYTES + 1)
except (OSError, gzip.BadGzipFile) as exc:
    fail(f"failed to read artifact patch: {exc}", code=65)
if len(patch) > MAX_PATCH_BYTES:
    fail("artifact patch exceeds size limit", code=65)
if hashlib.sha256(patch).hexdigest() != metadata.get("checksum"):
    fail("artifact patch checksum mismatch", code=65)

if mode == "review":
    finish({"success": True, "diff": patch.decode("utf-8", errors="replace")})

temp_path = None
try:
    with tempfile.NamedTemporaryFile(prefix="wegent-validated-turn-", suffix=".patch", delete=False) as temp_file:
        temp_file.write(patch)
        temp_path = Path(temp_file.name)

    check = subprocess.run(["git", "apply", "--reverse", "--check", "--binary", str(temp_path)], cwd=workspace, capture_output=True, text=True)
    if check.returncode != 0:
        finish({"success": False, "status": "conflicted", "error": "patch does not apply"})
    apply_result = subprocess.run(["git", "apply", "--reverse", "--binary", str(temp_path)], cwd=workspace, capture_output=True, text=True)
    if apply_result.returncode != 0:
        finish({"success": False, "status": "conflicted", "error": "patch does not apply"})
    finish({"success": True, "status": "reverted"})
finally:
    if temp_path is not None:
        temp_path.unlink(missing_ok=True)
"#;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait RuntimeWorkHandler: Send + Sync {
    fn handle_runtime_rpc<'a>(&'a self, data: Value) -> BoxFuture<'a, Result<Value, AppIpcError>>;

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "codex_app_server_unavailable",
                "Codex app-server handler is not available",
            ))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIpcError {
    pub code: String,
    pub message: String,
}

impl AppIpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone)]
struct LocalAppCommandDefinition {
    command: &'static str,
    argv: &'static [&'static str],
    post_processor: Option<PostProcessor>,
}

#[derive(Clone, Copy)]
enum PostProcessor {
    DirectoryList,
    Json,
}

#[derive(Clone)]
pub struct AppIpcServer {
    device_id: String,
    runtime_instance_id: Option<String>,
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    command_handler: Arc<dyn DeviceCommandHandler>,
    event_tx: broadcast::Sender<Value>,
}

impl Default for AppIpcServer {
    fn default() -> Self {
        let (event_tx, _) = broadcast::channel(512);
        Self {
            device_id: DEFAULT_DEVICE_ID.to_owned(),
            runtime_instance_id: None,
            runtime_work_handler: None,
            command_handler: Arc::new(CommandHandler),
            event_tx,
        }
    }
}

impl AppIpcServer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_device_id(mut self, device_id: impl Into<String>) -> Self {
        let device_id = device_id.into();
        self.device_id = if device_id.trim().is_empty() {
            DEFAULT_DEVICE_ID.to_owned()
        } else {
            device_id
        };
        self
    }

    pub fn with_runtime_instance_id(mut self, runtime_instance_id: impl Into<String>) -> Self {
        self.runtime_instance_id = Some(runtime_instance_id.into())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        self
    }

    pub fn with_runtime_work_handler<H>(mut self, handler: H) -> Self
    where
        H: RuntimeWorkHandler + 'static,
    {
        self.runtime_work_handler = Some(Arc::new(handler));
        self
    }

    pub fn with_local_runtime_work_handler(mut self, codex_binary: impl Into<String>) -> Self {
        self.runtime_work_handler = Some(Arc::new(RuntimeWorkRpcHandler::with_event_sender(
            self.device_id.clone(),
            codex_binary.into(),
            self.event_tx.clone(),
        )));
        self
    }

    pub fn with_command_handler<H>(mut self, handler: H) -> Self
    where
        H: DeviceCommandHandler + 'static,
    {
        self.command_handler = Arc::new(handler);
        self
    }

    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        if line.trim().is_empty() {
            return None;
        }

        let mut request_id = None;
        let response = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(message)) => {
                request_id = match request_id_from(&message) {
                    Ok(request_id) => Some(request_id),
                    Err(error) => return Some(error_message(None, &error)),
                };

                match request_from_message(&message) {
                    Ok((method, params)) => match self.dispatch(&method, params).await {
                        Ok(result) => {
                            response_message(request_id.as_deref().unwrap_or_default(), result)
                        }
                        Err(error) => error_message(request_id.as_deref(), &error),
                    },
                    Err(error) => error_message(request_id.as_deref(), &error),
                }
            }
            Ok(_) => error_message(
                request_id.as_deref(),
                &AppIpcError::new("invalid_request", "Request must be a JSON object"),
            ),
            Err(error) => error_message(
                request_id.as_deref(),
                &AppIpcError::new("invalid_json", error.to_string()),
            ),
        };

        Some(response)
    }

    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, AppIpcError> {
        if method == "executor.health" {
            return Ok(json!({"status": "healthy"}));
        }

        if method == "device.execute_command" {
            return self.handle_device_command(params).await;
        }

        if method.starts_with("runtime.") {
            let Some(handler) = &self.runtime_work_handler else {
                return Err(AppIpcError::new(
                    "runtime_unavailable",
                    "Runtime work handler is not available",
                ));
            };
            return handler
                .handle_runtime_rpc(json!({"method": method, "payload": params}))
                .await;
        }

        if method == "codex.app_server_request" {
            let Some(handler) = &self.runtime_work_handler else {
                return Err(AppIpcError::new(
                    "codex_app_server_unavailable",
                    "Codex app-server handler is not available",
                ));
            };
            return handler.handle_codex_app_server_rpc(params).await;
        }

        Err(AppIpcError::new(
            "unsupported_method",
            format!("Unsupported app IPC method: {method}"),
        ))
    }

    pub fn event_message(&self, event: &str, payload: Value) -> Value {
        let mut normalized_payload = payload.as_object().cloned().unwrap_or_default();
        normalized_payload
            .entry("device_id".to_owned())
            .or_insert_with(|| Value::String(self.device_id.clone()));

        json!({
            "type": "event",
            "event": event,
            "payload": normalized_payload,
        })
    }

    pub fn emit_event(&self, event: &str, payload: Value) -> Result<usize, String> {
        self.event_tx
            .send(self.event_message(event, payload))
            .map_err(|error| error.to_string())
    }

    pub fn ready_event(&self) -> Value {
        let mut payload = json!({
            "device_id": self.device_id,
            "ready": true,
            "version": get_version(),
        });
        if let Some(runtime_instance_id) = &self.runtime_instance_id {
            payload["runtime_instance_id"] = Value::String(runtime_instance_id.clone());
        }
        self.event_message("executor.ready", payload)
    }

    pub async fn serve_forever(&self) -> Result<(), String> {
        let addr = local_app_ipc_addr();
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|error| format!("failed to bind app IPC TCP socket {addr}: {error}"))?;
        let local_addr = listener
            .local_addr()
            .map_err(|error| format!("failed to read app IPC TCP local address: {error}"))?;
        if let Err(error) = write_app_ipc_addr_file(local_addr) {
            eprintln!("failed to write app IPC address file: {error}");
        }
        write_executor_log_line(&app_ipc_listening_log_line(
            &self.device_id,
            &local_addr.to_string(),
        ));

        loop {
            let (stream, _) = listener.accept().await.map_err(|error| {
                format!("failed to accept app IPC client on {local_addr}: {error}")
            })?;
            let server = self.clone();
            tokio::spawn(async move {
                if let Err(error) = server.handle_stream(stream).await {
                    eprintln!("app IPC client error: {error}");
                }
            });
        }
    }

    async fn handle_stream(&self, stream: TcpStream) -> Result<(), String> {
        let (reader, writer) = stream.into_split();
        let (write_tx, mut write_rx) = mpsc::channel::<Value>(512);
        let mut writer_task = tokio::spawn(async move {
            let mut writer = writer;
            while let Some(message) = write_rx.recv().await {
                write_message(&mut writer, &message)
                    .await
                    .map_err(|error| format!("failed to write app IPC message: {error}"))?;
            }
            Ok::<(), String>(())
        });

        write_tx
            .send(self.ready_event())
            .await
            .map_err(|error| format!("failed to queue app IPC ready event: {error}"))?;

        let mut reader = BufReader::new(reader);
        let mut events = self.event_tx.subscribe();
        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                writer = &mut writer_task => {
                    return match writer {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(error)) => Err(error),
                        Err(error) => Err(format!("app IPC writer task failed: {error}")),
                    };
                }
                read = reader.read_line(&mut line) => {
                    let bytes_read = read
                        .map_err(|error| format!("failed to read app IPC request: {error}"))?;
                    if bytes_read == 0 {
                        return Ok(());
                    }
                    let server = self.clone();
                    let response_tx = write_tx.clone();
                    let request_line = line.clone();
                    let (request_id, method) = app_ipc_request_metadata(&request_line);
                    tokio::spawn(async move {
                        let started_at = Instant::now();
                        log_app_ipc_request(
                            "app IPC request started",
                            request_id.as_deref(),
                            method.as_deref(),
                            None,
                            None,
                        );
                        let response = match tokio::time::timeout(
                            Duration::from_secs(APP_IPC_REQUEST_TIMEOUT_SECONDS),
                            server.handle_line(&request_line),
                        )
                        .await
                        {
                            Ok(response) => response,
                            Err(_) => {
                                log_app_ipc_request(
                                    "app IPC request timed out",
                                    request_id.as_deref(),
                                    method.as_deref(),
                                    Some(started_at.elapsed().as_millis()),
                                    None,
                                );
                                Some(error_message(
                                    request_id.as_deref(),
                                    &AppIpcError::new(
                                        "request_timeout",
                                        format!(
                                            "app IPC request timed out after {APP_IPC_REQUEST_TIMEOUT_SECONDS}s"
                                        ),
                                    ),
                                ))
                            }
                        };

                        if let Some(response) = response {
                            let ok = response.get("ok").and_then(Value::as_bool);
                            let elapsed_ms = started_at.elapsed().as_millis();
                            log_app_ipc_request(
                                "app IPC request finished",
                                request_id.as_deref(),
                                method.as_deref(),
                                Some(elapsed_ms),
                                ok,
                            );
                            if ok == Some(false) {
                                log_app_ipc_response_error(
                                    request_id.as_deref(),
                                    method.as_deref(),
                                    elapsed_ms,
                                    &response,
                                );
                            }
                            if response_tx.send(response).await.is_err() {
                                log_app_ipc_request(
                                    "app IPC response dropped",
                                    request_id.as_deref(),
                                    method.as_deref(),
                                    Some(elapsed_ms),
                                    ok,
                                );
                            }
                        } else {
                            log_app_ipc_request(
                                "app IPC request ignored",
                                request_id.as_deref(),
                                method.as_deref(),
                                Some(started_at.elapsed().as_millis()),
                                None,
                            );
                        }
                    });
                }
                event = events.recv() => {
                    match event {
                        Ok(message) => {
                            write_tx.send(message)
                                .await
                                .map_err(|error| format!("failed to queue app IPC event: {error}"))?;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            let message = self.event_message(
                                "executor.event_lagged",
                                json!({ "skipped": skipped }),
                            );
                            write_tx.send(message)
                                .await
                                .map_err(|error| format!("failed to queue app IPC lag event: {error}"))?;
                        }
                        Err(broadcast::error::RecvError::Closed) => return Ok(()),
                    }
                }
            }
        }
    }

    async fn handle_device_command(&self, params: Value) -> Result<Value, AppIpcError> {
        let command_key = string_field(&params, "command_key")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("bad_request", "command_key is required"))?;
        let command_key = command_key.trim();

        if command_key == "git_generate_commit_message" {
            let cwd = string_field(&params, "path").or_else(|| string_field(&params, "cwd"));
            let env = string_env(params.get("env"))?;
            let result = generate_commit_message(cwd, env).await;
            return serde_json::to_value(result)
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        if command_key == "ls_skills" {
            let result = list_local_skills().await;
            return serde_json::to_value(result)
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        let args = string_list(params.get("args"))?;
        let env = string_env(params.get("env"))?;
        if is_workspace_file_command(command_key) {
            return serde_json::to_value(
                execute_workspace_file_command_with_input(
                    command_key,
                    string_field(&params, "path").or_else(|| string_field(&params, "cwd")),
                    args,
                    env,
                    string_field(&params, "stdin"),
                )
                .await,
            )
            .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        if let Some((result, post_processor)) =
            handle_builtin_device_command(command_key, &params).await
        {
            return serde_json::to_value(apply_post_processor(result, post_processor))
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        let command = local_app_command(command_key).ok_or_else(|| {
            AppIpcError::new(
                "unknown_command",
                format!("Device command key '{command_key}' is not configured"),
            )
        })?;

        let request = CommandRequest {
            command: command.command.to_owned(),
            argv: command
                .argv
                .iter()
                .map(|item| (*item).to_owned())
                .chain(args)
                .collect(),
            cwd: string_field(&params, "path").or_else(|| string_field(&params, "cwd")),
            env,
            timeout_seconds: positive_number(
                params.get("timeout_seconds"),
                DEFAULT_TIMEOUT_SECONDS,
            ),
            max_output_bytes: positive_number(
                params.get("max_output_bytes"),
                DEFAULT_MAX_OUTPUT_BYTES as f64,
            )
            .round() as usize,
        };

        let result = self.command_handler.handle_execute_command(request).await;
        serde_json::to_value(apply_post_processor(result, command.post_processor))
            .map_err(|error| AppIpcError::new("internal_error", error.to_string()))
    }
}

#[cfg(windows)]
async fn handle_builtin_device_command(
    command_key: &str,
    params: &Value,
) -> Option<(CommandResult, Option<PostProcessor>)> {
    match command_key {
        "home_dir" => Some((
            CommandResult::ok(
                dirs::home_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| ".".to_string()),
            ),
            None,
        )),
        "pwd" => Some((
            CommandResult::ok(
                std::env::current_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| ".".to_string()),
            ),
            None,
        )),
        "project_workspace_root" => match project_workspace_root_path() {
            Ok(path) => Some((CommandResult::ok(path), None)),
            Err(error) => Some((CommandResult::error(error, 0.0, false), None)),
        },
        "mkdir_p" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((
                match std::fs::create_dir_all(path) {
                    Ok(()) => CommandResult::ok(""),
                    Err(error) => CommandResult::error(
                        format!("Failed to create directory {path}: {error}"),
                        0.0,
                        false,
                    ),
                },
                None,
            ))
        }
        "path_exists" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((
                CommandResult::ok(if Path::new(path).exists() { "true" } else { "" }),
                None,
            ))
        }
        "ls_dirs" => {
            let path = string_field(params, "path").or_else(|| string_field(params, "cwd"))?;
            Some((
                match std::fs::read_dir(&path) {
                    Ok(entries) => {
                        let mut output = String::new();
                        for entry in entries.flatten() {
                            if let Ok(metadata) = entry.metadata() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if metadata.is_dir() {
                                    output.push_str(&name);
                                    output.push('/');
                                } else {
                                    output.push_str(&name);
                                }
                                output.push('\n');
                            }
                        }
                        CommandResult::ok(output)
                    }
                    Err(error) => CommandResult::error(
                        format!("Failed to list directory {path}: {error}"),
                        0.0,
                        false,
                    ),
                },
                Some(PostProcessor::DirectoryList),
            ))
        }
        "runtime_auth_status" => {
            let codex_home = env::var("CODEX_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    dirs::home_dir()
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join(".codex")
                });
            let target = codex_home.join("auth.json");
            let mut result = json!({
                "runtime": "codex",
                "target_path": target.display().to_string(),
                "exists": target.exists() && target.is_file(),
                "updated_at": Value::Null,
                "sha256": Value::Null,
                "size_bytes": Value::Null,
                "error": Value::Null,
            });
            if target.exists() && target.is_file() {
                match std::fs::metadata(&target) {
                    Ok(metadata) => {
                        if let Ok(updated_at) = metadata.modified() {
                            let datetime = chrono::DateTime::<chrono::Utc>::from(updated_at);
                            result["updated_at"] = Value::String(datetime.to_rfc3339());
                        }
                        result["size_bytes"] = Value::Number(metadata.len().into());
                        match std::fs::read(&target) {
                            Ok(content) => {
                                use sha2::{Digest, Sha256};
                                let hash = Sha256::digest(&content);
                                result["sha256"] = Value::String(format!("{hash:x}"));
                            }
                            Err(error) => {
                                result["error"] = Value::String(error.to_string());
                            }
                        }
                    }
                    Err(error) => {
                        result["error"] = Value::String(error.to_string());
                    }
                }
            }
            Some((
                CommandResult::ok(result.to_string()),
                Some(PostProcessor::Json),
            ))
        }
        "git_is_worktree" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((
                CommandResult::ok(if git_is_worktree(path) { "true" } else { "" }),
                None,
            ))
        }
        _ => None,
    }
}

#[cfg(not(windows))]
async fn handle_builtin_device_command(
    _command_key: &str,
    _params: &Value,
) -> Option<(CommandResult, Option<PostProcessor>)> {
    None
}

#[cfg(windows)]
fn git_is_worktree(path: &str) -> bool {
    git_stdout(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|output| output.trim() == "true")
        .unwrap_or(false)
        || git_stdout(path, &["rev-parse", "--git-dir"]).is_some()
}

#[cfg(windows)]
fn git_stdout(path: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env_clear()
        .envs(build_env(&HashMap::new()))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn project_workspace_root_path() -> Result<String, String> {
    if let Ok(value) = env::var("WEGENT_EXECUTOR_PROJECTS_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    if let Ok(value) = env::var("WECODE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed)
                .join("wegent-executor")
                .join("workspace")
                .join("projects")
                .display()
                .to_string());
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home
        .join(".wecode")
        .join("wegent-executor")
        .join("workspace")
        .join("projects")
        .display()
        .to_string())
}

pub fn app_ipc_listening_log_line(device_id: &str, addr: &str) -> String {
    format_executor_log(
        "app IPC listening",
        &[
            ("device_id", device_id.to_owned()),
            ("addr", addr.to_owned()),
        ],
    )
}

fn app_ipc_request_metadata(line: &str) -> (Option<String>, Option<String>) {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(message)) => {
            let request_id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned);
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned);
            (request_id, method)
        }
        _ => (None, None),
    }
}

fn log_app_ipc_request(
    event: &str,
    request_id: Option<&str>,
    method: Option<&str>,
    elapsed_ms: Option<u128>,
    ok: Option<bool>,
) {
    let mut fields = Vec::new();
    if let Some(request_id) = request_id {
        fields.push(("request_id", request_id.to_owned()));
    }
    if let Some(method) = method {
        fields.push(("method", method.to_owned()));
    }
    if let Some(elapsed_ms) = elapsed_ms {
        fields.push(("elapsed_ms", elapsed_ms.to_string()));
    }
    if let Some(ok) = ok {
        fields.push(("ok", ok.to_string()));
    }
    write_executor_log_line(&format_executor_log(event, &fields));
}

fn log_app_ipc_response_error(
    request_id: Option<&str>,
    method: Option<&str>,
    elapsed_ms: u128,
    response: &Value,
) {
    let error = response.get("error").and_then(Value::as_object);
    let code = error
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = error
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    let mut fields = Vec::new();
    if let Some(request_id) = request_id {
        fields.push(("request_id", request_id.to_owned()));
    }
    if let Some(method) = method {
        fields.push(("method", method.to_owned()));
    }
    fields.push(("elapsed_ms", elapsed_ms.to_string()));
    fields.push(("code", code.to_owned()));
    fields.push(("error", message.to_owned()));
    write_executor_log_line(&format_executor_log("app IPC request failed", &fields));
}

pub async fn serve_app_ipc_sidecar(
    device_id: String,
    runtime_instance_id: String,
) -> Result<(), String> {
    let server = AppIpcServer::new()
        .with_device_id(normalize_device_id(device_id))
        .with_runtime_instance_id(runtime_instance_id)
        .with_local_runtime_work_handler(resolve_codex_binary());
    server.serve_forever().await
}

pub fn normalize_device_id(device_id: impl Into<String>) -> String {
    let device_id = device_id.into();
    if device_id.trim().is_empty() {
        DEFAULT_DEVICE_ID.to_owned()
    } else {
        device_id
    }
}

fn local_app_command(command_key: &str) -> Option<LocalAppCommandDefinition> {
    match command_key {
        "pwd" => Some(command_definition("pwd", &["pwd"], None)),
        "home_dir" => Some(command_definition("printenv HOME", &["printenv", "HOME"], None)),
        "project_workspace_root" => Some(command_definition(
            "sh -c 'printf %s \"${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}\"'",
            &[
                "sh",
                "-c",
                "printf %s \"${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}\"",
            ],
            None,
        )),
        "ls_dirs" => Some(command_definition(
            "ls -a -p",
            &["ls", "-a", "-p"],
            Some(PostProcessor::DirectoryList),
        )),
        "runtime_auth_status" => Some(command_definition(
            "python3 -c <runtime_auth_status>",
            &["python3", "-c", RUNTIME_AUTH_STATUS_SCRIPT],
            Some(PostProcessor::Json),
        )),
        "mkdir_p" => Some(command_definition("mkdir -p", &["mkdir", "-p"], None)),
        "path_exists" => Some(command_definition("test -e", &["test", "-e"], None)),
        "git_branch" => Some(command_definition(
            "git branch --show-current",
            &["git", "branch", "--show-current"],
            None,
        )),
        "git_branch_list" => Some(command_definition(
            "git branch --format=%(refname:short)",
            &["git", "branch", "--format=%(refname:short)"],
            None,
        )),
        "git_checkout" => Some(command_definition("git checkout", &["git", "checkout"], None)),
        "git_checkout_new" => Some(command_definition(
            "git checkout -b",
            &["git", "checkout", "-b"],
            None,
        )),
        "git_diff_shortstat" => Some(command_definition(
            "git diff --shortstat",
            &["git", "diff", "--shortstat"],
            None,
        )),
        "git_diff" => Some(command_definition(
            "bash -lc <git_workspace_diff>",
            &["bash", "-lc", GIT_WORKSPACE_DIFF_SCRIPT],
            None,
        )),
        "git_branch_diff" => Some(command_definition(
            "bash -lc <git_branch_diff>",
            &["bash", "-lc", GIT_BRANCH_DIFF_SCRIPT],
            None,
        )),
        "git_branch_diff_shortstat" => Some(command_definition(
            "bash -lc <git_branch_diff_shortstat>",
            &["bash", "-lc", GIT_BRANCH_DIFF_SHORTSTAT_SCRIPT],
            None,
        )),
        "git_diff_unstaged" => Some(command_definition(
            "git diff --binary --",
            &["git", "diff", "--binary", "--"],
            None,
        )),
        "git_diff_staged" => Some(command_definition(
            "git diff --binary --cached --",
            &["git", "diff", "--binary", "--cached", "--"],
            None,
        )),
        "git_diff_last_commit" => Some(command_definition(
            "git diff --binary HEAD~1..HEAD --",
            &["git", "diff", "--binary", "HEAD~1..HEAD", "--"],
            None,
        )),
        "git_status_porcelain" => Some(command_definition(
            "git status --porcelain",
            &["git", "status", "--porcelain"],
            None,
        )),
        "git_remote_url" => Some(command_definition(
            "git remote get-url origin",
            &["git", "remote", "get-url", "origin"],
            None,
        )),
        "git_is_worktree" => Some(command_definition(
            "sh -c <git_is_worktree>",
            &[
                "sh",
                "-c",
                concat!(
                    "if [ \"$(git -C \"$1\" rev-parse --is-inside-work-tree 2>/dev/null)\" ",
                    "= \"true\" ] || git -C \"$1\" rev-parse --git-dir >/dev/null 2>&1; then ",
                    "printf 'true\\n'; else printf 'false\\n'; exit 1; fi"
                ),
                "--",
            ],
            None,
        )),
        "git_worktree_add" => Some(command_definition(
            "sh -c <git_worktree_add>",
            &[
                "sh",
                "-c",
                concat!(
                    "source=$1; target=$2; ref=$3; ",
                    "mkdir -p \"$(dirname \"$target\")\"; ",
                    "if git -C \"$target\" rev-parse --is-inside-work-tree ",
                    ">/dev/null 2>&1; then ",
                    "if [ -n \"$ref\" ]; then ",
                    "git -C \"$target\" checkout --force --detach \"$ref\"; fi; ",
                    "exit 0; ",
                    "else ",
                    "if [ -e \"$target\" ]; then ",
                    "echo \"target exists and is not a Git worktree\" >&2; exit 64; fi; ",
                    "if [ -n \"$ref\" ]; then ",
                    "git -C \"$source\" worktree add --detach \"$target\" \"$ref\"; ",
                    "else git -C \"$source\" worktree add --detach \"$target\"; fi; ",
                    "fi"
                ),
                "--",
            ],
            None,
        )),
        "git_worktree_remove" => Some(command_definition(
            "sh -c 'git -C \"$1\" worktree remove --force \"$2\"' --",
            &[
                "sh",
                "-c",
                "git -C \"$1\" worktree remove --force \"$2\"",
                "--",
            ],
            None,
        )),
        "git_add_all" => Some(command_definition("git add --all", &["git", "add", "--all"], None)),
        "git_commit" => Some(command_definition("git commit", &["git", "commit"], None)),
        "git_push" => Some(command_definition(
            "sh -c <git_push>",
            &["sh", "-c", GIT_PUSH_SCRIPT],
            None,
        )),
        "browser_relay_restart" => Some(command_definition(
            "sh -lc <browser_relay_restart>",
            &[
                "sh",
                "-lc",
                "exec \"$HOME/.wegent-executor/bin/cdp-relay-server\" --restart",
            ],
            None,
        )),
        "browser_tool" => Some(command_definition(
            "sh -lc <browser_tool>",
            &[
                "sh",
                "-lc",
                "payload=${1:?browser tool payload is required}; exec \"$HOME/.wegent-executor/bin/browser-tool\" \"$payload\"",
                "--",
            ],
            Some(PostProcessor::Json),
        )),
        "turn_file_changes_review" => Some(command_definition(
            "python3 -c <turn_file_changes> review",
            &["python3", "-c", TURN_FILE_CHANGES_SCRIPT, "review"],
            Some(PostProcessor::Json),
        )),
        "turn_file_changes_revert" => Some(command_definition(
            "python3 -c <turn_file_changes> revert",
            &["python3", "-c", TURN_FILE_CHANGES_SCRIPT, "revert"],
            Some(PostProcessor::Json),
        )),
        _ => None,
    }
}

fn command_definition(
    command: &'static str,
    argv: &'static [&'static str],
    post_processor: Option<PostProcessor>,
) -> LocalAppCommandDefinition {
    LocalAppCommandDefinition {
        command,
        argv,
        post_processor,
    }
}

fn request_from_message(
    message: &serde_json::Map<String, Value>,
) -> Result<(String, Value), AppIpcError> {
    if message.get("type").and_then(Value::as_str) != Some("request") {
        return Err(AppIpcError::new(
            "invalid_request",
            "Request type must be 'request'",
        ));
    }

    let method = message
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.trim().is_empty())
        .ok_or_else(|| AppIpcError::new("invalid_request", "Request method is required"))?
        .trim()
        .to_owned();

    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(AppIpcError::new(
            "invalid_request",
            "Request params must be an object",
        ));
    }

    Ok((method, params))
}

fn request_id_from(message: &serde_json::Map<String, Value>) -> Result<String, AppIpcError> {
    message
        .get("id")
        .and_then(Value::as_str)
        .filter(|request_id| !request_id.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppIpcError::new("invalid_request", "Request id is required"))
}

fn response_message(request_id: &str, result: Value) -> Value {
    json!({
        "type": "response",
        "id": request_id,
        "ok": true,
        "result": result,
    })
}

fn error_message(request_id: Option<&str>, error: &AppIpcError) -> Value {
    json!({
        "type": "response",
        "id": request_id,
        "ok": false,
        "error": {
            "code": error.code,
            "message": error.message,
        },
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, AppIpcError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(AppIpcError::new("bad_request", "args must be a list"));
    };

    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| AppIpcError::new("bad_request", "args must contain only strings"))
        })
        .collect()
}

fn string_env(value: Option<&Value>) -> Result<HashMap<String, String>, AppIpcError> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let Some(items) = value.as_object() else {
        return Err(AppIpcError::new("bad_request", "env must be an object"));
    };

    Ok(items
        .iter()
        .filter(|(key, _)| !key.is_empty())
        .map(|(key, value)| {
            (
                key.clone(),
                match value {
                    Value::Null => String::new(),
                    Value::String(value) => value.clone(),
                    other => other.to_string(),
                },
            )
        })
        .collect())
}

fn positive_number(value: Option<&Value>, default: f64) -> f64 {
    let parsed = value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(default);
    if parsed > 0.0 {
        parsed
    } else {
        default
    }
}

fn apply_post_processor(
    mut result: CommandResult,
    post_processor: Option<PostProcessor>,
) -> CommandResult {
    match post_processor {
        None => result,
        Some(PostProcessor::DirectoryList) => {
            if result.success {
                result.stdout = Value::Array(
                    stdout_string(&result)
                        .lines()
                        .map(str::trim)
                        .filter(|entry| entry.ends_with('/'))
                        .map(|entry| entry.trim_end_matches('/'))
                        .filter(|entry| !entry.is_empty() && *entry != "." && *entry != "..")
                        .map(|entry| Value::String(entry.to_owned()))
                        .collect(),
                );
            }
            result
        }
        Some(PostProcessor::Json) => {
            if result.stdout_truncated {
                result.success = false;
                result.error = Some(
                    "Command output exceeded max_output_bytes and was truncated; JSON is incomplete and cannot be parsed"
                        .to_owned(),
                );
                return result;
            }

            match serde_json::from_str::<Value>(&stdout_string(&result)) {
                Ok(stdout) => {
                    if !result.success && result.error.is_none() {
                        result.error = stdout
                            .get("error")
                            .and_then(Value::as_str)
                            .filter(|error| !error.trim().is_empty())
                            .map(str::to_owned);
                    }
                    result.stdout = stdout;
                    result
                }
                Err(error) if result.success => {
                    result.success = false;
                    result.error = Some(format!("Failed to parse command JSON output: {error}"));
                    result
                }
                Err(_) => result,
            }
        }
    }
}

fn stdout_string(result: &CommandResult) -> String {
    result
        .stdout
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| result.stdout.to_string())
}

pub fn app_ipc_socket_path() -> PathBuf {
    local_app_ipc_addr_file_path()
}

pub fn local_app_ipc_addr_file_path() -> PathBuf {
    let home = env::var("WEGENT_EXECUTOR_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_home(&value))
        .unwrap_or_else(|| home_dir().join(".wegent-executor"));
    home.join(APP_IPC_ADDR_FILE_NAME)
}

fn local_app_ipc_addr() -> SocketAddr {
    if let Ok(value) = env::var("WEGENT_EXECUTOR_APP_IPC_ADDR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            if let Ok(addr) = trimmed.parse::<SocketAddr>() {
                return addr;
            }
            if let Ok(port) = trimmed.parse::<u16>() {
                if let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() {
                    return addr;
                }
            }
        }
    }
    DEFAULT_APP_IPC_ADDR
        .parse()
        .expect("default address is valid")
}

fn write_app_ipc_addr_file(addr: SocketAddr) -> std::io::Result<()> {
    let path = local_app_ipc_addr_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, addr.to_string())
}

pub fn read_app_ipc_addr_file() -> Option<SocketAddr> {
    let path = local_app_ipc_addr_file_path();
    let content = std::fs::read_to_string(&path).ok()?;
    content.trim().parse::<SocketAddr>().ok()
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

async fn write_message<W>(writer: &mut W, message: &Value) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}
