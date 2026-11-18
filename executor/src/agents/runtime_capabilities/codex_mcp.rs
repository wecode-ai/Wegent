// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

use serde_json::{json, Map, Value};
use toml_edit::{DocumentMut, Item, Table};

use crate::{agents::claude_options::extract_claude_mcp_templates, protocol::ExecutionRequest};

use super::mcp_environment::{append_stdio_environment, bind_context, resolve_context};

/// Called while holding the named Home execution lease. Store definitions once;
/// bind task values through native thread RPC, never through disk or argv.
pub(super) fn prepare(
    home: &Path,
    request: &ExecutionRequest,
    thread_config: &mut Map<String, Value>,
) -> Result<(), String> {
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
    let mut servers: BTreeMap<String, Value> = serde_json::from_value(
        config
            .get("mcp_servers")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(|_| "Invalid Codex mcp_servers table")?;
    if servers.values().any(|server| !server.is_object()) {
        return Err("Invalid Codex MCP server definition".to_owned());
    }
    let previous = servers.clone();
    let mut incoming = extract_claude_mcp_templates(request, &BTreeMap::new());
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
    if servers != previous {
        update_servers(&mut document, &previous, &servers)?;
        crate::agents::codex::replace_config(&path, document.to_string())?;
    }
    let mut fields = crate::logging::task_fields(&request.task_id, &request.subtask_id);
    fields.extend([
        ("config_path", path.display().to_string()),
        ("server_count", servers.len().to_string()),
        ("config_changed", (servers != previous).to_string()),
    ]);
    crate::logging::log_executor_event("codex MCP config merged", &fields);
    Ok(())
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
    super::mcp_environment::prepare_context(servers, request)?;
    for server in servers.values_mut() {
        *server = native_definition(server.clone())?;
    }
    Ok(())
}

fn remove_managed_servers(servers: &mut BTreeMap<String, Value>) {
    // These grants remain authoritative per execution, not accumulated agent settings.
    for name in [
        crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME,
        crate::task_runtime::mcp::NOTIFICATIONS_MCP_SERVER_NAME,
        crate::task_runtime::mcp::STAND_IN_MCP_SERVER_NAME,
        crate::workbench_control::SERVER_NAME,
    ] {
        servers.remove(name);
    }
}

/// Share binding across every Home and send resolved values only through stdin.
fn prepare_runtime(
    servers: &mut BTreeMap<String, Value>,
    request: &ExecutionRequest,
    thread_config: &mut Map<String, Value>,
) -> Result<(), String> {
    remove_managed_servers(servers);
    let mut environment = BTreeMap::new();
    bind_context(servers, request, &mut environment)?;
    let mut runtime = Map::new();
    for (name, definition) in servers.iter() {
        let mut resolved = definition.clone();
        resolve_context(&mut resolved, &environment)?;
        append_stdio_environment(name, &resolved, &mut runtime)?;
        runtime.insert(super::toml_key_path(&["mcp_servers", name]), resolved);
    }
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
    native.remove("type");
    native.remove("timeout");
    for key in if stdio {
        &[
            "url",
            "http_headers",
            "env_http_headers",
            "bearer_token_env_var",
            "oauth_client_id",
            "oauth_resource",
        ][..]
    } else {
        &["command", "args", "env", "env_vars"][..]
    } {
        native.remove(*key);
    }
    let transport_key = if stdio { "command" } else { "url" };
    if !native
        .get(transport_key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
    {
        return Err(format!("MCP definition requires {transport_key}"));
    }
    native
        .entry("default_tools_approval_mode".to_owned())
        .or_insert(json!("approve"));
    Ok(Value::Object(native))
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
