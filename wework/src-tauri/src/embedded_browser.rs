use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    async_runtime::Mutex as AsyncMutex,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Wry,
};

#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;
#[cfg(not(target_os = "linux"))]
use tauri::{Position, Rect, Size};

mod agent_control;
mod bridge_security;
mod bridge_server;
mod browser_runtime;
mod data_clearing;
#[cfg(target_os = "linux")]
mod linux_host;
mod local_file_preview;
mod popup;
mod screenshot;

const EMBEDDED_BROWSER_CLOSE_EVENT: &str = "wework:embedded-browser-close";

use agent_control::{
    agent_action_signature, agent_action_target, agent_control_paused_result,
    clear_label_agent_state, consume_approved_agent_risk, emit_agent_state,
    is_agent_control_paused, is_agent_mutating_bridge_action, is_agent_observable_bridge_action,
    merge_request_option, register_agent_approval, EmbeddedBrowserApprovalState,
};
use bridge_security::bridge_navigation_url;
#[cfg(test)]
use bridge_security::bridge_request_authorized;
#[cfg(test)]
use bridge_server::read_http_request;
pub(crate) use bridge_server::{
    embedded_browser_bridge_runtime_path, start_embedded_browser_bridge,
};
#[cfg(test)]
use browser_runtime::script_semantic_inspect_for_test as script_semantic_inspect;
use browser_runtime::{
    ax_probe_result, embedded_browser_capabilities, eval_json_nonblocking,
    inspect_embedded_browser, native_input_probe_result, present_probe_result,
    script_browser_action, script_expression, script_resolve_inspect_target,
    wait_for_embedded_browser,
};
use data_clearing::{clear_embedded_browser_data, EmbeddedBrowserDataKind};
#[cfg(test)]
pub(crate) use local_file_preview::{
    browser_file_url_from_path, directory_entry_modified_unix_seconds, directory_listing_html,
    format_directory_entry_modified, format_file_size, DirectoryEntry,
};
use local_file_preview::{
    build_directory_preview, build_text_preview, file_url_path, is_generated_preview_path,
    is_natively_renderable_html, local_file_browser_title, should_block_local_file_preview,
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
const BRIDGE_OPEN_REQUEST_REPLAY_INTERVAL_MS: u64 = 500;
const AGENT_TAB_ROUTE_TTL_MS: u128 = 60_000;
const EMBEDDED_BROWSER_PLACEHOLDER_URL: &str = "about:blank";
const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT: &str = "wework:embedded-browser-open-request";
const EMBEDDED_BROWSER_DOWNLOAD_EVENT: &str = "wework:embedded-browser-download";
const EMBEDDED_BROWSER_LOCAL_FILE_PREVIEW_EVENT: &str =
    "wework:embedded-browser-local-file-preview";
const EMBEDDED_BROWSER_PAGE_STATE_CHANGE_EVENT: &str = "wework:embedded-browser-page-state-change";
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
static EMBEDDED_BROWSER_OPEN_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_SCREENSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EMBEDDED_BROWSER_POPUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct EmbeddedBrowserState {
    webviews: Arc<Mutex<HashMap<String, EmbeddedBrowserEntry>>>,
    downloads: Arc<Mutex<HashMap<String, EmbeddedBrowserDownloadControl>>>,
    preview_sources: Arc<Mutex<HashMap<String, String>>>,
    agent_control_paused: Arc<Mutex<HashMap<String, bool>>>,
    agent_approvals: Arc<Mutex<HashMap<String, EmbeddedBrowserApprovalState>>>,
    pending_open_requests: Arc<Mutex<HashMap<String, EmbeddedBrowserOpenRequest>>>,
    active_tabs: Arc<Mutex<HashMap<String, String>>>,
    agent_tabs: Arc<Mutex<HashMap<(String, String), AgentTabRoute>>>,
    lifecycle: Arc<AsyncMutex<()>>,
}

#[derive(Clone)]
struct EmbeddedBrowserEntry {
    native_label: String,
    title: Option<String>,
    url: Option<String>,
    loaded_url: Option<String>,
    opened_at_unix_ms: u128,
    phase: EmbeddedBrowserPhase,
}

#[derive(Clone)]
struct AgentTabRoute {
    label: String,
    last_request_at_unix_ms: u128,
    closed_at_unix_ms: Option<u128>,
}

#[derive(Clone)]
enum EmbeddedBrowserPhase {
    Opening,
    Hidden(Webview<Wry>),
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
            EmbeddedBrowserPhase::Hidden(_) => EmbeddedBrowserReadiness::Opening,
            EmbeddedBrowserPhase::Ready(_) => EmbeddedBrowserReadiness::Ready,
        }
    }

    fn ready_webview(&self) -> Result<Webview<Wry>, String> {
        match &self.phase {
            EmbeddedBrowserPhase::Ready(webview) => Ok(webview.clone()),
            EmbeddedBrowserPhase::Opening | EmbeddedBrowserPhase::Hidden(_) => {
                Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string())
            }
        }
    }

    fn available_webview(&self) -> Result<Webview<Wry>, String> {
        match &self.phase {
            EmbeddedBrowserPhase::Hidden(webview) | EmbeddedBrowserPhase::Ready(webview) => {
                Ok(webview.clone())
            }
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
    invalid_tls_certificate: Option<EmbeddedBrowserInvalidTlsCertificate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedBrowserInvalidTlsCertificate {
    pub(crate) native_label: String,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) port: u16,
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
    browser_session_id: Option<String>,
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
pub struct EmbeddedBrowserOpenRequest {
    id: String,
    url: String,
    base_label: String,
    source: String,
    disposition: String,
    target_label: Option<String>,
    parent_label: Option<String>,
    browser_session_id: Option<String>,
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserLocalFilePreviewPayload {
    label: String,
    native_label: String,
    url: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserPageStateChangePayload {
    label: String,
    native_label: String,
    title: Option<String>,
    url: Option<String>,
    invalid_tls_certificate: Option<EmbeddedBrowserInvalidTlsCertificate>,
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
    #[cfg(not(target_os = "linux"))]
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

#[cfg(target_os = "linux")]
fn apply_webview_bounds(webview: &Webview<Wry>, bounds: NormalizedBounds) -> Result<(), String> {
    linux_host::apply_bounds(webview, bounds.position, bounds.size)
}

#[cfg(not(target_os = "linux"))]
fn apply_webview_bounds(webview: &Webview<Wry>, bounds: NormalizedBounds) -> Result<(), String> {
    webview
        .set_bounds(bounds.rect())
        .map_err(|error| format!("Failed to set embedded browser bounds: {error}"))
}

fn browser_url(url: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(url).map_err(|error| format!("Invalid browser URL: {error}"))
}

fn preview_source_url(state: &EmbeddedBrowserState, display_url: &str) -> Option<String> {
    state
        .preview_sources
        .lock()
        .ok()
        .and_then(|previews| previews.get(display_url).cloned())
}

fn register_preview_source(state: &EmbeddedBrowserState, display_url: &str, requested_url: &str) {
    if let Ok(mut previews) = state.preview_sources.lock() {
        previews.insert(display_url.to_string(), requested_url.to_string());
    }
}

fn resolve_browser_navigation_url(
    state: &EmbeddedBrowserState,
    requested_url: &str,
) -> Result<tauri::Url, String> {
    let parsed_url = browser_url(requested_url)?;
    if parsed_url.scheme() != "file" {
        return Ok(parsed_url);
    }

    let Ok(path) = file_url_path(&parsed_url) else {
        return Ok(parsed_url);
    };
    if is_generated_preview_path(&path) {
        return Ok(parsed_url);
    }
    if !path.is_dir() {
        if is_natively_renderable_html(&path) {
            return Ok(parsed_url);
        }
        if let Some((display_url, source_url)) = build_text_preview(&parsed_url)? {
            register_preview_source(state, display_url.as_str(), &source_url);
            return Ok(display_url);
        }
        return Ok(parsed_url);
    }

    let (display_url, source_url) = build_directory_preview(&parsed_url)?;
    register_preview_source(state, display_url.as_str(), &source_url);
    Ok(display_url)
}

fn loaded_browser_url(state: &EmbeddedBrowserState, loaded_url: &str) -> Option<String> {
    if !should_record_loaded_url(loaded_url) {
        return None;
    }
    Some(preview_source_url(state, loaded_url).unwrap_or_else(|| loaded_url.to_string()))
}

#[cfg(any(not(target_os = "macos"), test))]
fn browser_webview_url(url: tauri::Url) -> WebviewUrl {
    match url.scheme() {
        "http" | "https" | "file" => WebviewUrl::External(url),
        _ => WebviewUrl::CustomProtocol(url),
    }
}

#[cfg(target_os = "macos")]
fn initial_browser_webview_url() -> Result<WebviewUrl, String> {
    browser_url(EMBEDDED_BROWSER_PLACEHOLDER_URL).map(WebviewUrl::External)
}

fn should_record_loaded_url(url: &str) -> bool {
    url != EMBEDDED_BROWSER_PLACEHOLDER_URL
}

fn browser_label(label: Option<String>) -> String {
    label.unwrap_or_else(|| BROWSER_WEBVIEW_LABEL.to_string())
}

fn resolve_agent_bridge_label(
    state: &EmbeddedBrowserState,
    base_label: &str,
    browser_session_id: Option<&str>,
) -> Result<String, String> {
    let now = current_unix_millis();
    let session_id = browser_session_id.filter(|value| !value.trim().is_empty());
    if let Some(session_id) = session_id {
        let key = (base_label.to_string(), session_id.to_string());
        let paused_labels = state
            .agent_control_paused
            .lock()
            .map_err(|_| "Embedded browser agent control state lock poisoned".to_string())?
            .iter()
            .filter_map(|(label, paused)| (*paused).then_some(label.clone()))
            .collect::<std::collections::HashSet<_>>();
        let approval_labels = state
            .agent_approvals
            .lock()
            .map_err(|_| "Embedded browser approval state lock poisoned".to_string())?
            .values()
            .filter(|approval| approval.payload.expires_at_unix_ms > now)
            .map(|approval| approval.label.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut agent_tabs = state
            .agent_tabs
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        agent_tabs.retain(|_, route| {
            route.closed_at_unix_ms.is_some()
                || paused_labels.contains(&route.label)
                || approval_labels.contains(&route.label)
                || now.saturating_sub(route.last_request_at_unix_ms) <= AGENT_TAB_ROUTE_TTL_MS
        });
        if let Some(route) = agent_tabs.get_mut(&key) {
            if route.closed_at_unix_ms.is_some() {
                return Err("agent tab was closed".to_string());
            }
            route.last_request_at_unix_ms = now;
            return Ok(route.label.clone());
        }
        let active_label = state
            .active_tabs
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?
            .get(base_label)
            .cloned()
            .unwrap_or_else(|| base_label.to_string());
        agent_tabs.insert(
            key,
            AgentTabRoute {
                label: active_label.clone(),
                last_request_at_unix_ms: now,
                closed_at_unix_ms: None,
            },
        );
        return Ok(active_label);
    }

    Ok(state
        .active_tabs
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .get(base_label)
        .cloned()
        .unwrap_or_else(|| base_label.to_string()))
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

fn emit_local_file_preview_blocked(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    native_label: &str,
    url: &str,
) {
    let label = state.webviews.lock().ok().and_then(|webviews| {
        download_event_owner(
            webviews.iter().map(|(logical_label, entry)| {
                (logical_label.as_str(), entry.native_label.as_str())
            }),
            native_label,
        )
    });
    let Some(label) = label else { return };
    let _ = app.emit(
        EMBEDDED_BROWSER_LOCAL_FILE_PREVIEW_EVENT,
        EmbeddedBrowserLocalFilePreviewPayload {
            label,
            native_label: native_label.to_string(),
            url: url.to_string(),
        },
    );
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

fn available_logical_entry<'a, T>(
    entries: &'a HashMap<String, T>,
    logical_label: &str,
    available: impl Fn(&T) -> bool,
) -> Result<&'a T, String> {
    match entries.get(logical_label) {
        Some(entry) if available(entry) => Ok(entry),
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

fn wait_for_browser_ready_with_observer(
    mut readiness: impl FnMut() -> Result<Option<EmbeddedBrowserReadiness>, String>,
    attempts: u64,
    interval: Duration,
    mut observer: impl FnMut(u64, Option<EmbeddedBrowserReadiness>) -> Result<(), String>,
) -> Result<(), String> {
    for attempt in 0..attempts {
        let current_readiness = readiness()?;
        if current_readiness == Some(EmbeddedBrowserReadiness::Ready) {
            return Ok(());
        }
        observer(attempt, current_readiness)?;
        thread::sleep(interval);
    }
    Err("Timed out waiting for Wework to open the embedded browser tab".to_string())
}

fn wait_for_browser_navigation(
    state: &EmbeddedBrowserState,
    label: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    loop {
        let loaded_url = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?
            .get(label)
            .ok_or_else(|| "Embedded browser is not open".to_string())?
            .loaded_url
            .clone();
        if loaded_url.is_some() {
            return Ok(());
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            return Err("Timed out waiting for embedded browser navigation".to_string());
        }
        thread::sleep(Duration::from_millis(BRIDGE_OPEN_WAIT_INTERVAL_MS));
    }
}

fn should_replay_browser_open_request(
    attempt: u64,
    readiness: Option<EmbeddedBrowserReadiness>,
) -> bool {
    let replay_stride = BRIDGE_OPEN_REQUEST_REPLAY_INTERVAL_MS
        .div_ceil(BRIDGE_OPEN_WAIT_INTERVAL_MS)
        .max(1);
    attempt > 0 && readiness.is_none() && attempt % replay_stride == 0
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

fn relabel_tab_routes(
    state: &EmbeddedBrowserState,
    from_label: &str,
    to_label: &str,
) -> Result<(), String> {
    {
        let mut active_tabs = state
            .active_tabs
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        if let Some(active_label) = active_tabs.remove(from_label) {
            active_tabs.insert(
                to_label.to_string(),
                (active_label == from_label)
                    .then(|| to_label.to_string())
                    .unwrap_or(active_label),
            );
        }
        for active_label in active_tabs.values_mut() {
            if active_label == from_label {
                *active_label = to_label.to_string();
            }
        }
    }
    let mut agent_tabs = state
        .agent_tabs
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    let entries = agent_tabs
        .drain()
        .map(|((base_label, session_id), mut route)| {
            let next_base = if base_label == from_label {
                to_label.to_string()
            } else {
                base_label
            };
            let next_tab = if route.label == from_label {
                to_label.to_string()
            } else {
                route.label.clone()
            };
            route.label = next_tab;
            ((next_base, session_id), route)
        })
        .collect::<Vec<_>>();
    agent_tabs.extend(entries);
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

fn get_available_entry(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<EmbeddedBrowserEntry, String> {
    let webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    available_logical_entry(&webviews, label, |entry| {
        !matches!(entry.phase, EmbeddedBrowserPhase::Opening)
    })
    .cloned()
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
    bridge_ready: bool,
) -> Result<(), String> {
    let updated = update_entry_for_native_label(state, native_label, |entry| {
        entry.phase = if bridge_ready {
            EmbeddedBrowserPhase::Ready(webview)
        } else {
            EmbeddedBrowserPhase::Hidden(webview)
        };
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
    let entry = get_available_entry(state, label)?;
    Ok(EmbeddedBrowserPageState {
        #[cfg(target_os = "macos")]
        invalid_tls_certificate: crate::embedded_browser_tls::invalid_tls_certificate(
            &entry.native_label,
        ),
        #[cfg(not(target_os = "macos"))]
        invalid_tls_certificate: None,
        native_label: entry.native_label,
        title: entry.title,
        url: entry.url,
    })
}

fn emit_page_state_change(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    label: String,
    native_label: String,
) {
    let (title, url) = state
        .webviews
        .lock()
        .ok()
        .and_then(|webviews| {
            webviews
                .get(&label)
                .filter(|entry| entry.native_label == native_label)
                .map(|entry| (entry.title.clone(), entry.url.clone()))
        })
        .unwrap_or((None, None));
    #[cfg(target_os = "macos")]
    let invalid_tls_certificate =
        crate::embedded_browser_tls::invalid_tls_certificate(&native_label);
    #[cfg(not(target_os = "macos"))]
    let invalid_tls_certificate = None;
    let _ = app.emit(
        EMBEDDED_BROWSER_PAGE_STATE_CHANGE_EVENT,
        EmbeddedBrowserPageStateChangePayload {
            label,
            native_label,
            title,
            url,
            invalid_tls_certificate,
        },
    );
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
        "loadedUrl": &entry.loaded_url,
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
    let display_url = resolve_browser_navigation_url(state, &url)?;
    let display_url_string = display_url.to_string();
    let entry = get_entry(state, label)?;
    log_embedded_browser_diagnostic(
        state,
        label,
        "navigate_requested",
        json!({
            "requestedUrl": &url,
            "displayUrl": display_url_string,
        }),
    );
    update_entry_for_native_label(state, &entry.native_label, |entry| {
        entry.url = Some(url.clone());
        entry.loaded_url = None;
    })?;
    if let Err(error) = entry.ready_webview()?.navigate(display_url) {
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
    base_label: &str,
    target_label: &str,
    url: &str,
    browser_session_id: Option<&str>,
) -> Result<(), String> {
    let request_id = match browser_open_action(entry_readiness(state, target_label)?) {
        EmbeddedBrowserOpenAction::Ready => return Ok(()),
        EmbeddedBrowserOpenAction::WaitForReady => state
            .pending_open_requests
            .lock()
            .map_err(|_| "Embedded browser pending request lock poisoned".to_string())?
            .get(target_label)
            .map(|request| request.id.clone()),
        EmbeddedBrowserOpenAction::RequestOpen => {
            let request = EmbeddedBrowserOpenRequest {
                id: format!(
                    "agent-open-{}",
                    EMBEDDED_BROWSER_OPEN_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                ),
                url: url.to_string(),
                base_label: base_label.to_string(),
                source: "agent".to_string(),
                disposition: "current-tab".to_string(),
                target_label: Some(target_label.to_string()),
                parent_label: None,
                browser_session_id: browser_session_id.map(str::to_string),
            };
            let request_id = request.id.clone();
            state
                .pending_open_requests
                .lock()
                .map_err(|_| "Embedded browser pending request lock poisoned".to_string())?
                .insert(target_label.to_string(), request.clone());
            if let Err(error) = app.emit(EMBEDDED_BROWSER_OPEN_REQUEST_EVENT, request) {
                if let Ok(mut requests) = state.pending_open_requests.lock() {
                    requests.remove(target_label);
                }
                return Err(format!("Failed to request embedded browser open: {error}"));
            }
            log_embedded_browser_diagnostic(
                state,
                base_label,
                "open_request_emitted",
                json!({
                    "requestedUrl": url,
                    "requestId": request_id,
                }),
            );
            Some(request_id)
        }
    };

    log_embedded_browser_diagnostic(
        state,
        base_label,
        "open_waiting_for_ready",
        json!({
            "requestedUrl": url,
            "requestId": request_id,
        }),
    );
    if let Err(error) = wait_for_browser_ready_with_observer(
        || entry_readiness(state, target_label),
        BRIDGE_OPEN_WAIT_TIMEOUT_MS / BRIDGE_OPEN_WAIT_INTERVAL_MS,
        Duration::from_millis(BRIDGE_OPEN_WAIT_INTERVAL_MS),
        |attempt, readiness| {
            if !should_replay_browser_open_request(attempt, readiness) {
                return Ok(());
            }
            let request = state
                .pending_open_requests
                .lock()
                .map_err(|_| "Embedded browser pending request lock poisoned".to_string())?
                .get(target_label)
                .cloned();
            let Some(request) = request else {
                return Ok(());
            };
            app.emit(EMBEDDED_BROWSER_OPEN_REQUEST_EVENT, request.clone())
                .map_err(|error| format!("Failed to replay embedded browser open: {error}"))?;
            log_embedded_browser_diagnostic(
                state,
                base_label,
                "open_request_replayed",
                json!({
                    "requestedUrl": url,
                    "requestId": request.id,
                    "elapsedMs": attempt * BRIDGE_OPEN_WAIT_INTERVAL_MS,
                }),
            );
            Ok(())
        },
    ) {
        if let Ok(mut requests) = state.pending_open_requests.lock() {
            requests.remove(target_label);
        }
        log_embedded_browser_diagnostic(
            state,
            base_label,
            "open_wait_timeout",
            json!({
                "requestedUrl": url,
                "requestId": request_id,
                "error": error,
            }),
        );
        return Err(error);
    }
    if let Ok(mut requests) = state.pending_open_requests.lock() {
        requests.remove(target_label);
    }
    log_embedded_browser_diagnostic(
        state,
        base_label,
        "open_ready",
        json!({
            "requestedUrl": url,
            "requestId": request_id,
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn embedded_browser_pending_open_requests(
    state: tauri::State<'_, EmbeddedBrowserState>,
) -> Result<Vec<EmbeddedBrowserOpenRequest>, String> {
    let requests = state
        .pending_open_requests
        .lock()
        .map_err(|_| "Embedded browser pending request lock poisoned".to_string())?;
    Ok(requests.values().cloned().collect())
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

fn handle_bridge_request(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    mut request: EmbeddedBrowserBridgeRequest,
) -> Result<Value, String> {
    let base_label = browser_label(request.label.clone());
    let label =
        resolve_agent_bridge_label(state, &base_label, request.browser_session_id.as_deref())?;
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
                request_browser_open(
                    app,
                    state,
                    &base_label,
                    &label,
                    &url,
                    request.browser_session_id.as_deref(),
                )?;
            }
            let timeout_ms = request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS);
            navigate_label(state, &label, url.clone())?;
            wait_for_browser_navigation(state, &label, timeout_ms)?;
            Ok(json!({ "ok": true }))
        }
        "reload" => {
            get_entry(state, &label)?
                .ready_webview()?
                .reload()
                .map_err(|error| format!("Failed to reload embedded browser: {error}"))?;
            Ok(json!({ "ok": true }))
        }
        "close" => {
            if let Some(native_label) = close_embedded_browser_entry(state, &label, None)? {
                app.emit_to(
                    MAIN_WINDOW_LABEL,
                    EMBEDDED_BROWSER_CLOSE_EVENT,
                    json!({ "label": label, "nativeLabel": native_label }),
                )
                .map_err(|error| format!("Failed to notify embedded browser close: {error}"))?;
            }
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

#[tauri::command]
pub async fn embedded_browser_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    url: String,
    bounds: EmbeddedBrowserBounds,
    label: Option<String>,
    visible: Option<bool>,
    ready_when_hidden: Option<bool>,
) -> Result<EmbeddedBrowserPageState, String> {
    let label = browser_label(label);
    let visible = visible.unwrap_or(true);
    let bridge_ready = visible || ready_when_hidden.unwrap_or(true);
    let _lifecycle = state.lifecycle.lock().await;
    let display_url = resolve_browser_navigation_url(&state, &url)?;
    let initial_title = browser_url(&url)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| local_file_browser_title(&url));
    let normalized_bounds = normalize_bounds(bounds);

    let existing = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        match webviews.get(&label) {
            Some(entry) if matches!(&entry.phase, EmbeddedBrowserPhase::Opening) => {
                return Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string());
            }
            Some(entry) => Some(entry.clone()),
            None => None,
        }
    };

    if let Some(entry) = existing {
        let webview = entry.available_webview()?;
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
        if let Err(error) = webview.navigate(display_url) {
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
        let visibility_result = if visible {
            webview
                .show()
                .map_err(|error| format!("Failed to show embedded browser: {error}"))
        } else {
            webview
                .hide()
                .map_err(|error| format!("Failed to hide embedded browser: {error}"))
        };
        if let Err(error) = visibility_result {
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
        let initial_title_for_entry = initial_title.clone();
        update_entry_for_native_label(&state, &entry.native_label, |entry| {
            entry.url = Some(url.clone());
            entry.title = initial_title_for_entry;
            entry.phase = if bridge_ready {
                EmbeddedBrowserPhase::Ready(webview.clone())
            } else {
                EmbeddedBrowserPhase::Hidden(webview.clone())
            };
        })?;
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
            #[cfg(target_os = "macos")]
            invalid_tls_certificate: crate::embedded_browser_tls::invalid_tls_certificate(
                &entry.native_label,
            ),
            #[cfg(not(target_os = "macos"))]
            invalid_tls_certificate: None,
            native_label: entry.native_label,
            title: initial_title,
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
    let label_for_navigation = label.clone();
    let label_for_load = label.clone();
    let label_for_popup = label.clone();
    let app_for_navigation = app.clone();
    let app_for_load = app.clone();
    let app_for_popup = app.clone();
    let data_directory = browser_data_directory(&app)?;

    let entry = EmbeddedBrowserEntry {
        native_label: native_label.clone(),
        title: initial_title.clone(),
        url: Some(url.clone()),
        loaded_url: None,
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

    #[cfg(target_os = "macos")]
    let initial_url = initial_browser_webview_url()?;
    #[cfg(not(target_os = "macos"))]
    let initial_url = browser_webview_url(display_url.clone());
    let builder = tauri::webview::WebviewBuilder::new(&native_label, initial_url)
        .user_agent(EMBEDDED_BROWSER_USER_AGENT)
        .data_directory(data_directory)
        .data_store_identifier(EMBEDDED_BROWSER_DATA_STORE_ID)
        .initialization_script(EMBEDDED_BROWSER_DIAGNOSTICS_SCRIPT)
        .devtools(true)
        .accept_first_mouse(true)
        .on_navigation({
            let state = state.inner().clone();
            move |url| {
                let requested_url = url.to_string();
                let owner = current_logical_owner_or(
                    &state,
                    &native_label_for_navigation,
                    &label_for_navigation,
                );
                log_embedded_browser_diagnostic(
                    &state,
                    &owner,
                    "navigation_requested",
                    json!({
                        "requestedUrl": &requested_url,
                    }),
                );
                if url.scheme() == "file" {
                    match resolve_browser_navigation_url(&state, &requested_url) {
                        Ok(display_url) if display_url.as_str() != requested_url => {
                            let _ = set_entry_url_for_native_label(
                                &state,
                                &native_label_for_navigation,
                                requested_url.clone(),
                            );
                            if let Some(webview) =
                                app_for_navigation.get_webview(&native_label_for_navigation)
                            {
                                if let Err(error) = webview.navigate(display_url.clone()) {
                                    log_embedded_browser_diagnostic(
                                        &state,
                                        &owner,
                                        "navigation_local_file_preview_failed",
                                        json!({
                                            "requestedUrl": &requested_url,
                                            "displayUrl": display_url.to_string(),
                                            "error": error.to_string(),
                                        }),
                                    );
                                    return true;
                                }
                            }
                            log_embedded_browser_diagnostic(
                                &state,
                                &owner,
                                "navigation_local_file_preview",
                                json!({
                                    "requestedUrl": &requested_url,
                                    "displayUrl": display_url.to_string(),
                                }),
                            );
                            return false;
                        }
                        Ok(_) if should_block_local_file_preview(&url) => {
                            emit_local_file_preview_blocked(
                                &app_for_navigation,
                                &state,
                                &native_label_for_navigation,
                                &requested_url,
                            );
                            log_embedded_browser_diagnostic(
                                &state,
                                &owner,
                                "navigation_local_file_preview_blocked",
                                json!({
                                    "requestedUrl": &requested_url,
                                }),
                            );
                            return false;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            log_embedded_browser_diagnostic(
                                &state,
                                &owner,
                                "navigation_local_file_preview_failed",
                                json!({
                                    "requestedUrl": &requested_url,
                                    "error": error,
                                }),
                            );
                        }
                    }
                }
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
                &label_for_load,
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
                #[cfg(target_os = "macos")]
                crate::embedded_browser_tls::clear_invalid_tls_certificate_if_origin_changed(
                    &native_label_for_load,
                    &current_url,
                );
                let loaded_url = webview_url.clone().or(Some(current_url.clone()));
                if let Some(loaded_url) =
                    loaded_url.and_then(|url| loaded_browser_url(&load_state_handle, &url))
                {
                    let _ = update_entry_for_native_label(
                        &load_state_handle,
                        &native_label_for_load,
                        |entry| {
                            entry.url = Some(loaded_url.clone());
                            entry.loaded_url = Some(loaded_url);
                        },
                    );
                    emit_page_state_change(
                        &app_for_load,
                        &load_state_handle,
                        owner.clone(),
                        native_label_for_load.clone(),
                    );
                }
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
                &label_for_popup,
            );
            emit_popup_observed(
                &app_for_popup,
                &parent_label,
                &native_label_for_popup,
                url.clone(),
            );
            let (_kind, strategy, _warning) = classify_popup_url(&url);
            if strategy == "controlled_popup_required" && url.scheme() == "file" {
                // Open local-file popups in the current window instead of a new window.
                if let Some(webview) = app_for_popup.get_webview(&native_label_for_popup) {
                    let _ = webview.navigate(url);
                }
                return NewWindowResponse::Deny;
            }
            if strategy == "user_confirmation_required" || strategy == "controlled_popup_required" {
                NewWindowResponse::Deny
            } else if _kind == "unknown" {
                // Unknown target=_blank navigations are represented as a frontend tab request.
                // OAuth-like popups stay native so sites that require window.opener keep working.
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
                if url.scheme() == "file" {
                    // The webview cannot preview this local file and would download
                    // it. Cancel the download and let the frontend show a notice.
                    emit_local_file_preview_blocked(
                        &download_app,
                        &download_state,
                        &download_native_label,
                        url.as_str(),
                    );
                    return false;
                }
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

    #[cfg(target_os = "linux")]
    if let Err(error) = apply_webview_bounds(&webview, normalized_bounds) {
        log_embedded_browser_diagnostic(
            &state,
            &label,
            "open_host_failed",
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
        "open_created",
        json!({
            "nativeLabel": &native_label,
        }),
    );

    #[cfg(target_os = "macos")]
    {
        let tls_result = crate::embedded_browser_tls::register_invalid_tls_handler(
            &webview,
            app.clone(),
            native_label.clone(),
        )
        .await
        .and_then(|_| {
            webview
                .navigate(display_url)
                .map_err(|error| format!("Failed to navigate embedded browser: {error}"))
        });
        if let Err(error) = tls_result {
            if let Ok(mut webviews) = state.webviews.lock() {
                remove_logical_entry_if_native_matches(
                    &mut webviews,
                    &label,
                    &native_label,
                    |current| current.native_label.as_str(),
                );
            }
            crate::embedded_browser_tls::unregister_invalid_tls_handler(&webview);
            let _ = webview.close();
            return Err(error);
        }
    }

    let visibility_result = if visible {
        webview
            .show()
            .map_err(|error| format!("Failed to show embedded browser: {error}"))
    } else {
        webview
            .hide()
            .map_err(|error| format!("Failed to hide embedded browser: {error}"))
    };
    if let Err(error) = visibility_result {
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
        #[cfg(target_os = "macos")]
        crate::embedded_browser_tls::unregister_invalid_tls_handler(&webview);
        let _ = webview.close();
        return Err(error);
    }
    log_embedded_browser_diagnostic(
        &state,
        &label,
        if visible {
            "open_visible"
        } else {
            "open_hidden"
        },
        json!({
            "nativeLabel": &native_label,
        }),
    );
    if let Err(error) =
        mark_entry_ready_for_native_label(&state, &native_label, webview.clone(), bridge_ready)
    {
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
        #[cfg(target_os = "macos")]
        crate::embedded_browser_tls::unregister_invalid_tls_handler(&webview);
        let _ = webview.close();
        return Err(error);
    }
    log_embedded_browser_diagnostic(
        &state,
        &label,
        if bridge_ready {
            "open_ready"
        } else {
            "open_waiting_for_visible_bounds"
        },
        json!({
            "nativeLabel": &native_label,
        }),
    );
    if bridge_ready {
        if let Ok(mut requests) = state.pending_open_requests.lock() {
            requests.remove(&label);
        }
    }

    Ok(EmbeddedBrowserPageState {
        #[cfg(target_os = "macos")]
        invalid_tls_certificate: crate::embedded_browser_tls::invalid_tls_certificate(
            &native_label,
        ),
        #[cfg(not(target_os = "macos"))]
        invalid_tls_certificate: None,
        native_label,
        title: initial_title,
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
    ready_when_hidden: Option<bool>,
) -> Result<(), String> {
    let label = browser_label(label);
    let normalized_bounds = normalize_bounds(bounds);
    let webview = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        match webviews.get(&label) {
            Some(entry) => Some((
                entry.native_label.clone(),
                entry.available_webview()?,
                entry.readiness(),
            )),
            None => None,
        }
    };

    let Some((native_label, webview, readiness)) = webview else {
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
    if (visible || ready_when_hidden.unwrap_or(false))
        && readiness != EmbeddedBrowserReadiness::Ready
    {
        mark_entry_ready_for_native_label(&state, &native_label, webview, true)?;
        if let Ok(mut requests) = state.pending_open_requests.lock() {
            requests.remove(&label);
        }
        log_embedded_browser_diagnostic(
            &state,
            &label,
            "bounds_visible_ready",
            json!({
                "nativeLabel": native_label,
                "visible": visible,
            }),
        );
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
    #[cfg(target_os = "macos")]
    {
        return reload_embedded_browser_from_origin(&webview);
    }
    #[cfg(not(target_os = "macos"))]
    {
        return webview
            .reload()
            .map_err(|error| format!("Failed to reload embedded browser: {error}"));
    }
}

#[cfg(target_os = "macos")]
fn reload_embedded_browser_from_origin(webview: &Webview<Wry>) -> Result<(), String> {
    webview
        .with_webview(|platform_webview| unsafe {
            if let Some(native_webview) = platform_webview.inner().cast::<WKWebView>().as_ref() {
                native_webview.reloadFromOrigin();
            }
        })
        .map_err(|error| format!("Failed to reload embedded browser: {error}"))?;
    Ok(())
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
        .and_then(|()| relabel_tab_routes(&state, &from_label, &to_label))
}

#[tauri::command]
pub fn embedded_browser_set_active_tab(
    state: tauri::State<'_, EmbeddedBrowserState>,
    base_label: String,
    active_tab_label: String,
) -> Result<(), String> {
    state
        .active_tabs
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .insert(base_label, active_tab_label);
    Ok(())
}

#[tauri::command]
pub async fn embedded_browser_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
    expected_native_label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    let _lifecycle = state.lifecycle.lock().await;
    let closed_native_label =
        close_embedded_browser_entry(&state, &label, expected_native_label.as_deref())?;
    log::info!(
        "Embedded browser close label={} expected_native_label={:?} closed_native_label={:?}",
        label,
        expected_native_label,
        closed_native_label
    );
    if let Some(native_label) = closed_native_label {
        app.emit_to(
            MAIN_WINDOW_LABEL,
            EMBEDDED_BROWSER_CLOSE_EVENT,
            json!({ "label": label, "nativeLabel": native_label }),
        )
        .map_err(|error| format!("Failed to notify embedded browser close: {error}"))?;
    }
    Ok(())
}

fn close_embedded_browser_entry(
    state: &EmbeddedBrowserState,
    label: &str,
    expected_native_label: Option<&str>,
) -> Result<Option<String>, String> {
    let entry = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        webviews
            .get(label)
            .filter(|entry| {
                expected_native_label.is_none_or(|expected| entry.native_label == expected)
            })
            .cloned()
    };
    if let Some(entry) = entry {
        let webview = entry.available_webview()?;
        #[cfg(target_os = "macos")]
        crate::embedded_browser_tls::unregister_invalid_tls_handler(&webview);
        webview
            .close()
            .map_err(|error| format!("Failed to close embedded browser: {error}"))?;
        let mut webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        remove_logical_entry_if_native_matches(
            &mut webviews,
            label,
            &entry.native_label,
            |current| current.native_label.as_str(),
        );
        clear_label_agent_state(state, label)?;
        state
            .active_tabs
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?
            .retain(|base_label, active_label| base_label != label && active_label != label);
        let now = current_unix_millis();
        state
            .agent_tabs
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?
            .iter_mut()
            .filter(|((base_label, _), route)| base_label == label || route.label == label)
            .for_each(|(_, route)| {
                route.closed_at_unix_ms = Some(now);
                route.last_request_at_unix_ms = now;
            });
        return Ok(Some(entry.native_label));
    }
    Ok(None)
}

#[tauri::command]
pub async fn embedded_browser_close_many(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    labels: Vec<String>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    let mut seen = std::collections::HashSet::new();
    for label in labels {
        if !seen.insert(label.clone()) {
            continue;
        }
        if let Some(native_label) = close_embedded_browser_entry(&state, &label, None)? {
            app.emit_to(
                MAIN_WINDOW_LABEL,
                EMBEDDED_BROWSER_CLOSE_EVENT,
                json!({ "label": label, "nativeLabel": native_label }),
            )
            .map_err(|error| format!("Failed to notify embedded browser close: {error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn embedded_browser_clear_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    data_kinds: Option<Vec<EmbeddedBrowserDataKind>>,
) -> Result<usize, String> {
    clear_embedded_browser_data(app, state, data_kinds).await
}
