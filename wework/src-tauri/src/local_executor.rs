use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
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
const LOCAL_EXECUTOR_DEVICE_ID: &str = "local-device";
const LOCAL_EXECUTOR_SOCKET_NAME: &str = "app-ipc.sock";
const LOCAL_EXECUTOR_CONNECT_RETRIES: usize = 120;
const LOCAL_EXECUTOR_CONNECT_RETRY_MS: u64 = 250;

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
    running: bool,
    ready: bool,
    device_id: Option<String>,
    version: Option<String>,
    error: Option<String>,
    generation: u64,
    #[cfg(unix)]
    stream: Option<UnixStream>,
}

enum LocalExecutorChild {
    Tauri(CommandChild),
    Process(Child),
}

impl LocalExecutorChild {
    fn is_running(&mut self) -> bool {
        match self {
            LocalExecutorChild::Tauri(_) => true,
            LocalExecutorChild::Process(child) => match child.try_wait() {
                Ok(Some(_)) => false,
                Ok(None) => true,
                Err(_) => false,
            },
        }
    }

    fn kill(self) {
        match self {
            LocalExecutorChild::Tauri(child) => {
                let _ = child.kill();
            }
            LocalExecutorChild::Process(mut child) => {
                let _ = child.kill();
            }
        }
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

    if let Ok(path) = std::env::var("WEGENT_EXECUTOR_HOME") {
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

fn drain_process_output(prefix: &'static str, output: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(output);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                log::info!("{prefix}: {trimmed}");
            }
        }
    });
}

fn spawn_configured_sidecar(path: PathBuf) -> Result<LocalExecutorChild, String> {
    if !path.exists() {
        return Err(format!(
            "Configured local executor sidecar does not exist: {}",
            path.display()
        ));
    }

    let mut child = Command::new(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to start local executor sidecar {}: {error}",
                path.display()
            )
        })?;

    if let Some(stdout) = child.stdout.take() {
        drain_process_output("Local executor stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_process_output("Local executor stderr", stderr);
    }

    Ok(LocalExecutorChild::Process(child))
}

async fn spawn_sidecar_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    {
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
    }

    if let Some(path) = configured_sidecar_path() {
        let child = spawn_configured_sidecar(path)?;
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
        })?;
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
                        log::info!("Local executor stdout: {}", text.trim());
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        log::warn!("Local executor stderr: {}", text.trim());
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
    use std::sync::{Mutex as TestMutex, MutexGuard, OnceLock};

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
}
