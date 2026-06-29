use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{async_runtime::Mutex as AsyncMutex, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const LOCAL_EXECUTOR_EVENT: &str = "local-executor:event";
const LOCAL_EXECUTOR_SIDECAR: &str = "binaries/wegent-executor";
const LOCAL_EXECUTOR_SIDECAR_ENV: &str = "WEWORK_EXECUTOR_SIDECAR";
const LOCAL_EXECUTOR_SOCKET_ENV: &str = "WEGENT_EXECUTOR_APP_IPC_SOCKET";
const LOCAL_EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const LOCAL_EXECUTOR_LOG_DIR_ENV: &str = "WEGENT_EXECUTOR_LOG_DIR";
const LOCAL_EXECUTOR_LOG_FILE_ENV: &str = "WEGENT_EXECUTOR_LOG_FILE";
const LOCAL_EXECUTOR_DEVICE_ID: &str = "local-device";
const LOCAL_EXECUTOR_SOCKET_NAME: &str = "app-ipc.sock";
const LOCAL_EXECUTOR_LOG_FILE_NAME: &str = "executor.log";
const LOCAL_EXECUTOR_LOG_TAIL_BYTES: u64 = 200 * 1024;
const LOCAL_EXECUTOR_LOG_TAIL_LINES: usize = 20;
const LOCAL_EXECUTOR_CONNECT_RETRIES: usize = 120;
const LOCAL_EXECUTOR_CONNECT_RETRY_MS: u64 = 250;
const LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS: u64 = 500;
const LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS: u64 = 20;

type PendingSender = mpsc::Sender<Result<Value, String>>;
type SharedExecutorInner = Arc<Mutex<LocalExecutorInner>>;

pub struct LocalExecutorState {
    inner: SharedExecutorInner,
    next_id: AtomicU64,
    start_lock: AsyncMutex<()>,
}

#[derive(Default)]
struct LocalExecutorInner {
    child: Option<LocalExecutorChild>,
    pending: HashMap<String, PendingSender>,
    backend_connection: Option<LocalExecutorBackendConnection>,
    running: bool,
    ready: bool,
    device_id: Option<String>,
    version: Option<String>,
    error: Option<String>,
    generation: u64,
    #[cfg(unix)]
    stream: Option<UnixStream>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalExecutorBackendConnection {
    backend_url: String,
    auth_token: String,
}

enum LocalExecutorChild {
    Tauri(CommandChild),
    Process(ManagedProcessChild),
}

struct ManagedProcessChild {
    child: Child,
    #[cfg(unix)]
    process_group_id: u32,
}

#[derive(Clone, Copy)]
enum LocalExecutorOutputStream {
    Stdout,
    Stderr,
}

impl LocalExecutorOutputStream {
    fn log_label(self) -> &'static str {
        match self {
            Self::Stdout => "Local executor output",
            Self::Stderr => "Local executor diagnostic",
        }
    }

    fn log_line(self, line: &str) {
        log::info!("{}: {}", self.log_label(), line);
    }
}

impl LocalExecutorChild {
    fn is_running(&mut self) -> bool {
        match self {
            LocalExecutorChild::Tauri(_) => true,
            LocalExecutorChild::Process(child) => child.is_running(),
        }
    }

    fn kill(self) {
        match self {
            LocalExecutorChild::Tauri(child) => {
                let _ = child.kill();
            }
            LocalExecutorChild::Process(child) => child.kill(),
        }
    }
}

impl ManagedProcessChild {
    fn new(child: Child) -> Self {
        #[cfg(unix)]
        {
            let process_group_id = child.id();
            Self {
                child,
                process_group_id,
            }
        }
        #[cfg(not(unix))]
        {
            Self { child }
        }
    }

    fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    fn kill(mut self) {
        #[cfg(unix)]
        {
            terminate_process_group(self.process_group_id);
            let _ = self.child.wait();
        }

        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(unix)]
fn configure_managed_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_managed_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(process_group_id: u32) {
    send_process_group_signal(process_group_id, libc::SIGTERM);
    wait_for_process_group_exit(
        process_group_id,
        Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS),
    );
    send_process_group_signal(process_group_id, libc::SIGKILL);
}

#[cfg(unix)]
fn wait_for_process_group_exit(process_group_id: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !process_group_exists(process_group_id) {
            return;
        }
        thread::sleep(Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS));
    }
}

#[cfg(unix)]
fn process_group_exists(process_group_id: u32) -> bool {
    unsafe { libc::kill(-(process_group_id as libc::pid_t), 0) == 0 }
}

#[cfg(unix)]
fn send_process_group_signal(process_group_id: u32, signal: libc::c_int) {
    unsafe {
        let _ = libc::kill(-(process_group_id as libc::pid_t), signal);
    }
}

impl Default for LocalExecutorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LocalExecutorInner::default())),
            next_id: AtomicU64::new(1),
            start_lock: AsyncMutex::new(()),
        }
    }
}

pub fn shutdown_local_executor(state: &LocalExecutorState) {
    let child = state.inner.lock().ok().and_then(|mut inner| {
        inner.running = false;
        inner.ready = false;
        inner.generation = inner.generation.saturating_add(1);
        clear_connected_stream(&mut inner);
        inner.error = Some("Local executor stopped".to_string());
        inner.child.take()
    });

    if let Some(child) = child {
        child.kill();
    }

    fail_pending_requests_inner(&state.inner, "Local executor stopped".to_string());
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ExecutorLine {
    #[serde(rename = "response")]
    Response(ExecutorResponse),
    #[serde(rename = "event")]
    Event(ExecutorEvent),
}

#[derive(Debug, Deserialize)]
pub struct ExecutorResponse {
    pub id: String,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<ExecutorError>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorError {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct LocalExecutorRequest {
    method: String,
    params: Value,
}

#[derive(Serialize)]
pub struct LocalExecutorStatus {
    running: bool,
    ready: bool,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExecutorLog {
    path: String,
    content: String,
    truncated: bool,
    line_count: usize,
    socket_path: String,
    socket_exists: bool,
    socket_file_type: String,
    socket_connected: bool,
    process_pids: Vec<u32>,
    process_paths: Vec<String>,
    sidecar_source: String,
    sidecar_path: String,
    current_dir: String,
    executor_home: String,
    backend_url: Option<String>,
    has_backend_auth_token: bool,
    pending_request_count: usize,
    status: LocalExecutorStatus,
}

struct LocalExecutorLogTail {
    path: String,
    content: String,
    truncated: bool,
    line_count: usize,
}

struct LocalExecutorSocketDebug {
    path: String,
    exists: bool,
    file_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalExecutorProcessInfo {
    pid: u32,
    path: String,
}

pub fn parse_executor_line(line: &str) -> Result<ExecutorLine, String> {
    serde_json::from_str::<ExecutorLine>(line).map_err(|error| error.to_string())
}

fn next_request_id(state: &LocalExecutorState) -> String {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    format!("local-req-{id}")
}

fn app_ipc_socket_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(LOCAL_EXECUTOR_SOCKET_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    if let Ok(path) = std::env::var(LOCAL_EXECUTOR_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join(LOCAL_EXECUTOR_SOCKET_NAME));
        }
    }

    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".wegent-executor")
        .join(LOCAL_EXECUTOR_SOCKET_NAME))
}

fn local_executor_home_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(LOCAL_EXECUTOR_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".wegent-executor"))
}

fn local_executor_log_path() -> Result<PathBuf, String> {
    let log_dir = std::env::var(LOCAL_EXECUTOR_LOG_DIR_ENV)
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| local_executor_home_path().map(|path| path.join("logs")))?;
    let log_file = std::env::var(LOCAL_EXECUTOR_LOG_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| LOCAL_EXECUTOR_LOG_FILE_NAME.to_string());

    Ok(log_dir.join(log_file))
}

fn read_local_executor_log_tail(
    path: &Path,
    max_bytes: u64,
) -> Result<LocalExecutorLogTail, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open local executor log: {error}"))?;
    let len = file
        .metadata()
        .map_err(|error| format!("Failed to inspect local executor log: {error}"))?
        .len();
    let byte_truncated = len > max_bytes;
    let offset = if byte_truncated { len - max_bytes } else { 0 };
    let starts_on_line_boundary = if offset == 0 {
        true
    } else {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|error| format!("Failed to seek local executor log: {error}"))?;
        let mut previous = [0_u8; 1];
        file.read_exact(&mut previous)
            .map_err(|error| format!("Failed to read local executor log: {error}"))?;
        previous[0] == b'\n'
    };
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek local executor log: {error}"))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read local executor log: {error}"))?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if byte_truncated && !starts_on_line_boundary {
        if let Some(index) = content.find('\n') {
            content = content[index + 1..].to_string();
        }
    }
    let (content, line_truncated, line_count) =
        limit_log_lines(&content, LOCAL_EXECUTOR_LOG_TAIL_LINES);

    Ok(LocalExecutorLogTail {
        path: path.display().to_string(),
        content,
        truncated: byte_truncated || line_truncated,
        line_count,
    })
}

fn limit_log_lines(content: &str, max_lines: usize) -> (String, bool, usize) {
    let has_trailing_newline = content.ends_with('\n');
    let lines = content.lines().collect::<Vec<_>>();
    let line_count = lines.len();
    let line_truncated = line_count > max_lines;
    let kept = if line_truncated {
        &lines[line_count - max_lines..]
    } else {
        &lines[..]
    };
    let mut content = kept.join("\n");
    if has_trailing_newline && !content.is_empty() {
        content.push('\n');
    }

    (content, line_truncated, kept.len())
}

fn local_executor_socket_debug() -> LocalExecutorSocketDebug {
    let path = match app_ipc_socket_path() {
        Ok(path) => path,
        Err(error) => {
            return LocalExecutorSocketDebug {
                path: format!("unavailable: {error}"),
                exists: false,
                file_type: "unknown".to_string(),
            };
        }
    };

    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => LocalExecutorSocketDebug {
            path: path.display().to_string(),
            exists: true,
            file_type: file_type_label(metadata.file_type()).to_string(),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LocalExecutorSocketDebug {
            path: path.display().to_string(),
            exists: false,
            file_type: "missing".to_string(),
        },
        Err(error) => LocalExecutorSocketDebug {
            path: path.display().to_string(),
            exists: false,
            file_type: format!("unavailable: {error}"),
        },
    }
}

fn file_type_label(file_type: std::fs::FileType) -> &'static str {
    #[cfg(unix)]
    {
        if file_type.is_socket() {
            return "socket";
        }
    }
    if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

fn parse_executor_processes(output: &str) -> Vec<LocalExecutorProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let executable = parts.next()?;
            let file_name = Path::new(executable)
                .file_name()
                .and_then(|name| name.to_str())?;
            if file_name != "wegent-executor" {
                return None;
            }
            Some(LocalExecutorProcessInfo {
                pid,
                path: executable.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
fn parse_executor_process_pids(output: &str) -> Vec<u32> {
    parse_executor_processes(output)
        .into_iter()
        .map(|process| process.pid)
        .collect()
}

#[cfg(unix)]
fn local_executor_processes() -> Vec<LocalExecutorProcessInfo> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_executor_processes(&stdout)
}

#[cfg(not(unix))]
fn local_executor_processes() -> Vec<LocalExecutorProcessInfo> {
    Vec::new()
}

fn sidecar_source_and_path() -> (String, String) {
    if let Some(path) = configured_sidecar_path() {
        return ("configured".to_string(), path.display().to_string());
    }

    ("bundled".to_string(), LOCAL_EXECUTOR_SIDECAR.to_string())
}

fn path_or_error(result: Result<PathBuf, String>) -> String {
    result
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {error}"))
}

#[cfg(target_os = "macos")]
fn write_text_to_native_clipboard(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let text = NSString::from_str(text);
    let string_type = unsafe { NSPasteboardTypeString };
    if pasteboard.setString_forType(&text, string_type) {
        Ok(())
    } else {
        Err("Failed to write text to the macOS pasteboard".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_text_to_native_clipboard(_text: &str) -> Result<(), String> {
    Err("Native clipboard copy is only available in the desktop macOS app".to_string())
}

fn configured_sidecar_path() -> Option<PathBuf> {
    std::env::var_os(LOCAL_EXECUTOR_SIDECAR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn has_connected_stream(inner: &LocalExecutorInner) -> bool {
    #[cfg(unix)]
    {
        inner.stream.is_some()
    }
    #[cfg(not(unix))]
    {
        let _ = inner;
        false
    }
}

fn clear_connected_stream(inner: &mut LocalExecutorInner) {
    #[cfg(unix)]
    {
        inner.stream = None;
    }
}

fn status_from_inner(inner: &LocalExecutorInner) -> LocalExecutorStatus {
    LocalExecutorStatus {
        running: inner.running,
        ready: inner.ready,
        device_id: inner.device_id.clone(),
        version: inner.version.clone(),
        error: inner.error.clone(),
    }
}

fn status_from_state(state: &LocalExecutorState) -> Result<LocalExecutorStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    Ok(status_from_inner(&inner))
}

fn normalize_command_arg(value: String, name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(trimmed.to_string())
    }
}

fn local_executor_backend_env(inner: &LocalExecutorInner) -> Vec<(String, String)> {
    let mut envs = vec![("EXECUTOR_STARTUP_MODE".to_string(), "socket".to_string())];
    let Some(connection) = &inner.backend_connection else {
        return envs;
    };
    let app_ipc_device_id = inner
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LOCAL_EXECUTOR_DEVICE_ID)
        .to_string();

    envs.extend([
        (
            "WEGENT_BACKEND_URL".to_string(),
            connection.backend_url.clone(),
        ),
        (
            "WEGENT_AUTH_TOKEN".to_string(),
            connection.auth_token.clone(),
        ),
        ("DEVICE_ID".to_string(), app_ipc_device_id.clone()),
        (
            "DEVICE_NAME".to_string(),
            format!("{app_ipc_device_id} app"),
        ),
        ("DEVICE_TYPE".to_string(), "app".to_string()),
        ("BIND_SHELL".to_string(), "claudecode".to_string()),
        ("WEGENT_APP_IPC_DEVICE_ID".to_string(), app_ipc_device_id),
    ]);
    envs
}

fn response_error(response: ExecutorResponse) -> String {
    response
        .error
        .map(|error| {
            if error.code.is_empty() {
                error.message
            } else {
                format!("{}: {}", error.code, error.message)
            }
        })
        .unwrap_or_else(|| "Local executor request failed".to_string())
}

fn resolve_response_inner(inner: &SharedExecutorInner, response: ExecutorResponse) {
    let sender = inner
        .lock()
        .ok()
        .and_then(|mut inner| inner.pending.remove(&response.id));

    if let Some(sender) = sender {
        let result = if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response_error(response))
        };
        let _ = sender.send(result);
    }
}

fn fail_pending_requests(state: &LocalExecutorState, message: String) {
    fail_pending_requests_inner(&state.inner, message);
}

fn fail_pending_requests_inner(inner: &SharedExecutorInner, message: String) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

fn fail_pending_requests_for_generation(
    inner: &SharedExecutorInner,
    generation: u64,
    message: String,
) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            if inner.generation != generation {
                return Vec::new();
            }
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

fn set_executor_error(state: &LocalExecutorState, error: String) {
    set_executor_error_inner(&state.inner, error);
}

fn set_executor_error_inner(inner: &SharedExecutorInner, error: String) {
    if let Ok(mut inner) = inner.lock() {
        inner.running = false;
        inner.ready = false;
        clear_connected_stream(&mut inner);
        inner.error = Some(error);
    }
}

fn set_executor_error_for_generation(inner: &SharedExecutorInner, generation: u64, error: String) {
    if let Ok(mut inner) = inner.lock() {
        if inner.generation != generation {
            return;
        }
        inner.running = false;
        inner.ready = false;
        clear_connected_stream(&mut inner);
        inner.error = Some(error);
    }
}

fn mark_child_terminated_inner(inner: &SharedExecutorInner, message: String) {
    if let Ok(mut inner) = inner.lock() {
        inner.child = None;
        inner.running = false;
        inner.ready = false;
        clear_connected_stream(&mut inner);
        inner.error = Some(message);
    }
}

fn update_ready_event_inner(inner: &SharedExecutorInner, event: &ExecutorEvent) {
    if event.event != "executor.ready" {
        return;
    }

    let ready = event
        .payload
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let device_id = event
        .payload
        .get("device_id")
        .or_else(|| event.payload.get("deviceId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let version = event
        .payload
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Ok(mut inner) = inner.lock() {
        inner.running = true;
        inner.ready = ready;
        if device_id.is_some() {
            inner.device_id = device_id;
        }
        if version.is_some() {
            inner.version = version;
        }
        if ready {
            inner.error = None;
        }
    }
}

fn handle_executor_line_inner(
    app: &tauri::AppHandle,
    inner: &SharedExecutorInner,
    line: &str,
) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }

    match parse_executor_line(line)? {
        ExecutorLine::Response(response) => {
            resolve_response_inner(inner, response);
        }
        ExecutorLine::Event(event) => {
            update_ready_event_inner(inner, &event);
            app.emit(LOCAL_EXECUTOR_EVENT, event)
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(unix)]
fn connect_sidecar_socket() -> Result<UnixStream, String> {
    let path = app_ipc_socket_path()?;
    UnixStream::connect(&path)
        .map_err(|error| format!("Failed to connect local executor socket {path:?}: {error}"))
}

#[cfg(unix)]
fn attach_connected_stream(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    stream: UnixStream,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("Failed to configure local executor socket timeout: {error}"))?;
    let mut reader = BufReader::new(stream);
    let mut ready_line = String::new();
    reader
        .read_line(&mut ready_line)
        .map_err(|error| format!("Failed to read local executor ready event: {error}"))?;
    if ready_line.trim().is_empty() {
        return Err("Local executor did not send a ready event".to_string());
    }
    reader
        .get_ref()
        .set_read_timeout(None)
        .map_err(|error| format!("Failed to clear local executor socket timeout: {error}"))?;
    let writer = reader
        .get_ref()
        .try_clone()
        .map_err(|error| format!("Failed to clone local executor socket: {error}"))?;
    let generation = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.generation = inner.generation.saturating_add(1);
        inner.stream = Some(writer);
        inner.running = true;
        inner.ready = false;
        inner.device_id = Some(
            inner
                .device_id
                .clone()
                .unwrap_or_else(|| LOCAL_EXECUTOR_DEVICE_ID.to_string()),
        );
        inner.error = None;
        inner.generation
    };
    handle_executor_line_inner(&app, &state.inner, &ready_line)?;
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        if !inner.ready {
            return Err("Local executor did not report ready".to_string());
        }
    }

    let state_handle = state.inner.clone();
    thread::spawn(move || {
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Err(error) = handle_executor_line_inner(&app, &state_handle, &line) {
                        log::warn!("Failed to handle local executor socket line: {error}");
                    }
                }
                Err(error) => {
                    log::warn!("Local executor socket read failed: {error}");
                    break;
                }
            }
        }

        let message = "Local executor socket disconnected".to_string();
        set_executor_error_for_generation(&state_handle, generation, message.clone());
        fail_pending_requests_for_generation(&state_handle, generation, message);
    });

    Ok(())
}

#[cfg(unix)]
fn write_request_line(inner: &mut LocalExecutorInner, line: &str) -> Result<(), String> {
    let Some(stream) = inner.stream.as_mut() else {
        return Err("Local executor socket is not connected".to_string());
    };

    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|error| format!("Failed to write local executor request: {error}"))
}

#[cfg(not(unix))]
fn write_request_line(_inner: &mut LocalExecutorInner, _line: &str) -> Result<(), String> {
    Err("Local executor socket IPC is not available on this platform".to_string())
}

fn drain_process_output(
    stream: LocalExecutorOutputStream,
    output: impl std::io::Read + Send + 'static,
) {
    thread::spawn(move || {
        let reader = BufReader::new(output);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                stream.log_line(trimmed);
            }
        }
    });
}

fn spawn_configured_sidecar(
    path: PathBuf,
    envs: &[(String, String)],
) -> Result<LocalExecutorChild, String> {
    if !path.exists() {
        return Err(format!(
            "Configured local executor sidecar does not exist: {}",
            path.display()
        ));
    }

    let mut command = Command::new(&path);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.envs(envs.iter().map(|(key, value)| (key, value)));
    configure_managed_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to start local executor sidecar {}: {error}",
            path.display()
        )
    })?;

    if let Some(stdout) = child.stdout.take() {
        drain_process_output(LocalExecutorOutputStream::Stdout, stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_process_output(LocalExecutorOutputStream::Stderr, stderr);
    }

    Ok(LocalExecutorChild::Process(ManagedProcessChild::new(child)))
}

async fn spawn_sidecar_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let envs = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        if let Some(child) = inner.child.as_mut() {
            if child.is_running() {
                return Ok(());
            }
            inner.child = None;
        }
        local_executor_backend_env(&inner)
    };

    if let Some(path) = configured_sidecar_path() {
        let child = spawn_configured_sidecar(path, &envs)?;
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.child = Some(child);
        inner.running = true;
        inner.ready = false;
        inner.error = None;
        return Ok(());
    }

    let sidecar = app
        .shell()
        .sidecar(LOCAL_EXECUTOR_SIDECAR)
        .map_err(|error| {
            format!("Failed to resolve local executor sidecar {LOCAL_EXECUTOR_SIDECAR}: {error}")
        })?
        .envs(envs.iter().map(|(key, value)| (key, value)));
    let (mut rx, child) = sidecar.spawn().map_err(|error| {
        format!("Failed to start local executor sidecar {LOCAL_EXECUTOR_SIDECAR}: {error}")
    })?;

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.child = Some(LocalExecutorChild::Tauri(child));
        inner.running = true;
        inner.ready = false;
        inner.error = None;
    }

    let state_handle = state.inner.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        LocalExecutorOutputStream::Stdout.log_line(text.trim());
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        LocalExecutorOutputStream::Stderr.log_line(text.trim());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!("Local executor exited: {payload:?}");
                    mark_child_terminated_inner(&state_handle, message.clone());
                    fail_pending_requests_inner(&state_handle, message);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

async fn retry_connect_delay() {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        thread::sleep(Duration::from_millis(LOCAL_EXECUTOR_CONNECT_RETRY_MS));
    })
    .await;
}

#[cfg(unix)]
async fn start_executor_if_needed_unlocked(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        if inner.running && has_connected_stream(&inner) {
            return Ok(());
        }
    }

    let mut last_error = match connect_sidecar_socket() {
        Ok(stream) => return attach_connected_stream(app, state, stream),
        Err(error) => error,
    };

    spawn_sidecar_if_needed(app.clone(), state).await?;

    for _ in 0..LOCAL_EXECUTOR_CONNECT_RETRIES {
        match connect_sidecar_socket() {
            Ok(stream) => return attach_connected_stream(app.clone(), state, stream),
            Err(error) => {
                last_error = error;
                retry_connect_delay().await;
            }
        }
    }

    let message = if last_error.is_empty() {
        "Failed to connect local executor socket".to_string()
    } else {
        last_error
    };
    set_executor_error(state, message.clone());
    fail_pending_requests(state, message.clone());
    Err(message)
}

#[cfg(not(unix))]
async fn start_executor_if_needed_unlocked(
    _app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let message = "Local executor socket IPC is not available on this platform".to_string();
    set_executor_error(state, message.clone());
    Err(message)
}

async fn start_executor_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let _guard = state.start_lock.lock().await;
    start_executor_if_needed_unlocked(app, state).await
}

async fn restart_executor_unlocked(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let mut old_child = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?
        .child
        .take();

    if let Some(child) = old_child.take() {
        child.kill();
    }

    set_executor_error(state, "Local executor restarting".to_string());
    fail_pending_requests(state, "Local executor restarting".to_string());
    start_executor_if_needed_unlocked(app, state).await
}

async fn restart_executor(app: tauri::AppHandle, state: &LocalExecutorState) -> Result<(), String> {
    let _guard = state.start_lock.lock().await;
    restart_executor_unlocked(app, state).await
}

async fn send_executor_request(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
) -> Result<Value, String> {
    start_executor_if_needed(app, state).await?;

    let request_id = next_request_id(state);
    let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
    let message = json!({
        "type": "request",
        "id": request_id,
        "method": request.method,
        "params": request.params,
    });
    let line = format!(
        "{}\n",
        serde_json::to_string(&message).map_err(|error| error.to_string())?
    );

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.pending.insert(request_id.clone(), sender);
        if let Err(error) = write_request_line(&mut inner, &line) {
            inner.pending.remove(&request_id);
            return Err(error);
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .unwrap_or_else(|_| Err("Local executor disconnected".to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_executor_status(
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_read_log(
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorLog, String> {
    let path = local_executor_log_path()?;
    let path_for_read = path.clone();
    let tail_result = tauri::async_runtime::spawn_blocking(move || {
        read_local_executor_log_tail(&path_for_read, LOCAL_EXECUTOR_LOG_TAIL_BYTES)
    })
    .await
    .map_err(|error| error.to_string())?;
    let tail = tail_result.unwrap_or_else(|error| LocalExecutorLogTail {
        path: path.display().to_string(),
        content: format!("Executor log unavailable: {error}"),
        truncated: false,
        line_count: 0,
    });
    let socket = local_executor_socket_debug();
    let processes = local_executor_processes();
    let process_pids = processes
        .iter()
        .map(|process| process.pid)
        .collect::<Vec<_>>();
    let process_paths = processes
        .iter()
        .map(|process| process.path.clone())
        .collect::<Vec<_>>();
    let (sidecar_source, sidecar_path) = sidecar_source_and_path();
    let current_dir = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {error}"));
    let executor_home = path_or_error(local_executor_home_path());
    let (status, backend_url, has_backend_auth_token, pending_request_count, socket_connected) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        let backend_url = inner
            .backend_connection
            .as_ref()
            .map(|connection| connection.backend_url.clone());
        let has_backend_auth_token = inner
            .backend_connection
            .as_ref()
            .map(|connection| !connection.auth_token.trim().is_empty())
            .unwrap_or(false);
        (
            status_from_inner(&inner),
            backend_url,
            has_backend_auth_token,
            inner.pending.len(),
            has_connected_stream(&inner),
        )
    };

    Ok(LocalExecutorLog {
        path: tail.path,
        content: tail.content,
        truncated: tail.truncated,
        line_count: tail.line_count,
        socket_path: socket.path,
        socket_exists: socket.exists,
        socket_file_type: socket.file_type,
        socket_connected,
        process_pids,
        process_paths,
        sidecar_source,
        sidecar_path,
        current_dir,
        executor_home,
        backend_url,
        has_backend_auth_token,
        pending_request_count,
        status,
    })
}

#[tauri::command]
pub async fn local_executor_copy_debug_info(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Debug info must not be empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || write_text_to_native_clipboard(&text))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_executor_ensure_started(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    start_executor_if_needed(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_restart(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    restart_executor(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_connect_backend(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    backend_url: String,
    auth_token: String,
) -> Result<LocalExecutorStatus, String> {
    let backend_url = normalize_command_arg(backend_url, "backend_url")?;
    let auth_token = normalize_command_arg(auth_token, "auth_token")?;
    let _guard = state.start_lock.lock().await;
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.backend_connection = Some(LocalExecutorBackendConnection {
            backend_url,
            auth_token,
        });
    }
    restart_executor_unlocked(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_disconnect_backend(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    let _guard = state.start_lock.lock().await;
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.backend_connection = None;
    }
    restart_executor_unlocked(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_request(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    send_executor_request(app, &state, LocalExecutorRequest { method, params }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::process::Stdio;
    use std::sync::{Mutex as TestMutex, MutexGuard, OnceLock};
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<TestMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| TestMutex::new(()))
            .lock()
            .expect("env lock should be available")
    }

    fn restore_env(key: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn parses_success_response_line() {
        let line = r#"{"type":"response","id":"req-1","ok":true,"result":{"value":1}}"#;
        let message = parse_executor_line(line).expect("line should parse");

        match message {
            ExecutorLine::Response(response) => assert_eq!(response.id, "req-1"),
            ExecutorLine::Event(_) => panic!("expected response line"),
        }
    }

    #[test]
    fn parses_event_line() {
        let line =
            r#"{"type":"event","event":"response.completed","payload":{"localTaskId":"task-1"}}"#;
        let message = parse_executor_line(line).expect("line should parse");

        assert!(matches!(message, ExecutorLine::Event(_)));
    }

    #[test]
    fn stderr_output_uses_diagnostic_label_in_app_logs() {
        let label = LocalExecutorOutputStream::Stderr.log_label();

        assert_eq!(label, "Local executor diagnostic");
        assert!(!label.contains("stderr"));
    }

    #[test]
    fn app_ipc_socket_path_uses_override() {
        let _guard = env_lock();
        let previous_socket = std::env::var_os("WEGENT_EXECUTOR_APP_IPC_SOCKET");
        std::env::set_var("WEGENT_EXECUTOR_APP_IPC_SOCKET", "/tmp/wegent-test.sock");
        let path = app_ipc_socket_path().expect("socket path should resolve");
        restore_env("WEGENT_EXECUTOR_APP_IPC_SOCKET", previous_socket);

        assert_eq!(path, PathBuf::from("/tmp/wegent-test.sock"));
    }

    #[test]
    fn app_ipc_socket_path_uses_executor_home() {
        let _guard = env_lock();
        let previous_socket = std::env::var_os("WEGENT_EXECUTOR_APP_IPC_SOCKET");
        let previous_home = std::env::var_os("WEGENT_EXECUTOR_HOME");
        std::env::remove_var("WEGENT_EXECUTOR_APP_IPC_SOCKET");
        std::env::set_var("WEGENT_EXECUTOR_HOME", "/tmp/wegent-home");
        let path = app_ipc_socket_path().expect("socket path should resolve");
        restore_env("WEGENT_EXECUTOR_APP_IPC_SOCKET", previous_socket);
        restore_env("WEGENT_EXECUTOR_HOME", previous_home);

        assert_eq!(path, PathBuf::from("/tmp/wegent-home/app-ipc.sock"));
    }

    #[test]
    fn local_executor_log_path_uses_executor_home() {
        let _guard = env_lock();
        let previous_home = std::env::var_os("WEGENT_EXECUTOR_HOME");
        std::env::set_var("WEGENT_EXECUTOR_HOME", "/tmp/wegent-executor-debug");

        let path = local_executor_log_path().expect("log path should resolve");
        restore_env("WEGENT_EXECUTOR_HOME", previous_home);

        assert_eq!(
            path,
            PathBuf::from("/tmp/wegent-executor-debug/logs/executor.log")
        );
    }

    #[test]
    fn read_local_executor_log_tail_limits_content() {
        let dir = std::env::temp_dir().join(format!(
            "wework-local-executor-log-tail-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("logs")).expect("test log dir should be created");
        let log_path = dir.join("logs").join("executor.log");
        fs::write(&log_path, "old log line\nrecent executor failure\n")
            .expect("test log should be written");

        let log = read_local_executor_log_tail(&log_path, 24).expect("log should be read");

        assert!(log.truncated);
        assert_eq!(log.path, log_path.display().to_string());
        assert_eq!(log.content, "recent executor failure\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_executor_log_tail_limits_to_last_twenty_lines() {
        let dir = std::env::temp_dir().join(format!(
            "wework-local-executor-log-lines-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("logs")).expect("test log dir should be created");
        let log_path = dir.join("logs").join("executor.log");
        let content = (1..=25)
            .map(|line| format!("line-{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&log_path, content).expect("test log should be written");

        let log = read_local_executor_log_tail(&log_path, 200 * 1024).expect("log should be read");

        assert!(log.truncated);
        assert_eq!(log.line_count, 20);
        assert!(log.content.starts_with("line-6\n"));
        assert!(log.content.ends_with("line-25"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_executor_process_pids_filters_executor_binary() {
        let output = r#"
111 /bin/zsh -c echo wegent-executor
222 /Applications/Wework.app/Contents/MacOS/wegent-executor --app
333 /usr/local/bin/wegent-executor --config /tmp/device-config.json
"#;

        assert_eq!(parse_executor_process_pids(output), vec![222, 333]);
    }

    #[test]
    fn ready_event_updates_status_device_id() {
        let inner = Arc::new(Mutex::new(LocalExecutorInner::default()));
        let event = ExecutorEvent {
            event: "executor.ready".to_string(),
            payload: json!({
                "device_id": "configured-device",
                "ready": true,
                "version": "1.9.0",
            }),
        };

        update_ready_event_inner(&inner, &event);

        let status = inner.lock().expect("state should lock");
        assert!(status.running);
        assert!(status.ready);
        assert_eq!(status.device_id.as_deref(), Some("configured-device"));
        assert_eq!(status.version.as_deref(), Some("1.9.0"));
        assert_eq!(status.error, None);
    }

    #[test]
    fn backend_env_marks_current_app_device_without_changing_device_id() {
        let inner = LocalExecutorInner {
            backend_connection: Some(LocalExecutorBackendConnection {
                backend_url: "https://cloud.example.com".to_string(),
                auth_token: "wg-token".to_string(),
            }),
            device_id: Some("local-device-abc".to_string()),
            ..LocalExecutorInner::default()
        };

        let envs = local_executor_backend_env(&inner)
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(
            envs.get("EXECUTOR_STARTUP_MODE").map(String::as_str),
            Some("socket")
        );
        assert_eq!(
            envs.get("WEGENT_BACKEND_URL").map(String::as_str),
            Some("https://cloud.example.com")
        );
        assert_eq!(
            envs.get("WEGENT_AUTH_TOKEN").map(String::as_str),
            Some("wg-token")
        );
        assert_eq!(
            envs.get("WEGENT_APP_IPC_DEVICE_ID").map(String::as_str),
            Some("local-device-abc")
        );
        assert_eq!(
            envs.get("DEVICE_ID").map(String::as_str),
            Some("local-device-abc")
        );
        assert_eq!(envs.get("DEVICE_TYPE").map(String::as_str), Some("app"));
    }

    #[cfg(unix)]
    #[test]
    fn configured_sidecar_kill_stops_grandchild_process_group() {
        let dir = std::env::temp_dir().join(format!(
            "wework-local-executor-process-group-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("test dir should be created");
        let pid_path = dir.join("grandchild.pid");
        let script_path = dir.join("sidecar.sh");
        fs::write(
            &script_path,
            format!(
                r#"#!/usr/bin/env bash
set -euo pipefail
(
  trap '' TERM
  while true; do sleep 10; done
) &
echo "$!" > "{}"
wait
"#,
                pid_path.display()
            ),
        )
        .expect("sidecar script should be written");
        let mut permissions = fs::metadata(&script_path)
            .expect("sidecar metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)
            .expect("sidecar script should be executable");

        let child = spawn_configured_sidecar(script_path, &[]).expect("sidecar should start");
        let grandchild_pid =
            wait_for_pid_file(&pid_path, Duration::from_secs(2)).expect("grandchild pid");
        let _cleanup = ProcessCleanup::new(grandchild_pid);

        child.kill();

        assert!(
            wait_until_dead(grandchild_pid, Duration::from_secs(2)),
            "grandchild process should be stopped when sidecar is killed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    struct ProcessCleanup {
        pid: u32,
    }

    #[cfg(unix)]
    impl ProcessCleanup {
        fn new(pid: u32) -> Self {
            Self { pid }
        }
    }

    #[cfg(unix)]
    impl Drop for ProcessCleanup {
        fn drop(&mut self) {
            if process_alive(self.pid) {
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", &self.pid.to_string()])
                    .status();
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_pid_file(path: &PathBuf, timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(value) = fs::read_to_string(path) {
                if let Ok(pid) = value.trim().parse::<u32>() {
                    return Some(pid);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    #[cfg(unix)]
    fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !process_alive(pid)
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
