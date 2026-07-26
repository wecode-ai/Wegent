use std::{
    env,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use chrono::Local;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:9231";
const BRIDGE_URL_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_URL";
const BROWSER_LABEL_ENV: &str = "WEWORK_EMBEDDED_BROWSER_LABEL";
const BRIDGE_CONNECT_TIMEOUT_SECONDS: u64 = 5;
const BRIDGE_REQUEST_TIMEOUT_SECONDS: u64 = 45;
const BROWSER_MCP_LOG_FILE: &str = "wework-browser-mcp.log";
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static LOG_WRITE_ERROR_REPORTED: AtomicBool = AtomicBool::new(false);

pub fn is_browser_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("browser-mcp-server")
}

pub async fn run() -> Result<(), String> {
    let result = run_inner().await;
    if let Err(error) = &result {
        write_browser_log(&format!(
            "[wework-browser-mcp] lifecycle=fatal pid={} error={error}",
            std::process::id()
        ));
    }
    result
}

async fn run_inner() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(BRIDGE_CONNECT_TIMEOUT_SECONDS))
        .timeout(Duration::from_secs(BRIDGE_REQUEST_TIMEOUT_SECONDS))
        .no_proxy()
        .build()
        .map_err(|error| format!("Failed to build embedded browser bridge client: {error}"))?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    write_browser_log(&format!(
        "[wework-browser-mcp] lifecycle=start pid={} bridge_url={} label={} request_timeout_seconds={BRIDGE_REQUEST_TIMEOUT_SECONDS} log_path={}",
        std::process::id(),
        bridge_url(),
        browser_label().unwrap_or_else(|| "<default>".to_owned()),
        browser_log_path().display()
    ));

    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        log_request(
            sequence,
            "stdin_line_received",
            "<unparsed>",
            None,
            started,
            Some(&format!("bytes={}", line.len())),
        );
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => {
                let method = request_method(&request);
                let tool = request_tool(&request);
                log_request(sequence, "received", method, tool, started, None);
                handle_request(&client, &request, sequence, started).await
            }
            Err(error) => {
                log_request(
                    sequence,
                    "parse_error",
                    "<invalid>",
                    None,
                    started,
                    Some(&error.to_string()),
                );
                Some(error_response(Value::Null, -32700, error.to_string()))
            }
        };
        if let Some(response) = response {
            let mut encoded = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
            encoded.push(b'\n');
            log_request(
                sequence,
                "response_write_start",
                "<response>",
                None,
                started,
                None,
            );
            stdout
                .write_all(&encoded)
                .await
                .map_err(|error| error.to_string())?;
            stdout.flush().await.map_err(|error| error.to_string())?;
            log_request(
                sequence,
                "response_flushed",
                "<response>",
                None,
                started,
                None,
            );
        } else {
            log_request(
                sequence,
                "notification_complete",
                "<notification>",
                None,
                started,
                None,
            );
        }
    }
    write_browser_log(&format!(
        "[wework-browser-mcp] lifecycle=stdin_eof pid={}",
        std::process::id()
    ));
    Ok(())
}

async fn handle_request(
    client: &reqwest::Client,
    request: &Value,
    sequence: u64,
    started: Instant,
) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "notifications/initialized" => None,
        "initialize" => id.map(|id| {
            result_response(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "wegent-embedded-browser", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
        }),
        "tools/list" => id.map(|id| result_response(id, json!({ "tools": tools() }))),
        "ping" => id.map(|id| result_response(id, json!({}))),
        "tools/call" => {
            let id = id?;
            let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                return Some(error_response(id, -32602, "tools/call requires params.name"));
            };
            let arguments = request.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            Some(result_response(
                id,
                execute_tool(client, name, &arguments, sequence, started).await,
            ))
        }
        _ => id.map(|id| error_response(id, -32601, format!("Unknown method: {method}"))),
    }
}

async fn execute_tool(
    client: &reqwest::Client,
    name: &str,
    arguments: &Value,
    sequence: u64,
    started: Instant,
) -> Value {
    let bridge_payload = match name {
        "browser_open" | "browser_navigate" | "browser_tab_new" => {
            json!({ "action": "open", "url": string_arg(arguments, "url") })
        }
        "browser_inspect" => inspect_payload(arguments),
        "browser_snapshot" => json!({
            "action": "evaluate",
            "expression": "({ title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 12000) || '' })"
        }),
        "browser_evaluate" => json!({
            "action": "evaluate",
            "expression": evaluate_expression(arguments)
        }),
        "browser_take_screenshot" => json!({ "action": "screenshot" }),
        "browser_capabilities" => json!({ "action": "capabilities" }),
        "browser_native_input_probe" => json!({
            "action": "nativeInputProbe",
            "x": optional_number_arg(arguments, "x"),
            "y": optional_number_arg(arguments, "y"),
            "key": optional_string_arg(arguments, "key"),
            "text": optional_string_arg(arguments, "text"),
            "options": {
                "kind": optional_string_arg(arguments, "kind").unwrap_or_else(|| "unknown".to_owned()),
                "screenshotId": optional_string_arg(arguments, "screenshotId")
            }
        }),
        "browser_ax_probe" => json!({
            "action": "axProbe",
            "options": {
                "mode": optional_string_arg(arguments, "mode").unwrap_or_else(|| "tree".to_owned()),
                "maxNodes": optional_number_arg(arguments, "maxNodes").unwrap_or(1000.0)
            }
        }),
        "browser_present_probe" => json!({ "action": "present" }),
        "browser_tab_list" => json!({ "action": "pageState" }),
        "browser_tab_select" => {
            return text_result(json!({ "ok": true, "targetId": "embedded" }), false)
        }
        "browser_tab_close" => {
            return text_result(
                "Embedded browser tabs are managed by the Wework right panel.",
                true,
            )
        }
        "browser_click" => action_target_payload("click", arguments),
        "browser_click_coordinates" => json!({
            "action": "click",
            "x": number_arg(arguments, "x"),
            "y": number_arg(arguments, "y")
        }),
        "browser_type" => action_target_payload("typeText", arguments),
        "browser_fill" => action_target_payload("fill", arguments),
        "browser_open_and_inspect"
        | "browser_click_and_inspect"
        | "browser_fill_and_inspect"
        | "browser_type_and_inspect"
        | "browser_wait_and_inspect" => {
            return execute_combined_tool(client, name, arguments, sequence, started).await
        }
        "browser_press_key" => action_target_payload("press", arguments),
        "browser_wait_for" => json!({
            "action": "waitFor",
            "text": optional_string_arg(arguments, "text"),
            "selector": optional_string_arg(arguments, "selector"),
            "url": optional_string_arg(arguments, "url"),
            "expression": optional_string_arg(arguments, "fn"),
            "timeoutMs": optional_u64_arg(arguments, "timeoutMs"),
            "options": wait_options(arguments, WaitConditionOptions {
                allow_flat_text: true,
                allow_flat_selector: true,
                allow_flat_url: true,
            })
        }),
        "browser_resize" => {
            return text_result(
                "Embedded browser size follows the Wework right panel bounds.",
                false,
            )
        }
        "browser_hover" => action_target_payload("hover", arguments),
        "browser_focus" => action_target_payload("focus", arguments),
        "browser_scroll_into_view" => action_target_payload("scrollIntoView", arguments),
        "browser_scroll" => json!({
            "action": "scroll",
            "x": optional_number_arg(arguments, "x"),
            "y": optional_number_arg(arguments, "y"),
            "options": {
                "direction": optional_string_arg(arguments, "direction").unwrap_or_else(|| "down".to_owned()),
                "amount": optional_number_arg(arguments, "amount").unwrap_or(600.0),
                "mode": optional_string_arg(arguments, "mode").unwrap_or_else(|| "smart".to_owned())
            },
            "timeoutMs": optional_u64_arg(arguments, "timeoutMs")
        }),
        "browser_select_option" => action_target_payload("select", arguments),
        "browser_set_checked" => action_target_payload("setChecked", arguments),
        "browser_fill_form" => fill_form_payload(arguments),
        "browser_drag" => drag_payload(arguments),
        _ => return text_result(format!("Unknown tool: {name}"), true),
    };

    log_request(
        sequence,
        "bridge_call_start",
        "tools/call",
        Some(name),
        started,
        None,
    );
    let result = match call_bridge(client, bridge_payload, sequence, name, started).await {
        Ok(value) => text_result(value, false),
        Err(error) => {
            log_request(
                sequence,
                "bridge_call_error",
                "tools/call",
                Some(name),
                started,
                Some(&error),
            );
            return text_result(error, true);
        }
    };
    log_request(
        sequence,
        "bridge_call_complete",
        "tools/call",
        Some(name),
        started,
        None,
    );
    result
}

async fn execute_combined_tool(
    client: &reqwest::Client,
    name: &str,
    arguments: &Value,
    sequence: u64,
    started: Instant,
) -> Value {
    let combined_started = Instant::now();
    let tool = name.strip_prefix("browser_").unwrap_or(name);
    let mut action = None;
    let mut warnings = Vec::new();
    let mut error = None;

    if let Some(payload) = combined_action_payload(name, arguments) {
        let result = call_bridge(client, payload, sequence, name, started).await;
        match result {
            Ok(value) => {
                collect_warnings(&mut warnings, value.get("warnings"));
                if value.get("ok").and_then(Value::as_bool) == Some(false) {
                    error = value.get("error").cloned();
                }
                action = Some(value);
            }
            Err(message) => {
                error = Some(json!({ "code": "bridge_action_failed", "message": message }));
            }
        }
    }

    let wait = match call_bridge(
        client,
        wait_payload(name, arguments),
        sequence,
        name,
        started,
    )
    .await
    {
        Ok(value) => normalize_wait_result(
            arguments,
            &value,
            WaitConditionOptions {
                allow_flat_text: name == "browser_wait_and_inspect",
                allow_flat_selector: name == "browser_wait_and_inspect",
                allow_flat_url: name == "browser_wait_and_inspect"
                    || name == "browser_open_and_inspect",
            },
        ),
        Err(message) => json!({
            "ok": false,
            "reason": "operation_failed",
            "elapsedMs": 0,
            "observed": {},
            "warnings": [],
            "error": { "code": "bridge_wait_failed", "message": message }
        }),
    };
    collect_warnings(&mut warnings, wait.get("warnings"));
    if wait.get("ok").and_then(Value::as_bool) == Some(false) && error.is_none() {
        error = wait.get("error").cloned();
    }

    let inspect = match call_bridge(
        client,
        combined_inspect_payload(arguments),
        sequence,
        name,
        started,
    )
    .await
    {
        Ok(value) => {
            collect_warnings(&mut warnings, value.get("warnings"));
            Some(value)
        }
        Err(message) => {
            if error.is_none() {
                error = Some(json!({ "code": "bridge_inspect_failed", "message": message }));
            }
            None
        }
    };

    let action_ok = action
        .as_ref()
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let wait_ok = wait.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let ok = action_ok && wait_ok && inspect.is_some() && error.is_none();

    let mut result = Map::new();
    result.insert(
        "kind".to_owned(),
        Value::String("browser.combined".to_owned()),
    );
    result.insert("ok".to_owned(), Value::Bool(ok));
    result.insert("tool".to_owned(), Value::String(tool.to_owned()));
    if let Some(action) = action {
        result.insert("action".to_owned(), action);
    }
    result.insert("wait".to_owned(), wait);
    if let Some(inspect) = inspect {
        result.insert("inspect".to_owned(), inspect);
    }
    result.insert(
        "elapsedMs".to_owned(),
        json!(combined_started.elapsed().as_millis()),
    );
    result.insert("warnings".to_owned(), Value::Array(warnings));
    if let Some(error) = error {
        result.insert("error".to_owned(), error);
    }
    text_result(Value::Object(result), false)
}

async fn call_bridge(
    client: &reqwest::Client,
    mut payload: Value,
    sequence: u64,
    tool: &str,
    started: Instant,
) -> Result<Value, String> {
    if let (Some(label), Some(object)) = (browser_label(), payload.as_object_mut()) {
        if !label.trim().is_empty() {
            object.insert("label".to_owned(), Value::String(label));
        }
    }
    let base_url = bridge_url();
    log_request(
        sequence,
        "bridge_http_send_start",
        "tools/call",
        Some(tool),
        started,
        None,
    );
    let response = client
        .post(format!("{}/browser", base_url.trim_end_matches('/')))
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            format!("Embedded browser bridge is unavailable at {base_url}: {error}")
        })?;
    log_request(
        sequence,
        "bridge_http_headers_received",
        "tools/call",
        Some(tool),
        started,
        Some(&format!("status={}", response.status())),
    );
    if !response.status().is_success() {
        return Err(format!(
            "Embedded browser bridge returned HTTP {}",
            response.status()
        ));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    log_request(
        sequence,
        "bridge_http_body_decoded",
        "tools/call",
        Some(tool),
        started,
        None,
    );
    if body.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Embedded browser tool failed")
            .to_owned());
    }
    Ok(body
        .get("data")
        .cloned()
        .unwrap_or_else(|| json!({ "ok": true })))
}

fn bridge_url() -> String {
    env::var(BRIDGE_URL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIDGE_URL.to_owned())
}

fn browser_label() -> Option<String> {
    env::var(BROWSER_LABEL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn request_method(request: &Value) -> &str {
    request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("<missing>")
}

fn request_tool(request: &Value) -> Option<&str> {
    request.pointer("/params/name").and_then(Value::as_str)
}

fn log_request(
    sequence: u64,
    stage: &str,
    method: &str,
    tool: Option<&str>,
    started: Instant,
    error: Option<&str>,
) {
    let tool = tool.unwrap_or("-");
    let elapsed_ms = started.elapsed().as_millis();
    if let Some(error) = error {
        write_browser_log(&format!(
            "[wework-browser-mcp] pid={} request={sequence} stage={stage} method={method} tool={tool} elapsed_ms={elapsed_ms} error={error}",
            std::process::id()
        ));
    } else {
        write_browser_log(&format!(
            "[wework-browser-mcp] pid={} request={sequence} stage={stage} method={method} tool={tool} elapsed_ms={elapsed_ms}",
            std::process::id()
        ));
    }
}

fn write_browser_log(message: &str) {
    eprintln!("{message}");
    let path = browser_log_path();
    let result = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        writeln!(file, "{timestamp} {message}")?;
        file.flush()
    })();
    if let Err(error) = result {
        if !LOG_WRITE_ERROR_REPORTED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "[wework-browser-mcp] lifecycle=file_log_error pid={} path={} error={error}",
                std::process::id(),
                path.display()
            );
        }
    }
}

fn browser_log_path() -> PathBuf {
    if let Some(log_dir) = non_empty_env("WEGENT_EXECUTOR_LOG_DIR") {
        return PathBuf::from(log_dir).join(BROWSER_MCP_LOG_FILE);
    }
    if let Some(executor_home) = non_empty_env("WEGENT_EXECUTOR_HOME") {
        return PathBuf::from(executor_home)
            .join("logs")
            .join(BROWSER_MCP_LOG_FILE);
    }
    let home = non_empty_env("HOME").unwrap_or_else(|| ".".to_owned());
    PathBuf::from(home)
        .join(".wegent-executor/logs")
        .join(BROWSER_MCP_LOG_FILE)
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "browser_open",
            "Open or navigate the built-in browser in Wegent's Wework desktop app to a URL.",
            &["url"],
        ),
        tool(
            "browser_inspect",
            "Inspect the current page and return a structured, indexable page tree.",
            &[],
        ),
        tool(
            "browser_navigate",
            "Alias of browser_open for opening pages in Wegent's Wework desktop app.",
            &["url"],
        ),
        tool(
            "browser_snapshot",
            "Deprecated text-only page read. Use browser_inspect for structured page inspection and browser_take_screenshot for screenshots.",
            &[],
        ),
        tool(
            "browser_click",
            "Click an element by inspect index/ref or CSS selector.",
            &[],
        ),
        tool(
            "browser_click_coordinates",
            "Click viewport coordinates.",
            &["x", "y"],
        ),
        tool(
            "browser_type",
            "Append text into an editable element by inspect index/ref, CSS selector, or the focused element.",
            &["text"],
        ),
        tool(
            "browser_fill",
            "Fill a single editable element by inspect index/ref or CSS selector.",
            &["text"],
        ),
        tool(
            "browser_open_and_inspect",
            "Open a URL, wait briefly for the page, then return a structured page inspection.",
            &["url"],
        ),
        tool(
            "browser_click_and_inspect",
            "Click an element by inspect index/ref or CSS selector, then return a fresh structured page inspection.",
            &[],
        ),
        tool(
            "browser_fill_and_inspect",
            "Fill a single editable element, then return a fresh structured page inspection.",
            &["text"],
        ),
        tool(
            "browser_type_and_inspect",
            "Append text into an editable element, then return a fresh structured page inspection.",
            &["text"],
        ),
        tool(
            "browser_wait_and_inspect",
            "Wait for page state, then return a fresh structured page inspection.",
            &[],
        ),
        tool(
            "browser_fill_form",
            "Fill multiple form fields.",
            &["fields"],
        ),
        tool("browser_press_key", "Press a keyboard key.", &["key"]),
        tool("browser_hover", "Hover an element.", &[]),
        tool("browser_focus", "Focus an element.", &[]),
        tool("browser_scroll", "Scroll the current page.", &[]),
        tool(
            "browser_scroll_into_view",
            "Scroll an element into view.",
            &[],
        ),
        tool("browser_select_option", "Select option values.", &[]),
        tool("browser_set_checked", "Set checkbox or radio checked state.", &[]),
        tool("browser_drag", "Drag between two elements.", &[]),
        tool("browser_wait_for", "Wait for page state.", &[]),
        tool(
            "browser_resize",
            "Resize the embedded browser viewport.",
            &[],
        ),
        tool("browser_take_screenshot", "Capture a page screenshot.", &[]),
        tool(
            "browser_capabilities",
            "Report current embedded WKWebView browser capabilities and limits.",
            &[],
        ),
        tool(
            "browser_native_input_probe",
            "Probe AppKit native input availability for the embedded browser.",
            &[],
        ),
        tool(
            "browser_ax_probe",
            "Probe macOS accessibility-tree availability for the embedded browser.",
            &[],
        ),
        tool(
            "browser_present_probe",
            "Report panel/popout WebView presentation and reparent capability.",
            &[],
        ),
        tool("browser_evaluate", "Evaluate JavaScript in the page.", &[]),
        tool(
            "browser_tab_list",
            "List browser tabs in Wegent's Wework desktop app.",
            &[],
        ),
        tool(
            "browser_tab_new",
            "Open a URL in the browser tab.",
            &["url"],
        ),
        tool("browser_tab_select", "Focus the embedded browser tab.", &[]),
        tool("browser_tab_close", "Close an embedded browser tab.", &[]),
    ]
}

fn tool(name: &str, description: &str, required: &[&str]) -> Value {
    let mut properties = Map::new();
    for key in [
        "url",
        "ref",
        "element",
        "text",
        "value",
        "key",
        "selector",
        "expression",
        "function",
        "fn",
        "kind",
        "screenshotId",
        "inspectId",
        "waitUntil",
        "urlIncludes",
        "urlMatches",
        "titleIncludes",
        "mode",
        "by",
        "direction",
        "startRef",
        "endRef",
    ] {
        properties.insert(key.to_owned(), json!({ "type": "string" }));
    }
    for key in [
        "x",
        "y",
        "amount",
        "time",
        "timeMs",
        "timeoutMs",
        "width",
        "height",
        "index",
    ] {
        properties.insert(key.to_owned(), json!({ "type": "number" }));
    }
    properties.insert("fields".to_owned(), json!({ "type": "array" }));
    properties.insert("condition".to_owned(), json!({ "type": "object" }));
    properties.insert("inspectOptions".to_owned(), json!({ "type": "object" }));
    for key in [
        "interactiveOnly",
        "includeTextBlocks",
        "includeHidden",
        "checked",
    ] {
        properties.insert(key.to_owned(), json!({ "type": "boolean" }));
    }
    properties.insert(
        "values".to_owned(),
        json!({ "type": "array", "items": { "type": "string" } }),
    );
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": true
        }
    })
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

fn text_result(data: impl Into<Value>, is_error: bool) -> Value {
    let data = data.into();
    let text = combined_text_result(&data)
        .or_else(|| inspect_text_result(&data))
        .unwrap_or_else(|| {
            data.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string_pretty(&data).unwrap_or_default())
        });
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn combined_text_result(data: &Value) -> Option<String> {
    if data.get("kind").and_then(Value::as_str) != Some("browser.combined") {
        return None;
    }
    let tool = data
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("combined");
    let ok = data.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut sections = vec![format!("Combined: {tool} ok={ok}")];
    if let Some(action) = data.get("action") {
        let action_name = action
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("action");
        let action_ok = action.get("ok").and_then(Value::as_bool).unwrap_or(false);
        sections.push(format!("Action: {action_name} ok={action_ok}"));
        if let Some(effect) = action.get("effect") {
            sections.push(format!(
                "Effect: {}",
                serde_json::to_string(effect).unwrap_or_default()
            ));
        }
    }
    if let Some(wait) = data.get("wait") {
        let reason = wait
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let wait_ok = wait.get("ok").and_then(Value::as_bool).unwrap_or(false);
        sections.push(format!("Wait: {reason} ok={wait_ok}"));
    }
    if let Some(error) = data.get("error") {
        sections.push(format!(
            "Error: {}",
            serde_json::to_string(error).unwrap_or_default()
        ));
    }
    if let Some(inspect_text) = data
        .pointer("/inspect/inspectText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        sections.push(format!("Inspect:\n{inspect_text}"));
    }
    let mut compact = data.clone();
    if let Some(object) = compact.as_object_mut() {
        if let Some(inspect) = object.get_mut("inspect").and_then(Value::as_object_mut) {
            inspect.remove("textPreview");
            inspect.remove("inspectText");
        }
    }
    let json_text = serde_json::to_string_pretty(&compact).unwrap_or_default();
    sections.push(format!("JSON:\n{json_text}"));
    Some(sections.join("\n\n"))
}

fn inspect_text_result(data: &Value) -> Option<String> {
    if data.get("kind").and_then(Value::as_str) != Some("browser.inspect") {
        return None;
    }
    let inspect_text = data.get("inspectText").and_then(Value::as_str)?;
    let mut compact = data.clone();
    if let Some(object) = compact.as_object_mut() {
        object.remove("textPreview");
        object.remove("inspectText");
    }
    let json_text = serde_json::to_string_pretty(&compact).unwrap_or_default();
    Some(format!("{inspect_text}\n\nJSON:\n{json_text}"))
}

fn string_arg(value: &Value, key: &str) -> String {
    optional_string_arg(value, key).unwrap_or_default()
}

fn optional_string_arg(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number_arg(value: &Value, key: &str) -> f64 {
    optional_number_arg(value, key).unwrap_or(0.0)
}

fn optional_number_arg(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn optional_u64_arg(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|number| *number >= 0.0)
                .map(|number| number as u64)
        })
    })
}

fn optional_bool_arg(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn evaluate_expression(value: &Value) -> String {
    optional_string_arg(value, "expression")
        .or_else(|| optional_string_arg(value, "function"))
        .or_else(|| optional_string_arg(value, "fn"))
        .unwrap_or_default()
}

fn inspect_payload(value: &Value) -> Value {
    json!({
        "action": "inspect",
        "options": {
            "mode": optional_string_arg(value, "mode").unwrap_or_else(|| "compact".to_owned()),
            "interactiveOnly": optional_bool_arg(value, "interactiveOnly").unwrap_or(false),
            "includeTextBlocks": optional_bool_arg(value, "includeTextBlocks").unwrap_or(true),
            "includeHidden": optional_bool_arg(value, "includeHidden").unwrap_or(false),
            "maxNodes": optional_number_arg(value, "maxNodes").unwrap_or(800.0),
            "maxTextChars": optional_number_arg(value, "maxTextChars").unwrap_or(12000.0),
            "maxNameChars": optional_number_arg(value, "maxNameChars").unwrap_or(120.0),
            "maxValueChars": optional_number_arg(value, "maxValueChars").unwrap_or(120.0),
            "viewportMargin": optional_number_arg(value, "viewportMargin").unwrap_or(600.0),
        },
        "timeoutMs": optional_u64_arg(value, "timeoutMs").unwrap_or(3000)
    })
}

fn action_target_payload(action: &str, value: &Value) -> Value {
    let mut payload = Map::new();
    payload.insert("action".to_owned(), Value::String(action.to_owned()));
    let mut options = Map::new();
    if let Some(text) =
        optional_string_arg(value, "text").or_else(|| optional_string_arg(value, "value"))
    {
        payload.insert("text".to_owned(), Value::String(text));
    }
    if let Some(key) = optional_string_arg(value, "key") {
        payload.insert("key".to_owned(), Value::String(key));
    }
    if let Some(ref_value) = optional_string_arg(value, "ref") {
        payload.insert("ref".to_owned(), Value::String(ref_value));
    }
    if let Some(inspect_id) = optional_string_arg(value, "inspectId") {
        payload.insert("inspectId".to_owned(), Value::String(inspect_id));
    }
    if let Some(index) = optional_number_arg(value, "index") {
        payload.insert("index".to_owned(), json!(index));
    }
    if let Some(selector) =
        optional_string_arg(value, "selector").or_else(|| optional_string_arg(value, "element"))
    {
        payload.insert(
            "selector".to_owned(),
            Value::String(
                selector
                    .strip_prefix("css=")
                    .unwrap_or(&selector)
                    .to_owned(),
            ),
        );
    }
    if let Some(timeout_ms) = optional_u64_arg(value, "timeoutMs") {
        payload.insert("timeoutMs".to_owned(), json!(timeout_ms));
    }
    if let Some(values) = value.get("values").filter(|value| value.is_array()) {
        options.insert("values".to_owned(), values.clone());
    } else if let Some(value_arg) = optional_string_arg(value, "value") {
        options.insert("value".to_owned(), Value::String(value_arg));
    }
    if let Some(by) = optional_string_arg(value, "by") {
        options.insert("by".to_owned(), Value::String(by));
    }
    if let Some(checked) = optional_bool_arg(value, "checked") {
        options.insert("checked".to_owned(), Value::Bool(checked));
    }
    if let Some(direction) = optional_string_arg(value, "direction") {
        options.insert("direction".to_owned(), Value::String(direction));
    }
    if let Some(amount) = optional_number_arg(value, "amount") {
        options.insert("amount".to_owned(), json!(amount));
    }
    if let Some(mode) = optional_string_arg(value, "mode") {
        options.insert("mode".to_owned(), Value::String(mode));
    }
    if !options.is_empty() {
        payload.insert("options".to_owned(), Value::Object(options));
    }
    Value::Object(payload)
}

fn combined_action_payload(name: &str, arguments: &Value) -> Option<Value> {
    match name {
        "browser_open_and_inspect" => Some(json!({
            "action": "open",
            "url": string_arg(arguments, "url"),
            "timeoutMs": optional_u64_arg(arguments, "timeoutMs")
        })),
        "browser_click_and_inspect" => Some(action_target_payload("click", arguments)),
        "browser_fill_and_inspect" => Some(action_target_payload("fill", arguments)),
        "browser_type_and_inspect" => Some(action_target_payload("typeText", arguments)),
        "browser_wait_and_inspect" => None,
        _ => None,
    }
}

fn wait_payload(name: &str, arguments: &Value) -> Value {
    let mut payload = Map::new();
    payload.insert("action".to_owned(), Value::String("waitFor".to_owned()));
    if let Some(timeout_ms) = optional_u64_arg(arguments, "timeoutMs") {
        payload.insert("timeoutMs".to_owned(), json!(timeout_ms));
    }
    let allow_flat_wait_target =
        name == "browser_wait_and_inspect" || name == "browser_open_and_inspect";
    apply_wait_condition(
        &mut payload,
        arguments,
        WaitConditionOptions {
            allow_flat_text: name == "browser_wait_and_inspect",
            allow_flat_selector: name == "browser_wait_and_inspect",
            allow_flat_url: allow_flat_wait_target,
        },
    );
    payload.insert(
        "options".to_owned(),
        wait_options(
            arguments,
            WaitConditionOptions {
                allow_flat_text: name == "browser_wait_and_inspect",
                allow_flat_selector: name == "browser_wait_and_inspect",
                allow_flat_url: allow_flat_wait_target,
            },
        ),
    );
    if name == "browser_open_and_inspect" && !payload.contains_key("url") {
        if let Some(url) = optional_string_arg(arguments, "url") {
            payload.insert("url".to_owned(), Value::String(url));
        }
    }
    if !payload.contains_key("text")
        && !payload.contains_key("selector")
        && !payload.contains_key("url")
        && !payload.contains_key("expression")
    {
        payload.insert(
            "expression".to_owned(),
            Value::String(
                "document.readyState === 'interactive' || document.readyState === 'complete'"
                    .to_owned(),
            ),
        );
    }
    Value::Object(payload)
}

fn wait_options(arguments: &Value, options: WaitConditionOptions) -> Value {
    let mut condition = arguments
        .get("condition")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if options.allow_flat_text {
        if let Some(text) = optional_string_arg(arguments, "text") {
            condition
                .entry("textVisible".to_owned())
                .or_insert(Value::String(text));
        }
    }
    if options.allow_flat_selector {
        if let Some(selector) = optional_string_arg(arguments, "selector") {
            condition
                .entry("selectorAttached".to_owned())
                .or_insert(Value::String(selector));
        }
    }
    if options.allow_flat_url {
        if let Some(url) = optional_string_arg(arguments, "url") {
            condition
                .entry("urlIncludes".to_owned())
                .or_insert(Value::String(url));
        }
    }
    if let Some(url) = optional_string_arg(arguments, "urlIncludes") {
        condition
            .entry("urlIncludes".to_owned())
            .or_insert(Value::String(url));
    }
    if let Some(pattern) = optional_string_arg(arguments, "urlMatches") {
        condition
            .entry("urlMatches".to_owned())
            .or_insert(Value::String(pattern));
    }
    if let Some(title) = optional_string_arg(arguments, "titleIncludes") {
        condition
            .entry("titleIncludes".to_owned())
            .or_insert(Value::String(title));
    }
    if let Some(expression) = optional_string_arg(arguments, "fn")
        .or_else(|| optional_string_arg(arguments, "expression"))
        .or_else(|| optional_string_arg(arguments, "function"))
    {
        condition
            .entry("expression".to_owned())
            .or_insert(Value::String(expression));
    }
    if let Some(wait_until) = optional_string_arg(arguments, "waitUntil") {
        condition
            .entry("waitUntil".to_owned())
            .or_insert(Value::String(wait_until));
    }
    if condition.is_empty() {
        condition.insert(
            "waitUntil".to_owned(),
            Value::String("pageStable".to_owned()),
        );
    }

    let mut options_map = Map::new();
    options_map.insert("condition".to_owned(), Value::Object(condition));
    if let Some(poll_ms) = optional_u64_arg(arguments, "pollMs") {
        options_map.insert("pollMs".to_owned(), json!(poll_ms));
    }
    if let Some(quiet_ms) = optional_u64_arg(arguments, "quietMs") {
        options_map.insert("quietMs".to_owned(), json!(quiet_ms));
    }
    Value::Object(options_map)
}

fn apply_wait_condition(
    payload: &mut Map<String, Value>,
    arguments: &Value,
    options: WaitConditionOptions,
) {
    let condition = arguments
        .get("condition")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let flat_text = options
        .allow_flat_text
        .then(|| optional_string_arg(arguments, "text"))
        .flatten();
    if let Some(text) = flat_text.or_else(|| condition_string(&condition, "textVisible")) {
        payload.insert("text".to_owned(), Value::String(text));
    }
    let flat_selector = options
        .allow_flat_selector
        .then(|| optional_string_arg(arguments, "selector"))
        .flatten();
    if let Some(selector) = flat_selector
        .or_else(|| condition_string(&condition, "selectorVisible"))
        .or_else(|| condition_string(&condition, "selectorAttached"))
    {
        payload.insert("selector".to_owned(), Value::String(selector));
    }
    let flat_url = options
        .allow_flat_url
        .then(|| optional_string_arg(arguments, "url"))
        .flatten();
    if let Some(url) = optional_string_arg(arguments, "urlIncludes")
        .or(flat_url)
        .or_else(|| condition_string(&condition, "urlIncludes"))
    {
        payload.insert("url".to_owned(), Value::String(url));
    }
    if let Some(expression) = optional_string_arg(arguments, "fn")
        .or_else(|| optional_string_arg(arguments, "expression"))
        .or_else(|| optional_string_arg(arguments, "function"))
    {
        payload.insert("expression".to_owned(), Value::String(expression));
    } else if let Some(pattern) = optional_string_arg(arguments, "urlMatches")
        .or_else(|| condition_string(&condition, "urlMatches"))
    {
        payload.insert(
            "expression".to_owned(),
            Value::String(format!(
                "new RegExp({}).test(location.href)",
                serde_json::to_string(&pattern).unwrap_or_else(|_| "\"\"".to_owned())
            )),
        );
    } else if let Some(title) = optional_string_arg(arguments, "titleIncludes")
        .or_else(|| condition_string(&condition, "titleIncludes"))
    {
        payload.insert(
            "expression".to_owned(),
            Value::String(format!(
                "document.title.includes({})",
                serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".to_owned())
            )),
        );
    }
}

#[derive(Clone, Copy)]
struct WaitConditionOptions {
    allow_flat_text: bool,
    allow_flat_selector: bool,
    allow_flat_url: bool,
}

fn condition_string(condition: &Map<String, Value>, key: &str) -> Option<String> {
    condition
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn normalize_wait_result(arguments: &Value, value: &Value, options: WaitConditionOptions) -> Value {
    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
    json!({
        "ok": ok,
        "reason": if ok { wait_success_reason(arguments, options) } else { "timeout" },
        "elapsedMs": value.get("elapsedMs").cloned().unwrap_or_else(|| json!(0)),
        "observed": value.get("observed").cloned().unwrap_or_else(|| json!({})),
        "warnings": value.get("warnings").cloned().unwrap_or_else(|| json!([])),
        "error": value.get("error").cloned()
            .or_else(|| value.get("errorCode").map(|code| json!({ "code": code })))
    })
}

fn wait_success_reason(arguments: &Value, options: WaitConditionOptions) -> &'static str {
    let condition = arguments.get("condition").and_then(Value::as_object);
    if (options.allow_flat_text && optional_string_arg(arguments, "text").is_some())
        || condition
            .and_then(|value| value.get("textVisible"))
            .is_some()
    {
        return "text_visible";
    }
    if (options.allow_flat_selector && optional_string_arg(arguments, "selector").is_some())
        || condition
            .and_then(|value| value.get("selectorVisible"))
            .is_some()
    {
        return "selector_visible";
    }
    if (options.allow_flat_url && optional_string_arg(arguments, "url").is_some())
        || optional_string_arg(arguments, "urlIncludes").is_some()
        || optional_string_arg(arguments, "urlMatches").is_some()
        || condition
            .and_then(|value| value.get("urlIncludes"))
            .is_some()
        || condition
            .and_then(|value| value.get("urlMatches"))
            .is_some()
    {
        return "url_matched";
    }
    if optional_string_arg(arguments, "waitUntil").as_deref() == Some("domStable") {
        return "dom_stable";
    }
    "load_finished"
}

fn combined_inspect_payload(arguments: &Value) -> Value {
    if let Some(options) = arguments
        .get("inspectOptions")
        .filter(|value| value.is_object())
    {
        let mut options = options.clone();
        if let Some(timeout_ms) = optional_u64_arg(arguments, "inspectTimeoutMs")
            .or_else(|| optional_u64_arg(arguments, "timeoutMs"))
        {
            if let Some(object) = options.as_object_mut() {
                object.insert("timeoutMs".to_owned(), json!(timeout_ms));
            }
        }
        return inspect_payload(&options);
    }
    inspect_payload(arguments)
}

fn collect_warnings(target: &mut Vec<Value>, warnings: Option<&Value>) {
    if let Some(items) = warnings.and_then(Value::as_array) {
        target.extend(items.iter().cloned());
    }
}

fn fill_form_payload(value: &Value) -> Value {
    let fields = value.get("fields").cloned().unwrap_or_else(|| json!([]));
    json!({ "action": "evaluate", "expression": format!("(() => {{ for (const field of {fields}) {{ const selector = String(field.ref || '').replace(/^css=/, ''); const element = document.querySelector(selector); if (element) {{ element.value = field.value; element.dispatchEvent(new Event('input', {{ bubbles: true }})); }} }} return true; }})()") })
}

fn drag_payload(value: &Value) -> Value {
    let start =
        serde_json::to_string(&string_arg(value, "startRef")).unwrap_or_else(|_| "\"\"".to_owned());
    let end =
        serde_json::to_string(&string_arg(value, "endRef")).unwrap_or_else(|_| "\"\"".to_owned());
    json!({ "action": "evaluate", "expression": format!("(() => {{ const source = document.querySelector({start}.replace(/^css=/, '')); const target = document.querySelector({end}.replace(/^css=/, '')); if (!source || !target) return false; source.dispatchEvent(new DragEvent('dragstart', {{ bubbles: true }})); target.dispatchEvent(new DragEvent('drop', {{ bubbles: true }})); source.dispatchEvent(new DragEvent('dragend', {{ bubbles: true }})); return true; }})()") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exposes_expected_browser_tools() {
        let request = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let response = handle_request(&reqwest::Client::new(), &request, 1, Instant::now())
            .await
            .unwrap();
        let names = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"browser_open"));
        assert!(names.contains(&"browser_inspect"));
        assert!(names.contains(&"browser_fill"));
        assert!(names.contains(&"browser_open_and_inspect"));
        assert!(names.contains(&"browser_click_and_inspect"));
        assert!(names.contains(&"browser_fill_and_inspect"));
        assert!(names.contains(&"browser_type_and_inspect"));
        assert!(names.contains(&"browser_wait_and_inspect"));
        assert!(names.contains(&"browser_navigate"));
        assert!(names.contains(&"browser_evaluate"));
        assert!(names.contains(&"browser_take_screenshot"));
        assert!(names.contains(&"browser_capabilities"));
        assert!(names.contains(&"browser_native_input_probe"));
        assert!(names.contains(&"browser_ax_probe"));
        assert!(names.contains(&"browser_present_probe"));
        assert!(names.contains(&"browser_press_key"));
        assert!(names.contains(&"browser_hover"));
        assert!(names.contains(&"browser_focus"));
        assert!(names.contains(&"browser_scroll"));
        assert!(names.contains(&"browser_scroll_into_view"));
        assert!(names.contains(&"browser_select_option"));
        assert!(names.contains(&"browser_set_checked"));
        assert_eq!(names.len(), 34);
    }

    #[test]
    fn inspect_payload_sets_defaults_and_overrides() {
        let payload = inspect_payload(&json!({
            "interactiveOnly": true,
            "includeTextBlocks": false,
            "maxNodes": 25,
            "timeoutMs": 4500
        }));

        assert_eq!(payload["action"], "inspect");
        assert_eq!(payload["options"]["mode"], "compact");
        assert_eq!(payload["options"]["interactiveOnly"], true);
        assert_eq!(payload["options"]["includeTextBlocks"], false);
        assert_eq!(payload["options"]["maxNodes"], 25.0);
        assert_eq!(payload["options"]["maxTextChars"], 12000.0);
        assert_eq!(payload["timeoutMs"], 4500);
    }

    #[test]
    fn inspect_text_result_prioritizes_agent_readable_tree() {
        let text = inspect_text_result(&json!({
            "kind": "browser.inspect",
            "inspectText": "[0] button \"登录\"",
            "textPreview": "large body text",
            "nodes": [{ "index": 0, "role": "button", "name": "登录" }]
        }))
        .unwrap();

        assert!(text.starts_with("[0] button \"登录\"\n\nJSON:"));
        assert!(text.contains("\"role\": \"button\""));
        assert!(!text.contains("large body text"));
    }

    #[test]
    fn action_target_payload_prefers_inspect_target_fields() {
        let payload = action_target_payload(
            "click",
            &json!({
                "inspectId": "wk-inspect-1",
                "index": 3,
                "ref": "wk-mvp:wk-inspect-1:main:3:abcd1234",
                "selector": "css=#fallback",
                "timeoutMs": 5000
            }),
        );

        assert_eq!(payload["action"], "click");
        assert_eq!(payload["inspectId"], "wk-inspect-1");
        assert_eq!(payload["index"], 3.0);
        assert_eq!(payload["ref"], "wk-mvp:wk-inspect-1:main:3:abcd1234");
        assert_eq!(payload["selector"], "#fallback");
        assert_eq!(payload["timeoutMs"], 5000);
    }

    #[test]
    fn fill_payload_maps_value_to_text() {
        let payload = action_target_payload(
            "fill",
            &json!({
                "selector": "#email",
                "value": "user@example.com"
            }),
        );

        assert_eq!(payload["action"], "fill");
        assert_eq!(payload["selector"], "#email");
        assert_eq!(payload["text"], "user@example.com");
    }

    #[test]
    fn p1_action_payload_carries_options() {
        let press = action_target_payload(
            "press",
            &json!({
                "key": "Meta+Enter",
                "ref": "wk-mvp:target"
            }),
        );
        let select = action_target_payload(
            "select",
            &json!({
                "selector": "#kind",
                "values": ["finance"],
                "by": "value"
            }),
        );
        let checked = action_target_payload(
            "setChecked",
            &json!({
                "index": 2,
                "checked": true
            }),
        );

        assert_eq!(press["action"], "press");
        assert_eq!(press["key"], "Meta+Enter");
        assert_eq!(press["ref"], "wk-mvp:target");
        assert_eq!(select["options"]["values"], json!(["finance"]));
        assert_eq!(select["options"]["by"], "value");
        assert_eq!(checked["options"]["checked"], true);
    }

    #[test]
    fn combined_inspect_payload_uses_nested_options() {
        let payload = combined_inspect_payload(&json!({
            "text": "typed value",
            "inspectOptions": {
                "interactiveOnly": true,
                "maxNodes": 10
            },
            "timeoutMs": 9000
        }));

        assert_eq!(payload["action"], "inspect");
        assert_eq!(payload["options"]["interactiveOnly"], true);
        assert_eq!(payload["options"]["maxNodes"], 10.0);
        assert_eq!(payload["timeoutMs"], 9000);
    }

    #[test]
    fn wait_payload_uses_condition_text_for_fill_combined() {
        let payload = wait_payload(
            "browser_fill_and_inspect",
            &json!({
                "text": "alice@example.com",
                "condition": { "textVisible": "Saved" },
                "timeoutMs": 4000
            }),
        );

        assert_eq!(payload["action"], "waitFor");
        assert_eq!(payload["text"], "Saved");
        assert_eq!(payload["options"]["condition"]["textVisible"], "Saved");
        assert_eq!(payload["timeoutMs"], 4000);
    }

    #[test]
    fn wait_payload_does_not_treat_fill_text_as_wait_text() {
        let payload = wait_payload(
            "browser_fill_and_inspect",
            &json!({
                "text": "alice@example.com"
            }),
        );

        assert_eq!(payload["action"], "waitFor");
        assert!(payload.get("text").is_none());
        assert!(payload.get("expression").is_some());
        assert_eq!(payload["options"]["condition"]["waitUntil"], "pageStable");
    }

    #[test]
    fn wait_payload_does_not_treat_action_selector_as_wait_selector() {
        let payload = wait_payload(
            "browser_click_and_inspect",
            &json!({
                "selector": "#submit"
            }),
        );

        assert_eq!(payload["action"], "waitFor");
        assert!(payload.get("selector").is_none());
        assert!(payload.get("expression").is_some());
        assert_eq!(payload["options"]["condition"]["waitUntil"], "pageStable");
    }

    #[test]
    fn wait_payload_maps_url_and_title_conditions() {
        let url_payload = wait_payload(
            "browser_wait_and_inspect",
            &json!({ "condition": { "urlMatches": "/dashboard" } }),
        );
        let title_payload = wait_payload(
            "browser_wait_and_inspect",
            &json!({ "condition": { "titleIncludes": "Home" } }),
        );

        assert!(url_payload["expression"]
            .as_str()
            .unwrap()
            .contains("location.href"));
        assert!(title_payload["expression"]
            .as_str()
            .unwrap()
            .contains("document.title.includes"));
        assert_eq!(
            url_payload["options"]["condition"]["urlMatches"],
            "/dashboard"
        );
        assert_eq!(
            title_payload["options"]["condition"]["titleIncludes"],
            "Home"
        );
    }

    #[test]
    fn wait_options_maps_flat_fields_only_when_allowed() {
        let fill_options = wait_options(
            &json!({
                "text": "typed value",
                "selector": "#email",
                "url": "https://example.com/result"
            }),
            WaitConditionOptions {
                allow_flat_text: false,
                allow_flat_selector: false,
                allow_flat_url: false,
            },
        );
        let wait_options = wait_options(
            &json!({
                "text": "Ready",
                "selector": "#done",
                "url": "https://example.com/result"
            }),
            WaitConditionOptions {
                allow_flat_text: true,
                allow_flat_selector: true,
                allow_flat_url: true,
            },
        );

        assert_eq!(fill_options["condition"]["waitUntil"], "pageStable");
        assert!(fill_options["condition"].get("textVisible").is_none());
        assert!(fill_options["condition"].get("selectorAttached").is_none());
        assert_eq!(wait_options["condition"]["textVisible"], "Ready");
        assert_eq!(wait_options["condition"]["selectorAttached"], "#done");
        assert_eq!(
            wait_options["condition"]["urlIncludes"],
            "https://example.com/result"
        );
    }
}
