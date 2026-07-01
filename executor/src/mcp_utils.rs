// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::protocol::ExecutionRequest;

pub fn extract_mcp_servers_config(config: &Value) -> Option<&Value> {
    let object = config.as_object()?;
    let mut candidates = Vec::new();

    for outer_key in ["mcpServers", "mcp_servers"] {
        let Some(value) = object
            .get(outer_key)
            .filter(|value| is_non_empty_object(value))
        else {
            continue;
        };
        let mut found_double = false;
        for inner_key in ["mcpServers", "mcp_servers"] {
            if let Some(nested) = value
                .get(inner_key)
                .filter(|nested| is_non_empty_object(nested))
            {
                candidates.push(McpConfigCandidate::double(outer_key, inner_key, nested));
                found_double = true;
            }
        }
        if !found_double {
            candidates.push(McpConfigCandidate::single(outer_key, value));
        }
    }

    select_mcp_config_candidate(&candidates).or_else(|| object.get("mcp_servers"))
}

pub fn replace_mcp_server_variables(
    mcp_servers: &Value,
    task_data: Option<&ExecutionRequest>,
) -> Value {
    if is_empty_json(mcp_servers) {
        return mcp_servers.clone();
    }
    let Some(task_data) = task_data else {
        return mcp_servers.clone();
    };
    let source = task_data.variable_context();
    replace_variables_recursive(mcp_servers, Some(&source))
}

pub fn replace_variables_recursive(value: &Value, source: Option<&Value>) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), replace_variables_recursive(value, source)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| replace_variables_recursive(value, source))
                .collect(),
        ),
        Value::String(text) => Value::String(replace_placeholders_in_string(text, source)),
        value => value.clone(),
    }
}

pub fn replace_placeholders_in_string(text: &str, source: Option<&Value>) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;

    while let Some(start_offset) = text[cursor..].find("${{") {
        let start = cursor + start_offset;
        output.push_str(&text[cursor..start]);
        let path_start = start + 3;
        let Some(end_offset) = text[path_start..].find("}}") else {
            output.push_str(&text[start..]);
            return output;
        };
        let end = path_start + end_offset;
        let placeholder_end = end + 2;
        let placeholder = &text[start..placeholder_end];
        let path = text[path_start..end].trim();

        if let Some(value) = get_nested_value(source, path).filter(|value| !value.is_null()) {
            output.push_str(&value_to_placeholder_text(value));
        } else {
            output.push_str(placeholder);
        }
        cursor = placeholder_end;
    }

    output.push_str(&text[cursor..]);
    output
}

pub fn get_nested_value<'a>(source: Option<&'a Value>, path: &str) -> Option<&'a Value> {
    let mut current = source?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }

    for key in path.split('.') {
        current = match current {
            Value::Object(object) => object.get(key)?,
            Value::Array(values) => {
                let index = key.parse::<usize>().ok()?;
                values.get(index)?
            }
            _ => return None,
        };
    }

    Some(current)
}

fn value_to_placeholder_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        value => value.to_string(),
    }
}

fn select_mcp_config_candidate<'a>(candidates: &[McpConfigCandidate<'a>]) -> Option<&'a Value> {
    for (outer_key, inner_key) in [
        ("mcpServers", Some("mcpServers")),
        ("mcpServers", Some("mcp_servers")),
        ("mcp_servers", Some("mcp_servers")),
        ("mcp_servers", Some("mcpServers")),
        ("mcpServers", None),
        ("mcp_servers", None),
    ] {
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.outer_key == outer_key && candidate.inner_key == inner_key)
        {
            return Some(candidate.config);
        }
    }
    None
}

fn is_non_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(|object| !object.is_empty())
}

fn is_empty_json(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(values) => values.is_empty(),
        Value::Object(object) => object.is_empty(),
        _ => false,
    }
}

#[derive(Debug)]
struct McpConfigCandidate<'a> {
    outer_key: &'static str,
    inner_key: Option<&'static str>,
    config: &'a Value,
}

impl<'a> McpConfigCandidate<'a> {
    fn double(outer_key: &'static str, inner_key: &'static str, config: &'a Value) -> Self {
        Self {
            outer_key,
            inner_key: Some(inner_key),
            config,
        }
    }

    fn single(outer_key: &'static str, config: &'a Value) -> Self {
        Self {
            outer_key,
            inner_key: None,
            config,
        }
    }
}
