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

mod payload;
mod result_text;
mod tools;

use payload::{
    action_target_payload, collect_warnings, combined_action_payload, combined_inspect_payload,
    evaluate_action_violation, evaluate_expression, inspect_payload, normalize_wait_result,
    number_arg, optional_bool_arg, optional_number_arg, optional_string_arg, optional_u64_arg,
    string_arg, wait_options, wait_payload, WaitConditionOptions,
};
use result_text::{text_result, text_result_with_options};

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:9231";
const BRIDGE_URL_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_URL";
const BRIDGE_TOKEN_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN";
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
        "tools/list" => id.map(|id| result_response(id, json!({ "tools": tools::tools() }))),
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
        "browser_evaluate" => {
            let expression = evaluate_expression(arguments);
            if let Some(reason) = evaluate_action_violation(&expression) {
                return text_result(
                    format!(
                        "browser_evaluate only supports read-only diagnostics during normal browser tasks ({reason}). Use browser_fill/browser_click/browser_press_key/browser_open for page actions."
                    ),
                    true,
                );
            }
            json!({
                "action": "evaluate",
                "expression": expression
            })
        }
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
        "browser_fill_form" => {
            return text_result(
                "browser_fill_form is disabled for WKWebView because it previously used unrestricted JavaScript evaluation. Use browser_fill once per inspected field.",
                true,
            )
        }
        "browser_drag" => {
            return text_result(
                "browser_drag is disabled for WKWebView because trusted drag input is not available in the current browser backend.",
                true,
            )
        }
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
        Ok(value) => {
            let is_error = bridge_value_is_error(name, &value);
            text_result_with_options(
                value,
                is_error,
                optional_bool_arg(arguments, "includeJson").unwrap_or(false),
            )
        }
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
                log_request(
                    sequence,
                    "bridge_action_error",
                    "tools/call",
                    Some(name),
                    started,
                    Some(&message),
                );
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
    text_result_with_options(
        Value::Object(result),
        !ok,
        optional_bool_arg(arguments, "includeJson").unwrap_or(false),
    )
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
    let mut request = client
        .post(format!("{}/browser", base_url.trim_end_matches('/')))
        .json(&payload);
    if let Some(token) = non_empty_env(BRIDGE_TOKEN_ENV) {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|error| {
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

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

fn bridge_value_is_error(tool: &str, value: &Value) -> bool {
    value.get("ok").and_then(Value::as_bool) == Some(false)
        && matches!(
            tool,
            "browser_open"
                | "browser_navigate"
                | "browser_tab_new"
                | "browser_click"
                | "browser_click_coordinates"
                | "browser_type"
                | "browser_fill"
                | "browser_press_key"
                | "browser_wait_for"
                | "browser_hover"
                | "browser_focus"
                | "browser_scroll_into_view"
                | "browser_scroll"
                | "browser_select_option"
                | "browser_set_checked"
                | "browser_fill_form"
                | "browser_drag"
        )
}

#[cfg(test)]
mod tests;
