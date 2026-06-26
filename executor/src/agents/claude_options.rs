// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::{mcp_utils::replace_mcp_server_variables, protocol::ExecutionRequest};

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeOptions {
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub mcp_servers: BTreeMap<String, Value>,
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
        Value::Object(object) => object
            .iter()
            .filter_map(|(name, config)| {
                config
                    .as_object()
                    .map(|_| (name.clone(), normalize_mcp_server_for_claude(config)))
            })
            .collect(),
        Value::Array(servers) => servers
            .iter()
            .filter_map(|server| {
                let name = server.get("name")?.as_str()?.to_owned();
                let mut object = server.as_object()?.clone();
                object.remove("name");
                Some((
                    name,
                    normalize_mcp_server_for_claude(&Value::Object(object)),
                ))
            })
            .collect(),
        _ => BTreeMap::new(),
    }
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
