use std::{env, time::Duration};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const BRIDGE_URL_ENV: &str = "WEWORK_COMPUTER_USE_BRIDGE_URL";
const BRIDGE_TOKEN_ENV: &str = "WEWORK_COMPUTER_USE_BRIDGE_TOKEN";

pub fn is_computer_use_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("computer-use-mcp-server")
}

pub async fn run() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
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
                    "serverInfo": {
                        "name": "wegent-computer-use",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }),
        "tools/list" => {
            let id = id?;
            Some(
                match bridge_request(client, json!({ "action": "listTools" })).await {
                    Ok(tools) => result_response(id, json!({ "tools": tools })),
                    Err(error) => error_response(id, -32000, error),
                },
            )
        }
        "tools/call" => {
            let id = id?;
            let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                return Some(error_response(
                    id,
                    -32602,
                    "tools/call requires params.name",
                ));
            };
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(
                match bridge_request(
                    client,
                    json!({ "action": "callTool", "name": name, "arguments": arguments }),
                )
                .await
                {
                    Ok(result) => result_response(id, mcp_tool_result(result)),
                    Err(error) => error_response(id, -32000, error),
                },
            )
        }
        "ping" => id.map(|id| result_response(id, json!({}))),
        _ => id.map(|id| error_response(id, -32601, format!("Unknown method: {method}"))),
    }
}

async fn bridge_request(client: &reqwest::Client, payload: Value) -> Result<Value, String> {
    let url = env::var(BRIDGE_URL_ENV)
        .map_err(|_| "Computer use bridge URL is unavailable".to_owned())?;
    let token = env::var(BRIDGE_TOKEN_ENV)
        .map_err(|_| "Computer use bridge token is unavailable".to_owned())?;
    let response = client
        .post(format!("{}/computer", url.trim_end_matches('/')))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Computer use bridge is unavailable: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Computer use bridge returned HTTP {}",
            response.status()
        ));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Computer use tool failed")
            .to_owned());
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

fn mcp_tool_result(result: Value) -> Value {
    let mut content = Vec::new();
    if let Some(text) = result.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
    }
    if let Some(images) = result.get("images").and_then(Value::as_array) {
        for image in images {
            if let (Some(data), Some(mime_type)) = (
                image.get("dataBase64").and_then(Value::as_str),
                image.get("mimeType").and_then(Value::as_str),
            ) {
                content.push(json!({ "type": "image", "data": data, "mimeType": mime_type }));
            }
        }
    }
    if content.is_empty() {
        content.push(json!({ "type": "text", "text": result.to_string() }));
    }
    let structured_content = result
        .get("structuredJson")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let mut response = json!({
        "content": content,
        "isError": result.get("isError").and_then(Value::as_bool).unwrap_or(false)
    });
    if let Some(structured_content) = structured_content {
        response["structuredContent"] = structured_content;
    }
    response
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[cfg(test)]
mod tests {
    use super::mcp_tool_result;
    use serde_json::json;

    #[test]
    fn maps_cua_text_images_and_structured_output_to_mcp() {
        let result = mcp_tool_result(json!({
            "text": "done",
            "images": [{ "mimeType": "image/png", "dataBase64": "abc" }],
            "structuredJson": "{\"value\":42}",
            "isError": false
        }));

        assert_eq!(
            result["content"][0],
            json!({ "type": "text", "text": "done" })
        );
        assert_eq!(
            result["content"][1],
            json!({ "type": "image", "data": "abc", "mimeType": "image/png" })
        );
        assert_eq!(result["structuredContent"], json!({ "value": 42 }));
        assert_eq!(result["isError"], false);
    }
}
