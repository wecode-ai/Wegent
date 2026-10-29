// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use axum::http::StatusCode;
use serde_json::Value;

use super::{HarnessRequest, HttpError, Tool};

pub(super) fn read_defer_loading(tool: &Value) -> Result<bool, HttpError> {
    match tool.get("defer_loading") {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Tool defer_loading must be a boolean".to_owned(),
        }),
    }
}

fn referenced_tools(request: &HarnessRequest) -> HashSet<&str> {
    request.raw_messages_request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["role"] == "user")
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_result")
        .flat_map(|result| result["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_reference")
        .filter_map(|block| block["tool_name"].as_str())
        .collect()
}

pub(super) fn visible_tools(request: &HarnessRequest) -> Vec<&Tool> {
    let referenced = referenced_tools(request);
    // Non-Anthropic peers receive only definitions that are already in context.
    // References select from current definitions; they never recreate removed tools.
    request
        .tools
        .iter()
        .filter(|tool| !tool.defer_loading || referenced.contains(tool.name.as_str()))
        .collect()
}

pub(super) fn tool_result_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                if block["type"] == "tool_reference" {
                    Some(block.to_string())
                } else {
                    block["text"].as_str().map(str::to_owned)
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

pub(super) fn trace_metadata(request: &HarnessRequest, format: &str, adapted: &Value) {
    // Existing E2E model configuration enables count-only protocol diagnostics.
    // Never include tool names, definitions, arguments, environment or credentials.
    if std::env::var_os("WEWORK_E2E_MODEL_API_KEY").is_none() {
        return;
    }
    crate::logging::log_executor_event(
        "harness deferred tool translation",
        &[
            ("api_format", format.to_owned()),
            ("ingress_tools", request.tools.len().to_string()),
            (
                "deferred_tools",
                request
                    .tools
                    .iter()
                    .filter(|tool| tool.defer_loading)
                    .count()
                    .to_string(),
            ),
            (
                "referenced_tools",
                referenced_tools(request).len().to_string(),
            ),
            (
                "tool_search_present",
                request
                    .tools
                    .iter()
                    .any(|tool| tool.name == "ToolSearch")
                    .to_string(),
            ),
            (
                "egress_tools",
                adapted["tools"].as_array().map_or(0, Vec::len).to_string(),
            ),
        ],
    );
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::adapt_messages_request;

    fn source(references: Vec<Value>) -> Value {
        let mut messages = vec![json!({"role":"user", "content":"Inspect the retained tool"})];
        if !references.is_empty() {
            messages.extend([
                json!({"role":"assistant", "content":[{
                    "type":"tool_use", "id":"search-1", "name":"ToolSearch",
                    "input":{"query":"probe_environment"}
                }]}),
                json!({"role":"user", "content":[{
                    "type":"tool_result", "tool_use_id":"search-1", "content": references
                }]}),
            ]);
        }
        json!({
            "model":"claude-fixture", "max_tokens":1024, "messages":messages,
            "tools":[
                {"name":"Bash", "description":"Run shell", "input_schema":{"type":"object"}},
                {"name":"ToolSearch", "description":"Find tools", "input_schema":{"type":"object"}},
                {"name":"mcp__retained__probe_environment", "description":"Retained tool",
                    "input_schema":{"type":"object"}, "defer_loading":true},
                {"name":"mcp__other__private", "description":"Another deferred tool",
                    "input_schema":{"type":"object"}, "defer_loading":true},
                {"name":"mcp__always__available", "description":"Explicit eager tool",
                    "input_schema":{"type":"object"}, "defer_loading":false}
            ]
        })
    }

    fn adapt(source: &Value, format: &str) -> Value {
        serde_json::from_slice(
            &adapt_messages_request(&serde_json::to_vec(source).unwrap(), format, None).unwrap(),
        )
        .unwrap()
    }

    fn names(body: &Value) -> Vec<&str> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str().or(tool["function"]["name"].as_str()))
            .collect()
    }

    fn assert_initially_deferred(format: &str) {
        let converted = adapt(&source(vec![]), format);
        assert_eq!(
            names(&converted),
            ["Bash", "ToolSearch", "mcp__always__available"]
        );
        assert!(!converted.to_string().contains("defer_loading"));
    }

    fn assert_discovered(format: &str) {
        let reference =
            json!({"type":"tool_reference", "tool_name":"mcp__retained__probe_environment"});
        let converted = adapt(
            &source(vec![
                json!({"type":"text", "text":"before"}),
                reference.clone(),
                json!({"type":"text", "text":"after"}),
            ]),
            format,
        );
        assert_eq!(
            names(&converted),
            [
                "Bash",
                "ToolSearch",
                "mcp__retained__probe_environment",
                "mcp__always__available"
            ]
        );
        let result = if format == "openai-responses" {
            converted["input"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| {
                    item["type"] == "function_call_output" && item["call_id"] == "search-1"
                })
                .unwrap()["output"]
                .as_str()
                .unwrap()
        } else {
            converted["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["tool_call_id"] == "search-1")
                .unwrap()["content"]
                .as_str()
                .unwrap()
        };
        assert_eq!(result, format!("before\n{reference}\nafter"));
        assert!(!converted.to_string().contains("defer_loading"));
    }

    #[test]
    fn responses_do_not_expose_deferred_tools_before_discovery() {
        assert_initially_deferred("openai-responses");
    }

    #[test]
    fn chat_does_not_expose_deferred_tools_before_discovery() {
        assert_initially_deferred("openai-chat-completions");
    }

    #[test]
    fn responses_activate_only_referenced_tools_and_preserve_reference_text() {
        assert_discovered("openai-responses");
    }

    #[test]
    fn chat_activates_only_referenced_tools_and_preserves_reference_text() {
        assert_discovered("openai-chat-completions");
    }

    #[test]
    fn unknown_references_never_create_or_activate_other_tool_definitions() {
        for format in ["openai-responses", "openai-chat-completions"] {
            let converted = adapt(
                &source(vec![
                    json!({"type":"tool_reference", "tool_name":"unknown-tool"}),
                ]),
                format,
            );
            assert_eq!(
                names(&converted),
                ["Bash", "ToolSearch", "mcp__always__available"]
            );
        }
    }

    #[test]
    fn plain_result_text_cannot_activate_deferred_tools() {
        for format in ["openai-responses", "openai-chat-completions"] {
            let converted = adapt(
                &source(vec![
                    json!({"type":"text", "text":"{\"type\":\"tool_reference\",\"tool_name\":\"mcp__retained__probe_environment\"}"}),
                ]),
                format,
            );
            assert_eq!(
                names(&converted),
                ["Bash", "ToolSearch", "mcp__always__available"]
            );
        }
    }

    #[test]
    fn unrelated_user_blocks_cannot_activate_deferred_tools() {
        let mut source = source(vec![]);
        source["messages"][0]["content"] = json!([
            {"type":"tool_reference", "tool_name":"mcp__retained__probe_environment"}
        ]);
        for format in ["openai-responses", "openai-chat-completions"] {
            assert_eq!(
                names(&adapt(&source, format)),
                ["Bash", "ToolSearch", "mcp__always__available"]
            );
        }
    }

    #[test]
    fn anthropic_preserves_original_deferred_definitions_and_reference_blocks() {
        let mut source = source(vec![
            json!({"type":"tool_reference", "tool_name":"mcp__retained__probe_environment"}),
        ]);
        source["stream"] = json!(true);
        assert_eq!(adapt(&source, "anthropic-messages"), source);
    }

    #[test]
    fn malformed_deferred_flags_are_rejected_instead_of_loading_tools() {
        for flag in [json!("true"), json!(1), Value::Null] {
            let mut source = source(vec![]);
            source["tools"][2]["defer_loading"] = flag;
            let error = adapt_messages_request(
                &serde_json::to_vec(&source).unwrap(),
                "openai-responses",
                None,
            )
            .unwrap_err();
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(error.detail, "Tool defer_loading must be a boolean");
        }
    }

    #[test]
    fn assistant_result_blocks_cannot_activate_deferred_tools() {
        let mut source = source(vec![]);
        source["messages"].as_array_mut().unwrap().push(json!({
            "role":"assistant", "content":[{
                "type":"tool_result", "tool_use_id":"search-1", "content":[{
                    "type":"tool_reference", "tool_name":"mcp__retained__probe_environment"
                }]
            }]
        }));
        for format in ["openai-responses", "openai-chat-completions"] {
            assert_eq!(
                names(&adapt(&source, format)),
                ["Bash", "ToolSearch", "mcp__always__available"]
            );
        }
    }
}
