use super::*;

use std::{
    env, fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use axum::{body::to_bytes, routing::post, Json, Router};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

fn cross_protocol_history_with_invalid_ids() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "model": "gpt-5.6-sol",
        "input": [
            {
                "type": "function_call",
                "id": "fc_functions.exec_command:0",
                "call_id": "functions.exec_command:0",
                "name": "exec_command",
                "arguments": "{}"
            },
            {
                "type": "function_call_output",
                "call_id": "functions.exec_command:0",
                "output": "done"
            }
        ]
    }))
    .expect("request body")
}

fn assert_valid_api_id(value: &str) {
    assert!(value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')));
}

async fn collect_responses_stream<S, E>(stream: S) -> String
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: ToString,
{
    normalize_responses_stream(stream, HashSet::new())
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|chunk| String::from_utf8_lossy(&chunk.expect("normalized chunk")).into_owned())
        .collect()
}

/// Mirrors the upstream Responses pairing rule: a `function_call` must be
/// followed by its `function_call_output` before any other item, otherwise
/// the upstream rejects the turn with `No tool output found for tool call ...`.
fn upstream_rejects_interleaved_tool_items(body: &Value) -> Option<String> {
    let mut pending = Vec::new();
    for item in body.get("input")?.as_array()? {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        match item_type {
            "function_call" => pending.push(
                item.get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            "function_call_output" => {
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match pending.iter().position(|pending| pending == call_id) {
                    Some(position) => {
                        pending.remove(position);
                    }
                    None => return Some(format!("unsolicited tool output for {call_id}")),
                }
            }
            _ => {
                if let Some(call_id) = pending.first() {
                    return Some(format!("No tool output found for tool call {call_id}."));
                }
            }
        }
    }
    pending
        .first()
        .map(|call_id| format!("No tool output found for tool call {call_id}."))
}

fn assert_compact_bridged_app_tools(request: &Value, tool_name_pointer: &str) {
    let tools = request["tools"].as_array().expect("request tools");
    let tool_bytes = serde_json::to_vec(tools).expect("serialize tools");
    assert_eq!(tools.len(), 1);
    assert_eq!(
        tools[0].pointer(tool_name_pointer).and_then(Value::as_str),
        Some(chat::BRIDGED_TOOL_SEARCH_NAME)
    );
    assert!(
        tool_bytes.len() < 1_024,
        "first-turn tools must stay compact: {} bytes",
        tool_bytes.len()
    );
    assert!(
        !request.to_string().contains("github__create_issue"),
        "App schema must not be injected before tool search"
    );
}

fn assert_single_loaded_app_tool(
    request: &Value,
    tool_name_pointer: &str,
    expected_app_name: &str,
) {
    let tools = request["tools"].as_array().expect("request tools");
    assert_eq!(tools.len(), 2);
    assert_eq!(
        tools
            .iter()
            .filter(|tool| {
                tool.pointer(tool_name_pointer).and_then(Value::as_str) == Some(expected_app_name)
            })
            .count(),
        1,
        "only the App tool selected by tool_search should be expanded"
    );
}

fn proxy_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
    );
    headers
}

fn mixed_tool_turn_request() -> Value {
    json!({
        "model": "kimi-k3",
        "stream": true,
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Inspect it"}]},
            {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect it."}]},
            {"type": "function_call", "call_id": "call_previous", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
            {"type": "function_call_output", "call_id": "call_previous", "output": "/workspace"},
            {"role": "user", "content": [{"type": "input_text", "text": "Continue"}]}
        ],
        "tools": [{
            "type": "function",
            "name": "exec_command",
            "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"]
            }
        }]
    })
}

fn app_tool_search_request(include_loaded_app: bool) -> Value {
    let tools = vec![json!({
        "type": "tool_search",
        "execution": "client",
        "description": "Search available Apps",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": false
        }
    })];
    let mut input = vec![json!({
        "role": "user",
        "content": [{"type": "input_text", "text": "Create a GitHub issue"}]
    })];
    if include_loaded_app {
        input.extend([
            json!({
                "type": "tool_search_call",
                "call_id": "search_1",
                "execution": "client",
                "arguments": {"query": "GitHub create issue"}
            }),
            json!({
                "type": "tool_search_output",
                "call_id": "search_1",
                "execution": "client",
                "status": "completed",
                "tools": [{
                    "type": "namespace",
                    "name": "github",
                    "description": "GitHub App",
                    "tools": [{
                        "type": "function",
                        "name": "create_issue",
                        "description": "Create a GitHub issue",
                        "parameters": {
                            "type": "object",
                            "properties": {"title": {"type": "string"}},
                            "required": ["title"]
                        }
                    }]
                }]
            }),
        ]);
    }
    json!({
        "model": "third-party-chat",
        "stream": true,
        "input": input,
        "tools": tools
    })
}

fn app_tool_result_request() -> Value {
    let mut request = app_tool_search_request(true);
    request["input"]
        .as_array_mut()
        .expect("request input")
        .extend([
            json!({
                "type": "function_call",
                "call_id": "app_1",
                "namespace": "github",
                "name": "create_issue",
                "arguments": "{\"title\":\"Bug\"}"
            }),
            json!({
                "type": "function_call_output",
                "call_id": "app_1",
                "output": {
                    "_meta": null,
                    "content": [{
                        "type": "text",
                        "text": "GitHub tool completed successfully."
                    }],
                    "structuredContent": {
                        "id": 42,
                        "url": "https://github.example/issues/42"
                    }
                }
            }),
        ]);
    request
}

mod cases_1;

mod cases_2;

mod cases_3;

mod cases_4;

mod deepseek_custom_tools;
mod sse_regressions;
