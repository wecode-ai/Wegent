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
        "browser_navigate" | "browser_tab_new" => {
            json!({ "action": "navigate", "url": string_arg(arguments, "url") })
        }
        "browser_snapshot" => json!({
            "action": "evaluate",
            "expression": "({ title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 12000) || '' })"
        }),
        "browser_evaluate" => json!({
            "action": "evaluate",
            "expression": evaluate_expression(arguments)
        }),
        "browser_take_screenshot" => json!({ "action": "screenshot" }),
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
        "browser_click" => json!({ "action": "click", "selector": selector_arg(arguments) }),
        "browser_click_coordinates" => json!({
            "action": "click",
            "x": number_arg(arguments, "x"),
            "y": number_arg(arguments, "y")
        }),
        "browser_type" => json!({
            "action": "typeText",
            "selector": selector_arg(arguments),
            "text": string_arg(arguments, "text")
        }),
        "browser_press_key" => json!({ "action": "press", "key": string_arg(arguments, "key") }),
        "browser_wait_for" => json!({
            "action": "waitFor",
            "text": optional_string_arg(arguments, "text"),
            "selector": optional_string_arg(arguments, "selector"),
            "url": optional_string_arg(arguments, "url"),
            "expression": optional_string_arg(arguments, "fn"),
            "timeoutMs": optional_number_arg(arguments, "timeoutMs")
        }),
        "browser_resize" => {
            return text_result(
                "Embedded browser size follows the Wework right panel bounds.",
                false,
            )
        }
        "browser_hover" => evaluate_payload(
            arguments,
            "element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true",
        ),
        "browser_scroll_into_view" => evaluate_payload(
            arguments,
            "element.scrollIntoView({ block: 'center', inline: 'center' }); true",
        ),
        "browser_scroll" => json!({
            "action": "evaluate",
            "expression": format!(
                "window.scrollBy(0, {} * {}), true",
                if string_arg(arguments, "direction") == "up" { -1 } else { 1 },
                optional_number_arg(arguments, "amount").unwrap_or(500.0)
            )
        }),
        "browser_select_option" => select_payload(arguments),
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
            "browser_navigate",
            "Navigate the built-in browser in Wegent's Wework desktop app to a URL.",
            &["url"],
        ),
        tool(
            "browser_snapshot",
            "Capture a text snapshot of the current page.",
            &[],
        ),
        tool(
            "browser_click",
            "Click an element by CSS selector or snapshot ref.",
            &[],
        ),
        tool(
            "browser_click_coordinates",
            "Click viewport coordinates.",
            &["x", "y"],
        ),
        tool("browser_type", "Type text into an element.", &["text"]),
        tool(
            "browser_fill_form",
            "Fill multiple form fields.",
            &["fields"],
        ),
        tool("browser_press_key", "Press a keyboard key.", &["key"]),
        tool("browser_hover", "Hover an element.", &[]),
        tool("browser_scroll", "Scroll the current page.", &[]),
        tool(
            "browser_scroll_into_view",
            "Scroll an element into view.",
            &[],
        ),
        tool("browser_select_option", "Select option values.", &[]),
        tool("browser_drag", "Drag between two elements.", &[]),
        tool("browser_wait_for", "Wait for page state.", &[]),
        tool(
            "browser_resize",
            "Resize the embedded browser viewport.",
            &[],
        ),
        tool("browser_take_screenshot", "Capture a page screenshot.", &[]),
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
        "key",
        "selector",
        "expression",
        "function",
        "fn",
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
    let text = data
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| serde_json::to_string_pretty(&data).unwrap_or_default());
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
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

fn selector_arg(value: &Value) -> String {
    let selector = optional_string_arg(value, "ref")
        .or_else(|| optional_string_arg(value, "element"))
        .or_else(|| optional_string_arg(value, "selector"))
        .unwrap_or_default();
    selector
        .strip_prefix("css=")
        .unwrap_or(&selector)
        .to_owned()
}

fn evaluate_expression(value: &Value) -> String {
    optional_string_arg(value, "expression")
        .or_else(|| optional_string_arg(value, "function"))
        .or_else(|| optional_string_arg(value, "fn"))
        .unwrap_or_default()
}

fn evaluate_payload(value: &Value, action: &str) -> Value {
    let selector =
        serde_json::to_string(&selector_arg(value)).unwrap_or_else(|_| "\"\"".to_owned());
    json!({
        "action": "evaluate",
        "expression": format!("(() => {{ const element = document.querySelector({selector}); if (!element) return false; {action} }})()")
    })
}

fn select_payload(value: &Value) -> Value {
    let selector =
        serde_json::to_string(&selector_arg(value)).unwrap_or_else(|_| "\"\"".to_owned());
    let values = value.get("values").cloned().unwrap_or_else(|| json!([]));
    json!({ "action": "evaluate", "expression": format!("(() => {{ const element = document.querySelector({selector}); const values = {values}; for (const option of element?.options || []) option.selected = values.includes(option.value); element?.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()") })
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
        assert!(names.contains(&"browser_navigate"));
        assert!(names.contains(&"browser_evaluate"));
        assert!(names.contains(&"browser_take_screenshot"));
        assert_eq!(names.len(), 20);
    }

    #[test]
    fn strips_css_ref_prefix() {
        assert_eq!(selector_arg(&json!({ "ref": "css=#submit" })), "#submit");
    }
}
