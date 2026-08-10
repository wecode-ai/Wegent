use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use super::bridge_security::{bridge_request_authorized, generate_bridge_token};
use super::{
    browser_label, current_unix_millis, handle_bridge_request, EmbeddedBrowserBridgeRequest,
    EmbeddedBrowserBridgeResponse, EmbeddedBrowserState, BRIDGE_READ_TIMEOUT_MS,
    EMBEDDED_BROWSER_BRIDGE_ADDR, EMBEDDED_BROWSER_BRIDGE_ADDR_ENV,
    EMBEDDED_BROWSER_BRIDGE_SEQUENCE, EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV,
};

const BRIDGE_MAX_CONCURRENT_REQUESTS: usize = 8;
const BRIDGE_RUNTIME_DIRECTORY: &str = "runtime";
pub(super) const BRIDGE_RUNTIME_FILE: &str = "embedded-browser-bridge.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRuntimeRecord<'a> {
    schema_version: u8,
    pid: u32,
    address: String,
    token: &'a str,
    started_at_unix_ms: u128,
}

struct BridgeWorkerLease {
    active: Arc<AtomicUsize>,
}

impl Drop for BridgeWorkerLease {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_worker(active: &Arc<AtomicUsize>) -> Option<BridgeWorkerLease> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < BRIDGE_MAX_CONCURRENT_REQUESTS).then_some(current + 1)
        })
        .ok()
        .map(|_| BridgeWorkerLease {
            active: active.clone(),
        })
}

fn bridge_runtime_path(executor_home: &Path) -> PathBuf {
    executor_home
        .join(BRIDGE_RUNTIME_DIRECTORY)
        .join(BRIDGE_RUNTIME_FILE)
}

fn write_bridge_runtime_record(
    executor_home: &Path,
    address: SocketAddr,
    token: &str,
) -> Result<PathBuf, String> {
    let path = bridge_runtime_path(executor_home);
    let directory = path
        .parent()
        .ok_or_else(|| "Embedded browser bridge runtime path has no parent".to_string())?;
    fs::create_dir_all(directory).map_err(|error| {
        format!("Failed to create embedded browser bridge runtime directory: {error}")
    })?;
    restrict_directory_permissions(directory)?;

    let record = BridgeRuntimeRecord {
        schema_version: 1,
        pid: std::process::id(),
        address: address.to_string(),
        token,
        started_at_unix_ms: current_unix_millis(),
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("Failed to encode embedded browser bridge runtime: {error}"))?;
    let temporary = directory.join(format!(".{BRIDGE_RUNTIME_FILE}.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Failed to create embedded browser bridge runtime: {error}"))?;
    restrict_file_permissions(&file)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to write embedded browser bridge runtime: {error}"))?;
    replace_runtime_file(&temporary, &path)?;
    Ok(path)
}

fn replace_runtime_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    match fs::rename(temporary, destination) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            fs::remove_file(destination).map_err(|remove_error| {
                format!("Failed to replace embedded browser bridge runtime: {remove_error}")
            })?;
            fs::rename(temporary, destination).map_err(|rename_error| {
                format!("Failed to install embedded browser bridge runtime: {rename_error}")
            })
        }
        Err(error) => Err(format!(
            "Failed to install embedded browser bridge runtime: {error}"
        )),
    }
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!("Failed to protect embedded browser bridge runtime directory: {error}")
    })
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file_permissions(file: &fs::File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect embedded browser bridge runtime: {error}"))
}

#[cfg(not(unix))]
fn restrict_file_permissions(_file: &fs::File) -> Result<(), String> {
    Ok(())
}

fn bridge_success(data: Value) -> EmbeddedBrowserBridgeResponse {
    EmbeddedBrowserBridgeResponse {
        ok: true,
        data: Some(data),
        error: None,
    }
}

fn bridge_error(error: String) -> EmbeddedBrowserBridgeResponse {
    EmbeddedBrowserBridgeResponse {
        ok: false,
        data: None,
        error: Some(error),
    }
}

pub(super) fn read_http_request(stream: &mut TcpStream) -> Result<(String, String), String> {
    stream
        .set_read_timeout(Some(Duration::from_millis(BRIDGE_READ_TIMEOUT_MS)))
        .map_err(|error| format!("Failed to set bridge read timeout: {error}"))?;
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("Failed to read bridge request: {error}"))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8(buffer)
        .map_err(|error| format!("Bridge request is not valid UTF-8: {error}"))?;
    let (headers, mut body) = request
        .split_once("\r\n\r\n")
        .map(|(headers, body)| (headers.to_string(), body.as_bytes().to_vec()))
        .ok_or_else(|| "Bridge request is missing HTTP header terminator".to_string())?;
    let content_length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while body.len() < content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("Failed to read bridge request body: {error}"))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8(body)
        .map(|body| (headers, body))
        .map_err(|error| format!("Bridge request body is not valid UTF-8: {error}"))
}

fn http_path(headers: &str) -> &str {
    headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
}

fn write_http_response(
    stream: &mut TcpStream,
    status: &str,
    response: &EmbeddedBrowserBridgeResponse,
) -> Result<(), String> {
    let body = serde_json::to_string(response)
        .map_err(|error| format!("Failed to encode bridge response: {error}"))?;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type, authorization\r\n\r\n{body}",
        body.len()
    )
    .map_err(|error| format!("Failed to write bridge response: {error}"))
}

fn handle_bridge_connection(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    mut stream: TcpStream,
    request_id: u64,
) -> Result<(), String> {
    let started = Instant::now();
    let (headers, body) = read_http_request(&mut stream)?;
    let path = http_path(&headers);
    log::info!(
        "Embedded browser bridge request id={request_id} stage=request_read path={path} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    if !bridge_request_authorized(&headers)? {
        write_http_response(
            &mut stream,
            "401 Unauthorized",
            &bridge_error("Unauthorized embedded browser bridge request".to_string()),
        )?;
        log::warn!(
            "Embedded browser bridge request id={request_id} stage=unauthorized path={path} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        return Ok(());
    }
    if path == "/status" {
        return handle_status_request(app, state, &mut stream, request_id, started);
    }
    if path != "/browser" {
        return write_http_response(
            &mut stream,
            "404 Not Found",
            &bridge_error("Unknown embedded browser bridge endpoint".to_string()),
        );
    }
    let request = serde_json::from_str::<EmbeddedBrowserBridgeRequest>(&body)
        .map_err(|error| format!("Invalid embedded browser bridge request: {error}"))?;
    dispatch_browser_request(app, state, &mut stream, request_id, started, request)
}

fn handle_status_request(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    stream: &mut TcpStream,
    request_id: u64,
    started: Instant,
) -> Result<(), String> {
    let result = handle_bridge_request(
        app,
        state,
        EmbeddedBrowserBridgeRequest {
            action: "status".to_string(),
            url: None,
            expression: None,
            selector: None,
            text: None,
            key: None,
            x: None,
            y: None,
            timeout_ms: None,
            label: None,
            browser_session_id: None,
            options: None,
            inspect_id: None,
            index: None,
            ref_: None,
        },
    );
    let response = result.map_or_else(bridge_error, bridge_success);
    write_http_response(stream, "200 OK", &response)?;
    log::info!(
        "Embedded browser bridge request id={request_id} stage=response_written action=status ok={} elapsed_ms={}",
        response.ok,
        started.elapsed().as_millis()
    );
    Ok(())
}

fn dispatch_browser_request(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    stream: &mut TcpStream,
    request_id: u64,
    started: Instant,
    request: EmbeddedBrowserBridgeRequest,
) -> Result<(), String> {
    let action = request.action.clone();
    let label = browser_label(request.label.clone());
    log::info!(
        "Embedded browser bridge request id={request_id} stage=dispatch_start action={action} label={label} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let response =
        handle_bridge_request(app, state, request).map_or_else(bridge_error, bridge_success);
    log::info!(
        "Embedded browser bridge request id={request_id} stage=dispatch_complete action={action} label={label} ok={} elapsed_ms={}",
        response.ok,
        started.elapsed().as_millis()
    );
    write_http_response(stream, "200 OK", &response)?;
    log::info!(
        "Embedded browser bridge request id={request_id} stage=response_written action={action} label={label} ok={} elapsed_ms={}",
        response.ok,
        started.elapsed().as_millis()
    );
    Ok(())
}

fn reject_busy_connection(mut stream: TcpStream, request_id: u64) {
    let response = bridge_error(
        "Embedded browser bridge is busy; retry after the current browser operation finishes."
            .to_string(),
    );
    let _ = write_http_response(&mut stream, "503 Service Unavailable", &response);
    log::warn!("Embedded browser bridge request id={request_id} stage=rejected_busy");
}

fn serve_connection(
    app: tauri::AppHandle,
    state: EmbeddedBrowserState,
    stream: TcpStream,
    request_id: u64,
    lease: BridgeWorkerLease,
) {
    let _lease = lease;
    if let Err(error) = handle_bridge_connection(&app, &state, stream, request_id) {
        log::warn!("Embedded browser bridge request id={request_id} stage=failed error={error}");
    }
}

pub(crate) fn start_embedded_browser_bridge(app: tauri::AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(EMBEDDED_BROWSER_BRIDGE_ADDR)
        .map_err(|error| format!("Failed to bind embedded browser bridge: {error}"))?;
    let listening_addr = listener
        .local_addr()
        .map_err(|error| format!("Failed to read embedded browser bridge address: {error}"))?;
    let bridge_token = generate_bridge_token()?;
    write_bridge_runtime_record(
        &crate::local_executor::local_executor_home_path()?,
        listening_addr,
        &bridge_token,
    )?;
    env::set_var(EMBEDDED_BROWSER_BRIDGE_ADDR_ENV, listening_addr.to_string());
    env::set_var(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV, bridge_token);
    let state = app.state::<EmbeddedBrowserState>().inner().clone();

    std::thread::Builder::new()
        .name("embedded-browser-bridge".to_string())
        .spawn(move || {
            log::info!("Embedded browser bridge listening on {listening_addr}");
            let active = Arc::new(AtomicUsize::new(0));
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    log::warn!("Embedded browser bridge accept failed");
                    continue;
                };
                let request_id = EMBEDDED_BROWSER_BRIDGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let peer = stream
                    .peer_addr()
                    .map(|value| value.to_string())
                    .unwrap_or_else(|_| "<unknown>".to_string());
                log::info!(
                    "Embedded browser bridge request id={request_id} stage=accepted peer={peer}"
                );
                let Some(lease) = acquire_worker(&active) else {
                    reject_busy_connection(stream, request_id);
                    continue;
                };
                let worker_app = app.clone();
                let worker_state = state.clone();
                if let Err(error) = std::thread::Builder::new()
                    .name(format!("embedded-browser-request-{request_id}"))
                    .spawn(move || serve_connection(worker_app, worker_state, stream, request_id, lease))
                {
                    log::warn!(
                        "Embedded browser bridge request id={request_id} stage=worker_spawn_failed error={error}"
                    );
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to spawn embedded browser bridge: {error}"))
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicUsize, Arc};

    use super::{acquire_worker, BRIDGE_MAX_CONCURRENT_REQUESTS};

    #[test]
    fn bridge_worker_limit_rejects_excess_requests_and_recovers() {
        let active = Arc::new(AtomicUsize::new(0));
        let leases = (0..BRIDGE_MAX_CONCURRENT_REQUESTS)
            .map(|_| acquire_worker(&active).expect("worker slot"))
            .collect::<Vec<_>>();

        assert!(acquire_worker(&active).is_none());
        drop(leases);
        assert!(acquire_worker(&active).is_some());
    }
}
