// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env, fs,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::broadcast,
};

use crate::{
    agents::resolve_codex_binary,
    local::command::{CommandHandler, CommandRequest, CommandResult, DeviceCommandHandler},
    logging::{format_executor_log, write_executor_log_line},
    runtime_work::RuntimeWorkRpcHandler,
    version::get_version,
};

const DEFAULT_DEVICE_ID: &str = "local-device";
const DEFAULT_SOCKET_NAME: &str = "app-ipc.sock";
const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const WORKSPACE_TREE_SCRIPT: &str = r#"
import json
import os
import stat as stat_module
from datetime import datetime, timezone
from pathlib import Path


def iso_mtime(path_stat):
    return datetime.fromtimestamp(path_stat.st_mtime, timezone.utc).isoformat()


root = Path.cwd().resolve()
entries = []
for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
    if child.name in {'.', '..'}:
        continue
    try:
        child_stat = child.lstat()
    except OSError:
        continue
    is_directory = stat_module.S_ISDIR(child_stat.st_mode)
    entries.append(
        {
            "name": child.name,
            "path": str(child),
            "is_directory": is_directory,
            "size": 0 if is_directory else child_stat.st_size,
            "modified_at": iso_mtime(child_stat),
        }
    )

entries.sort(key=lambda item: (not item["is_directory"], item["name"].lower()))
print(json.dumps({"path": str(root), "entries": entries}, ensure_ascii=False))
"#;
const WORKSPACE_READ_TEXT_FILE_SCRIPT: &str = r#"
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 262144


def fail(message, code=64):
    print(json.dumps({"success": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def is_relative_to(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


if len(sys.argv) != 2:
    fail("file name is required")

root = Path.cwd().resolve()
target = (root / sys.argv[1]).resolve()
if not is_relative_to(target, root):
    fail("file path is outside workspace")
if not target.is_file():
    fail("file does not exist")

with target.open("rb") as target_file:
    data = target_file.read(MAX_BYTES + 1)
truncated = len(data) > MAX_BYTES
content = data[:MAX_BYTES].decode("utf-8", errors="replace")
stat = target.stat()
print(
    json.dumps(
        {
            "success": True,
            "path": str(target),
            "name": target.name,
            "content": content,
            "truncated": truncated,
            "size": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        },
        ensure_ascii=False,
    )
)
"#;
const RUNTIME_AUTH_STATUS_SCRIPT: &str = r#"
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def iso_mtime(path_stat):
    return datetime.fromtimestamp(path_stat.st_mtime, timezone.utc).isoformat()


target = Path.home() / ".codex" / "auth.json"
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
const GIT_WORKSPACE_DIFF_SCRIPT: &str = r#"if git rev-parse --verify --quiet HEAD >/dev/null; then git diff --binary HEAD --; else git diff --binary --; fi; git ls-files --others --exclude-standard -z | while IFS= read -r -d "" file; do git diff --binary --no-index -- /dev/null "$file" || true; done"#;
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
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    command_handler: Arc<dyn DeviceCommandHandler>,
    event_tx: broadcast::Sender<Value>,
}

impl Default for AppIpcServer {
    fn default() -> Self {
        let (event_tx, _) = broadcast::channel(512);
        Self {
            device_id: DEFAULT_DEVICE_ID.to_owned(),
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
        if method == "device.execute_command" {
            return self.handle_device_command(params).await;
        }

        let method = if method == "runtime.tasks.guidance" {
            "runtime.tasks.send"
        } else {
            method
        };

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
        self.event_message(
            "executor.ready",
            json!({
                "device_id": self.device_id,
                "ready": true,
                "version": get_version(),
            }),
        )
    }

    pub async fn serve_forever(&self, socket_path: PathBuf) -> Result<(), String> {
        prepare_socket_path(&socket_path).map_err(|error| {
            format!(
                "failed to prepare app IPC socket {}: {error}",
                socket_path.display()
            )
        })?;
        let listener = UnixListener::bind(&socket_path).map_err(|error| {
            format!(
                "failed to bind app IPC socket {}: {error}",
                socket_path.display()
            )
        })?;
        set_socket_permissions(&socket_path);
        write_executor_log_line(&app_ipc_listening_log_line(
            &self.device_id,
            &socket_path.display().to_string(),
        ));

        loop {
            let (stream, _) = listener.accept().await.map_err(|error| {
                format!(
                    "failed to accept app IPC client on {}: {error}",
                    socket_path.display()
                )
            })?;
            let server = self.clone();
            tokio::spawn(async move {
                if let Err(error) = server.handle_stream(stream).await {
                    eprintln!("app IPC client error: {error}");
                }
            });
        }
    }

    async fn handle_stream(&self, stream: tokio::net::UnixStream) -> Result<(), String> {
        let (reader, mut writer) = stream.into_split();
        write_message(&mut writer, &self.ready_event())
            .await
            .map_err(|error| format!("failed to write app IPC ready event: {error}"))?;

        let mut reader = BufReader::new(reader);
        let mut events = self.event_tx.subscribe();
        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                read = reader.read_line(&mut line) => {
                    let bytes_read = read
                        .map_err(|error| format!("failed to read app IPC request: {error}"))?;
                    if bytes_read == 0 {
                        return Ok(());
                    }
                    if let Some(response) = self.handle_line(&line).await {
                        write_message(&mut writer, &response)
                            .await
                            .map_err(|error| format!("failed to write app IPC response: {error}"))?;
                    }
                }
                event = events.recv() => {
                    match event {
                        Ok(message) => {
                            write_message(&mut writer, &message)
                                .await
                                .map_err(|error| format!("failed to write app IPC event: {error}"))?;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
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
        let command = local_app_command(command_key.trim()).ok_or_else(|| {
            AppIpcError::new(
                "unknown_command",
                format!("Device command key '{command_key}' is not configured"),
            )
        })?;

        let args = string_list(params.get("args"))?;
        let request = CommandRequest {
            command: command.command.to_owned(),
            argv: command
                .argv
                .iter()
                .map(|item| (*item).to_owned())
                .chain(args)
                .collect(),
            cwd: string_field(&params, "path").or_else(|| string_field(&params, "cwd")),
            env: string_env(params.get("env"))?,
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

pub fn app_ipc_listening_log_line(device_id: &str, socket_path: &str) -> String {
    format_executor_log(
        "app IPC listening",
        &[
            ("device_id", device_id.to_owned()),
            ("socket_path", socket_path.to_owned()),
        ],
    )
}

pub fn app_ipc_socket_path() -> PathBuf {
    if let Ok(path) = env::var("WEGENT_EXECUTOR_APP_IPC_SOCKET") {
        let path = path.trim();
        if !path.is_empty() {
            return expand_home(path);
        }
    }

    let home = env::var("WEGENT_EXECUTOR_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "~/.wegent-executor".to_owned());
    expand_home(&home).join(DEFAULT_SOCKET_NAME)
}

pub async fn serve_app_ipc_sidecar(device_id: String) -> Result<(), String> {
    let server = AppIpcServer::new()
        .with_device_id(normalize_device_id(device_id))
        .with_local_runtime_work_handler(resolve_codex_binary());
    server.serve_forever(app_ipc_socket_path()).await
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
        "workspace_tree" => Some(command_definition(
            "python3 -c <workspace_tree>",
            &["python3", "-c", WORKSPACE_TREE_SCRIPT],
            Some(PostProcessor::Json),
        )),
        "workspace_read_text_file" => Some(command_definition(
            "python3 -c <workspace_read_text_file>",
            &["python3", "-c", WORKSPACE_READ_TEXT_FILE_SCRIPT],
            Some(PostProcessor::Json),
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
            "sh -c 'git -C \"$1\" rev-parse --is-inside-work-tree' --",
            &["sh", "-c", "git -C \"$1\" rev-parse --is-inside-work-tree", "--"],
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
        "ls_skills" => Some(command_definition(
            "python3 -c 'import json; print(json.dumps([]))'",
            &["python3", "-c", "import json; print(json.dumps([]))"],
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
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn prepare_socket_path(socket_path: &Path) -> io::Result<()> {
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::remove_file(socket_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn set_socket_permissions(socket_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_socket_permissions(_socket_path: &Path) {}

async fn write_message<W>(writer: &mut W, message: &Value) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}
