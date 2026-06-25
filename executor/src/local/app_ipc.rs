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
};

use crate::{
    local::command::{CommandHandler, CommandRequest, CommandResult, DeviceCommandHandler},
    version::get_version,
};

const DEFAULT_DEVICE_ID: &str = "local-device";
const DEFAULT_SOCKET_NAME: &str = "app-ipc.sock";
const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;

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
}

impl Default for AppIpcServer {
    fn default() -> Self {
        Self {
            device_id: DEFAULT_DEVICE_ID.to_owned(),
            runtime_work_handler: None,
            command_handler: Arc::new(CommandHandler),
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
        let mut line = String::new();
        loop {
            line.clear();
            let bytes_read = reader
                .read_line(&mut line)
                .await
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
    let server = AppIpcServer::new().with_device_id(normalize_device_id(device_id));
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
        "mkdir_p" => Some(command_definition("mkdir -p", &["mkdir", "-p"], None)),
        "path_exists" => Some(command_definition("test -e", &["test", "-e"], None)),
        "ls_skills" => Some(command_definition(
            "python3 -c 'import json; print(json.dumps([]))'",
            &["python3", "-c", "import json; print(json.dumps([]))"],
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
