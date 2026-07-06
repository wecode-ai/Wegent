use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    webview::PageLoadEvent, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size,
    Webview, WebviewUrl, Wry,
};

const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_WEBVIEW_LABEL: &str = "workspace-browser";
const EMBEDDED_BROWSER_BRIDGE_ADDR: &str = "127.0.0.1:9231";
const BRIDGE_READ_TIMEOUT_MS: u64 = 5_000;
const BRIDGE_EVAL_TIMEOUT_MS: u64 = 10_000;
const BRIDGE_OPEN_WAIT_TIMEOUT_MS: u64 = 15_000;
const BRIDGE_OPEN_WAIT_INTERVAL_MS: u64 = 100;
const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT: &str = "wework:embedded-browser-open-request";

#[derive(Clone, Default)]
pub struct EmbeddedBrowserState {
    webviews: Arc<Mutex<HashMap<String, EmbeddedBrowserEntry>>>,
}

#[derive(Clone)]
struct EmbeddedBrowserEntry {
    webview: Webview<Wry>,
    title: Option<String>,
    url: Option<String>,
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

fn browser_label(label: Option<String>) -> String {
    label.unwrap_or_else(|| BROWSER_WEBVIEW_LABEL.to_string())
}

fn get_entry(state: &EmbeddedBrowserState, label: &str) -> Result<EmbeddedBrowserEntry, String> {
    state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .get(label)
        .cloned()
        .ok_or_else(|| "Embedded browser is not open".to_string())
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

fn page_state_for_label(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<EmbeddedBrowserPageState, String> {
    let entry = get_entry(state, label)?;
    let url = entry
        .webview
        .url()
        .ok()
        .map(|url| url.to_string())
        .or(entry.url);
    Ok(EmbeddedBrowserPageState {
        title: entry.title,
        url,
    })
}

fn navigate_label(state: &EmbeddedBrowserState, label: &str, url: String) -> Result<(), String> {
    let parsed_url = browser_url(&url)?;
    let entry = get_entry(state, label)?;
    entry
        .webview
        .navigate(parsed_url)
        .map_err(|error| format!("Failed to navigate embedded browser: {error}"))?;
    set_entry_url(state, label, Some(url))
}

fn is_browser_open(state: &EmbeddedBrowserState, label: &str) -> Result<bool, String> {
    Ok(state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .contains_key(label))
}

fn request_browser_open(
    app: &tauri::AppHandle,
    state: &EmbeddedBrowserState,
    label: &str,
    url: &str,
) -> Result<(), String> {
    app.emit(
        EMBEDDED_BROWSER_OPEN_REQUEST_EVENT,
        EmbeddedBrowserOpenRequest {
            url: url.to_string(),
            label: label.to_string(),
        },
    )
    .map_err(|error| format!("Failed to request embedded browser open: {error}"))?;

    let attempts = BRIDGE_OPEN_WAIT_TIMEOUT_MS / BRIDGE_OPEN_WAIT_INTERVAL_MS;
    for _ in 0..attempts {
        if is_browser_open(state, label)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(BRIDGE_OPEN_WAIT_INTERVAL_MS));
    }

    Err("Timed out waiting for Wework to open the embedded browser tab".to_string())
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
        .webview
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Failed to evaluate embedded browser script: {error}"))?;

    let result = receiver
        .recv_timeout(Duration::from_millis(timeout_ms))
        .map_err(|_| "Timed out waiting for embedded browser evaluation".to_string())?;
    serde_json::from_str(&result).or_else(|_| Ok(Value::String(result)))
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
        .webview
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
    serde_json::from_str(&result).or_else(|_| Ok(Value::String(result)))
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
    let window_position = entry
        .webview
        .window()
        .inner_position()
        .map_err(|error| format!("Failed to read Wework window position: {error}"))?;
    let webview_position = entry
        .webview
        .position()
        .map_err(|error| format!("Failed to read embedded browser position: {error}"))?;
    let webview_size = entry
        .webview
        .size()
        .map_err(|error| format!("Failed to read embedded browser size: {error}"))?;
    let scale_factor = entry
        .webview
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
            "open": state.webviews.lock().map_err(|_| "Embedded browser state lock poisoned".to_string())?.contains_key(&label),
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
                .webview
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
) -> Result<(), String> {
    let (headers, body) = read_http_request(&mut stream)?;
    let path = http_path(&headers);
    if path == "/status" {
        let data = handle_bridge_request(
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
        )?;
        return write_http_response(&mut stream, "200 OK", &bridge_success(data));
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
    match handle_bridge_request(app, state, request) {
        Ok(data) => write_http_response(&mut stream, "200 OK", &bridge_success(data)),
        Err(error) => write_http_response(&mut stream, "200 OK", &bridge_error(error)),
    }
}

pub fn start_embedded_browser_bridge(app: tauri::AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(EMBEDDED_BROWSER_BRIDGE_ADDR)
        .map_err(|error| format!("Failed to bind embedded browser bridge: {error}"))?;
    let state = app.state::<EmbeddedBrowserState>().inner().clone();
    let app_handle = app.clone();
    std::thread::Builder::new()
        .name("embedded-browser-bridge".to_string())
        .spawn(move || {
            log::info!("Embedded browser bridge listening on {EMBEDDED_BROWSER_BRIDGE_ADDR}");
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        if let Err(error) = handle_bridge_connection(&app_handle, &state, stream) {
                            log::warn!("Embedded browser bridge request failed: {error}");
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
    let parsed_url = browser_url(&url)?;
    let normalized_bounds = normalize_bounds(bounds);

    let existing = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        webviews.get(&label).cloned()
    };

    if let Some(entry) = existing {
        apply_webview_bounds(&entry.webview, normalized_bounds)?;
        entry
            .webview
            .navigate(parsed_url)
            .map_err(|error| format!("Failed to navigate embedded browser: {error}"))?;
        entry
            .webview
            .show()
            .map_err(|error| format!("Failed to show embedded browser: {error}"))?;
        set_entry_url(&state, &label, Some(url.clone()))?;
        return Ok(EmbeddedBrowserPageState {
            title: entry.title,
            url: Some(url),
        });
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;
    let load_state_handle = state.inner().clone();
    let title_state_handle = state.inner().clone();
    let label_for_load = label.clone();
    let label_for_title = label.clone();

    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .accept_first_mouse(true)
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let current_url = webview.url().ok().map(|url| url.to_string());
                let _ = set_entry_url(&load_state_handle, &label_for_load, current_url);
            }
        })
        .on_document_title_changed(move |_webview, title| {
            if let Ok(mut webviews) = title_state_handle.webviews.lock() {
                if let Some(entry) = webviews.get_mut(&label_for_title) {
                    entry.title = Some(title);
                }
            }
        });

    let webview = window
        .add_child(builder, normalized_bounds.position, normalized_bounds.size)
        .map_err(|error| format!("Failed to create embedded browser: {error}"))?;
    webview
        .show()
        .map_err(|error| format!("Failed to show embedded browser: {error}"))?;

    let entry = EmbeddedBrowserEntry {
        webview,
        title: None,
        url: Some(url.clone()),
    };
    state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .insert(label, entry);

    Ok(EmbeddedBrowserPageState {
        title: None,
        url: Some(url),
    })
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
        webviews.get(&label).map(|entry| entry.webview.clone())
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
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .get(&label)
        .map(|entry| entry.webview.clone())
        .ok_or_else(|| "Embedded browser is not open".to_string())?;
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
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .get(&label)
        .map(|entry| entry.webview.clone())
        .ok_or_else(|| "Embedded browser is not open".to_string())?;
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
pub fn embedded_browser_relabel(
    state: tauri::State<'_, EmbeddedBrowserState>,
    from_label: String,
    to_label: String,
) -> Result<(), String> {
    if from_label == to_label {
        return Ok(());
    }

    let mut webviews = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
    if webviews.contains_key(&to_label) {
        return Ok(());
    }
    let entry = webviews
        .remove(&from_label)
        .ok_or_else(|| "Embedded browser is not open".to_string())?;
    webviews.insert(to_label, entry);
    Ok(())
}

#[tauri::command]
pub fn embedded_browser_close(
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
) -> Result<(), String> {
    let label = browser_label(label);
    let entry = state
        .webviews
        .lock()
        .map_err(|_| "Embedded browser state lock poisoned".to_string())?
        .remove(&label);
    if let Some(entry) = entry {
        entry
            .webview
            .close()
            .map_err(|error| format!("Failed to close embedded browser: {error}"))?;
    }
    Ok(())
}
