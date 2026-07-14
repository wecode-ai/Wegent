use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use tauri::{async_runtime::Mutex as AsyncMutex, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::process_environment;

const LOCAL_EXECUTOR_EVENT: &str = "local-executor:event";
const LOCAL_EXECUTOR_SIDECAR: &str = "wegent-executor";
const LOCAL_EXECUTOR_SIDECAR_ENV: &str = "WEWORK_EXECUTOR_SIDECAR";
const LOCAL_EXECUTOR_ADDR_ENV: &str = "WEGENT_EXECUTOR_APP_IPC_ADDR";
const LOCAL_EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const LOCAL_EXECUTOR_LOG_DIR_ENV: &str = "WEGENT_EXECUTOR_LOG_DIR";
const LOCAL_EXECUTOR_LOG_FILE_ENV: &str = "WEGENT_EXECUTOR_LOG_FILE";
const CODEX_HOME_ENV: &str = "CODEX_HOME";
const WEGENT_CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const FILE_EDIT_HOOK_COMMAND_ENV: &str = "WEGENT_FILE_EDIT_HOOK_COMMAND";
const FILE_EDIT_LOG_ENDPOINT_ENV: &str = "WEWORK_FILE_EDIT_LOG_ENDPOINT";
const CODEX_BINARY_PATH_ENV: &str = "CODEX_BINARY_PATH";
const CODEX_BIN_ENV: &str = "CODEX_BIN";
const CODEX_MANAGED_PACKAGE_ROOT_ENV: &str = "CODEX_MANAGED_PACKAGE_ROOT";
const DEFAULT_FILE_EDIT_LOG_ENDPOINT: &str = "http://127.0.0.1:3456/api/file-edit-log";
const LOCAL_EXECUTOR_DEVICE_ID: &str = "local-device";
const LOCAL_EXECUTOR_ADDR_FILE_NAME: &str = "app-ipc.addr";
const LOCAL_EXECUTOR_DEFAULT_ADDR: &str = "127.0.0.1:0";
const LOCAL_EXECUTOR_LOG_FILE_NAME: &str = "executor.log";
const LOCAL_EXECUTOR_RUNTIME_DIR_NAME: &str = "app-runtime";
const LOCAL_EXECUTOR_LOG_TAIL_BYTES: u64 = 200 * 1024;
const LOCAL_EXECUTOR_LOG_TAIL_LINES: usize = 20;
const LOCAL_EXECUTOR_CONNECT_RETRY_MS: u64 = 250;
const LOCAL_EXECUTOR_READY_TIMEOUT_SECS: u64 = 10;
const LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS: u64 = 500;
const LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS: u64 = 20;
const LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS: u64 = 60;
const LOCAL_EXECUTOR_KEEPALIVE_INTERVAL_SECS: u64 = 10;

type PendingSender = mpsc::Sender<Result<Value, String>>;
type SharedExecutorInner = Arc<Mutex<LocalExecutorInner>>;

pub struct LocalExecutorState {
    inner: SharedExecutorInner,
    next_id: Arc<AtomicU64>,
    start_lock: Arc<AsyncMutex<()>>,
    keepalive: Arc<LocalExecutorKeepaliveState>,
}

struct LocalExecutorKeepaliveState {
    enabled: AtomicBool,
    worker_running: AtomicBool,
}

impl Clone for LocalExecutorState {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            next_id: self.next_id.clone(),
            start_lock: self.start_lock.clone(),
            keepalive: self.keepalive.clone(),
        }
    }
}

#[derive(Default)]
struct LocalExecutorInner {
    child: Option<LocalExecutorChild>,
    pending: HashMap<String, PendingSender>,
    backend_connection: Option<LocalExecutorBackendConnection>,
    startup_cleanup_done: bool,
    running: bool,
    ready: bool,
    device_id: Option<String>,
    runtime_instance_id: Option<String>,
    version: Option<String>,
    error: Option<String>,
    generation: u64,
    stream: Option<TcpStream>,
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

#[cfg(unix)]
fn terminate_process(process_id: u32) -> Result<(), String> {
    terminate_process_group(process_id);
    if !process_exists(process_id) {
        return Ok(());
    }

    send_process_signal(process_id, libc::SIGTERM)?;
    wait_for_process_exit(
        process_id,
        Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS),
    );
    if process_exists(process_id) {
        send_process_signal(process_id, libc::SIGKILL)?;
    }
    Ok(())
}

#[cfg(unix)]
fn wait_for_process_exit(process_id: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !process_exists(process_id) {
            return;
        }
        thread::sleep(Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS));
    }
}

#[cfg(unix)]
fn process_exists(process_id: u32) -> bool {
    unsafe { libc::kill(process_id as libc::pid_t, 0) == 0 }
}

#[cfg(unix)]
fn send_process_signal(process_id: u32, signal: libc::c_int) -> Result<(), String> {
    let result = unsafe { libc::kill(process_id as libc::pid_t, signal) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "Failed to signal stale local executor process {process_id}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

impl Default for LocalExecutorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LocalExecutorInner::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            start_lock: Arc::new(AsyncMutex::new(())),
            keepalive: Arc::new(LocalExecutorKeepaliveState {
                enabled: AtomicBool::new(false),
                worker_running: AtomicBool::new(false),
            }),
        }
    }
}

pub fn shutdown_local_executor(state: &LocalExecutorState) {
    state.keepalive.enabled.store(false, Ordering::SeqCst);
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
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: Option<String>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeMigrationStatus {
    wework_codex_home: String,
    native_codex_home: String,
    wework_codex_home_exists: bool,
    native_codex_home_exists: bool,
    should_prompt_migration: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeInitializeOptions {
    migrate_native_home: bool,
    remote_apps_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportOptions {
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportResult {
    source: String,
    source_path: String,
    destination_path: String,
    imported_entries: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfigPatch {
    remote_apps_enabled: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfig {
    codex_home: String,
    config_path: String,
    remote_apps_enabled: bool,
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

struct PreparedExecutorStream {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    ready_line: String,
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

fn local_executor_instance_name() -> &'static str {
    static INSTANCE_NAME: OnceLock<String> = OnceLock::new();
    INSTANCE_NAME.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        format!("wework-{}-{nanos}", std::process::id())
    })
}

fn local_executor_runtime_dir_path() -> Result<PathBuf, String> {
    let home = local_executor_home_path()?;
    if cfg!(debug_assertions) {
        return Ok(home
            .join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
            .join(local_executor_instance_name()));
    }

    Ok(home)
}

fn local_executor_home_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(LOCAL_EXECUTOR_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home.join(".wegent-executor"))
}

fn app_ipc_addr_file_path() -> Result<PathBuf, String> {
    Ok(local_executor_home_path()?.join(LOCAL_EXECUTOR_ADDR_FILE_NAME))
}

fn resolve_app_ipc_addr() -> Result<SocketAddr, String> {
    if let Ok(value) = std::env::var(LOCAL_EXECUTOR_ADDR_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            if let Ok(addr) = trimmed.parse::<SocketAddr>() {
                return Ok(addr);
            }
            if let Ok(port) = trimmed.parse::<u16>() {
                if let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() {
                    return Ok(addr);
                }
            }
            return Err(format!(
                "{LOCAL_EXECUTOR_ADDR_ENV} is not a valid socket address: {trimmed}"
            ));
        }
    }

    if let Ok(path) = app_ipc_addr_file_path() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(addr) = content.trim().parse::<SocketAddr>() {
                return Ok(addr);
            }
        }
    }

    LOCAL_EXECUTOR_DEFAULT_ADDR
        .parse()
        .map_err(|error| format!("default app IPC address is invalid: {error}"))
}

fn wait_for_app_ipc_addr(timeout: Duration) -> Result<SocketAddr, String> {
    let deadline = Instant::now() + timeout;
    let path = app_ipc_addr_file_path()?;
    while Instant::now() < deadline {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                if let Ok(addr) = trimmed.parse::<SocketAddr>() {
                    return Ok(addr);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(LOCAL_EXECUTOR_CONNECT_RETRY_MS));
    }
    Err(format!(
        "Timed out waiting for app IPC address file: {}",
        path.display()
    ))
}

fn local_executor_log_path() -> Result<PathBuf, String> {
    let log_dir = local_executor_log_dir_path()?;
    let log_file = std::env::var(LOCAL_EXECUTOR_LOG_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| LOCAL_EXECUTOR_LOG_FILE_NAME.to_string());

    Ok(log_dir.join(log_file))
}

pub(crate) fn local_executor_log_dir_path() -> Result<PathBuf, String> {
    std::env::var(LOCAL_EXECUTOR_LOG_DIR_ENV)
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| local_executor_runtime_dir_path().map(|path| path.join("logs")))
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
    let path = match app_ipc_addr_file_path() {
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

fn executor_process_pids(processes: &[LocalExecutorProcessInfo]) -> Vec<u32> {
    let current_process_id = std::process::id();
    processes
        .iter()
        .filter(|process| process.pid != current_process_id)
        .map(|process| process.pid)
        .collect()
}

#[cfg(test)]
fn parse_executor_process_pids(output: &str) -> Vec<u32> {
    executor_process_pids(&parse_executor_processes(output))
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

#[cfg(unix)]
fn remove_stale_app_ipc_addr_file_at(path: &Path) -> Result<(), String> {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    if file_name != LOCAL_EXECUTOR_ADDR_FILE_NAME {
        return Ok(());
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            std::fs::remove_file(path).map_err(|error| {
                format!(
                    "Failed to remove stale local executor IPC address file {path:?}: {error}"
                )
            })
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to inspect local executor IPC address file {path:?}: {error}"
        )),
    }
}

#[cfg(not(unix))]
fn remove_stale_app_ipc_addr_file_at(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn addr_env_assignment(addr: &str) -> String {
    format!("{LOCAL_EXECUTOR_ADDR_ENV}={addr}")
}

fn process_text_uses_addr_file(process_text: &str, addr_file_path: &Path) -> bool {
    process_text.contains(&addr_env_assignment(&addr_file_path.display().to_string()))
        || process_text.contains(&format!(
            "{LOCAL_EXECUTOR_HOME_ENV}={}",
            addr_file_path.parent().unwrap_or(Path::new("")).display()
        ))
}

#[cfg(unix)]
fn local_executor_process_uses_addr_file(process_id: u32, addr_file_path: &Path) -> bool {
    if let Ok(environ) = std::fs::read(format!("/proc/{process_id}/environ")) {
        let process_text = String::from_utf8_lossy(&environ).replace('\0', " ");
        if process_text_uses_addr_file(&process_text, addr_file_path) {
            return true;
        }
    }

    let Ok(output) = Command::new("ps")
        .args(["eww", "-p", &process_id.to_string(), "-o", "command="])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    process_text_uses_addr_file(&String::from_utf8_lossy(&output.stdout), addr_file_path)
}

#[cfg(not(unix))]
fn local_executor_process_uses_addr_file(_process_id: u32, _addr_file_path: &Path) -> bool {
    false
}

#[cfg(unix)]
fn terminate_stale_local_executor_processes(
    processes: &[LocalExecutorProcessInfo],
    addr_file_path: &Path,
) -> Result<(), String> {
    for process_id in executor_process_pids(processes) {
        if !local_executor_process_uses_addr_file(process_id, addr_file_path) {
            log::info!(
                "Skipping local executor process with a different app IPC address: pid={process_id}"
            );
            continue;
        }
        log::info!("Terminating stale local executor process before app pairing: pid={process_id}");
        terminate_process(process_id)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate_stale_local_executor_processes(
    _processes: &[LocalExecutorProcessInfo],
    _addr_file_path: &Path,
) -> Result<(), String> {
    Ok(())
}

fn cleanup_stale_local_executor_processes() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }

    let addr_file_path = app_ipc_addr_file_path()?;
    let processes = local_executor_processes();
    if processes.is_empty() {
        return remove_stale_app_ipc_addr_file_at(&addr_file_path);
    }

    terminate_stale_local_executor_processes(&processes, &addr_file_path)?;
    remove_stale_app_ipc_addr_file_at(&addr_file_path)
}

fn cleanup_stale_local_executor_once(state: &LocalExecutorState) -> Result<(), String> {
    let should_cleanup = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        !inner.startup_cleanup_done && inner.child.is_none()
    };
    if !should_cleanup {
        return Ok(());
    }

    cleanup_stale_local_executor_processes()?;

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    inner.startup_cleanup_done = true;
    Ok(())
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
    inner.stream.is_some()
}

fn clear_connected_stream(inner: &mut LocalExecutorInner) {
    inner.stream = None;
}

fn status_from_inner(inner: &LocalExecutorInner) -> LocalExecutorStatus {
    LocalExecutorStatus {
        running: inner.running,
        ready: inner.ready,
        device_id: inner.device_id.clone(),
        runtime_instance_id: inner.runtime_instance_id.clone(),
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

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_file_edit_hook_command() -> String {
    let endpoint = non_empty_env(FILE_EDIT_LOG_ENDPOINT_ENV)
        .unwrap_or_else(|| DEFAULT_FILE_EDIT_LOG_ENDPOINT.to_string());
    format!("curl -s -X POST {endpoint} -H \"Content-Type: application/json\" -d @-")
}

fn configured_file_edit_hook_command() -> String {
    non_empty_env(FILE_EDIT_HOOK_COMMAND_ENV).unwrap_or_else(default_file_edit_hook_command)
}

fn local_executor_backend_env(inner: &LocalExecutorInner) -> Vec<(String, String)> {
    let executor_home = path_or_error(local_executor_home_path());
    let codex_home = path_or_error(wework_codex_home_path(&executor_home));
    let log_dir = path_or_error(local_executor_log_dir_path());
    let mut envs = vec![
        (LOCAL_EXECUTOR_HOME_ENV.to_string(), executor_home),
        (CODEX_HOME_ENV.to_string(), codex_home),
        (LOCAL_EXECUTOR_ADDR_ENV.to_string(), LOCAL_EXECUTOR_DEFAULT_ADDR.to_string()),
        (LOCAL_EXECUTOR_LOG_DIR_ENV.to_string(), log_dir),
        (
            "PATH".to_string(),
            process_environment::normalized_current_path(),
        ),
        (
            FILE_EDIT_HOOK_COMMAND_ENV.to_string(),
            configured_file_edit_hook_command(),
        ),
    ];
    if let Some(log_file) = non_empty_env(LOCAL_EXECUTOR_LOG_FILE_ENV) {
        envs.push((LOCAL_EXECUTOR_LOG_FILE_ENV.to_string(), log_file));
    }
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

fn wework_codex_home_path(executor_home: &str) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(WEGENT_CODEX_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(PathBuf::from(executor_home).join("codex"))
}

fn native_codex_home_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home.join(".codex"))
}

fn codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String> {
    let executor_home = local_executor_home_path()?;
    let wework_codex_home = wework_codex_home_path(&executor_home.display().to_string())?;
    let wework_codex_config = wework_codex_home.join("config.toml");
    let native_codex_home = native_codex_home_path()?;
    let wework_codex_home_exists = wework_codex_home.exists();
    let wework_codex_config_exists = wework_codex_config.exists();
    let native_codex_home_exists = native_codex_home.exists();
    Ok(CodexHomeMigrationStatus {
        wework_codex_home: wework_codex_home.display().to_string(),
        native_codex_home: native_codex_home.display().to_string(),
        wework_codex_home_exists,
        native_codex_home_exists,
        should_prompt_migration: !wework_codex_config_exists && native_codex_home_exists,
    })
}

fn wework_codex_config_path() -> Result<(PathBuf, PathBuf), String> {
    let executor_home = local_executor_home_path()?;
    let codex_home = wework_codex_home_path(&executor_home.display().to_string())?;
    let config_path = codex_home.join("config.toml");
    Ok((codex_home, config_path))
}

fn read_remote_apps_enabled_from_config(content: &str) -> bool {
    let mut in_features = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_features = trimmed == "[features]";
            continue;
        }
        if !in_features || trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("apps") else {
            continue;
        };
        if !rest.trim_start().starts_with('=') {
            continue;
        }
        return rest
            .trim_start()
            .trim_start_matches('=')
            .trim()
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            == "true";
    }
    false
}

fn read_codex_local_config() -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    Ok(CodexLocalConfig {
        codex_home: codex_home.display().to_string(),
        config_path: config_path.display().to_string(),
        remote_apps_enabled: read_remote_apps_enabled_from_config(&content),
    })
}

fn set_remote_apps_enabled_in_config(content: &str, enabled: bool) -> String {
    let apps_line = format!("apps = {enabled}");
    let mut lines = content.lines().map(str::to_string).collect::<Vec<_>>();
    let mut features_start = None;
    let mut features_end = lines.len();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if features_start.is_some() {
                features_end = index;
                break;
            }
            if trimmed == "[features]" {
                features_start = Some(index);
            }
        }
    }

    if let Some(start) = features_start {
        for line in lines.iter_mut().take(features_end).skip(start + 1) {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("apps") else {
                continue;
            };
            if rest.trim_start().starts_with('=') {
                let indent_len = line.len() - trimmed.len();
                *line = format!("{}{}", " ".repeat(indent_len), apps_line);
                return format!("{}\n", lines.join("\n"));
            }
        }
        lines.insert(start + 1, apps_line);
        return format!("{}\n", lines.join("\n"));
    }

    let mut next = content.trim_end().to_string();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    next.push_str("[features]\n");
    next.push_str(&apps_line);
    next.push('\n');
    next
}

fn write_codex_remote_apps_enabled(enabled: bool) -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create {}: {error}", codex_home.display()))?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let next_content = set_remote_apps_enabled_in_config(&content, enabled);
    fs::write(&config_path, next_content)
        .map_err(|error| format!("failed to write {}: {error}", config_path.display()))?;
    read_codex_local_config()
}

fn copy_codex_initialization_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to inspect {}: {error}", source.display()))?;
    if metadata.is_dir() {
        copy_directory_recursive(source, destination)
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        fs::copy(source, destination).map_err(|error| {
            format!(
                "failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
        Ok(())
    } else {
        Ok(())
    }
}

fn copy_codex_initialization_files(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;

    let entries = [
        "config.toml",
        "auth.json",
        "AGENTS.md",
        "models_cache.json",
        "plugins",
        "skills",
        "cache",
        "vendor_imports",
    ];
    for entry in entries {
        let source_path = source.join(entry);
        let destination_path = destination.join(entry);
        log::info!(
            "Codex home initialization copying entry: source={}, destination={}",
            source_path.display(),
            destination_path.display()
        );
        copy_codex_initialization_entry(&source_path, &destination_path)?;
    }
    Ok(())
}

fn import_external_content(source: &str) -> Result<ExternalContentImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    let executor_home = local_executor_home_path()?;
    let destination = wework_codex_home_path(&executor_home.display().to_string())?;
    import_external_content_from_paths(source, &home, &destination)
}

fn import_external_content_from_paths(
    source: &str,
    home: &Path,
    destination: &Path,
) -> Result<ExternalContentImportResult, String> {
    let (source_path, entries): (PathBuf, Vec<(&str, &str)>) = match source {
        "codex" => (
            home.join(".codex"),
            vec![
                ("config.toml", "config.toml"),
                ("auth.json", "auth.json"),
                ("AGENTS.md", "AGENTS.md"),
                ("models_cache.json", "models_cache.json"),
                ("plugins", "plugins"),
                ("skills", "skills"),
                ("cache", "cache"),
                ("vendor_imports", "vendor_imports"),
            ],
        ),
        "claude-code" => (
            home.join(".claude"),
            vec![("CLAUDE.md", "AGENTS.md"), ("skills", "skills")],
        ),
        _ => return Err(format!("Unsupported import source: {source}")),
    };
    if !source_path.is_dir() {
        return Err(format!(
            "Import source does not exist: {}",
            source_path.display()
        ));
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    let mut imported_entries = Vec::new();
    for (source_entry, destination_entry) in entries {
        let entry_path = source_path.join(source_entry);
        if !entry_path.exists() {
            continue;
        }
        copy_codex_initialization_entry(&entry_path, &destination.join(destination_entry))?;
        imported_entries.push(source_entry.to_string());
    }
    if imported_entries.is_empty() {
        return Err(format!(
            "No supported content was found in {}",
            source_path.display()
        ));
    }
    Ok(ExternalContentImportResult {
        source: source.to_string(),
        source_path: source_path.display().to_string(),
        destination_path: destination.display().to_string(),
        imported_entries,
    })
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn local_executor_sidecar_env(
    inner: &LocalExecutorInner,
    app: &tauri::AppHandle,
) -> Vec<(String, String)> {
    let mut envs = local_executor_backend_env(inner);
    if std::env::var_os(CODEX_BINARY_PATH_ENV).is_none()
        && std::env::var_os(CODEX_BIN_ENV).is_none()
    {
        if let Some((package_root, binary_path)) = bundled_codex_paths(app) {
            envs.push((
                CODEX_BINARY_PATH_ENV.to_string(),
                binary_path.display().to_string(),
            ));
            envs.push((
                CODEX_MANAGED_PACKAGE_ROOT_ENV.to_string(),
                package_root.display().to_string(),
            ));
        }
    }
    envs
}

fn append_bundled_codex_envs_for_root(envs: &mut Vec<(String, String)>, root: &Path) {
    if std::env::var_os(CODEX_BINARY_PATH_ENV).is_some()
        || std::env::var_os(CODEX_BIN_ENV).is_some()
    {
        return;
    }
    let Some((target, binary)) = bundled_codex_target_layout() else {
        return;
    };
    let package_root = root.join("binaries").join("codex").join(target);
    let binary_path = package_root.join(binary);
    if binary_path.is_file() {
        envs.push((
            CODEX_BINARY_PATH_ENV.to_string(),
            binary_path.display().to_string(),
        ));
        envs.push((
            CODEX_MANAGED_PACKAGE_ROOT_ENV.to_string(),
            package_root.display().to_string(),
        ));
    }
}

fn bundled_codex_paths(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resource_dir = app.path().resource_dir().ok()?;
    let mut envs = Vec::new();
    append_bundled_codex_envs_for_root(&mut envs, &resource_dir);
    let package_root = envs
        .iter()
        .find(|(key, _)| key == CODEX_MANAGED_PACKAGE_ROOT_ENV)
        .map(|(_, value)| PathBuf::from(value))?;
    let binary_path = envs
        .iter()
        .find(|(key, _)| key == CODEX_BINARY_PATH_ENV)
        .map(|(_, value)| PathBuf::from(value))?;
    Some((package_root, binary_path))
}

fn bundled_codex_target_layout() -> Option<(&'static str, &'static str)> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some((
            "aarch64-apple-darwin",
            "vendor/aarch64-apple-darwin/bin/codex",
        ));
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some((
            "x86_64-apple-darwin",
            "vendor/x86_64-apple-darwin/bin/codex",
        ));
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some((
            "x86_64-unknown-linux-gnu",
            "vendor/x86_64-unknown-linux-musl/bin/codex",
        ));
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some((
            "aarch64-unknown-linux-gnu",
            "vendor/aarch64-unknown-linux-musl/bin/codex",
        ));
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some((
            "x86_64-pc-windows-msvc",
            "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ));
    }
    #[allow(unreachable_code)]
    None
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

fn fail_unresponsive_request_inner(inner: &SharedExecutorInner, request_id: &str, message: String) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            let mut pending = Vec::new();
            if let Some(sender) = inner.pending.remove(request_id) {
                pending.push(sender);
            }
            let failed_pending_count = inner.pending.len();
            pending.extend(inner.pending.drain().map(|(_, sender)| sender));
            inner.ready = false;
            inner.running = false;
            inner.generation = inner.generation.saturating_add(1);
            clear_connected_stream(&mut inner);
            inner.error = Some(message.clone());
            log::warn!(
                "Local executor IPC marked unresponsive: request_id={request_id}, failed_pending_count={failed_pending_count}, message={message}"
            );
            pending
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
    let runtime_instance_id = event
        .payload
        .get("runtime_instance_id")
        .or_else(|| event.payload.get("runtimeInstanceId"))
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Ok(mut inner) = inner.lock() {
        inner.running = true;
        inner.ready = ready;
        if device_id.is_some() {
            inner.device_id = device_id;
        }
        if runtime_instance_id.is_some() {
            inner.runtime_instance_id = runtime_instance_id;
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
            if event.event == "runtime.plan.updated" {
                log::info!(
                    "Forwarding runtime task plan event to frontend: task_id={:?}, device_id={:?}",
                    event.payload.get("taskId"),
                    event.payload.get("deviceId")
                );
            }
            app.emit(LOCAL_EXECUTOR_EVENT, event)
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn connect_sidecar_socket() -> Result<TcpStream, String> {
    let addr = resolve_app_ipc_addr()?;
    if addr.port() != 0 {
        return TcpStream::connect(addr)
            .map_err(|error| format!("Failed to connect local executor TCP socket {addr}: {error}"));
    }

    let addr = wait_for_app_ipc_addr(Duration::from_secs(LOCAL_EXECUTOR_READY_TIMEOUT_SECS))?;
    TcpStream::connect(addr)
        .map_err(|error| format!("Failed to connect local executor TCP socket {addr}: {error}"))
}

fn prepare_connected_stream(stream: TcpStream) -> Result<PreparedExecutorStream, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(LOCAL_EXECUTOR_READY_TIMEOUT_SECS)))
        .map_err(|error| format!("Failed to configure local executor TCP socket timeout: {error}"))?;
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
        .map_err(|error| format!("Failed to clear local executor TCP socket timeout: {error}"))?;
    let writer = reader
        .get_ref()
        .try_clone()
        .map_err(|error| format!("Failed to clone local executor TCP socket: {error}"))?;

    Ok(PreparedExecutorStream {
        reader,
        writer,
        ready_line,
    })
}

fn connect_and_prepare_sidecar_socket() -> Result<PreparedExecutorStream, String> {
    prepare_connected_stream(connect_sidecar_socket()?)
}

async fn connect_and_prepare_sidecar_socket_with_timeout() -> Result<PreparedExecutorStream, String>
{
    let (sender, receiver) = mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = sender.send(connect_and_prepare_sidecar_socket());
    });

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(LOCAL_EXECUTOR_READY_TIMEOUT_SECS + 1))
            .unwrap_or_else(|_| Err("Timed out waiting for local executor ready event".to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn attach_prepared_stream(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    prepared: PreparedExecutorStream,
) -> Result<(), String> {
    let mut reader = prepared.reader;
    let generation = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.generation = inner.generation.saturating_add(1);
        inner.stream = Some(prepared.writer);
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
    handle_executor_line_inner(&app, &state.inner, &prepared.ready_line)?;
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
                        log::warn!("Failed to handle local executor TCP socket line: {error}");
                    }
                }
                Err(error) => {
                    log::warn!("Local executor TCP socket read failed: {error}");
                    break;
                }
            }
        }

        let message = "Local executor TCP socket disconnected".to_string();
        set_executor_error_for_generation(&state_handle, generation, message.clone());
        fail_pending_requests_for_generation(&state_handle, generation, message);
    });

    Ok(())
}

async fn connect_and_attach_sidecar_socket(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let prepared = connect_and_prepare_sidecar_socket_with_timeout().await?;
    attach_prepared_stream(app, state, prepared)
}

fn write_request_line(inner: &mut LocalExecutorInner, line: &str) -> Result<(), String> {
    let Some(stream) = inner.stream.as_mut() else {
        return Err("Local executor TCP socket is not connected".to_string());
    };

    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|error| format!("Failed to write local executor request: {error}"))
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
        local_executor_sidecar_env(&inner, &app)
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

fn ensure_sidecar_child_still_running(state: &LocalExecutorState) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    let Some(child) = inner.child.as_mut() else {
        return Ok(());
    };
    if child.is_running() {
        return Ok(());
    }

    inner.child = None;
    inner.running = false;
    inner.ready = false;
    clear_connected_stream(&mut inner);
    let message = "Local executor sidecar exited before opening its socket".to_string();
    inner.error = Some(message.clone());
    Err(message)
}

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

    if let Err(error) = cleanup_stale_local_executor_once(state) {
        set_executor_error(state, error.clone());
        return Err(error);
    }

    if connect_and_attach_sidecar_socket(app.clone(), state)
        .await
        .is_ok()
    {
        return Ok(());
    }

    spawn_sidecar_if_needed(app.clone(), state).await?;

    loop {
        let error = match connect_and_attach_sidecar_socket(app.clone(), state).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };

        if let Err(sidecar_error) = ensure_sidecar_child_still_running(state) {
            let message = format!("{sidecar_error}: {error}");
            set_executor_error(state, message.clone());
            fail_pending_requests(state, message.clone());
            return Err(message);
        }
        retry_connect_delay().await;
    }
}

async fn start_executor_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let _guard = state.start_lock.lock().await;
    start_executor_if_needed_unlocked(app.clone(), state).await?;
    ensure_local_executor_keepalive(app, state);
    Ok(())
}

fn local_executor_is_healthy(state: &LocalExecutorState) -> bool {
    state
        .inner
        .lock()
        .map(|inner| inner.running && inner.ready && has_connected_stream(&inner))
        .unwrap_or(false)
}

fn development_sidecar_is_restarting(state: &LocalExecutorState) -> bool {
    if !cfg!(debug_assertions)
        || configured_sidecar_path().is_none()
        || matches!(std::env::var("WEGENT_EXECUTOR_DEV_RELOAD"), Ok(value) if value == "0")
    {
        return false;
    }

    state
        .inner
        .lock()
        .ok()
        .and_then(|mut inner| inner.child.as_mut().map(LocalExecutorChild::is_running))
        .unwrap_or(false)
}

fn ensure_local_executor_keepalive(app: tauri::AppHandle, state: &LocalExecutorState) {
    state.keepalive.enabled.store(true, Ordering::SeqCst);
    if state.keepalive.worker_running.swap(true, Ordering::SeqCst) {
        return;
    }

    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = tauri::async_runtime::spawn_blocking(|| {
                thread::sleep(Duration::from_secs(LOCAL_EXECUTOR_KEEPALIVE_INTERVAL_SECS));
            })
            .await;

            if !state.keepalive.enabled.load(Ordering::SeqCst) {
                state
                    .keepalive
                    .worker_running
                    .store(false, Ordering::SeqCst);
                return;
            }

            if local_executor_is_healthy(&state) {
                continue;
            }

            if development_sidecar_is_restarting(&state) {
                log::info!(
                    "Local executor IPC is unavailable while the development sidecar is restarting"
                );
                continue;
            }

            log::warn!("Local executor keepalive detected an unhealthy executor; restarting");
            if let Err(error) = restart_executor(app.clone(), &state).await {
                log::warn!("Local executor keepalive restart failed: {error}");
            }
        }
    });
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
    restart_executor_unlocked(app.clone(), state).await?;
    ensure_local_executor_keepalive(app, state);
    Ok(())
}

async fn send_executor_request(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
) -> Result<Value, String> {
    start_executor_if_needed(app, state).await?;

    let request_id = next_request_id(state);
    let method = request.method.clone();
    let started_at = Instant::now();
    let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
    let message = json!({
        "type": "request",
        "id": request_id,
        "method": method,
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
        let pending_count = inner.pending.len();
        log::info!(
            "Local executor IPC request started: request_id={request_id}, method={method}, pending_count={pending_count}"
        );
        if let Err(error) = write_request_line(&mut inner, &line) {
            inner.pending.remove(&request_id);
            log::warn!(
                "Local executor IPC request write failed: request_id={request_id}, method={method}, error={error}"
            );
            return Err(error);
        }
    }

    let inner = state.inner.clone();
    let wait_request_id = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match receiver.recv_timeout(Duration::from_secs(LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS)) {
            Ok(result) => {
                log::info!(
                    "Local executor IPC request finished: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                result
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!(
                    "Local executor IPC request disconnected: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                Err("Local executor disconnected".to_string())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let message = format!(
                    "Local executor request {method} timed out after {LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS}s"
                );
                log::warn!(
                    "Local executor IPC request timed out: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                fail_unresponsive_request_inner(&inner, &wait_request_id, message.clone());
                Err(message)
            }
        }
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
pub async fn local_executor_codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String>
{
    codex_home_migration_status()
}

#[tauri::command]
pub async fn local_executor_read_codex_local_config() -> Result<CodexLocalConfig, String> {
    read_codex_local_config()
}

#[tauri::command]
pub async fn local_executor_update_codex_local_config(
    patch: CodexLocalConfigPatch,
) -> Result<CodexLocalConfig, String> {
    if let Some(enabled) = patch.remote_apps_enabled {
        return write_codex_remote_apps_enabled(enabled);
    }
    read_codex_local_config()
}

#[tauri::command]
pub async fn local_executor_initialize_codex_home(
    options: CodexHomeInitializeOptions,
) -> Result<CodexHomeMigrationStatus, String> {
    let status = codex_home_migration_status()?;
    log::info!(
        "Codex home initialization started: migrate_native_home={}, remote_apps_enabled={}, should_prompt_migration={}, native={}, wework={}",
        options.migrate_native_home,
        options.remote_apps_enabled,
        status.should_prompt_migration,
        status.native_codex_home,
        status.wework_codex_home
    );
    if options.migrate_native_home && status.should_prompt_migration {
        let source = PathBuf::from(&status.native_codex_home);
        let destination = PathBuf::from(&status.wework_codex_home);
        copy_codex_initialization_files(&source, &destination)?;
    } else {
        let destination = PathBuf::from(&status.wework_codex_home);
        fs::create_dir_all(&destination)
            .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    }
    write_codex_remote_apps_enabled(options.remote_apps_enabled)?;
    let next_status = codex_home_migration_status()?;
    log::info!(
        "Codex home initialization finished: should_prompt_migration={}, wework={}",
        next_status.should_prompt_migration,
        next_status.wework_codex_home
    );
    Ok(next_status)
}

#[tauri::command]
pub async fn local_executor_migrate_native_codex_home() -> Result<CodexHomeMigrationStatus, String>
{
    local_executor_initialize_codex_home(CodexHomeInitializeOptions {
        migrate_native_home: true,
        remote_apps_enabled: false,
    })
    .await
}

#[tauri::command]
pub async fn local_executor_import_external_content(
    options: ExternalContentImportOptions,
) -> Result<ExternalContentImportResult, String> {
    import_external_content(&options.source)
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
    restart_executor_unlocked(app.clone(), &state).await?;
    ensure_local_executor_keepalive(app, &state);
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
    restart_executor_unlocked(app.clone(), &state).await?;
    ensure_local_executor_keepalive(app, &state);
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

    fn import_test_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "wework-import-{label}-{}-{nanos}",
            std::process::id()
        ))
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
    fn codex_local_config_remote_apps_defaults_to_disabled() {
        assert!(!read_remote_apps_enabled_from_config(""));
        assert!(!read_remote_apps_enabled_from_config("[features]\n"));
        assert!(!read_remote_apps_enabled_from_config(
            "[features]\napps = false\n"
        ));
        assert!(!read_remote_apps_enabled_from_config(
            "[other]\napps = true\n"
        ));
    }

    #[test]
    fn imports_codex_initialization_content_again() {
        let root = import_test_root("codex");
        let home = root.join("home");
        let destination = root.join("destination");
        fs::create_dir_all(home.join(".codex/skills/example")).unwrap();
        fs::write(home.join(".codex/config.toml"), "model = \"gpt-5\"").unwrap();
        fs::write(home.join(".codex/skills/example/SKILL.md"), "example").unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("config.toml"), "old").unwrap();

        let result = import_external_content_from_paths("codex", &home, &destination).unwrap();

        assert_eq!(fs::read_to_string(destination.join("config.toml")).unwrap(), "model = \"gpt-5\"");
        assert!(destination.join("skills/example/SKILL.md").is_file());
        assert_eq!(result.imported_entries, vec!["config.toml", "skills"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maps_claude_instructions_and_skills_to_codex_content() {
        let root = import_test_root("claude");
        let home = root.join("home");
        let destination = root.join("destination");
        fs::create_dir_all(home.join(".claude/skills/example")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "Claude instructions").unwrap();
        fs::write(home.join(".claude/skills/example/SKILL.md"), "example").unwrap();

        let result =
            import_external_content_from_paths("claude-code", &home, &destination).unwrap();

        assert_eq!(fs::read_to_string(destination.join("AGENTS.md")).unwrap(), "Claude instructions");
        assert!(destination.join("skills/example/SKILL.md").is_file());
        assert_eq!(result.imported_entries, vec!["CLAUDE.md", "skills"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_local_config_remote_apps_reads_features_section() {
        let content = r#"
model = "gpt-5.5"

[features]
apps = true # enables remote apps

[projects."/tmp/example"]
trust_level = "trusted"
"#;

        assert!(read_remote_apps_enabled_from_config(content));
    }

    #[test]
    fn codex_local_config_remote_apps_updates_existing_value() {
        let content = r#"
model = "gpt-5.5"

[features]
  apps = true
shell_environment_policy = "inherit"
"#;

        let next = set_remote_apps_enabled_in_config(content, false);

        assert!(next.contains("[features]\n  apps = false\nshell_environment_policy"));
        assert!(next.contains("model = \"gpt-5.5\""));
    }

    #[test]
    fn codex_local_config_remote_apps_inserts_features_section() {
        let next = set_remote_apps_enabled_in_config("model = \"gpt-5.5\"\n", false);

        assert_eq!(next, "model = \"gpt-5.5\"\n\n[features]\napps = false\n");
    }

    #[test]
    fn codex_local_config_remote_apps_adds_to_existing_features_section() {
        let content = r#"
[features]
shell_environment_policy = "inherit"

[mcp_servers.example]
command = "example"
"#;

        let next = set_remote_apps_enabled_in_config(content, true);

        assert!(next.contains("[features]\napps = true\nshell_environment_policy"));
        assert!(next.contains("[mcp_servers.example]\ncommand = \"example\""));
    }

    #[test]
    fn bundled_sidecar_path_uses_bundled_executable_name() {
        let _guard = env_lock();
        let previous_sidecar = std::env::var_os(LOCAL_EXECUTOR_SIDECAR_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_SIDECAR_ENV);

        let (source, path) = sidecar_source_and_path();
        restore_env(LOCAL_EXECUTOR_SIDECAR_ENV, previous_sidecar);

        assert_eq!(source, "bundled");
        assert_eq!(path, "wegent-executor");
    }

    #[test]
    fn app_ipc_addr_file_path_uses_executor_home() {
        let _guard = env_lock();
        let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wegent-home");
        let path = app_ipc_addr_file_path().expect("addr file path should resolve");
        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);

        assert_eq!(
            path,
            PathBuf::from("/tmp/wegent-home/app-ipc.addr")
        );
    }

    #[cfg(unix)]
    #[test]
    fn app_ipc_addr_file_path_falls_back_to_home_dir() {
        let _guard = env_lock();
        let previous_home = std::env::var_os("HOME");
        let previous_executor_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        std::env::set_var("HOME", "/tmp/wework-test-home");
        std::env::remove_var(LOCAL_EXECUTOR_HOME_ENV);
        let path = app_ipc_addr_file_path().expect("addr file path should resolve");
        restore_env("HOME", previous_home);
        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_executor_home);

        assert_eq!(
            path,
            PathBuf::from("/tmp/wework-test-home/.wegent-executor/app-ipc.addr")
        );
    }

    #[test]
    fn local_executor_log_path_follows_build_mode() {
        let _guard = env_lock();
        let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
        std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wegent-executor-debug");
        std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);

        let path = local_executor_log_path().expect("log path should resolve");
        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
        restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

        if cfg!(debug_assertions) {
            assert!(path.starts_with("/tmp/wegent-executor-debug/app-runtime"));
        } else {
            assert_eq!(
                path,
                PathBuf::from("/tmp/wegent-executor-debug/logs/executor.log")
            );
        }
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("executor.log")
        );
    }

    #[cfg(unix)]
    #[test]
    fn default_runtime_paths_follow_build_mode() {
        let _guard = env_lock();
        let previous_home = std::env::var_os("HOME");
        let previous_executor_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
        std::env::set_var("HOME", "/tmp/wework-test-home");
        std::env::remove_var(LOCAL_EXECUTOR_HOME_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);

        let home = local_executor_home_path().expect("executor home should resolve");
        let addr_file = app_ipc_addr_file_path().expect("addr file path should resolve");
        let log = local_executor_log_path().expect("log path should resolve");

        restore_env("HOME", previous_home);
        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_executor_home);
        restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

        assert_eq!(
            home,
            PathBuf::from("/tmp/wework-test-home/.wegent-executor")
        );
        assert_eq!(addr_file, home.join(LOCAL_EXECUTOR_ADDR_FILE_NAME));
        if cfg!(debug_assertions) {
            assert_eq!(
                log,
                home.join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
                    .join(local_executor_instance_name())
                    .join("logs")
                    .join(LOCAL_EXECUTOR_LOG_FILE_NAME)
            );
        } else {
            assert_eq!(log, home.join("logs").join(LOCAL_EXECUTOR_LOG_FILE_NAME));
        }
        assert_eq!(
            addr_file.file_name().and_then(|name| name.to_str()),
            Some(LOCAL_EXECUTOR_ADDR_FILE_NAME)
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
    fn executor_process_pids_excludes_current_process() {
        let current_process_id = std::process::id();
        let processes = vec![
            LocalExecutorProcessInfo {
                pid: current_process_id,
                path: "/tmp/wegent-executor".to_string(),
            },
            LocalExecutorProcessInfo {
                pid: current_process_id + 1,
                path: "/tmp/wegent-executor".to_string(),
            },
        ];

        assert_eq!(
            executor_process_pids(&processes),
            vec![current_process_id + 1]
        );
    }

    #[test]
    fn process_text_uses_addr_file_matches_only_exact_addr_file_env() {
        let release_addr_file = PathBuf::from("/Users/me/.wegent-executor/app-ipc.addr");
        let debug_text = "WEGENT_EXECUTOR_APP_IPC_ADDR=/Users/me/.wegent-executor/app-runtime/wework-123/app-ipc.addr";
        let release_text = "WEGENT_EXECUTOR_APP_IPC_ADDR=/Users/me/.wegent-executor/app-ipc.addr";

        assert!(!process_text_uses_addr_file(debug_text, &release_addr_file));
        assert!(process_text_uses_addr_file(release_text, &release_addr_file));
    }

    #[test]
    fn remove_stale_app_ipc_addr_file_removes_addr_files_only() {
        let dir = std::env::temp_dir().join(format!(
            "wework-stale-executor-addr-file-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("test addr file dir should be created");
        let addr_file_path = dir.join("app-ipc.addr");
        let regular_path = dir.join("regular-file");
        fs::write(&addr_file_path, "127.0.0.1:12345").expect("addr file should be written");
        fs::write(&regular_path, "not an addr file").expect("regular file should be written");

        remove_stale_app_ipc_addr_file_at(&addr_file_path)
            .expect("addr file cleanup should succeed");
        remove_stale_app_ipc_addr_file_at(&regular_path)
            .expect("regular cleanup should succeed");

        assert!(!addr_file_path.exists());
        assert!(regular_path.exists());

        let _ = fs::remove_dir_all(&dir);
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
        let _guard = env_lock();
        let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_codex_home = std::env::var_os(WEGENT_CODEX_HOME_ENV);
        let previous_addr = std::env::var_os(LOCAL_EXECUTOR_ADDR_ENV);
        let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
        std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wework-instance-executor");
        std::env::remove_var(WEGENT_CODEX_HOME_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_ADDR_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);
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

        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
        restore_env(WEGENT_CODEX_HOME_ENV, previous_codex_home);
        restore_env(LOCAL_EXECUTOR_ADDR_ENV, previous_addr);
        restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

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
        assert_eq!(
            envs.get(LOCAL_EXECUTOR_HOME_ENV).map(String::as_str),
            Some("/tmp/wework-instance-executor")
        );
        assert_eq!(
            envs.get(CODEX_HOME_ENV).map(String::as_str),
            Some("/tmp/wework-instance-executor/codex")
        );
        let addr_env = envs
            .get(LOCAL_EXECUTOR_ADDR_ENV)
            .expect("addr env should be passed to sidecar");
        let log_dir_env = envs
            .get(LOCAL_EXECUTOR_LOG_DIR_ENV)
            .expect("log dir env should be passed to sidecar");
        assert_eq!(addr_env, LOCAL_EXECUTOR_DEFAULT_ADDR);
        if cfg!(debug_assertions) {
            assert!(log_dir_env.starts_with("/tmp/wework-instance-executor/app-runtime/wework-"));
        } else {
            assert_eq!(log_dir_env, "/tmp/wework-instance-executor/logs");
        }
    }

    #[test]
    fn backend_env_includes_normalized_developer_path() {
        let _guard = env_lock();
        let previous_path = std::env::var_os("PATH");
        let previous_extra = std::env::var_os("WEGENT_EXTRA_PATHS");
        std::env::set_var("PATH", "/usr/bin:/bin");
        std::env::set_var("WEGENT_EXTRA_PATHS", "/custom/bin:/opt/homebrew/bin");

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("PATH", previous_path);
        restore_env("WEGENT_EXTRA_PATHS", previous_extra);

        let path = envs.get("PATH").expect("PATH should be present");
        assert!(path.starts_with("/usr/bin:/bin:/custom/bin:/opt/homebrew/bin"));
        assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
        assert!(path.contains("/opt/homebrew/sbin"));
        assert!(path.contains("/usr/local/bin"));
    }

    #[test]
    fn backend_env_includes_file_edit_hook_command() {
        let _guard = env_lock();
        let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
        std::env::remove_var("WEGENT_FILE_EDIT_HOOK_COMMAND");

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);

        assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND").map(String::as_str),
            Some(
                "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log -H \"Content-Type: application/json\" -d @-"
            )
        );
    }

    #[test]
    fn backend_env_preserves_custom_file_edit_hook_command() {
        let _guard = env_lock();
        let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
        std::env::set_var(
            "WEGENT_FILE_EDIT_HOOK_COMMAND",
            "custom-file-edit-hook --stdin",
        );

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);

        assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND")
                .map(String::as_str),
            Some("custom-file-edit-hook --stdin")
        );
    }

    #[test]
    fn backend_env_builds_file_edit_hook_command_from_configured_endpoint() {
        let _guard = env_lock();
        let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
        let previous_endpoint = std::env::var_os("WEWORK_FILE_EDIT_LOG_ENDPOINT");
        std::env::remove_var("WEGENT_FILE_EDIT_HOOK_COMMAND");
        std::env::set_var(
            "WEWORK_FILE_EDIT_LOG_ENDPOINT",
            "http://127.0.0.1:4567/custom-file-edit-log",
        );

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);
        restore_env("WEWORK_FILE_EDIT_LOG_ENDPOINT", previous_endpoint);

        assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND")
                .map(String::as_str),
            Some(
                "curl -s -X POST http://127.0.0.1:4567/custom-file-edit-log -H \"Content-Type: application/json\" -d @-"
            )
        );
    }

    #[test]
    fn bundled_codex_env_is_added_when_binary_exists() {
        let _guard = env_lock();
        let Some((target, binary)) = bundled_codex_target_layout() else {
            return;
        };
        let previous_binary = std::env::var_os(CODEX_BINARY_PATH_ENV);
        let previous_bin = std::env::var_os(CODEX_BIN_ENV);
        std::env::remove_var(CODEX_BINARY_PATH_ENV);
        std::env::remove_var(CODEX_BIN_ENV);
        let root =
            std::env::temp_dir().join(format!("wework-bundled-codex-env-{}", std::process::id()));
        let binary_path = root
            .join("binaries")
            .join("codex")
            .join(target)
            .join(binary);
        fs::create_dir_all(
            binary_path
                .parent()
                .expect("binary path should have parent"),
        )
        .expect("test binary dir should be created");
        fs::write(&binary_path, b"codex").expect("test binary should be written");

        let mut envs = Vec::new();
        append_bundled_codex_envs_for_root(&mut envs, &root);

        restore_env(CODEX_BINARY_PATH_ENV, previous_binary);
        restore_env(CODEX_BIN_ENV, previous_bin);
        let _ = fs::remove_dir_all(&root);

        let expected_binary = binary_path.display().to_string();
        let expected_package_root = root
            .join("binaries")
            .join("codex")
            .join(target)
            .display()
            .to_string();
        assert_eq!(
            envs.iter()
                .find(|(key, _)| key == CODEX_BINARY_PATH_ENV)
                .map(|(_, value)| value.as_str()),
            Some(expected_binary.as_str())
        );
        assert_eq!(
            envs.iter()
                .find(|(key, _)| key == CODEX_MANAGED_PACKAGE_ROOT_ENV)
                .map(|(_, value)| value.as_str()),
            Some(expected_package_root.as_str())
        );
    }

    #[test]
    fn bundled_codex_env_does_not_override_explicit_binary() {
        let _guard = env_lock();
        let Some((target, binary)) = bundled_codex_target_layout() else {
            return;
        };
        let previous_binary = std::env::var_os(CODEX_BINARY_PATH_ENV);
        let previous_bin = std::env::var_os(CODEX_BIN_ENV);
        std::env::set_var(CODEX_BINARY_PATH_ENV, "/custom/codex");
        std::env::remove_var(CODEX_BIN_ENV);
        let root = std::env::temp_dir().join(format!(
            "wework-bundled-codex-override-{}",
            std::process::id()
        ));
        let binary_path = root
            .join("binaries")
            .join("codex")
            .join(target)
            .join(binary);
        fs::create_dir_all(
            binary_path
                .parent()
                .expect("binary path should have parent"),
        )
        .expect("test binary dir should be created");
        fs::write(&binary_path, b"codex").expect("test binary should be written");

        let mut envs = Vec::new();
        append_bundled_codex_envs_for_root(&mut envs, &root);

        restore_env(CODEX_BINARY_PATH_ENV, previous_binary);
        restore_env(CODEX_BIN_ENV, previous_bin);
        let _ = fs::remove_dir_all(&root);

        assert!(envs.is_empty());
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
