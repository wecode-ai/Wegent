// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stdio MCP proxy for Wegent cloud connector applications.

use std::env;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::connector_gateway::load_connector_gateway_config;

pub fn is_connector_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("connector-mcp-server")
}

pub async fn run() -> Result<(), String> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(&request).await,
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

async fn handle_request(request: &Value) -> Option<Value> {
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
                        "name": "wegent_apps",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }),
        "ping" => id.map(|id| result_response(id, json!({}))),
        "tools/list" => {
            let id = id?;
            Some(
                match connector_gateway_request(reqwest::Method::GET, "tools", None).await {
                    Ok(value) => result_response(id, json!({ "tools": mcp_tools(&value) })),
                    Err(error) => error_response(id, -32001, error),
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
                match connector_gateway_request(
                    reqwest::Method::POST,
                    "call",
                    Some(json!({ "name": name, "arguments": arguments })),
                )
                .await
                {
                    Ok(value) => result_response(id, tool_result(&value)),
                    Err(error) => result_response(id, text_result(error, true)),
                },
            )
        }
        _ => id.map(|id| error_response(id, -32601, format!("Unknown method: {method}"))),
    }
}

fn mcp_tools(value: &Value) -> Vec<Value> {
    value
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            Some(json!({
                "name": tool.get("name")?.as_str()?,
                "title": tool.get("title").cloned().unwrap_or(Value::Null),
                "description": tool.get("description").cloned().unwrap_or_else(|| json!("")),
                "inputSchema": tool.get("input_schema").cloned().unwrap_or_else(|| json!({
                    "type": "object", "properties": {}
                })),
                "annotations": tool.get("annotations").cloned().unwrap_or(Value::Null)
            }))
        })
        .collect()
}

fn tool_result(value: &Value) -> Value {
    let content = value.get("content").cloned().unwrap_or(Value::Null);
    let is_error = value
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut result = if is_mcp_content(&content) {
        json!({ "content": content, "isError": is_error })
    } else if let Some(nested) = content.get("content").filter(|item| is_mcp_content(item)) {
        json!({ "content": nested, "isError": is_error })
    } else {
        let text = match content {
            Value::String(text) => text,
            other => serde_json::to_string(&other).unwrap_or_else(|_| "null".to_owned()),
        };
        text_result(text, is_error)
    };
    if let Some(structured_content) = value
        .get("structured_content")
        .filter(|item| !item.is_null())
    {
        result["structuredContent"] = structured_content.clone();
    }
    result
}

fn is_mcp_content(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().all(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| !kind.is_empty())
        })
    })
}

fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text.into() }],
        "isError": is_error
    })
}

async fn connector_gateway_request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    load_connector_gateway_config()?
        .request(method, path, body)
        .await
        .map_err(|error| error.message)
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_backend_tool_schema_to_mcp_shape() {
        let tools = mcp_tools(&json!({ "tools": [{
            "name": "tickets__search",
            "description": "Search tickets",
            "input_schema": { "type": "object", "properties": { "q": { "type": "string" } } },
            "annotations": { "readOnlyHint": true }
        }] }));
        assert_eq!(tools[0]["name"], "tickets__search");
        assert_eq!(tools[0]["inputSchema"]["properties"]["q"]["type"], "string");
    }

    #[test]
    fn preserves_upstream_mcp_content_blocks() {
        let result = tool_result(&json!({
            "content": [{ "type": "text", "text": "done" }],
            "structured_content": { "ticket": { "id": "T-1" } },
            "is_error": false
        }));

        assert_eq!(result["content"][0]["text"], "done");
        assert_eq!(result["structuredContent"]["ticket"]["id"], "T-1");
        assert_eq!(result["isError"], false);
    }
}
