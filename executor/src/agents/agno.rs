// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Map, Value};

use crate::{agents::task_identity::task_identity_env, protocol::ExecutionRequest};

const VALID_OPTIONS: &[&str] = &[
    "model",
    "model_id",
    "api_key",
    "system_prompt",
    "tools",
    "mcp_servers",
    "mcpServers",
    "team_members",
    "team_description",
    "stream",
];

pub fn build_agno_options(request: &ExecutionRequest) -> Value {
    let mut options = Map::new();
    match &request.bot {
        Value::Object(bot) => copy_valid_options(bot, &mut options, true),
        Value::Array(bots) if !bots.is_empty() => {
            options.insert("team_members".to_owned(), Value::Array(bots.clone()));
            if let Some(first_bot) = bots.first().and_then(Value::as_object) {
                copy_valid_options(first_bot, &mut options, false);
            }
        }
        _ => {}
    }
    inject_task_identity(request, &mut options);
    Value::Object(options)
}

fn copy_valid_options(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    include_team_members: bool,
) {
    for key in VALID_OPTIONS {
        if !include_team_members && *key == "team_members" {
            continue;
        }
        if let Some(value) = source.get(*key) {
            if !value.is_null() {
                target.insert((*key).to_owned(), value.clone());
            }
        }
    }
}

fn inject_task_identity(request: &ExecutionRequest, options: &mut Map<String, Value>) {
    let identity = task_identity_json_env(request);
    if identity.is_empty() {
        return;
    }
    let Some(team_members) = options
        .get_mut("team_members")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for member in team_members {
        let Some(member) = member.as_object_mut() else {
            continue;
        };
        let agent_config = ensure_object(member, "agent_config");
        let env = ensure_object(agent_config, "env");
        for (key, value) in &identity {
            env.insert(key.clone(), value.clone());
        }
    }
}

fn task_identity_json_env(request: &ExecutionRequest) -> Map<String, Value> {
    let mut env = Map::new();
    for (key, value) in task_identity_env(request) {
        env.insert(key, Value::String(value));
    }
    env
}

fn ensure_object<'a>(object: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value
        .as_object_mut()
        .expect("value was normalized to object")
}
