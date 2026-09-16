// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, io::ErrorKind, path::Path};

use serde_json::{Map, Value};

use crate::{mcp_utils::replace_mcp_server_variables, protocol::ExecutionRequest};

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeOptions {
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub mcp_servers: BTreeMap<String, Value>,
}

pub(super) fn merge_claude_mcp_servers(
    config_path: &Path,
    incoming: BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let mut servers = match fs::read(config_path) {
        Ok(content) => {
            let config: Value = serde_json::from_slice(&content)
                .map_err(|_| format!("invalid MCP config JSON: {}", config_path.display()))?;
            if !config.is_object() {
                return Err(format!(
                    "invalid MCP config object: {}",
                    config_path.display()
                ));
            }
            let servers = config
                .get("mcpServers")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let servers: BTreeMap<String, Value> = serde_json::from_value(servers)
                .map_err(|_| format!("invalid mcpServers map: {}", config_path.display()))?;
            if servers.values().any(|server| !server.is_object()) {
                return Err(format!(
                    "invalid MCP server config: {}",
                    config_path.display()
                ));
            }
            servers
        }
        Err(error) if error.kind() == ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => {
            return Err(format!("failed to read {}: {error}", config_path.display()));
        }
    };
    // A missing service is not a deletion. Replace matching services in full so
    // stale headers and transport settings do not survive a newer configuration.
    servers.extend(incoming);
    Ok(servers)
}

pub fn extract_claude_options(
    request: &ExecutionRequest,
    global_mcps: &BTreeMap<String, Value>,
) -> ClaudeOptions {
    let primary_bot = primary_bot(request);
    let raw_mcp = Value::Array(collect_mcp_servers_for_claude(
        request,
        primary_bot,
        global_mcps,
    ));
    let replaced = replace_mcp_server_variables(&raw_mcp, Some(request));

    ClaudeOptions {
        system_prompt: claude_system_prompt(request, primary_bot),
        model: task_model_id(primary_bot),
        mcp_servers: convert_mcp_servers_to_dict(&replaced),
    }
}

fn collect_mcp_servers_for_claude(
    request: &ExecutionRequest,
    primary_bot: Option<&Value>,
    global_mcps: &BTreeMap<String, Value>,
) -> Vec<Value> {
    let mut collected = Vec::new();

    if request_mode(request).is_some_and(|mode| mode == "coordinate") {
        if let Some(bots) = request.bot.as_array() {
            for bot in bots {
                append_mcp_servers(&mut collected, bot_mcp_servers(bot));
            }
        }
    } else if let Some(bot) = primary_bot {
        append_mcp_servers(&mut collected, bot_mcp_servers(bot));
    }

    if !request.mcp_servers.is_empty() {
        append_mcp_servers(
            &mut collected,
            Some(&Value::Array(request.mcp_servers.clone())),
        );
    }

    for (name, record) in global_mcps {
        let server = record.get("server").unwrap_or(record);
        if server.as_object().is_some() {
            let mut object = server.as_object().cloned().unwrap_or_default();
            object.insert("name".to_owned(), Value::String(name.clone()));
            collected.push(Value::Object(object));
        }
    }

    collected
}

fn append_mcp_servers(target: &mut Vec<Value>, mcp_servers: Option<&Value>) {
    match mcp_servers {
        Some(Value::Object(object)) => {
            for (name, config) in object {
                let Some(config) = config.as_object() else {
                    continue;
                };
                let mut server = config.clone();
                server.insert("name".to_owned(), Value::String(name.clone()));
                target.push(Value::Object(server));
            }
        }
        Some(Value::Array(servers)) => {
            for server in servers {
                if server.get("name").is_some() {
                    target.push(server.clone());
                }
            }
        }
        _ => {}
    }
}

fn convert_mcp_servers_to_dict(mcp_servers: &Value) -> BTreeMap<String, Value> {
    match mcp_servers {
        Value::Object(object) => {
            let mut normalized = BTreeMap::new();
            for (name, config) in object {
                if config.as_object().is_some() {
                    merge_mcp_server(
                        &mut normalized,
                        name.clone(),
                        normalize_mcp_server_for_claude(config),
                    );
                }
            }
            normalized
        }
        Value::Array(servers) => {
            let mut normalized = BTreeMap::new();
            for server in servers {
                let Some(name) = server.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let Some(server_object) = server.as_object() else {
                    continue;
                };
                let mut object = server_object.clone();
                object.remove("name");
                merge_mcp_server(
                    &mut normalized,
                    name.to_owned(),
                    normalize_mcp_server_for_claude(&Value::Object(object)),
                );
            }
            normalized
        }
        _ => BTreeMap::new(),
    }
}

fn merge_mcp_server(servers: &mut BTreeMap<String, Value>, name: String, mut incoming: Value) {
    if let Some(existing) = servers.get(&name) {
        preserve_existing_mcp_headers(existing, &mut incoming);
        preserve_existing_mcp_timeout(existing, &mut incoming);
    }
    servers.insert(name, incoming);
}

fn preserve_existing_mcp_headers(existing: &Value, incoming: &mut Value) {
    let Some(existing_headers) = existing.get("headers").cloned() else {
        return;
    };
    let Some(incoming_object) = incoming.as_object_mut() else {
        return;
    };
    if incoming_object
        .get("headers")
        .and_then(Value::as_object)
        .is_some_and(|headers| !headers.is_empty())
    {
        return;
    }
    incoming_object.insert("headers".to_owned(), existing_headers);
}

fn preserve_existing_mcp_timeout(existing: &Value, incoming: &mut Value) {
    let Some(existing_timeout) = existing.get("timeout").cloned() else {
        return;
    };
    let Some(incoming_object) = incoming.as_object_mut() else {
        return;
    };
    if incoming_object.get("timeout").is_some() {
        return;
    }
    incoming_object.insert("timeout".to_owned(), existing_timeout);
}

fn normalize_mcp_server_for_claude(server: &Value) -> Value {
    let Some(config) = server.as_object() else {
        return server.clone();
    };
    let server_type = config.get("type").and_then(Value::as_str).map(|value| {
        if value == "streamable-http" {
            "http"
        } else {
            value
        }
    });

    match server_type {
        Some("http" | "sse") => {
            let mut normalized = Map::new();
            normalized.insert(
                "type".to_owned(),
                Value::String(server_type.unwrap().to_owned()),
            );
            if let Some(url) = config.get("url").or_else(|| config.get("base_url")) {
                normalized.insert("url".to_owned(), url.clone());
            }
            if let Some(headers) = config
                .get("headers")
                .filter(|headers| headers.as_object().is_some_and(|object| !object.is_empty()))
            {
                normalized.insert("headers".to_owned(), headers.clone());
            }
            if let Some(timeout) = claude_mcp_timeout(config) {
                normalized.insert("timeout".to_owned(), timeout.clone());
            }
            for key in [
                "bearer_token_env_var",
                "bearerTokenEnvVar",
                "oauth_client_id",
                "oauthClientId",
                "oauth_resource",
                "oauthResource",
            ] {
                if let Some(value) = config.get(key) {
                    normalized.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(normalized)
        }
        Some("stdio") | None if config.contains_key("command") => {
            let mut normalized = Map::new();
            normalized.insert("type".to_owned(), Value::String("stdio".to_owned()));
            for key in ["command", "args", "env"] {
                if let Some(value) = config.get(key) {
                    normalized.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(normalized)
        }
        _ => server.clone(),
    }
}

fn claude_mcp_timeout(config: &Map<String, Value>) -> Option<Value> {
    if let Some(timeout) = config.get("timeout").and_then(Value::as_u64) {
        return Some(Value::Number(
            mcp_timeout_milliseconds(timeout, TimeoutUnit::Auto).into(),
        ));
    }
    config
        .get("timeout_seconds")
        .or_else(|| config.get("timeoutSeconds"))
        .and_then(Value::as_u64)
        .map(|timeout| {
            Value::Number(mcp_timeout_milliseconds(timeout, TimeoutUnit::Seconds).into())
        })
}

fn mcp_timeout_milliseconds(timeout: u64, unit: TimeoutUnit) -> u64 {
    match unit {
        TimeoutUnit::Seconds => timeout.saturating_mul(1000),
        TimeoutUnit::Auto if timeout < 1000 => timeout.saturating_mul(1000),
        TimeoutUnit::Auto => timeout,
    }
}

enum TimeoutUnit {
    Auto,
    Seconds,
}

fn claude_system_prompt(request: &ExecutionRequest, primary_bot: Option<&Value>) -> Option<String> {
    let top_level = request.system_prompt.trim();
    if !top_level.is_empty() {
        return Some(top_level.to_owned());
    }
    primary_bot
        .and_then(|bot| bot.get("system_prompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn task_model_id(primary_bot: Option<&Value>) -> Option<String> {
    let env = primary_bot?.get("agent_config")?.get("env")?.as_object()?;
    env.get("model").and_then(Value::as_str)?;
    env.get("model_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn bot_mcp_servers(bot: &Value) -> Option<&Value> {
    bot.get("mcp_servers").or_else(|| bot.get("mcpServers"))
}

fn primary_bot(request: &ExecutionRequest) -> Option<&Value> {
    match &request.bot {
        Value::Array(bots) => bots.first(),
        Value::Object(_) => Some(&request.bot),
        _ => None,
    }
}

fn request_mode(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

#[cfg(test)]
mod mcp_config_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn followup_preserves_omitted_servers_and_replaces_matching_services_in_full() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let docs = json!({"type": "http", "url": "https://example.com/docs"});
        fs::write(&path, serde_json::to_vec(&json!({"mcpServers": {
            "docs": docs,
            "interactive": {"type": "http", "url": "https://example.com/old", "headers": {"X-Test": "old"}, "timeout": 10}
        }})).unwrap()).unwrap();
        let updated = json!({"type": "stdio", "command": "new-tool"});
        let incoming = BTreeMap::from([
            ("interactive".to_owned(), updated.clone()),
            (
                "new-service".to_owned(),
                json!({"type": "http", "url": "https://example.com/new"}),
            ),
        ]);

        let merged = merge_claude_mcp_servers(&path, incoming).unwrap();

        assert_eq!(merged.len(), 3);
        assert_eq!(merged["docs"], docs);
        assert_eq!(merged["interactive"], updated);
        assert!(merged.contains_key("new-service"));

        // Persist the next turn as the runtime does, then send no MCP additions.
        fs::write(
            &path,
            serde_json::to_vec(&json!({"mcpServers": merged})).unwrap(),
        )
        .unwrap();
        let next_turn = merge_claude_mcp_servers(&path, BTreeMap::new()).unwrap();
        assert_eq!(next_turn, merged);
    }

    #[test]
    fn invalid_existing_config_is_reported_without_discarding_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        for content in [
            "{broken",
            "[]",
            "{\"mcpServers\":[]}",
            "{\"mcpServers\":{\"docs\":null}}",
        ] {
            fs::write(&path, content).unwrap();

            let result = merge_claude_mcp_servers(&path, BTreeMap::new());

            assert!(result.is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        }
    }
}
