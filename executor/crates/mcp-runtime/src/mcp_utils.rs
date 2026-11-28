// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use crate::protocol::ExecutionRequest;

pub fn is_stdio_mcp_server(server: &Value) -> bool {
    match server.get("type").and_then(Value::as_str) {
        Some("stdio") => true,
        Some("http" | "streamable-http" | "streamable_http" | "sse") => false,
        _ => server
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| !command.trim().is_empty()),
    }
}

pub fn validate_mcp_server_definition(server: &Value) -> Result<(), String> {
    let object = server.as_object().ok_or("Invalid MCP definition")?;
    if object
        .get("type")
        .filter(|value| !value.is_null())
        .is_some_and(|value| {
            !matches!(
                value.as_str(),
                Some("stdio" | "http" | "sse" | "streamable-http" | "streamable_http")
            )
        })
    {
        return Err("Invalid MCP transport".to_owned());
    }
    let transport = if is_stdio_mcp_server(server) {
        "command"
    } else {
        "url"
    };
    if !object
        .get(transport)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
    {
        return Err(format!("MCP definition requires {transport}"));
    }
    validate_mcp_fields(
        object,
        &["args", "enabled_tools", "disabled_tools", "scopes"],
        |value| {
            value
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        },
    )?;
    validate_mcp_fields(object, &["env_vars"], |value| {
        value
            .as_array()
            .is_some_and(|items| items.iter().all(valid_mcp_env_variable))
    })?;
    validate_mcp_fields(
        object,
        &[
            "bearer_token_env_var",
            "bearerTokenEnvVar",
            "oauth_client_id",
            "oauthClientId",
            "oauth_resource",
            "oauthResource",
        ],
        Value::is_string,
    )?;
    validate_mcp_fields(
        object,
        &["default_tools_approval_mode", "defaultToolsApprovalMode"],
        valid_mcp_approval_mode,
    )?;
    validate_mcp_fields(object, &["tools"], |value| {
        value
            .as_object()
            .is_some_and(|tools| tools.values().all(valid_mcp_tool_settings))
    })?;
    validate_mcp_fields(
        object,
        &["headers", "http_headers", "env_http_headers", "env"],
        |value| {
            value
                .as_object()
                .is_some_and(|items| items.values().all(Value::is_string))
        },
    )?;
    validate_mcp_fields(
        object,
        &[
            "enabled",
            "required",
            "alwaysLoad",
            "supports_parallel_tool_calls",
        ],
        Value::is_boolean,
    )?;
    validate_mcp_fields(
        object,
        &["startup_timeout_sec", "tool_timeout_sec", "timeout"],
        |value| {
            value
                .as_f64()
                .is_some_and(|seconds| std::time::Duration::try_from_secs_f64(seconds).is_ok())
        },
    )
}

fn validate_mcp_fields(
    object: &serde_json::Map<String, Value>,
    fields: &[&str],
    valid: fn(&Value) -> bool,
) -> Result<(), String> {
    for field in fields {
        if object
            .get(*field)
            .filter(|value| !value.is_null())
            .is_some_and(|value| !valid(value))
        {
            return Err(format!("Invalid MCP {field}"));
        }
    }
    Ok(())
}

fn valid_mcp_env_variable(item: &Value) -> bool {
    item.is_string()
        || item.as_object().is_some_and(|object| {
            object.get("name").is_some_and(Value::is_string)
                && object
                    .get("source")
                    .is_none_or(|value| value.is_null() || value.is_string())
        })
}

fn valid_mcp_approval_mode(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("auto" | "prompt" | "writes" | "approve")
    )
}

fn valid_mcp_tool_settings(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    validate_mcp_fields(object, &["approval_mode"], valid_mcp_approval_mode).is_ok()
        && validate_mcp_fields(object, &["output_token_limit"], |value| {
            value
                .as_u64()
                .and_then(|limit| usize::try_from(limit).ok())
                .is_some_and(|limit| limit > 0)
        })
        .is_ok()
}

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
