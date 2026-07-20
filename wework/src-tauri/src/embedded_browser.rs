#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    async_runtime::Mutex as AsyncMutex,
    webview::{DownloadEvent, PageLoadEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Webview, WebviewUrl, Wry,
};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_WEBVIEW_LABEL: &str = "workspace-browser";
const EMBEDDED_BROWSER_BRIDGE_ADDR: &str = "127.0.0.1:0";
const EMBEDDED_BROWSER_BRIDGE_ADDR_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR";
const BRIDGE_READ_TIMEOUT_MS: u64 = 5_000;
const BRIDGE_EVAL_TIMEOUT_MS: u64 = 10_000;
const BRIDGE_OPEN_WAIT_TIMEOUT_MS: u64 = 15_000;
const BRIDGE_OPEN_WAIT_INTERVAL_MS: u64 = 100;
const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT: &str = "wework:embedded-browser-open-request";
const EMBEDDED_BROWSER_DOWNLOAD_EVENT: &str = "wework:embedded-browser-download";
const EMBEDDED_BROWSER_NOT_READY_ERROR: &str = "Embedded browser is not ready";
const EMBEDDED_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const EMBEDDED_BROWSER_DATA_STORE_ID: [u8; 16] = *b"wework-browser01";
const EMBEDDED_BROWSER_DATA_DIRECTORY: &str = "embedded-browser-data";
static EMBEDDED_BROWSER_DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_BRIDGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_NATIVE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct EmbeddedBrowserState {
    webviews: Arc<Mutex<HashMap<String, EmbeddedBrowserEntry>>>,
    downloads: Arc<Mutex<HashMap<String, EmbeddedBrowserDownloadControl>>>,
    lifecycle: Arc<AsyncMutex<()>>,
}

#[derive(Clone)]
struct EmbeddedBrowserEntry {
    native_label: String,
    title: Option<String>,
    url: Option<String>,
    phase: EmbeddedBrowserPhase,
}

#[derive(Clone)]
enum EmbeddedBrowserPhase {
    Opening,
    Ready(Webview<Wry>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EmbeddedBrowserReadiness {
    Opening,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EmbeddedBrowserOpenAction {
    Ready,
    WaitForReady,
    RequestOpen,
}

impl EmbeddedBrowserEntry {
    fn readiness(&self) -> EmbeddedBrowserReadiness {
        match &self.phase {
            EmbeddedBrowserPhase::Opening => EmbeddedBrowserReadiness::Opening,
            EmbeddedBrowserPhase::Ready(_) => EmbeddedBrowserReadiness::Ready,
        }
    }

    fn ready_webview(&self) -> Result<Webview<Wry>, String> {
        match &self.phase {
            EmbeddedBrowserPhase::Ready(webview) => Ok(webview.clone()),
            EmbeddedBrowserPhase::Opening => Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserPageState {
    native_label: String,
    title: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserBridgeRequest {
    action: String,
    url: Option<String>,
    expression: Option<String>,
    selector: Option<String>,
    text: Option<String>,
    key: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    timeout_ms: Option<u64>,
    label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserBridgeResponse {
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserOpenRequest {
    url: String,
    label: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserDownloadPayload {
    id: String,
    label: String,
    native_label: String,
    url: String,
    path: Option<String>,
    status: String,
    received_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

#[derive(Clone)]
struct EmbeddedBrowserDownloadControl {
    app: tauri::AppHandle,
    id: String,
    native_label: String,
    owner_webviews: Weak<Mutex<HashMap<String, EmbeddedBrowserEntry>>>,
    url: String,
    path: PathBuf,
    paused: Arc<(Mutex<bool>, Condvar)>,
    cancelled: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    received_bytes: Arc<AtomicU64>,
    total_bytes: Arc<AtomicU64>,
}

impl EmbeddedBrowserDownloadControl {
    fn payload(&self, status: &str) -> Option<EmbeddedBrowserDownloadPayload> {
        let owner_webviews = self.owner_webviews.upgrade()?;
        let label = {
            let webviews = owner_webviews.lock().ok()?;
            download_event_owner(
                webviews.iter().map(|(logical_label, entry)| {
                    (logical_label.as_str(), entry.native_label.as_str())
                }),
                &self.native_label,
            )?
        };
        let received_bytes = self.received_bytes.load(Ordering::Relaxed);
        let total_bytes = self.total_bytes.load(Ordering::Relaxed);
        Some(EmbeddedBrowserDownloadPayload {
            id: self.id.clone(),
            label,
            native_label: self.native_label.clone(),
            url: self.url.clone(),
            path: Some(self.path.to_string_lossy().to_string()),
            status: status.to_string(),
            received_bytes: Some(received_bytes),
            total_bytes: (total_bytes > 0).then_some(total_bytes),
        })
    }

    fn emit(&self, status: &str) {
        if let Some(payload) = self.payload(status) {
            let _ = self.app.emit(EMBEDDED_BROWSER_DOWNLOAD_EVENT, payload);
        }
    }
}

fn run_browser_download(state: EmbeddedBrowserState, control: EmbeddedBrowserDownloadControl) {
    thread::spawn(move || {
        if let Err(error) = stream_browser_download(&control) {
            if !control.cancelled.load(Ordering::Relaxed) {
                control.failed.store(true, Ordering::Relaxed);
                log::warn!("Embedded browser download failed: {error}");
                control.emit("failed");
            }
            return;
        }
        control.emit("finished");
        if let Ok(mut downloads) = state.downloads.lock() {
            downloads.remove(&control.id);
        }
    });
}

fn stream_browser_download(control: &EmbeddedBrowserDownloadControl) -> Result<(), String> {
    let mut response = reqwest::blocking::Client::new()
        .get(&control.url)
        .send()
        .map_err(|error| format!("Failed to request download: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Download request failed: {error}"))?;
    if let Some(total_bytes) = response.content_length() {
        control.total_bytes.store(total_bytes, Ordering::Relaxed);
    }
    let mut file = std::fs::File::create(&control.path)
        .map_err(|error| format!("Failed to create download file: {error}"))?;
    control.emit("progress");
    let mut buffer = [0_u8; 64 * 1024];
    let mut last_progress_emit = Instant::now();
    loop {
        let (paused, wake) = &*control.paused;
        let mut is_paused = paused
            .lock()
            .map_err(|_| "Download pause lock poisoned".to_string())?;
        while *is_paused && !control.cancelled.load(Ordering::Relaxed) {
            is_paused = wake
                .wait(is_paused)
                .map_err(|_| "Download pause lock poisoned".to_string())?;
        }
        drop(is_paused);
        if control.cancelled.load(Ordering::Relaxed) {
            return Err("Download cancelled".to_string());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read download: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write download: {error}"))?;
        control
            .received_bytes
            .fetch_add(read as u64, Ordering::Relaxed);
        let is_paused = control
            .paused
            .0
            .lock()
            .map(|paused| *paused)
            .unwrap_or(false);
        if is_paused {
            control.emit("paused");
        } else if last_progress_emit.elapsed() >= Duration::from_millis(100) {
            control.emit("progress");
            last_progress_emit = Instant::now();
        }
    }
    file.flush()
        .map_err(|error| format!("Failed to finish download: {error}"))
}

struct NormalizedBounds {
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
}

impl NormalizedBounds {
    fn rect(&self) -> Rect {
        Rect {
            position: Position::Logical(self.position),
            size: Size::Logical(self.size),
        }
    }
}

fn normalize_bounds(bounds: EmbeddedBrowserBounds) -> NormalizedBounds {
    NormalizedBounds {
        position: LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
        size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    }
}

fn apply_webview_bounds(webview: &Webview<Wry>, bounds: NormalizedBounds) -> Result<(), String> {
    webview
        .set_bounds(bounds.rect())
        .map_err(|error| format!("Failed to set embedded browser bounds: {error}"))
}

fn browser_url(url: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(url).map_err(|error| format!("Invalid browser URL: {error}"))
}

fn browser_webview_url(url: tauri::Url) -> WebviewUrl {
    match url.scheme() {
        "http" | "https" => WebviewUrl::External(url),
        _ => WebviewUrl::CustomProtocol(url),
    }
}

fn browser_label(label: Option<String>) -> String {
    label.unwrap_or_else(|| BROWSER_WEBVIEW_LABEL.to_string())
}

fn native_webview_label(_logical_label: &str, sequence: u64) -> String {
    format!("embedded-browser-native-{sequence}")
}

fn logical_owner_for_native_label<'a>(
    identities: impl IntoIterator<Item = (&'a str, &'a str)>,
    native_label: &str,
) -> Option<String> {
    identities
        .into_iter()
        .find_map(|(logical_label, identity)| {
            (identity == native_label).then(|| logical_label.to_string())
        })
}

fn download_event_owner<'a>(
    identities: impl IntoIterator<Item = (&'a str, &'a str)>,
    native_label: &str,
) -> Option<String> {
    logical_owner_for_native_label(identities, native_label)
}

fn remove_logical_entry_if_native_matches<T>(
    entries: &mut HashMap<String, T>,
    logical_label: &str,
    native_label: &str,
    identity: impl Fn(&T) -> &str,
) -> Option<T> {
    let matches_identity = entries
        .get(logical_label)
        .is_some_and(|entry| identity(entry) == native_label);
    matches_identity
        .then(|| entries.remove(logical_label))
        .flatten()
}

fn update_logical_entry_if_native_matches<T>(
    entries: &mut HashMap<String, T>,
    native_label: &str,
    identity: impl Fn(&T) -> &str,
    update: impl FnOnce(&mut T),
) -> bool {
    let Some(entry) = entries
        .values_mut()
        .find(|entry| identity(entry) == native_label)
    else {
        return false;
    };
    update(entry);
    true
}

fn ready_logical_entry<'a, T>(
    entries: &'a HashMap<String, T>,
    logical_label: &str,
    readiness: impl Fn(&T) -> EmbeddedBrowserReadiness,
) -> Result<&'a T, String> {
    match entries.get(logical_label) {
        Some(entry) if readiness(entry) == EmbeddedBrowserReadiness::Ready => Ok(entry),
        Some(_) => Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string()),
        None => Err("Embedded browser is not open".to_string()),
    }
}

fn browser_open_action(readiness: Option<EmbeddedBrowserReadiness>) -> EmbeddedBrowserOpenAction {
    match readiness {
        Some(EmbeddedBrowserReadiness::Ready) => EmbeddedBrowserOpenAction::Ready,
        Some(EmbeddedBrowserReadiness::Opening) => EmbeddedBrowserOpenAction::WaitForReady,
        None => EmbeddedBrowserOpenAction::RequestOpen,
    }
}

fn wait_for_browser_ready(
    mut readiness: impl FnMut() -> Result<Option<EmbeddedBrowserReadiness>, String>,
    attempts: u64,
    interval: Duration,
) -> Result<(), String> {
    for _ in 0..attempts {
        if readiness()? == Some(EmbeddedBrowserReadiness::Ready) {
            return Ok(());
        }
        thread::sleep(interval);
    }
    Err("Timed out waiting for Wework to open the embedded browser tab".to_string())
}

fn relabel_logical_entry<T>(
    entries: &mut HashMap<String, T>,
    from_label: &str,
    to_label: &str,
) -> Result<(), String> {
    if from_label == to_label {
        return Ok(());
    }
    if entries.contains_key(to_label) {
        return if entries.contains_key(from_label) {
            Err("Embedded browser destination label is already open".to_string())
        } else {
            Ok(())
        };
    }
    let entry = entries
        .remove(from_label)
        .ok_or_else(|| "Embedded browser is not open".to_string())?;
    entries.insert(to_label.to_string(), entry);
    Ok(())
}

fn browser_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(EMBEDDED_BROWSER_DATA_DIRECTORY))
        .map_err(|error| format!("Failed to locate embedded browser data directory: {error}"))
}

#[cfg(desktop)]
fn browser_download_destination(
    app: &tauri::AppHandle,
    suggested_destination: &Path,
) -> Result<(PathBuf, String, bool), String> {
    let preferences = crate::read_app_preferences_impl(app);
    let suggested_name = suggested_destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("download")
        .to_string();
    let download_directory = preferences
        .browser_download_directory
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            app.path()
                .download_dir()
                .map_err(|error| format!("Failed to locate download directory: {error}"))
        })?;

    std::fs::create_dir_all(&download_directory)
        .map_err(|error| format!("Failed to create browser download directory: {error}"))?;
    let destination = download_directory.join(&suggested_name);
    Ok((
        destination,
        suggested_name,
        preferences.browser_ask_before_download,
    ))
}

fn start_managed_browser_download(
    app: tauri::AppHandle,
    state: EmbeddedBrowserState,
    native_label: String,
    url: String,
    path: PathBuf,
) {
    let id = format!(
        "browser-download-{}",
        EMBEDDED_BROWSER_DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let control = EmbeddedBrowserDownloadControl {
        app,
        id: id.clone(),
        native_label,
        owner_webviews: Arc::downgrade(&state.webviews),
        url,
        path,
        paused: Arc::new((Mutex::new(false), Condvar::new())),
        cancelled: Arc::new(AtomicBool::new(false)),
        failed: Arc::new(AtomicBool::new(false)),
        received_bytes: Arc::new(AtomicU64::new(0)),
        total_bytes: Arc::new(AtomicU64::new(0)),
    };
    if let Ok(mut downloads) = state.downloads.lock() {
        downloads.insert(id, control.clone());
    }
    control.emit("started");
    run_browser_download(state, control);
}

fn get_entry(state: &EmbeddedBrowserState, label: &str) -> Result<EmbeddedBrowserEntry, String> {
    let webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    ready_logical_entry(&webviews, label, EmbeddedBrowserEntry::readiness).cloned()
}

fn set_entry_url(
    state: &EmbeddedBrowserState,
    label: &str,
    url: impl Into<Option<String>>,
) -> Result<(), String> {
    let mut webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    if let Some(entry) = webviews.get_mut(label) {
        entry.url = url.into();
    }
    Ok(())
}

fn update_entry_for_native_label(
    state: &EmbeddedBrowserState,
    native_label: &str,
    update: impl FnOnce(&mut EmbeddedBrowserEntry),
) -> Result<bool, String> {
    let mut webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    Ok(update_logical_entry_if_native_matches(
        &mut webviews,
        native_label,
        |entry| entry.native_label.as_str(),
        update,
    ))
}

fn set_entry_url_for_native_label(
    state: &EmbeddedBrowserState,
    native_label: &str,
    url: String,
) -> Result<(), String> {
    update_entry_for_native_label(state, native_label, |entry| {
        entry.url = Some(url);
    })
    .map(|_| ())
}

fn mark_entry_ready_for_native_label(
    state: &EmbeddedBrowserState,
    native_label: &str,
    webview: Webview<Wry>,
) -> Result<(), String> {
    let updated = update_entry_for_native_label(state, native_label, |entry| {
        entry.phase = EmbeddedBrowserPhase::Ready(webview);
    })?;
    updated
        .then_some(())
        .ok_or_else(|| "Embedded browser route disappeared while opening".to_string())
}

fn entry_readiness(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<Option<EmbeddedBrowserReadiness>, String> {
    Ok(state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .get(label)
        .map(EmbeddedBrowserEntry::readiness))
}

fn current_logical_owner(
    state: &EmbeddedBrowserState,
    native_label: &str,
) -> Result<Option<String>, String> {
    let webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    Ok(logical_owner_for_native_label(
        webviews
            .iter()
            .map(|(logical_label, entry)| (logical_label.as_str(), entry.native_label.as_str())),
        native_label,
    ))
}

fn start_managed_browser_download_for_native(
    app: tauri::AppHandle,
    state: EmbeddedBrowserState,
    native_label: &str,
    url: String,
    path: PathBuf,
) {
    match current_logical_owner(&state, native_label) {
        Ok(Some(_)) => {
            start_managed_browser_download(app, state, native_label.to_string(), url, path)
        }
        Ok(None) => log::warn!("Ignored download from a closed embedded browser"),
        Err(error) => log::warn!("Failed to resolve embedded browser download owner: {error}"),
    }
}

fn page_state_for_label(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<EmbeddedBrowserPageState, String> {
    let entry = get_entry(state, label)?;
    Ok(EmbeddedBrowserPageState {
        native_label: entry.native_label,
        title: entry.title,
        url: entry.url,
    })
}

fn navigate_label(state: &EmbeddedBrowserState, label: &str, url: String) -> Result<(), String> {
    let parsed_url = browser_url(&url)?;
    let entry = get_entry(state, label)?;
    entry
        .ready_webview()?
        .navigate(parsed_url)
        .map_err(|error| format!("Failed to navigate embedded browser: {error}"))?;
    set_entry_url_for_native_label(state, &entry.native_label, url)
}

fn is_browser_open(state: &EmbeddedBrowserState, label: &str) -> Result<bool, String> {
    Ok(entry_readiness(state, label)? == Some(EmbeddedBrowserReadiness::Ready))
}

fn request_browser_open(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    label: &str,
    url: &str,
) -> Result<(), String> {
    match browser_open_action(entry_readiness(state, label)?) {
        EmbeddedBrowserOpenAction::Ready => return Ok(()),
        EmbeddedBrowserOpenAction::WaitForReady => {}
        EmbeddedBrowserOpenAction::RequestOpen => {
            app.emit(
                EMBEDDED_BROWSER_OPEN_REQUEST_EVENT,
                EmbeddedBrowserOpenRequest {
                    url: url.to_string(),
                    label: label.to_string(),
                },
            )
            .map_err(|error| format!("Failed to request embedded browser open: {error}"))?;
        }
    }

    wait_for_browser_ready(
        || entry_readiness(state, label),
        BRIDGE_OPEN_WAIT_TIMEOUT_MS / BRIDGE_OPEN_WAIT_INTERVAL_MS,
        Duration::from_millis(BRIDGE_OPEN_WAIT_INTERVAL_MS),
    )
}

fn eval_json(
    state: &EmbeddedBrowserState,
    label: &str,
    script: String,
    timeout_ms: u64,
) -> Result<Value, String> {
    let entry = get_entry(state, label)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    entry
        .ready_webview()?
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Failed to evaluate embedded browser script: {error}"))?;

    let result = receiver
        .recv_timeout(Duration::from_millis(timeout_ms))
        .map_err(|_| "Timed out waiting for embedded browser evaluation".to_string())?;
    serde_json::from_str(&result).or(Ok(Value::String(result)))
}

async fn eval_json_nonblocking(
    state: &EmbeddedBrowserState,
    label: &str,
    script: String,
    timeout_ms: u64,
) -> Result<Value, String> {
    let entry = get_entry(state, label)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    entry
        .ready_webview()?
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Failed to evaluate embedded browser script: {error}"))?;

    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_millis(timeout_ms))
            .map_err(|_| "Timed out waiting for embedded browser evaluation".to_string())
    })
    .await
    .map_err(|error| format!("Failed to join embedded browser evaluation task: {error}"))??;
    serde_json::from_str(&result).or(Ok(Value::String(result)))
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn script_expression(expression: &str) -> String {
    format!(
        r#"(() => {{
  try {{
    const value = (() => {{ return ({expression}); }})();
    return {{ ok: true, value }};
  }} catch (error) {{
    return {{ ok: false, error: String(error?.stack || error?.message || error) }};
  }}
}})()"#
    )
}

fn script_selector_action(selector: &str, action: &str) -> String {
    format!(
        r#"(async () => {{
  const element = document.querySelector({selector});
  if (!element) {{
    return {{ ok: false, error: "Element not found" }};
  }}
  element.scrollIntoView({{ block: "center", inline: "center" }});
  {action}
  return {{ ok: true }};
}})()"#,
        selector = json_string(selector)
    )
}

fn script_click_at(x: f64, y: f64) -> String {
    format!(
        r#"(async () => {{
  const element = document.elementFromPoint({x}, {y});
  if (!element) {{
    return {{ ok: false, error: "Element not found at coordinates" }};
  }}
  element.dispatchEvent(new MouseEvent("mousedown", {{ bubbles: true, clientX: {x}, clientY: {y} }}));
  element.dispatchEvent(new MouseEvent("mouseup", {{ bubbles: true, clientX: {x}, clientY: {y} }}));
  element.click();
  return {{ ok: true }};
}})()"#
    )
}

fn script_type_text(selector: Option<&str>, text: &str) -> String {
    let element = selector
        .map(|selector| format!("document.querySelector({})", json_string(selector)))
        .unwrap_or_else(|| "document.activeElement".to_string());
    format!(
        r#"(async () => {{
  const element = {element};
  if (!element) {{
    return {{ ok: false, error: "Element not found" }};
  }}
  element.focus();
  const text = {text};
  if ("value" in element) {{
    element.value = `${{element.value ?? ""}}${{text}}`;
    element.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: text }}));
    element.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }} else {{
    document.execCommand("insertText", false, text);
  }}
  return {{ ok: true }};
}})()"#,
        text = json_string(text)
    )
}

fn script_press_key(key: &str) -> String {
    format!(
        r#"(async () => {{
  const target = document.activeElement || document.body;
  const key = {key};
  for (const type of ["keydown", "keyup"]) {{
    target.dispatchEvent(new KeyboardEvent(type, {{ key, bubbles: true, cancelable: true }}));
  }}
  return {{ ok: true }};
}})()"#,
        key = json_string(key)
    )
}

fn script_wait_for(request: &EmbeddedBrowserBridgeRequest) -> String {
    let selector = request.selector.as_deref().map(json_string);
    let text = request.text.as_deref().map(json_string);
    let url = request.url.as_deref().map(json_string);
    let expression = request.expression.as_deref().unwrap_or("true");
    format!(
        r#"(async () => {{
  const deadline = Date.now() + {timeout};
  const selector = {selector};
  const text = {text};
  const url = {url};
  while (Date.now() <= deadline) {{
    const selectorOk = !selector || Boolean(document.querySelector(selector));
    const textOk = !text || document.body?.innerText?.includes(text);
    const urlOk = !url || location.href.includes(url);
    let expressionOk = true;
    try {{
      expressionOk = Boolean(await (async () => {{ return ({expression}); }})());
    }} catch {{
      expressionOk = false;
    }}
    if (selectorOk && textOk && urlOk && expressionOk) {{
      return {{ ok: true }};
    }}
    await new Promise(resolve => setTimeout(resolve, 100));
  }}
  return {{ ok: false, error: "Timed out waiting for embedded browser condition" }};
}})()"#,
        timeout = request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        selector = selector.unwrap_or_else(|| "null".to_string()),
        text = text.unwrap_or_else(|| "null".to_string()),
        url = url.unwrap_or_else(|| "null".to_string())
    )
}

#[cfg(target_os = "macos")]
fn screenshot_embedded_browser(state: &EmbeddedBrowserState, label: &str) -> Result<Value, String> {
    let entry = get_entry(state, label)?;
    let webview = entry.ready_webview()?;
    let window_position = webview
        .window()
        .inner_position()
        .map_err(|error| format!("Failed to read Wework window position: {error}"))?;
    let webview_position = webview
        .position()
        .map_err(|error| format!("Failed to read embedded browser position: {error}"))?;
    let webview_size = webview
        .size()
        .map_err(|error| format!("Failed to read embedded browser size: {error}"))?;
    let scale_factor = webview
        .window()
        .scale_factor()
        .map_err(|error| format!("Failed to read Wework window scale factor: {error}"))?
        .max(1.0);
    let x = ((window_position.x + webview_position.x) as f64 / scale_factor).round() as i32;
    let y = ((window_position.y + webview_position.y) as f64 / scale_factor).round() as i32;
    let width = (webview_size.width.max(1) as f64 / scale_factor).round() as u32;
    let height = (webview_size.height.max(1) as f64 / scale_factor).round() as u32;
    let path = screenshot_path()?;
    let region = format!("{x},{y},{width},{height}");
    let output = Command::new("screencapture")
        .args(["-x", "-R", &region])
        .arg(&path)
        .output()
        .map_err(|error| format!("Failed to run macOS screencapture: {error}"))?;
    if output.status.success() {
        return Ok(json!({
            "path": path.to_string_lossy(),
            "type": "png",
            "region": { "x": x, "y": y, "width": width, "height": height },
        }));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to capture embedded browser screenshot".to_string()
    } else {
        stderr
    })
}

#[cfg(not(target_os = "macos"))]
fn screenshot_embedded_browser(
    _state: &EmbeddedBrowserState,
    _label: &str,
) -> Result<Value, String> {
    Err("Embedded browser screenshots are currently supported on macOS only".to_string())
}

#[cfg(target_os = "macos")]
fn screenshot_path() -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join("wework-embedded-browser");
    std::fs::create_dir_all(&directory).map_err(|error| {
        format!("Failed to create embedded browser screenshot directory: {error}")
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System time is before UNIX epoch: {error}"))?
        .as_millis();
    Ok(directory.join(format!("screenshot-{timestamp}.png")))
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

fn handle_bridge_request(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    request: EmbeddedBrowserBridgeRequest,
) -> Result<Value, String> {
    let label = browser_label(request.label.clone());
    match request.action.as_str() {
        "status" => Ok(json!({
            "open": is_browser_open(state, &label)?,
            "label": label,
        })),
        "pageState" => serde_json::to_value(page_state_for_label(state, &label)?)
            .map_err(|error| format!("Failed to encode embedded browser page state: {error}")),
        "navigate" | "open" => {
            let url = request
                .url
                .ok_or_else(|| "Embedded browser navigate requires url".to_string())?;
            browser_url(&url)?;
            if !is_browser_open(state, &label)? {
                request_browser_open(app, state, &label, &url)?;
            }
            navigate_label(state, &label, url)?;
            Ok(json!({ "ok": true }))
        }
        "reload" => {
            get_entry(state, &label)?
                .ready_webview()?
                .reload()
                .map_err(|error| format!("Failed to reload embedded browser: {error}"))?;
            Ok(json!({ "ok": true }))
        }
        "back" => eval_json(
            state,
            &label,
            script_expression("window.history.back(), true"),
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "forward" => eval_json(
            state,
            &label,
            script_expression("window.history.forward(), true"),
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "evaluate" => {
            let expression = request
                .expression
                .ok_or_else(|| "Embedded browser evaluate requires expression".to_string())?;
            eval_json(
                state,
                &label,
                script_expression(&expression),
                request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
            )
        }
        "click" => {
            let script = if let Some(selector) = request.selector.as_deref() {
                script_selector_action(selector, "element.click();")
            } else {
                script_click_at(request.x.unwrap_or(0.0), request.y.unwrap_or(0.0))
            };
            eval_json(
                state,
                &label,
                script,
                request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
            )
        }
        "typeText" => eval_json(
            state,
            &label,
            script_type_text(
                request.selector.as_deref(),
                request.text.as_deref().unwrap_or(""),
            ),
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "press" => eval_json(
            state,
            &label,
            script_press_key(request.key.as_deref().unwrap_or("")),
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "waitFor" => eval_json(
            state,
            &label,
            script_wait_for(&request),
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "screenshot" => screenshot_embedded_browser(state, &label),
        _ => Err(format!(
            "Unknown embedded browser bridge action: {}",
            request.action
        )),
    }
}

fn read_http_request(stream: &mut TcpStream) -> Result<(String, String), String> {
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
        .find_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
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
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\n\r\n{body}",
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
    if path == "/status" {
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
            },
        );
        let response = match result {
            Ok(data) => bridge_success(data),
            Err(error) => bridge_error(error),
        };
        write_http_response(&mut stream, "200 OK", &response)?;
        log::info!(
            "Embedded browser bridge request id={request_id} stage=response_written action=status ok={} elapsed_ms={}",
            response.ok,
            started.elapsed().as_millis()
        );
        return Ok(());
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
    let action = request.action.clone();
    let label = browser_label(request.label.clone());
    log::info!(
        "Embedded browser bridge request id={request_id} stage=dispatch_start action={action} label={label} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let response = match handle_bridge_request(app, state, request) {
        Ok(data) => bridge_success(data),
        Err(error) => bridge_error(error),
    };
    log::info!(
        "Embedded browser bridge request id={request_id} stage=dispatch_complete action={action} label={label} ok={} elapsed_ms={}",
        response.ok,
        started.elapsed().as_millis()
    );
    write_http_response(&mut stream, "200 OK", &response)?;
    log::info!(
        "Embedded browser bridge request id={request_id} stage=response_written action={action} label={label} ok={} elapsed_ms={}",
        response.ok,
        started.elapsed().as_millis()
    );
    Ok(())
}

pub fn start_embedded_browser_bridge(app: tauri::AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(EMBEDDED_BROWSER_BRIDGE_ADDR)
        .map_err(|error| format!("Failed to bind embedded browser bridge: {error}"))?;
    let listening_addr = listener
        .local_addr()
        .map_err(|error| format!("Failed to read embedded browser bridge address: {error}"))?;
    env::set_var(EMBEDDED_BROWSER_BRIDGE_ADDR_ENV, listening_addr.to_string());
    let state = app.state::<EmbeddedBrowserState>().inner().clone();
    let app_handle = app.clone();
    std::thread::Builder::new()
        .name("embedded-browser-bridge".to_string())
        .spawn(move || {
            log::info!("Embedded browser bridge listening on {listening_addr}");
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let request_id = EMBEDDED_BROWSER_BRIDGE_SEQUENCE
                            .fetch_add(1, Ordering::Relaxed);
                        let peer = stream
                            .peer_addr()
                            .map(|value| value.to_string())
                            .unwrap_or_else(|_| "<unknown>".to_string());
                        log::info!(
                            "Embedded browser bridge request id={request_id} stage=accepted peer={peer}"
                        );
                        if let Err(error) =
                            handle_bridge_connection(&app_handle, &state, stream, request_id)
                        {
                            log::warn!(
                                "Embedded browser bridge request id={request_id} stage=failed error={error}"
                            );
                        }
                    }
                    Err(error) => {
                        log::warn!("Embedded browser bridge accept failed: {error}");
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to spawn embedded browser bridge: {error}"))
}

#[tauri::command]
pub async fn embedded_browser_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    url: String,
    bounds: EmbeddedBrowserBounds,
    label: Option<String>,
) -> Result<EmbeddedBrowserPageState, String> {
    let label = browser_label(label);
    let _lifecycle = state.lifecycle.lock().await;
    let parsed_url = browser_url(&url)?;
    let normalized_bounds = normalize_bounds(bounds);

    let existing = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        match webviews.get(&label) {
            Some(entry) if entry.readiness() == EmbeddedBrowserReadiness::Ready => {
                Some(entry.clone())
            }
            Some(_) => return Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string()),
            None => None,
        }
    };

    if let Some(entry) = existing {
        let webview = entry.ready_webview()?;
        apply_webview_bounds(&webview, normalized_bounds)?;
        webview
            .navigate(parsed_url)
            .map_err(|error| format!("Failed to navigate embedded browser: {error}"))?;
        webview
            .show()
            .map_err(|error| format!("Failed to show embedded browser: {error}"))?;
        set_entry_url(&state, &label, Some(url.clone()))?;
        return Ok(EmbeddedBrowserPageState {
            native_label: entry.native_label,
            title: entry.title,
            url: Some(url),
        });
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;
    let load_state_handle = state.inner().clone();
    let title_state_handle = state.inner().clone();
    let native_label = native_webview_label(
        &label,
        EMBEDDED_BROWSER_NATIVE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    );
    let native_label_for_load = native_label.clone();
    let native_label_for_title = native_label.clone();
    let data_directory = browser_data_directory(&app)?;

    let entry = EmbeddedBrowserEntry {
        native_label: native_label.clone(),
        title: None,
        url: Some(url.clone()),
        phase: EmbeddedBrowserPhase::Opening,
    };
    state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .insert(label.clone(), entry);

    let builder =
        tauri::webview::WebviewBuilder::new(&native_label, browser_webview_url(parsed_url))
            .user_agent(EMBEDDED_BROWSER_USER_AGENT)
            .data_directory(data_directory)
            .data_store_identifier(EMBEDDED_BROWSER_DATA_STORE_ID)
            .accept_first_mouse(true)
            .on_page_load(move |_webview, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let loaded_url = payload.url().to_string();
                    let _ = update_entry_for_native_label(
                        &load_state_handle,
                        &native_label_for_load,
                        |entry| entry.url = Some(loaded_url),
                    );
                }
            })
            .on_document_title_changed(move |_webview, title| {
                let _ = update_entry_for_native_label(
                    &title_state_handle,
                    &native_label_for_title,
                    |entry| entry.title = Some(title),
                );
            });

    #[cfg(desktop)]
    let builder = {
        let download_app = app.clone();
        let download_native_label = native_label.clone();
        let download_state = state.inner().clone();
        builder.on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                match browser_download_destination(&download_app, destination) {
                    Ok((path, suggested_name, ask_before_download)) => {
                        let url = url.to_string();
                        if ask_before_download {
                            let callback_app = download_app.clone();
                            let callback_state = download_state.clone();
                            let callback_native_label = download_native_label.clone();
                            download_app
                                .dialog()
                                .file()
                                .set_directory(
                                    path.parent().unwrap_or_else(|| std::path::Path::new("/")),
                                )
                                .set_file_name(&suggested_name)
                                .save_file(move |selected| {
                                    let Some(selected) = selected else {
                                        return;
                                    };
                                    match selected.into_path() {
                                        Ok(path) => start_managed_browser_download_for_native(
                                            callback_app,
                                            callback_state,
                                            &callback_native_label,
                                            url,
                                            path,
                                        ),
                                        Err(_) => {
                                            log::warn!("Invalid browser download destination")
                                        }
                                    }
                                });
                        } else {
                            start_managed_browser_download_for_native(
                                download_app.clone(),
                                download_state.clone(),
                                &download_native_label,
                                url,
                                path,
                            );
                        }
                        false
                    }
                    Err(error) => {
                        log::warn!("Failed to prepare embedded browser download: {error}");
                        false
                    }
                }
            }
            DownloadEvent::Finished { .. } => true,
            _ => true,
        })
    };

    let webview =
        match window.add_child(builder, normalized_bounds.position, normalized_bounds.size) {
            Ok(webview) => webview,
            Err(error) => {
                if let Ok(mut webviews) = state.webviews.lock() {
                    remove_logical_entry_if_native_matches(
                        &mut webviews,
                        &label,
                        &native_label,
                        |current| current.native_label.as_str(),
                    );
                }
                return Err(format!("Failed to create embedded browser: {error}"));
            }
        };

    if let Err(error) = webview
        .show()
        .map_err(|error| format!("Failed to show embedded browser: {error}"))
    {
        if let Ok(mut webviews) = state.webviews.lock() {
            remove_logical_entry_if_native_matches(
                &mut webviews,
                &label,
                &native_label,
                |current| current.native_label.as_str(),
            );
        }
        let _ = webview.close();
        return Err(error);
    }
    if let Err(error) = mark_entry_ready_for_native_label(&state, &native_label, webview.clone()) {
        if let Ok(mut webviews) = state.webviews.lock() {
            remove_logical_entry_if_native_matches(
                &mut webviews,
                &label,
                &native_label,
                |current| current.native_label.as_str(),
            );
        }
        let _ = webview.close();
        return Err(error);
    }

    Ok(EmbeddedBrowserPageState {
        native_label,
        title: None,
        url: Some(url),
    })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Barrier, Mutex},
        thread,
        time::Duration,
    };

    use super::{
        browser_open_action, browser_webview_url, download_event_owner,
        logical_owner_for_native_label, native_webview_label, ready_logical_entry,
        relabel_logical_entry, remove_logical_entry_if_native_matches,
        update_logical_entry_if_native_matches, wait_for_browser_ready,
        EmbeddedBrowserDownloadPayload, EmbeddedBrowserOpenAction, EmbeddedBrowserPageState,
        EmbeddedBrowserReadiness, EMBEDDED_BROWSER_NOT_READY_ERROR,
    };
    use tauri::WebviewUrl;

    #[test]
    fn new_browser_uses_the_requested_url_as_its_initial_navigation() {
        let external_url = tauri::Url::parse("https://example.com/").unwrap();
        let app_url =
            tauri::Url::parse("tauri://localhost/extension-page.html?sessionId=test").unwrap();

        assert!(matches!(
            browser_webview_url(external_url),
            WebviewUrl::External(_)
        ));
        assert!(matches!(
            browser_webview_url(app_url),
            WebviewUrl::CustomProtocol(_)
        ));
    }

    #[test]
    fn opening_route_is_hidden_from_public_access_but_available_to_native_callbacks() {
        let native_label = native_webview_label("workspace-browser", 41);
        let mut entries = HashMap::from([(
            "workspace-browser".to_string(),
            (
                native_label.clone(),
                EmbeddedBrowserReadiness::Opening,
                None,
            ),
        )]);

        let public_entry = ready_logical_entry(&entries, "workspace-browser", |entry| entry.1);
        assert_eq!(public_entry.unwrap_err(), EMBEDDED_BROWSER_NOT_READY_ERROR);

        let callback_updated = update_logical_entry_if_native_matches(
            &mut entries,
            &native_label,
            |entry| entry.0.as_str(),
            |entry| entry.2 = Some("loaded"),
        );
        assert!(callback_updated);
        assert_eq!(entries["workspace-browser"].2, Some("loaded"));

        entries.get_mut("workspace-browser").unwrap().1 = EmbeddedBrowserReadiness::Ready;
        assert!(ready_logical_entry(&entries, "workspace-browser", |entry| entry.1).is_ok());
    }

    #[test]
    fn bridge_open_waits_for_an_opening_route_without_requesting_again() {
        assert_eq!(
            browser_open_action(Some(EmbeddedBrowserReadiness::Opening)),
            EmbeddedBrowserOpenAction::WaitForReady
        );
        assert_eq!(
            browser_open_action(None),
            EmbeddedBrowserOpenAction::RequestOpen
        );
        assert_eq!(
            browser_open_action(Some(EmbeddedBrowserReadiness::Ready)),
            EmbeddedBrowserOpenAction::Ready
        );
    }

    #[test]
    fn bridge_waits_for_ready_instead_of_accepting_an_opening_registration() {
        let readiness = Arc::new(Mutex::new(EmbeddedBrowserReadiness::Opening));
        let waiter_readiness = Arc::clone(&readiness);
        let started = Arc::new(Barrier::new(2));
        let waiter_started = Arc::clone(&started);

        let waiter = thread::spawn(move || {
            let mut first_check = true;
            wait_for_browser_ready(
                || {
                    if first_check {
                        first_check = false;
                        waiter_started.wait();
                    }
                    Ok(Some(*waiter_readiness.lock().unwrap()))
                },
                100,
                Duration::from_millis(1),
            )
        });

        started.wait();
        assert!(!waiter.is_finished());
        *readiness.lock().unwrap() = EmbeddedBrowserReadiness::Ready;
        assert_eq!(waiter.join().unwrap(), Ok(()));
    }

    #[test]
    fn native_webview_labels_are_unique_across_creation_sequences() {
        let first = native_webview_label("workspace-browser", 41);
        let second = native_webview_label("workspace-browser", 42);

        assert_ne!(first, second);
    }

    #[test]
    fn page_state_serializes_native_identity() {
        let state = EmbeddedBrowserPageState {
            native_label: "workspace-browser-native-41".to_string(),
            title: Some("Example".to_string()),
            url: Some("https://example.com/".to_string()),
        };

        let serialized = serde_json::to_value(state).unwrap();

        assert_eq!(serialized["nativeLabel"], "workspace-browser-native-41");
    }

    #[test]
    fn download_payload_serializes_native_identity() {
        let payload = EmbeddedBrowserDownloadPayload {
            id: "download-1".to_string(),
            label: "workspace-browser-owner".to_string(),
            native_label: "workspace-browser-native-41".to_string(),
            url: "https://example.com/app.dmg".to_string(),
            path: Some("/tmp/app.dmg".to_string()),
            status: "finished".to_string(),
            received_bytes: Some(1024),
            total_bytes: Some(1024),
        };

        let serialized = serde_json::to_value(payload).unwrap();

        assert_eq!(serialized["nativeLabel"], "workspace-browser-native-41");
    }

    #[test]
    fn native_identity_resolves_the_current_owner_after_logical_relabel() {
        let native_label = native_webview_label("workspace-browser", 41);
        let mut owners = HashMap::from([("workspace-browser".to_string(), native_label.clone())]);
        let identity = owners.remove("workspace-browser").unwrap();
        owners.insert("workspace-browser-regression-owner".to_string(), identity);

        let owner = logical_owner_for_native_label(
            owners.iter().map(|(logical_label, native_label)| {
                (logical_label.as_str(), native_label.as_str())
            }),
            &native_label,
        );

        assert_eq!(owner.as_deref(), Some("workspace-browser-regression-owner"));
    }

    #[test]
    fn download_event_owner_follows_relabel_and_ignores_reused_logical_label() {
        let original_native = native_webview_label("workspace-browser", 41);
        let replacement_native = native_webview_label("workspace-browser", 42);
        let owners = HashMap::from([
            (
                "workspace-browser-regression-owner".to_string(),
                original_native.clone(),
            ),
            ("workspace-browser".to_string(), replacement_native),
        ]);

        let owner = download_event_owner(
            owners.iter().map(|(logical_label, native_label)| {
                (logical_label.as_str(), native_label.as_str())
            }),
            &original_native,
        );

        assert_eq!(owner.as_deref(), Some("workspace-browser-regression-owner"));
    }

    #[test]
    fn conditional_native_removal_preserves_a_replacement_entry() {
        let original_native = native_webview_label("workspace-browser", 41);
        let replacement_native = native_webview_label("workspace-browser", 42);
        let mut owners =
            HashMap::from([("workspace-browser".to_string(), replacement_native.clone())]);

        let removed = remove_logical_entry_if_native_matches(
            &mut owners,
            "workspace-browser",
            &original_native,
            String::as_str,
        );

        assert_eq!(removed, None);
        assert_eq!(owners.get("workspace-browser"), Some(&replacement_native));
    }

    #[test]
    fn conditional_native_removal_removes_the_matching_entry() {
        let native_label = native_webview_label("workspace-browser", 41);
        let mut owners = HashMap::from([("workspace-browser".to_string(), native_label.clone())]);

        let removed = remove_logical_entry_if_native_matches(
            &mut owners,
            "workspace-browser",
            &native_label,
            String::as_str,
        );

        assert_eq!(removed.as_deref(), Some(native_label.as_str()));
        assert!(!owners.contains_key("workspace-browser"));
    }

    #[test]
    fn native_scoped_update_follows_relabel_without_mutating_reused_logical_label() {
        let original_native = native_webview_label("workspace-browser", 41);
        let replacement_native = native_webview_label("workspace-browser", 42);
        let mut entries = HashMap::from([
            (
                "workspace-browser-task-1".to_string(),
                (original_native.clone(), None),
            ),
            ("workspace-browser".to_string(), (replacement_native, None)),
        ]);

        let updated = update_logical_entry_if_native_matches(
            &mut entries,
            &original_native,
            |entry| entry.0.as_str(),
            |entry| entry.1 = Some("https://openai.com/".to_string()),
        );

        assert!(updated);
        assert_eq!(
            entries["workspace-browser-task-1"].1.as_deref(),
            Some("https://openai.com/")
        );
        assert_eq!(entries["workspace-browser"].1, None);
    }

    #[test]
    fn relabel_rejects_an_occupied_destination_without_orphaning_the_source() {
        let mut entries = HashMap::from([
            ("workspace-browser-source".to_string(), "source-native"),
            ("workspace-browser-target".to_string(), "target-native"),
        ]);

        let result = relabel_logical_entry(
            &mut entries,
            "workspace-browser-source",
            "workspace-browser-target",
        );

        assert_eq!(
            result,
            Err("Embedded browser destination label is already open".to_string())
        );
        assert_eq!(entries["workspace-browser-source"], "source-native");
        assert_eq!(entries["workspace-browser-target"], "target-native");
    }
}

#[tauri::command]
pub fn embedded_browser_set_bounds(
    state: tauri::State<'_, EmbeddedBrowserState>,
    bounds: EmbeddedBrowserBounds,
    visible: bool,
    label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    let normalized_bounds = normalize_bounds(bounds);
    let webview = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        match webviews.get(&label) {
            Some(entry) if entry.readiness() == EmbeddedBrowserReadiness::Ready => {
                Some(entry.ready_webview()?)
            }
            Some(_) => return Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string()),
            None => None,
        }
    };

    let Some(webview) = webview else {
        return Ok(());
    };

    apply_webview_bounds(&webview, normalized_bounds)?;
    if visible {
        webview
            .show()
            .map_err(|error| format!("Failed to show embedded browser: {error}"))?;
    } else {
        webview
            .hide()
            .map_err(|error| format!("Failed to hide embedded browser: {error}"))?;
    }
    Ok(())
}

fn browser_download_control(
    state: &EmbeddedBrowserState,
    id: &str,
) -> Result<EmbeddedBrowserDownloadControl, String> {
    state
        .downloads
        .lock()
        .map_err(|_| "Embedded browser download state lock poisoned".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "Browser download not found".to_string())
}

#[tauri::command]
pub fn embedded_browser_pause_download(
    state: tauri::State<'_, EmbeddedBrowserState>,
    id: String,
) -> Result<(), String> {
    let control = browser_download_control(&state, &id)?;
    let (paused, _) = &*control.paused;
    *paused
        .lock()
        .map_err(|_| "Download pause lock poisoned".to_string())? = true;
    control.emit("paused");
    Ok(())
}

#[tauri::command]
pub fn embedded_browser_resume_download(
    state: tauri::State<'_, EmbeddedBrowserState>,
    id: String,
) -> Result<(), String> {
    let control = browser_download_control(&state, &id)?;
    if control.failed.load(Ordering::Relaxed) {
        return Err("Failed downloads cannot be resumed".to_string());
    }
    let (paused, wake) = &*control.paused;
    *paused
        .lock()
        .map_err(|_| "Download pause lock poisoned".to_string())? = false;
    wake.notify_all();
    control.emit("progress");
    Ok(())
}

#[tauri::command]
pub fn embedded_browser_delete_download(
    state: tauri::State<'_, EmbeddedBrowserState>,
    id: String,
) -> Result<(), String> {
    let control = browser_download_control(&state, &id)?;
    let is_paused = *control
        .paused
        .0
        .lock()
        .map_err(|_| "Download pause lock poisoned".to_string())?;
    if !is_paused && !control.failed.load(Ordering::Relaxed) {
        return Err("Pause the download before deleting it".to_string());
    }
    control.cancelled.store(true, Ordering::Relaxed);
    control.paused.1.notify_all();
    let _ = std::fs::remove_file(&control.path);
    state
        .downloads
        .lock()
        .map_err(|_| "Embedded browser download state lock poisoned".to_string())?
        .remove(&id);
    control.emit("deleted");
    Ok(())
}

#[tauri::command]
pub fn embedded_browser_navigate(
    state: tauri::State<'_, EmbeddedBrowserState>,
    url: String,
    label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    navigate_label(&state, &label, url)
}

#[tauri::command]
pub fn embedded_browser_reload(
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    let webview = get_entry(&state, &label)?.ready_webview()?;
    webview
        .reload()
        .map_err(|error| format!("Failed to reload embedded browser: {error}"))
}

#[tauri::command]
pub fn embedded_browser_go_back(
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
) -> Result<(), String> {
    embedded_browser_eval(state, "window.history.back(); true".to_string(), label)
}

#[tauri::command]
pub fn embedded_browser_go_forward(
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
) -> Result<(), String> {
    embedded_browser_eval(state, "window.history.forward(); true".to_string(), label)
}

#[tauri::command]
pub fn embedded_browser_eval(
    state: tauri::State<'_, EmbeddedBrowserState>,
    script: String,
    label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    let webview = get_entry(&state, &label)?.ready_webview()?;
    webview
        .eval(script)
        .map_err(|error| format!("Failed to evaluate embedded browser script: {error}"))
}

#[tauri::command]
pub async fn embedded_browser_eval_json(
    state: tauri::State<'_, EmbeddedBrowserState>,
    expression: String,
    label: Option<String>,
) -> Result<Value, String> {
    let label = browser_label(label);
    eval_json_nonblocking(
        &state,
        &label,
        script_expression(&expression),
        BRIDGE_EVAL_TIMEOUT_MS,
    )
    .await
}

#[tauri::command]
pub fn embedded_browser_page_state(
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
) -> Result<EmbeddedBrowserPageState, String> {
    let label = browser_label(label);
    page_state_for_label(&state, &label)
}

#[tauri::command]
pub async fn embedded_browser_relabel(
    state: tauri::State<'_, EmbeddedBrowserState>,
    from_label: String,
    to_label: String,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    let mut webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    relabel_logical_entry(&mut webviews, &from_label, &to_label)
}

#[tauri::command]
pub async fn embedded_browser_close(
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    let _lifecycle = state.lifecycle.lock().await;
    let entry = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        webviews.get(&label).cloned()
    };
    if let Some(entry) = entry {
        entry
            .ready_webview()?
            .close()
            .map_err(|error| format!("Failed to close embedded browser: {error}"))?;
        let mut webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        remove_logical_entry_if_native_matches(
            &mut webviews,
            &label,
            &entry.native_label,
            |current| current.native_label.as_str(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn embedded_browser_clear_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
) -> Result<usize, String> {
    let _lifecycle = state.lifecycle.lock().await;
    let webviews = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        if webviews
            .values()
            .any(|entry| entry.readiness() == EmbeddedBrowserReadiness::Opening)
        {
            return Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string());
        }
        webviews
            .values()
            .map(EmbeddedBrowserEntry::ready_webview)
            .collect::<Result<Vec<_>, _>>()?
    };

    if !webviews.is_empty() {
        for webview in &webviews {
            webview
                .clear_all_browsing_data()
                .map_err(|error| format!("Failed to clear embedded browser data: {error}"))?;
        }
        return Ok(webviews.len());
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;
    let cleanup_label = format!(
        "browser-data-cleanup-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let cleanup_url = tauri::Url::parse("about:blank")
        .map_err(|error| format!("Failed to create browser cleanup URL: {error}"))?;
    let builder =
        tauri::webview::WebviewBuilder::new(&cleanup_label, WebviewUrl::External(cleanup_url))
            .data_directory(browser_data_directory(&app)?)
            .data_store_identifier(EMBEDDED_BROWSER_DATA_STORE_ID);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(-10_000.0, -10_000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("Failed to create browser data cleanup view: {error}"))?;
    webview
        .hide()
        .map_err(|error| format!("Failed to hide browser data cleanup view: {error}"))?;
    let clear_result = webview
        .clear_all_browsing_data()
        .map_err(|error| format!("Failed to clear embedded browser data: {error}"));
    let close_result = webview
        .close()
        .map_err(|error| format!("Failed to close browser data cleanup view: {error}"));
    clear_result?;
    close_result?;
    Ok(0)
}
