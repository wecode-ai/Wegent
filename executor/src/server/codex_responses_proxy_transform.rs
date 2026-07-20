// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use std::collections::HashSet;

const WEWORK_BROWSER_NAMESPACE: &str = "wework_browser";

/// Expands the `wework_browser` namespace tool in an OpenAI Responses API
/// request into its inner `function` tools. Returns the set of tool names that
/// were expanded so response rewriting can recognize them.
pub fn expand_wework_browser_namespace_tools(request: &mut Value) -> HashSet<String> {
    let mut expanded = HashSet::new();
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return expanded;
    };

    let mut new_tools = Vec::with_capacity(tools.len());
    for tool in tools.drain(..) {
        if is_wework_browser_namespace_tool(&tool) {
            if let Some(inner) = tool.get("tools").and_then(Value::as_array) {
                for inner_tool in inner {
                    if let Some(name) = inner_tool.get("name").and_then(Value::as_str) {
                        expanded.insert(name.to_owned());
                        new_tools.push(inner_tool.clone());
                    }
                }
            }
        } else {
            new_tools.push(tool);
        }
    }

    if let Some(request_object) = request.as_object_mut() {
        request_object.insert("tools".to_owned(), Value::Array(new_tools));
    }
    expanded
}

fn is_wework_browser_namespace_tool(tool: &Value) -> bool {
    tool.get("type").and_then(Value::as_str) == Some("namespace")
        && tool.get("name").and_then(Value::as_str) == Some(WEWORK_BROWSER_NAMESPACE)
}

/// Rewrites flat `function_call` items for tools that originated from the
/// `wework_browser` namespace so Codex receives them as namespaced calls.
pub fn rewrite_wework_browser_function_calls(value: &mut Value, expanded: &HashSet<String>) {
    rewrite_value(value, expanded);
}

fn rewrite_value(value: &mut Value, expanded: &HashSet<String>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("function_call") {
                if let Some(name) = map.get("name").and_then(Value::as_str) {
                    if expanded.contains(name)
                        && map
                            .get("namespace")
                            .map_or(true, |namespace| namespace.is_null())
                    {
                        map.insert(
                            "namespace".to_owned(),
                            Value::String(WEWORK_BROWSER_NAMESPACE.to_owned()),
                        );
                    }
                }
            }
            for child in map.values_mut() {
                rewrite_value(child, expanded);
            }
        }
        Value::Array(array) => {
            for child in array.iter_mut() {
                rewrite_value(child, expanded);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expands_wework_browser_namespace_into_flat_functions() {
        let mut request = json!({
            "model": "doubao",
            "tools": [
                {"type": "function", "name": "exec_command"},
                {
                    "type": "namespace",
                    "name": "wework_browser",
                    "tools": [
                        {"type": "function", "name": "browser_navigate", "parameters": {}},
                        {"type": "function", "name": "browser_snapshot", "parameters": {}}
                    ]
                }
            ]
        });

        let expanded = expand_wework_browser_namespace_tools(&mut request);

        assert_eq!(
            expanded,
            HashSet::from(["browser_navigate".to_owned(), "browser_snapshot".to_owned()])
        );
        let tools = request["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], "exec_command");
        assert_eq!(tools[1]["name"], "browser_navigate");
        assert_eq!(tools[2]["name"], "browser_snapshot");
    }

    #[test]
    fn leaves_non_browser_namespace_tools_unchanged() {
        let mut request = json!({
            "tools": [
                {
                    "type": "namespace",
                    "name": "other_namespace",
                    "tools": [{"type": "function", "name": "other_tool"}]
                }
            ]
        });

        let expanded = expand_wework_browser_namespace_tools(&mut request);

        assert!(expanded.is_empty());
        let tools = request["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "other_namespace");
    }

    #[test]
    fn rewrites_flat_browser_function_calls_to_namespace() {
        let mut response = json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "call_id": "call-1",
                "name": "browser_navigate",
                "arguments": "{\"url\":\"https://example.com\"}"
            }
        });
        let expanded = HashSet::from(["browser_navigate".to_owned()]);

        rewrite_wework_browser_function_calls(&mut response, &expanded);

        assert_eq!(response["item"]["namespace"], "wework_browser");
        assert_eq!(response["item"]["name"], "browser_navigate");
    }

    #[test]
    fn does_not_rewrite_non_browser_function_calls() {
        let mut response = json!({
            "output": [{
                "type": "function_call",
                "call_id": "call-2",
                "name": "exec_command",
                "arguments": "{}"
            }]
        });
        let expanded = HashSet::from(["browser_navigate".to_owned()]);

        rewrite_wework_browser_function_calls(&mut response, &expanded);

        assert!(response["output"][0].get("namespace").is_none());
    }
}
