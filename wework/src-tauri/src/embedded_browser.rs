use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    async_runtime::Mutex as AsyncMutex,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Webview, WebviewUrl, Wry,
};

mod agent_control;
mod bridge_security;
mod browser_runtime;
mod popup;
mod screenshot;

use agent_control::{
    agent_action_signature, agent_action_target, agent_control_paused_result,
    clear_label_agent_state, consume_approved_agent_risk, emit_agent_state,
    is_agent_control_paused, is_agent_mutating_bridge_action, is_agent_observable_bridge_action,
    merge_request_option, register_agent_approval, EmbeddedBrowserApprovalState,
};
use bridge_security::{bridge_navigation_url, bridge_request_authorized, generate_bridge_token};
#[cfg(test)]
use browser_runtime::script_semantic_inspect_for_test as script_semantic_inspect;
use browser_runtime::{
    ax_probe_result, embedded_browser_capabilities, eval_json_nonblocking,
    inspect_embedded_browser, native_input_probe_result, present_probe_result,
    script_browser_action, script_expression, script_resolve_inspect_target,
    wait_for_embedded_browser,
};
use popup::{classify_popup_url, emit_popup_observed};
use screenshot::screenshot_embedded_browser;

const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_WEBVIEW_LABEL: &str = "workspace-browser";
const EMBEDDED_BROWSER_BRIDGE_ADDR: &str = "127.0.0.1:0";
const EMBEDDED_BROWSER_BRIDGE_ADDR_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR";
const EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN";
const BRIDGE_READ_TIMEOUT_MS: u64 = 5_000;
const BRIDGE_EVAL_TIMEOUT_MS: u64 = 10_000;
const BRIDGE_OPEN_WAIT_TIMEOUT_MS: u64 = 15_000;
const BRIDGE_OPEN_WAIT_INTERVAL_MS: u64 = 100;
const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT: &str = "wework:embedded-browser-open-request";
const EMBEDDED_BROWSER_DOWNLOAD_EVENT: &str = "wework:embedded-browser-download";
const EMBEDDED_BROWSER_POPUP_EVENT: &str = "wework:embedded-browser-popup";
const EMBEDDED_BROWSER_AGENT_STATE_EVENT: &str = "wework:embedded-browser-agent-state";
const EMBEDDED_BROWSER_NOT_READY_ERROR: &str = "Embedded browser is not ready";
const EMBEDDED_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const EMBEDDED_BROWSER_DATA_STORE_ID: [u8; 16] = *b"wework-browser01";
const EMBEDDED_BROWSER_DATA_DIRECTORY: &str = "embedded-browser-data";
const EMBEDDED_BROWSER_DIAGNOSTICS_SCRIPT: &str = include_str!("embedded_browser_diagnostics.js");
const EMBEDDED_BROWSER_ACTION_SCRIPT: &str = include_str!("embedded_browser_action.js");
const EMBEDDED_BROWSER_INSPECT_SCRIPT: &str = include_str!("embedded_browser_inspect.js");
const EMBEDDED_BROWSER_WAIT_SCRIPT: &str = include_str!("embedded_browser_wait.js");
static EMBEDDED_BROWSER_DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_BRIDGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_NATIVE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_SCREENSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_POPUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct EmbeddedBrowserState {
    webviews: Arc<Mutex<HashMap<String, EmbeddedBrowserEntry>>>,
    downloads: Arc<Mutex<HashMap<String, EmbeddedBrowserDownloadControl>>>,
    agent_control_paused: Arc<Mutex<HashMap<String, bool>>>,
    agent_approvals: Arc<Mutex<HashMap<String, EmbeddedBrowserApprovalState>>>,
    lifecycle: Arc<AsyncMutex<()>>,
}

#[derive(Clone)]
struct EmbeddedBrowserEntry {
    native_label: String,
    title: Option<String>,
    url: Option<String>,
    opened_at_unix_ms: u128,
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
    options: Option<Value>,
    inspect_id: Option<String>,
    index: Option<u64>,
    #[serde(rename = "ref")]
    ref_: Option<String>,
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

fn start_native_browser_download(
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
        failed: Arc::new(AtomicBool::new(false)),
        received_bytes: Arc::new(AtomicU64::new(0)),
        total_bytes: Arc::new(AtomicU64::new(0)),
    };
    if let Ok(mut downloads) = state.downloads.lock() {
        downloads.insert(id, control.clone());
    }
    control.emit("started");
}

fn finish_native_browser_download(
    state: &EmbeddedBrowserState,
    native_label: &str,
    url: &str,
    success: bool,
) {
    let control = state.downloads.lock().ok().and_then(|downloads| {
        downloads
            .values()
            .find(|control| control.native_label == native_label && control.url == url)
            .cloned()
    });
    let Some(control) = control else {
        return;
    };
    if success {
        control.emit("finished");
        if let Ok(mut downloads) = state.downloads.lock() {
            downloads.remove(&control.id);
        }
    } else {
        control.failed.store(true, Ordering::Relaxed);
        control.emit("failed");
    }
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

fn current_logical_owner_or(
    state: &EmbeddedBrowserState,
    native_label: &str,
    fallback_label: &str,
) -> String {
    current_logical_owner(state, native_label)
        .ok()
        .flatten()
        .unwrap_or_else(|| fallback_label.to_string())
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

fn embedded_browser_entry_snapshot(state: &EmbeddedBrowserState, label: &str) -> Option<Value> {
    let webviews = state.webviews.lock().ok()?;
    let entry = webviews.get(label)?;
    let readiness = match entry.readiness() {
        EmbeddedBrowserReadiness::Opening => "opening",
        EmbeddedBrowserReadiness::Ready => "ready",
    };
    Some(json!({
        "label": label,
        "nativeLabel": &entry.native_label,
        "title": &entry.title,
        "url": &entry.url,
        "readiness": readiness,
        "openedAtUnixMs": entry.opened_at_unix_ms,
        "ageMs": current_unix_millis().saturating_sub(entry.opened_at_unix_ms),
    }))
}

fn embedded_browser_page_diagnostics_script() -> String {
    r#"(() => {
  try {
    const navigation = performance.getEntriesByType('navigation')[0] || null;
    return {
      ok: true,
      kind: 'browser.pageDiagnostics',
      href: location.href,
      title: document.title || '',
      readyState: document.readyState,
      visibilityState: document.visibilityState || '',
      referrer: document.referrer || '',
      bodyChildElementCount: document.body ? document.body.children.length : null,
      bodyTextLength: document.body ? (document.body.innerText || '').length : null,
      bodyHtmlLength: document.body ? (document.body.innerHTML || '').length : null,
      htmlLength: document.documentElement ? (document.documentElement.outerHTML || '').length : null,
      navigation: navigation ? {
        type: navigation.type || '',
        redirectCount: navigation.redirectCount ?? null,
        transferSize: navigation.transferSize ?? null,
        encodedBodySize: navigation.encodedBodySize ?? null,
        decodedBodySize: navigation.decodedBodySize ?? null,
        domContentLoadedEventEnd: navigation.domContentLoadedEventEnd ?? null,
        loadEventEnd: navigation.loadEventEnd ?? null,
        responseStart: navigation.responseStart ?? null,
        responseEnd: navigation.responseEnd ?? null,
      } : null,
      timestampUnixMs: Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'browser.pageDiagnostics',
      error: String(error?.stack || error?.message || error),
      timestampUnixMs: Date.now(),
    };
  }
})()"#
    .to_string()
}

fn log_embedded_browser_diagnostic(
    state: &EmbeddedBrowserState,
    label: &str,
    stage: &str,
    detail: Value,
) {
    let Some(entry_snapshot) = embedded_browser_entry_snapshot(state, label) else {
        log::info!("Embedded browser diagnostic stage={stage} label={label} detail={detail}");
        return;
    };
    let payload = json!({
        "kind": "browser.navigationDiagnostic",
        "stage": stage,
        "timestampUnixMs": current_unix_millis(),
        "entry": entry_snapshot,
        "detail": detail,
    });
    log::info!("Embedded browser diagnostic: {payload}");
}

fn log_embedded_browser_page_diagnostics(
    state: EmbeddedBrowserState,
    label: String,
    stage: &'static str,
) {
    thread::spawn(move || {
        let detail = match eval_json(
            &state,
            &label,
            embedded_browser_page_diagnostics_script(),
            BRIDGE_EVAL_TIMEOUT_MS,
        ) {
            Ok(value) => value,
            Err(error) => json!({
                "ok": false,
                "kind": "browser.pageDiagnostics",
                "error": error,
                "timestampUnixMs": current_unix_millis(),
            }),
        };
        log_embedded_browser_diagnostic(
            &state,
            &label,
            stage,
            json!({
                "page": detail,
            }),
        );
    });
}

fn navigate_label(state: &EmbeddedBrowserState, label: &str, url: String) -> Result<(), String> {
    let parsed_url = browser_url(&url)?;
    let parsed_url_string = parsed_url.to_string();
    let entry = get_entry(state, label)?;
    log_embedded_browser_diagnostic(
        state,
        label,
        "navigate_requested",
        json!({
            "requestedUrl": &url,
            "parsedUrl": parsed_url_string,
        }),
    );
    if let Err(error) = entry.ready_webview()?.navigate(parsed_url) {
        let message = format!("Failed to navigate embedded browser: {error}");
        log_embedded_browser_diagnostic(
            state,
            label,
            "navigate_failed",
            json!({
                "requestedUrl": &url,
                "error": &message,
            }),
        );
        return Err(message);
    }
    set_entry_url_for_native_label(state, &entry.native_label, url.clone())?;
    log_embedded_browser_diagnostic(
        state,
        label,
        "navigate_dispatched",
        json!({
            "requestedUrl": url,
        }),
    );
    Ok(())
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

    log_embedded_browser_diagnostic(
        state,
        label,
        "open_waiting_for_ready",
        json!({
            "requestedUrl": url,
        }),
    );
    if let Err(error) = wait_for_browser_ready(
        || entry_readiness(state, label),
        BRIDGE_OPEN_WAIT_TIMEOUT_MS / BRIDGE_OPEN_WAIT_INTERVAL_MS,
        Duration::from_millis(BRIDGE_OPEN_WAIT_INTERVAL_MS),
    ) {
        log_embedded_browser_diagnostic(
            state,
            label,
            "open_wait_timeout",
            json!({
                "requestedUrl": url,
                "error": error,
            }),
        );
        return Err(error);
    }
    log_embedded_browser_diagnostic(
        state,
        label,
        "open_ready",
        json!({
            "requestedUrl": url,
        }),
    );
    Ok(())
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

fn current_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
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
    mut request: EmbeddedBrowserBridgeRequest,
) -> Result<Value, String> {
    let label = browser_label(request.label.clone());
    let action = request.action.clone();
    let observable = is_agent_observable_bridge_action(&action);
    let mutating = is_agent_mutating_bridge_action(&action);
    let target = agent_action_target(&request);
    let action_signature = agent_action_signature(&action, &request);

    if mutating && is_agent_control_paused(state, &label)? {
        emit_agent_state(
            app,
            &label,
            "paused",
            Some(&action),
            target,
            Some("User is controlling the embedded browser.".to_string()),
            Some("user_control".to_string()),
            None,
        );
        return Ok(agent_control_paused_result(&action));
    }

    if mutating && consume_approved_agent_risk(state, &label, &action_signature)? {
        merge_request_option(&mut request, "riskApproved", Value::Bool(true));
    }

    if observable {
        emit_agent_state(
            app,
            &label,
            "running",
            Some(&action),
            target.clone(),
            None,
            None,
            None,
        );
    }

    let mut result = match action.as_str() {
        "status" => Ok(json!({
            "open": is_browser_open(state, &label)?,
            "label": label.clone(),
        })),
        "pageState" => serde_json::to_value(page_state_for_label(state, &label)?)
            .map_err(|error| format!("Failed to encode embedded browser page state: {error}")),
        "capabilities" => Ok(embedded_browser_capabilities()),
        "navigate" | "open" => {
            let url = request
                .url
                .ok_or_else(|| "Embedded browser navigate requires url".to_string())?;
            bridge_navigation_url(&url)?;
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
        "inspect" => inspect_embedded_browser(
            state,
            &label,
            request.options.unwrap_or_else(|| json!({})),
            request.timeout_ms.unwrap_or(3_000),
        ),
        "resolveRef" => eval_json(
            state,
            &label,
            script_resolve_inspect_target(&request),
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "click" => eval_json(
            state,
            &label,
            script_browser_action("click", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "typeText" => eval_json(
            state,
            &label,
            script_browser_action("type", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "fill" => eval_json(
            state,
            &label,
            script_browser_action("fill", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "hover" => eval_json(
            state,
            &label,
            script_browser_action("hover", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "focus" => eval_json(
            state,
            &label,
            script_browser_action("focus", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "select" => eval_json(
            state,
            &label,
            script_browser_action("select", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "setChecked" => eval_json(
            state,
            &label,
            script_browser_action("setChecked", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "scroll" => eval_json(
            state,
            &label,
            script_browser_action("scroll", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "scrollIntoView" => eval_json(
            state,
            &label,
            script_browser_action("scrollIntoView", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "press" => eval_json(
            state,
            &label,
            script_browser_action("press", &request)?,
            request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        ),
        "waitFor" => wait_for_embedded_browser(state, &label, &request),
        "screenshot" => screenshot_embedded_browser(state, &label),
        "nativeInputProbe" => Ok(native_input_probe_result(&request)),
        "axProbe" => Ok(ax_probe_result()),
        "present" => present_probe_result(state, &label),
        _ => Err(format!(
            "Unknown embedded browser bridge action: {}",
            action
        )),
    };

    let approval = match &mut result {
        Ok(value) if mutating => {
            register_agent_approval(state, &label, &action, &action_signature, value)?
        }
        _ => None,
    };

    if observable {
        match &result {
            Ok(value) => {
                let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
                let error_code = value
                    .get("error")
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let message = value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                emit_agent_state(
                    app,
                    &label,
                    if ok { "idle" } else { "needs_user" },
                    Some(&action),
                    target,
                    message,
                    error_code,
                    approval,
                );
            }
            Err(error) => emit_agent_state(
                app,
                &label,
                "error",
                Some(&action),
                target,
                Some(error.clone()),
                Some("operation_failed".to_string()),
                None,
            ),
        }
    }

    result
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
                options: None,
                inspect_id: None,
                index: None,
                ref_: None,
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
    let bridge_token = generate_bridge_token()?;
    env::set_var(EMBEDDED_BROWSER_BRIDGE_ADDR_ENV, listening_addr.to_string());
    env::set_var(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV, bridge_token);
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
        log_embedded_browser_diagnostic(
            &state,
            &label,
            "open_reuse_existing",
            json!({
                "requestedUrl": &url,
                "nativeLabel": &entry.native_label,
            }),
        );
        if let Err(error) = webview.navigate(parsed_url) {
            let message = format!("Failed to navigate embedded browser: {error}");
            log_embedded_browser_diagnostic(
                &state,
                &label,
                "open_reuse_navigate_failed",
                json!({
                    "requestedUrl": &url,
                    "nativeLabel": &entry.native_label,
                    "error": &message,
                }),
            );
            return Err(message);
        }
        if let Err(error) = webview
            .show()
            .map_err(|error| format!("Failed to show embedded browser: {error}"))
        {
            log_embedded_browser_diagnostic(
                &state,
                &label,
                "open_reuse_show_failed",
                json!({
                    "requestedUrl": &url,
                    "nativeLabel": &entry.native_label,
                    "error": &error,
                }),
            );
            return Err(error);
        }
        set_entry_url(&state, &label, Some(url.clone()))?;
        log_embedded_browser_diagnostic(
            &state,
            &label,
            "open_reuse_dispatched",
            json!({
                "requestedUrl": &url,
                "nativeLabel": &entry.native_label,
            }),
        );
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
    let native_label_for_navigation = native_label.clone();
    let native_label_for_title = native_label.clone();
    let native_label_for_popup = native_label.clone();
    let app_for_popup = app.clone();
    let data_directory = browser_data_directory(&app)?;

    let entry = EmbeddedBrowserEntry {
        native_label: native_label.clone(),
        title: None,
        url: Some(url.clone()),
        opened_at_unix_ms: current_unix_millis(),
        phase: EmbeddedBrowserPhase::Opening,
    };
    state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .insert(label.clone(), entry);

    log_embedded_browser_diagnostic(
        &state,
        &label,
        "open_requested",
        json!({
            "requestedUrl": &url,
            "bounds": {
                "x": normalized_bounds.position.x,
                "y": normalized_bounds.position.y,
                "width": normalized_bounds.size.width,
                "height": normalized_bounds.size.height,
            },
            "nativeLabel": &native_label,
        }),
    );

    let builder =
        tauri::webview::WebviewBuilder::new(&native_label, browser_webview_url(parsed_url))
            .user_agent(EMBEDDED_BROWSER_USER_AGENT)
            .data_directory(data_directory)
            .data_store_identifier(EMBEDDED_BROWSER_DATA_STORE_ID)
            .initialization_script(EMBEDDED_BROWSER_DIAGNOSTICS_SCRIPT)
            .devtools(true)
            .accept_first_mouse(true)
            .on_navigation({
                let state = state.inner().clone();
                move |url| {
                    let owner = current_logical_owner_or(
                        &state,
                        &native_label_for_navigation,
                        &native_label_for_navigation,
                    );
                    log_embedded_browser_diagnostic(
                        &state,
                        &owner,
                        "navigation_requested",
                        json!({
                            "requestedUrl": url.to_string(),
                        }),
                    );
                    true
                }
            })
            .on_page_load(move |webview, payload| {
                let event = format!("{:?}", payload.event());
                let current_url = payload.url().to_string();
                let webview_url = webview.url().ok().map(|url| url.to_string());
                let owner = current_logical_owner_or(
                    &load_state_handle,
                    &native_label_for_load,
                    &native_label_for_load,
                );
                log_embedded_browser_diagnostic(
                    &load_state_handle,
                    &owner,
                    "page_load_event",
                    json!({
                        "event": event,
                        "payloadUrl": current_url,
                        "webviewUrl": webview_url.clone(),
                    }),
                );
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let loaded_url = webview_url.clone().or(Some(current_url.clone()));
                    let _ = update_entry_for_native_label(
                        &load_state_handle,
                        &native_label_for_load,
                        |entry| entry.url = loaded_url,
                    );
                    log_embedded_browser_page_diagnostics(
                        load_state_handle.clone(),
                        owner,
                        "page_load_finished",
                    );
                }
            })
            .on_document_title_changed(move |_webview, title| {
                let _ = update_entry_for_native_label(
                    &title_state_handle,
                    &native_label_for_title,
                    |entry| entry.title = Some(title),
                );
            })
            .on_new_window(move |url, _features| {
                let parent_label = current_logical_owner_or(
                    app_for_popup.state::<EmbeddedBrowserState>().inner(),
                    &native_label_for_popup,
                    &native_label_for_popup,
                );
                emit_popup_observed(
                    &app_for_popup,
                    &parent_label,
                    &native_label_for_popup,
                    url.clone(),
                );
                let (_kind, strategy, _warning) = classify_popup_url(&url);
                if strategy == "user_confirmation_required"
                    || strategy == "controlled_popup_required"
                {
                    NewWindowResponse::Deny
                } else {
                    NewWindowResponse::Allow
                }
            });

    #[cfg(desktop)]
    let builder = {
        let download_app = app.clone();
        let download_native_label = native_label.clone();
        let download_state = state.inner().clone();
        builder.on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                match browser_download_destination(&download_app, destination) {
                    Ok((path, _suggested_name, _ask_before_download)) => {
                        let url = url.to_string();
                        *destination = path.clone();
                        start_native_browser_download(
                            download_app.clone(),
                            download_state.clone(),
                            download_native_label.clone(),
                            url,
                            path,
                        );
                        true
                    }
                    Err(error) => {
                        log::warn!("Failed to prepare embedded browser download: {error}");
                        false
                    }
                }
            }
            DownloadEvent::Finished {
                url,
                path: _,
                success,
            } => {
                finish_native_browser_download(
                    &download_state,
                    &download_native_label,
                    &url.to_string(),
                    success,
                );
                true
            }
            _ => true,
        })
    };

    let webview =
        match window.add_child(builder, normalized_bounds.position, normalized_bounds.size) {
            Ok(webview) => webview,
            Err(error) => {
                log_embedded_browser_diagnostic(
                    &state,
                    &label,
                    "open_create_failed",
                    json!({
                        "nativeLabel": &native_label,
                        "error": error.to_string(),
                    }),
                );
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

    log_embedded_browser_diagnostic(
        &state,
        &label,
        "open_created",
        json!({
            "nativeLabel": &native_label,
        }),
    );

    if let Err(error) = webview
        .show()
        .map_err(|error| format!("Failed to show embedded browser: {error}"))
    {
        log_embedded_browser_diagnostic(
            &state,
            &label,
            "open_show_failed",
            json!({
                "nativeLabel": &native_label,
                "error": &error,
            }),
        );
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
    log_embedded_browser_diagnostic(
        &state,
        &label,
        "open_visible",
        json!({
            "nativeLabel": &native_label,
        }),
    );
    if let Err(error) = mark_entry_ready_for_native_label(&state, &native_label, webview.clone()) {
        log_embedded_browser_diagnostic(
            &state,
            &label,
            "open_ready_failed",
            json!({
                "nativeLabel": &native_label,
                "error": &error,
            }),
        );
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
    log_embedded_browser_diagnostic(
        &state,
        &label,
        "open_ready",
        json!({
            "nativeLabel": &native_label,
        }),
    );

    Ok(EmbeddedBrowserPageState {
        native_label,
        title: None,
        url: Some(url),
    })
}

#[cfg(test)]
mod tests;

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
    let _ = browser_download_control(&state, &id)?;
    Err("Native WebKit downloads cannot be paused".to_string())
}

#[tauri::command]
pub fn embedded_browser_resume_download(
    state: tauri::State<'_, EmbeddedBrowserState>,
    id: String,
) -> Result<(), String> {
    let _ = browser_download_control(&state, &id)?;
    Err("Native WebKit downloads cannot be resumed".to_string())
}

#[tauri::command]
pub fn embedded_browser_delete_download(
    state: tauri::State<'_, EmbeddedBrowserState>,
    id: String,
) -> Result<(), String> {
    let control = browser_download_control(&state, &id)?;
    if !control.failed.load(Ordering::Relaxed) {
        return Err("Native WebKit downloads cannot be deleted while in progress".to_string());
    }
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
pub fn embedded_browser_set_agent_control_paused(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
    paused: bool,
) -> Result<(), String> {
    agent_control::set_agent_control_paused(app, state, label, paused)
}

#[tauri::command]
pub fn embedded_browser_resolve_agent_approval(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    agent_control::resolve_agent_approval(app, state, label, approval_id, approved)
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
    clear_label_agent_state(&state, &label)
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
