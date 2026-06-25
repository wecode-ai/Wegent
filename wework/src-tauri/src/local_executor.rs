use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::{channel, Sender};
use tauri::{Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const LOCAL_EXECUTOR_EVENT: &str = "local-executor:event";
const LOCAL_EXECUTOR_SIDECAR: &str = "binaries/wegent-executor";
const LOCAL_EXECUTOR_DEVICE_ID: &str = "local-device";

type PendingSender = Sender<Result<Value, String>>;
type SharedExecutorInner = Arc<Mutex<LocalExecutorInner>>;

pub struct LocalExecutorState {
    inner: SharedExecutorInner,
    next_id: AtomicU64,
}

#[derive(Default)]
struct LocalExecutorInner {
    child: Option<CommandChild>,
    pending: HashMap<String, PendingSender>,
    running: bool,
    ready: bool,
    device_id: Option<String>,
    error: Option<String>,
}

impl Default for LocalExecutorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LocalExecutorInner::default())),
            next_id: AtomicU64::new(1),
        }
    }
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
    error: Option<String>,
}

pub fn parse_executor_line(line: &str) -> Result<ExecutorLine, String> {
    serde_json::from_str::<ExecutorLine>(line).map_err(|error| error.to_string())
}

fn next_request_id(state: &LocalExecutorState) -> String {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    format!("local-req-{id}")
}

fn status_from_inner(inner: &LocalExecutorInner) -> LocalExecutorStatus {
    LocalExecutorStatus {
        running: inner.running,
        ready: inner.ready,
        device_id: inner.device_id.clone(),
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

async fn resolve_response_inner(inner: &SharedExecutorInner, response: ExecutorResponse) {
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
        let _ = sender.send(result).await;
    }
}

async fn fail_pending_requests(state: &LocalExecutorState, message: String) {
    fail_pending_requests_inner(&state.inner, message).await;
}

async fn fail_pending_requests_inner(inner: &SharedExecutorInner, message: String) {
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
        let _ = sender.send(Err(message.clone())).await;
    }
}

fn set_executor_error(state: &LocalExecutorState, error: String) {
    set_executor_error_inner(&state.inner, error);
}

fn set_executor_error_inner(inner: &SharedExecutorInner, error: String) {
    if let Ok(mut inner) = inner.lock() {
        inner.running = false;
        inner.ready = false;
        inner.child = None;
        inner.error = Some(error);
    }
}

async fn handle_executor_line_inner(
    app: &tauri::AppHandle,
    inner: &SharedExecutorInner,
    line: &str,
) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }

    match parse_executor_line(line)? {
        ExecutorLine::Response(response) => {
            resolve_response_inner(inner, response).await;
        }
        ExecutorLine::Event(event) => {
            app.emit(LOCAL_EXECUTOR_EVENT, event)
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn drain_complete_lines(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);
    let mut lines = Vec::new();

    while let Some(index) = buffer.find('\n') {
        let mut line = buffer.drain(..=index).collect::<String>();
        if line.ends_with('\n') {
            line.pop();
        }
        if line.ends_with('\r') {
            line.pop();
        }
        lines.push(line);
    }

    lines
}

async fn start_executor_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        if inner.running && inner.child.is_some() {
            return Ok(());
        }
    }

    let sidecar = app
        .shell()
        .sidecar(LOCAL_EXECUTOR_SIDECAR)
        .map_err(|error| error.to_string())?
        .args(["--app-ipc", "--no-backend"]);
    let (mut rx, child) = sidecar.spawn().map_err(|error| error.to_string())?;

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.child = Some(child);
        inner.running = true;
        inner.ready = true;
        inner.device_id = Some(LOCAL_EXECUTOR_DEVICE_ID.to_string());
        inner.error = None;
    }

    let app_handle = app.clone();
    let state_handle = state.inner.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout_buffer = String::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in drain_complete_lines(&mut stdout_buffer, &text) {
                        if let Err(error) =
                            handle_executor_line_inner(&app_handle, &state_handle, &line).await
                        {
                            log::warn!("Failed to handle local executor line: {error}");
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    log::warn!("Local executor stderr: {}", text.trim());
                }
                CommandEvent::Terminated(payload) => {
                    if !stdout_buffer.trim().is_empty() {
                        if let Err(error) =
                            handle_executor_line_inner(&app_handle, &state_handle, &stdout_buffer)
                                .await
                        {
                            log::warn!("Failed to handle local executor line: {error}");
                        }
                    }
                    let message = format!("Local executor exited: {payload:?}");
                    set_executor_error_inner(&state_handle, message.clone());
                    fail_pending_requests_inner(&state_handle, message).await;
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

async fn restart_executor(app: tauri::AppHandle, state: &LocalExecutorState) -> Result<(), String> {
    let old_child = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?
        .child
        .take();

    if let Some(child) = old_child {
        let _ = child.kill();
    }

    set_executor_error(state, "Local executor restarting".to_string());
    fail_pending_requests(state, "Local executor restarting".to_string()).await;
    start_executor_if_needed(app, state).await
}

async fn send_executor_request(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
) -> Result<Value, String> {
    start_executor_if_needed(app, state).await?;

    let request_id = next_request_id(state);
    let (sender, mut receiver) = channel::<Result<Value, String>>(1);
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
        let Some(child) = inner.child.as_mut() else {
            inner.pending.remove(&request_id);
            return Err("Local executor is not running".to_string());
        };
        if let Err(error) = child.write(line.as_bytes()) {
            inner.pending.remove(&request_id);
            return Err(format!("Failed to write local executor request: {error}"));
        }
    }

    receiver
        .recv()
        .await
        .unwrap_or_else(|| Err("Local executor disconnected".to_string()))
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
    fn drains_complete_stdout_lines() {
        let mut buffer = String::new();

        assert!(drain_complete_lines(&mut buffer, r#"{"type":"event""#).is_empty());
        let lines = drain_complete_lines(&mut buffer, r#","event":"ready","payload":{}}"#);
        assert!(lines.is_empty());
        let lines = drain_complete_lines(
            &mut buffer,
            "\n{\"type\":\"response\",\"id\":\"req-1\",\"ok\":true}\npartial",
        );

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], r#"{"type":"event","event":"ready","payload":{}}"#);
        assert_eq!(lines[1], r#"{"type":"response","id":"req-1","ok":true}"#);
        assert_eq!(buffer, "partial");
    }
}
