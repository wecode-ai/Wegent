// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

use serde_json::{json, Map, Value};
use toml_edit::{DocumentMut, Item, Table};

use crate::{agents::claude_options::extract_codex_mcp_templates, protocol::ExecutionRequest};

use super::mcp_environment::{
    append_stdio_environment, bind_available_context, resolve_context, retain_available_servers,
};

mod validation;

/// Called while holding the named Home execution lease. Store definitions once;
/// bind task values through native thread RPC, never through disk or argv.
pub(super) fn prepare(
    home: &Path,
    request: &ExecutionRequest,
    thread_config: &mut Map<String, Value>,
) -> Result<bool, String> {
    let path = home.join("config.toml");
    if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
        return Err("Codex MCP config must be a regular file".to_owned());
    }
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("Cannot read Codex MCP config".to_owned()),
    };
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|_| "Invalid Codex config TOML")?;
    let config: Value =
        toml_edit::de::from_str(&content).map_err(|_| "Invalid Codex config TOML")?;
    let saved: Result<BTreeMap<String, Value>, _> = serde_json::from_value(
        config
            .get("mcp_servers")
            .cloned()
            .unwrap_or_else(|| json!({})),
    );
    let valid_table = saved.is_ok();
    let mut servers = saved.unwrap_or_else(|_| {
        super::mcp_environment::log_server_unavailable(
            request,
            "codex_mcps",
            "configuration_table",
        );
        BTreeMap::new()
    });
    let previous = servers.clone();
    let mut incoming = extract_codex_mcp_templates(request, &BTreeMap::new());
    let configured_names = servers
        .keys()
        .chain(incoming.keys())
        .filter(|name| !is_managed_server(name))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    super::preserve_explicit_mcp_approval_modes(request, &mut incoming);
    // An unavailable replacement must also remove its previously saved definition.
    for name in incoming.keys() {
        servers.remove(name);
    }
    normalize_templates(&mut incoming, request)?;
    for (name, server) in incoming {
        servers.insert(name, server);
    }
    prepare_runtime(&mut servers, request, thread_config)?;
    let config_changed = if valid_table && servers != previous {
        let result = update_servers(&mut document, &previous, &servers)
            .and_then(|_| crate::agents::codex::replace_config(&path, document.to_string()));
        if result.is_err() {
            super::mcp_environment::log_server_unavailable(
                request,
                "codex_mcps",
                "configuration_write",
            );
        }
        result.is_ok()
    } else {
        false
    };
    let mut fields = crate::logging::task_fields(&request.task_id, &request.subtask_id);
    fields.extend([
        ("config_path", path.display().to_string()),
        ("server_count", servers.len().to_string()),
        ("config_changed", config_changed.to_string()),
    ]);
    crate::logging::log_executor_event("codex MCP config merged", &fields);
    Ok(!valid_table
        || configured_names
            .iter()
            .any(|name| !servers.contains_key(name)))
}

/// Convert incoming templates without changing previously saved native settings.
pub(crate) fn prepare_templates(
    servers: &mut BTreeMap<String, Value>,
    request: &ExecutionRequest,
    thread_config: &mut Map<String, Value>,
) -> Result<(), String> {
    normalize_templates(servers, request)?;
    prepare_runtime(servers, request, thread_config)
}

fn normalize_templates(
    servers: &mut BTreeMap<String, Value>,
    request: &ExecutionRequest,
) -> Result<(), String> {
    remove_managed_servers(servers);
    retain_available_servers(servers, request, "native_configuration", |name, server| {
        if let Some(server_type) = server.get_mut("type") {
            *server_type =
                crate::mcp_utils::replace_mcp_server_variables(server_type, Some(request));
        }
        let native = native_definition(server.clone())?;
        let mut candidate = BTreeMap::from([(name.to_owned(), native)]);
        super::mcp_environment::prepare_context(&mut candidate, request)?;
        let Some(available) = candidate.remove(name) else {
            return Ok(false);
        };
        *server = available;
        toml_edit::ser::to_document(server).map_err(|_| "Cannot encode Codex MCP definition")?;
        Ok(true)
    });
    Ok(())
}

fn remove_managed_servers(servers: &mut BTreeMap<String, Value>) {
    // These grants remain authoritative per execution, not accumulated agent settings.
    servers.retain(|name, _| !is_managed_server(name));
}

fn is_managed_server(name: &str) -> bool {
    matches!(
        name,
        crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME
            | crate::task_runtime::mcp::NOTIFICATIONS_MCP_SERVER_NAME
            | crate::task_runtime::mcp::STAND_IN_MCP_SERVER_NAME
            | crate::workbench_control::SERVER_NAME
    )
}

/// Share binding across every Home and send resolved values only through stdin.
fn prepare_runtime(
    servers: &mut BTreeMap<String, Value>,
    request: &ExecutionRequest,
    thread_config: &mut Map<String, Value>,
) -> Result<(), String> {
    remove_managed_servers(servers);
    retain_available_servers(servers, request, "transport_configuration", |_, server| {
        remove_inactive_transport_fields(server)?;
        Ok(true)
    });
    let mut environment = BTreeMap::new();
    bind_available_context(servers, request, &mut environment);
    let mut runtime = Map::new();
    retain_available_servers(
        servers,
        request,
        "runtime_configuration",
        |name, definition| {
            let mut resolved = definition.clone();
            resolve_context(&mut resolved, &environment)?;
            resolved = native_definition(resolved)?;
            crate::mcp_utils::validate_mcp_server_definition(&resolved)?;
            validation::validate(&resolved)?;
            // A connector is a capability, never a prerequisite for the whole turn.
            resolved["required"] = json!(false);
            let mut staged = Map::new();
            append_stdio_environment(name, &resolved, &mut staged)?;
            staged.insert(super::toml_key_path(&["mcp_servers", name]), resolved);
            runtime.extend(staged);
            Ok(true)
        },
    );
    thread_config.extend(runtime);
    Ok(())
}

fn native_definition(server: Value) -> Result<Value, String> {
    let mut native = server
        .as_object()
        .cloned()
        .ok_or("Invalid MCP definition")?;
    let stdio = crate::mcp_utils::is_stdio_mcp_server(&server);
    for (from, to) in [
        ("headers", "http_headers"),
        ("base_url", "url"),
        ("bearerTokenEnvVar", "bearer_token_env_var"),
        ("oauthClientId", "oauth_client_id"),
        ("oauthResource", "oauth_resource"),
        ("defaultToolsApprovalMode", "default_tools_approval_mode"),
    ] {
        if let Some(value) = native.remove(from) {
            native.entry(to.to_owned()).or_insert(value);
        }
    }
    native.remove("timeout");
    let mut result = Value::Object(native);
    remove_inactive_transport_fields(&mut result)?;
    let native = result.as_object_mut().ok_or("Invalid MCP definition")?;
    native.remove("type");
    let transport_key = if stdio { "command" } else { "url" };
    if !native
        .get(transport_key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
    {
        return Err(format!("MCP definition requires {transport_key}"));
    }
    let transport = native[transport_key].as_str().unwrap().trim().to_owned();
    native.insert(transport_key.to_owned(), json!(transport));
    if stdio {
        if let Some(args) = native.get_mut("args").and_then(Value::as_array_mut) {
            *args = args
                .iter()
                .filter_map(|value| match value {
                    Value::String(_) => Some(value.clone()),
                    Value::Number(_) | Value::Bool(_) => Some(json!(value.to_string())),
                    _ => None,
                })
                .collect();
        }
    }
    native
        .entry("default_tools_approval_mode".to_owned())
        .or_insert(json!("approve"));
    Ok(result)
}

fn remove_inactive_transport_fields(server: &mut Value) -> Result<(), String> {
    let stdio = crate::mcp_utils::is_stdio_mcp_server(server);
    let native = server.as_object_mut().ok_or("Invalid MCP definition")?;
    for key in if stdio {
        &[
            "url",
            "base_url",
            "headers",
            "http_headers",
            "env_http_headers",
            "http_headers_helper",
            "bearer_token",
            "bearer_token_env_var",
            "bearerTokenEnvVar",
            "oauth_client_id",
            "oauthClientId",
            "oauth_resource",
            "oauthResource",
            "oauth",
            "auth",
        ][..]
    } else {
        &["command", "args", "env", "env_vars", "cwd"][..]
    } {
        native.remove(*key);
    }
    Ok(())
}

fn update_servers(
    document: &mut DocumentMut,
    previous: &BTreeMap<String, Value>,
    servers: &BTreeMap<String, Value>,
) -> Result<(), String> {
    if document.get("mcp_servers").is_none() {
        document["mcp_servers"] = Item::Table(Table::new());
    }
    let inline = document["mcp_servers"].is_inline_table();
    let table = document["mcp_servers"]
        .as_table_like_mut()
        .ok_or("Invalid Codex mcp_servers table")?;
    for name in previous.keys().filter(|name| !servers.contains_key(*name)) {
        table.remove(name);
    }
    for (name, server) in servers {
        if previous.get(name) == Some(server) {
            continue;
        }
        let encoded = toml_edit::ser::to_document(server)
            .map_err(|_| "Cannot encode Codex MCP definition")?;
        let item = if inline {
            Item::Value(toml_edit::Value::InlineTable(
                encoded.into_table().into_inline_table(),
            ))
        } else {
            Item::Table(encoded.into_table())
        };
        table.insert(name, item);
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/codex_mcp.rs"]
mod tests;
