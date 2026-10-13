// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use crate::{mcp_utils::get_nested_value, protocol::ExecutionRequest};
use regex::Regex;
use serde_json::{Map, Value};
use std::{collections::BTreeMap, sync::OnceLock};

fn task_reference() -> &'static Regex {
    static REFERENCE: OnceLock<Regex> = OnceLock::new();
    REFERENCE.get_or_init(|| Regex::new(r"\$\{\{\s*([^{}]+?)\s*\}\}").unwrap())
}

fn env_reference() -> &'static Regex {
    static REFERENCE: OnceLock<Regex> = OnceLock::new();
    REFERENCE.get_or_init(|| Regex::new(r"\$\{WEGENT_MCP_CONTEXT_([0-9a-f]+)\}").unwrap())
}

// Encode the context path, not its value, so persisted references can be rebound
// on later turns even when the originating skill is not sent again.
pub(super) fn context_variable(path: &str) -> String {
    format!(
        "WEGENT_MCP_CONTEXT_{}",
        path.bytes().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

pub(super) fn visit_strings(
    value: &mut Value,
    visit: &mut impl FnMut(&mut String) -> Result<(), String>,
) -> Result<(), String> {
    match value {
        Value::String(text) => visit(text)?,
        Value::Object(values) => {
            for value in values.values_mut() {
                visit_strings(value, visit)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                visit_strings(value, visit)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn bind_context(
    servers: &mut BTreeMap<String, Value>,
    request: &ExecutionRequest,
    environment: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let context = request.variable_context();
    let mut unconfigured = Vec::new();
    for (name, server) in servers.iter_mut() {
        normalize_context_references(server, request.auth_token.as_deref())?;
        if let Some(path) = missing_user_mcp_context(server, &context)? {
            let mut fields = crate::logging::task_fields(&request.task_id, &request.subtask_id);
            fields.extend([("server_name", name.clone()), ("context_path", path)]);
            crate::logging::log_executor_event("unconfigured user MCP skipped", &fields);
            unconfigured.push(name.clone());
            continue;
        }
        visit_strings(server, &mut |text| {
            for captures in env_reference().captures_iter(text) {
                let path = decode_context_path(&captures[1])?;
                let value = get_nested_value(Some(&context), &path)
                    .filter(|value| !value.is_null())
                    .ok_or_else(|| format!("Missing MCP execution context: {path}"))?;
                environment.insert(
                    context_variable(&path),
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                );
            }
            Ok(())
        })?;
    }
    for name in unconfigured {
        servers.remove(&name);
    }
    Ok(())
}

fn normalize_context_references(server: &mut Value, token: Option<&str>) -> Result<(), String> {
    visit_strings(server, &mut |text| {
        if let Some(token) = token.filter(|token| !token.is_empty()) {
            *text = text.replace(token, "${{auth_token}}");
        }
        *text = task_reference()
            .replace_all(text, |captures: &regex::Captures| {
                format!("${{{}}}", context_variable(captures[1].trim()))
            })
            .into_owned();
        Ok(())
    })
}

fn decode_context_path(encoded: &str) -> Result<String, String> {
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|index| {
            encoded
                .get(index..index + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or("Invalid MCP context reference")
        })
        .collect::<Result<Vec<_>, _>>()?;
    String::from_utf8(bytes).map_err(|_| "Invalid MCP context reference".to_owned())
}

// User-managed integrations are optional. Apply this to both incoming templates
// and persisted references so removing credentials also removes stale services.
fn missing_user_mcp_context(server: &mut Value, context: &Value) -> Result<Option<String>, String> {
    let mut missing = None;
    visit_strings(server, &mut |text| {
        for captures in env_reference().captures_iter(text) {
            let path = decode_context_path(&captures[1])?;
            if path.starts_with("task_data.user_mcps.")
                && get_nested_value(Some(context), &path)
                    .filter(|value| !value.is_null())
                    .filter(|value| !value.as_str().is_some_and(|text| text.trim().is_empty()))
                    .is_none()
            {
                missing = Some(path);
            }
        }
        Ok(())
    })?;
    Ok(missing)
}

pub(crate) fn resolve_context(
    value: &mut Value,
    environment: &BTreeMap<String, String>,
) -> Result<(), String> {
    static RUNTIME_REFERENCE: OnceLock<Regex> = OnceLock::new();
    let reference = RUNTIME_REFERENCE
        .get_or_init(|| Regex::new(r"\$\{(WEGENT_MCP_(?:CONTEXT|MANAGED)_[0-9a-f]+)\}").unwrap());
    visit_strings(value, &mut |text| {
        let mut missing = false;
        *text = reference
            .replace_all(text, |captures: &regex::Captures| {
                environment.get(&captures[1]).cloned().unwrap_or_else(|| {
                    missing = true;
                    String::new()
                })
            })
            .into_owned();
        if missing {
            return Err("Missing MCP execution context".to_owned());
        }
        Ok(())
    })
}

/// Service-local environment is sent through thread/start or thread/resume
/// config on stdin, never promoted to Codex's environment or command line.
pub(crate) fn append_stdio_environment(
    name: &str,
    server: &Value,
    thread_config: &mut Map<String, Value>,
) -> Result<(), String> {
    let Some(object) = server.as_object() else {
        return Ok(());
    };
    if !crate::mcp_utils::is_stdio_mcp_server(server) {
        return Ok(());
    }
    let environment = match object.get("env") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(environment)) => environment.clone(),
        Some(_) => return Err("MCP env must be an object".to_owned()),
    };
    for (key, value) in &environment {
        if key.is_empty() || key.contains(['=', '\0']) {
            return Err("Invalid MCP environment variable name".to_owned());
        }
        let value = value
            .as_str()
            .ok_or("MCP environment values must be strings")?;
        if value.contains('\0') {
            return Err("MCP environment value contains a null byte".to_owned());
        }
    }
    // Publish the whole table, including empty, so removed credentials do not
    // survive from an earlier definition of this service.
    thread_config.insert(
        super::toml_key_path(&["mcp_servers", name, "env"]),
        Value::Object(environment),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unconfigured_user_mcps_do_not_block_other_services_or_bind_partial_credentials() {
        let path = "task_data.user_mcps.example.services.storage.credentials.url";
        for url in [Value::Null, json!(""), json!(" \t")] {
            for reference in [
                format!("${{{{{path}}}}}"),
                format!("${{{}}}", context_variable(path)),
            ] {
                let mut request = ExecutionRequest {
                    auth_token: Some("synthetic-token".to_owned()),
                    ..Default::default()
                };
                request.extra.insert("task_data".to_owned(), json!({
                    "user_mcps": {"example": {"services": {"storage": {"credentials": {"url": url}}}}}
                }));
                let mut servers = BTreeMap::from([
                    (
                        "custom-table".to_owned(),
                        json!({"url": reference, "headers": {"Authorization": "Bearer ${{auth_token}}"}}),
                    ),
                    ("web".to_owned(), json!({"url": "https://example.test/mcp"})),
                ]);
                let mut environment = BTreeMap::new();
                bind_context(&mut servers, &request, &mut environment).unwrap();
                assert_eq!(servers.len(), 1);
                assert!(servers.contains_key("web"));
                assert!(environment.is_empty());
            }
        }
    }

    #[test]
    fn missing_required_context_still_fails() {
        let mut servers = BTreeMap::from([(
            "required".to_owned(),
            json!({"url": "${{backend_url}}/mcp"}),
        )]);
        assert_eq!(
            bind_context(
                &mut servers,
                &ExecutionRequest::default(),
                &mut BTreeMap::new()
            )
            .unwrap_err(),
            "Missing MCP execution context: backend_url"
        );
    }

    #[test]
    fn resolves_execution_url_and_headers_without_changing_persisted_templates() {
        let template = json!({"mcpServers": {"form": {
            "url": "${WEGENT_MCP_CONTEXT_61}/mcp",
            "headers": {"Authorization": "Bearer ${WEGENT_MCP_MANAGED_ab}"}
        }}});
        for token in ["first-token", "second-token"] {
            let mut resolved = template.clone();
            let environment = BTreeMap::from([
                (
                    "WEGENT_MCP_CONTEXT_61".to_owned(),
                    "https://example.test".to_owned(),
                ),
                ("WEGENT_MCP_MANAGED_ab".to_owned(), token.to_owned()),
            ]);
            resolve_context(&mut resolved, &environment).unwrap();
            assert_eq!(
                resolved["mcpServers"]["form"]["url"],
                "https://example.test/mcp"
            );
            assert_eq!(
                resolved["mcpServers"]["form"]["headers"]["Authorization"],
                format!("Bearer {token}")
            );
            assert!(!template.to_string().contains(token));
        }
    }

    #[test]
    fn missing_execution_binding_fails_without_exposing_values() {
        let mut config =
            json!({"url": "${WEGENT_MCP_CONTEXT_ab}", "headers": {"Authorization": "secret"}});
        assert_eq!(
            resolve_context(&mut config, &BTreeMap::new()).unwrap_err(),
            "Missing MCP execution context"
        );
    }

    #[test]
    fn remote_empty_command_does_not_publish_stdio_environment() {
        let mut config = Map::new();
        append_stdio_environment(
            "remote",
            &json!({"command": "", "url": "https://example.test/mcp", "env": false}),
            &mut config,
        )
        .unwrap();
        assert!(config.is_empty());
    }

    #[test]
    fn same_name_credentials_and_runtime_names_remain_service_local() {
        let mut config = Map::new();
        append_stdio_environment("first", &json!({"command":"tool", "env":{"TOKEN":"one","OPENAI_API_KEY":"first-key","PATH":"/first/bin"}}), &mut config).unwrap();
        append_stdio_environment("second", &json!({"command":"tool", "env":{"TOKEN":"two","OPENAI_API_KEY":"second-key","PATH":"/second/bin"}}), &mut config).unwrap();
        assert_eq!(config["mcp_servers.first.env"]["TOKEN"], "one");
        assert_eq!(config["mcp_servers.second.env"]["TOKEN"], "two");
        assert_eq!(
            config["mcp_servers.first.env"]["OPENAI_API_KEY"],
            "first-key"
        );
        assert_eq!(config["mcp_servers.second.env"]["PATH"], "/second/bin");

        append_stdio_environment("first", &json!({"command":"tool"}), &mut config).unwrap();
        assert_eq!(config["mcp_servers.first.env"], json!({}));
        assert_eq!(config["mcp_servers.second.env"]["TOKEN"], "two");
    }
}
