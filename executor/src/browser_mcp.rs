use std::env;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:9231";
const BRIDGE_URL_ENV: &str = "WEWORK_EMBEDDED_BROWSER_BRIDGE_URL";
const BROWSER_LABEL_ENV: &str = "WEWORK_EMBEDDED_BROWSER_LABEL";

pub fn is_browser_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("browser-mcp-server")
}

pub async fn run() -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(&client, &request).await,
            Err(error) => Some(error_response(Value::Null, -32700, error.to_string())),
        };
        if let Some(response) = response {
            let mut encoded = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
            encoded.push(b'\n');
            stdout
                .write_all(&encoded)
                .await
                .map_err(|error| error.to_string())?;
            stdout.flush().await.map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn handle_request(client: &reqwest::Client, request: &Value) -> Option<Value> {
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
            Some(result_response(id, execute_tool(client, name, &arguments).await))
        }
        _ => id.map(|id| error_response(id, -32601, format!("Unknown method: {method}"))),
    }
}

async fn execute_tool(client: &reqwest::Client, name: &str, arguments: &Value) -> Value {
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

    match call_bridge(client, bridge_payload).await {
        Ok(value) => text_result(value, false),
        Err(error) => text_result(error, true),
    }
}

async fn call_bridge(client: &reqwest::Client, mut payload: Value) -> Result<Value, String> {
    if let (Some(label), Some(object)) = (env::var(BROWSER_LABEL_ENV).ok(), payload.as_object_mut())
    {
        if !label.trim().is_empty() {
            object.insert("label".to_owned(), Value::String(label));
        }
    }
    let base_url = env::var(BRIDGE_URL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIDGE_URL.to_owned());
    let response = client
        .post(format!("{}/browser", base_url.trim_end_matches('/')))
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            format!("Embedded browser bridge is unavailable at {base_url}: {error}")
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Embedded browser bridge returned HTTP {}",
            response.status()
        ));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
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

fn tools() -> Vec<Value> {
    vec![
        tool(
            "browser_navigate",
            "Navigate the Wework built-in browser to a URL.",
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
            "List Wework built-in browser tabs.",
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
        let response = handle_request(&reqwest::Client::new(), &request)
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
