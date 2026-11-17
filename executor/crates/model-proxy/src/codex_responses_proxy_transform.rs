// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use std::collections::HashSet;

const WEWORK_BROWSER_NAMESPACE: &str = "wework_browser";

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
