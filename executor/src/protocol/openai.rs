// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Map, Value};
use thiserror::Error;

use super::execution::{ExecutionRequest, KnowledgeBaseScope, FULL_KB_TOOL_ACCESS_MODE};

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("OpenAI Responses request must be a JSON object")]
    ExpectedObject,
}

#[derive(Debug, Clone)]
pub struct OpenAIResponsesRequest {
    raw: Value,
}

impl OpenAIResponsesRequest {
    pub fn from_value(raw: Value) -> Result<Self, ProtocolError> {
        if !raw.is_object() {
            return Err(ProtocolError::ExpectedObject);
        }
        Ok(Self { raw })
    }

    pub fn background(&self) -> bool {
        self.raw
            .get("background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub fn to_execution_request(&self) -> ExecutionRequest {
        let metadata = object_field(&self.raw, "metadata");
        let (prompt, history) = convert_input(self.raw.get("input").cloned());

        ExecutionRequest {
            task_id: get_id_string(&metadata, "task_id").unwrap_or_default(),
            subtask_id: get_id_string(&metadata, "subtask_id").unwrap_or_default(),
            team_namespace: get_string(&metadata, "team_namespace"),
            bot: metadata
                .get("bot")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
            model_config: self
                .raw
                .get("model_config")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
            system_prompt: self
                .raw
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            prompt,
            history,
            mcp_servers: convert_tools(self.raw.get("tools")),
            knowledge_base_scopes: convert_knowledge_base_scopes(
                metadata.get("knowledge_base_scopes"),
            ),
            kb_tool_access_mode: normalize_kb_tool_access_mode(metadata.get("kb_tool_access_mode")),
            skip_git_clone: metadata
                .get("skip_git_clone")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            new_session: metadata
                .get("new_session")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            ephemeral: metadata
                .get("ephemeral")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            fork_runtime: metadata.get("fork_runtime").cloned(),
            inherited_sessions: metadata
                .get("inherited_sessions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            task_type: get_string(&metadata, "type"),
            workspace_source: get_string(&metadata, "workspace_source"),
            project_workspace_path: get_string(&metadata, "project_workspace_path")
                .or_else(|| project_workspace_path(&metadata)),
            device_id: get_string(&metadata, "device_id"),
            message_id: get_i64_optional(&metadata, "message_id"),
            executor_name: get_string(&metadata, "executor_name"),
            executor_namespace: get_string(&metadata, "executor_namespace"),
            backend_url: get_string(&metadata, "backend_url"),
            validation_params: metadata
                .get("validation_params")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
            user_name: get_string(&metadata, "user_name")
                .or_else(|| metadata_user_string(&metadata, "user_name")),
            auth_token: get_string(&metadata, "auth_token"),
            skill_identity_token: get_string(&metadata, "skill_identity_token"),
            extra: extra_metadata(&metadata),
        }
    }
}

fn convert_input(input: Option<Value>) -> (Value, Vec<Value>) {
    match input.unwrap_or_else(|| Value::String(String::new())) {
        Value::Array(items) => convert_array_input(items),
        Value::Null => (Value::String(String::new()), Vec::new()),
        value => (value, Vec::new()),
    }
}

fn convert_array_input(items: Vec<Value>) -> (Value, Vec<Value>) {
    let Some(first) = items.first().and_then(Value::as_object) else {
        return (Value::Array(items), Vec::new());
    };

    if first
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| matches!(value, "input_text" | "input_image"))
    {
        return (Value::Array(items), Vec::new());
    }

    if !first.contains_key("role") {
        return (Value::Array(items), Vec::new());
    }

    convert_message_input(items)
}

fn convert_message_input(items: Vec<Value>) -> (Value, Vec<Value>) {
    let mut prompt = Value::String(String::new());
    let mut history = Vec::new();

    for item in items {
        if item
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role == "user")
        {
            prompt = item
                .get("content")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
        }
        history.push(item);
    }

    if history
        .last()
        .and_then(|item| item.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| role == "user")
    {
        history.pop();
    }

    (prompt, history)
}

fn convert_tools(tools: Option<&Value>) -> Vec<Value> {
    tools
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(convert_mcp_tool)
        .collect()
}

fn convert_mcp_tool(tool: &Value) -> Option<Value> {
    if tool.get("type").and_then(Value::as_str) != Some("mcp") {
        return None;
    }

    let mut server = Map::new();
    copy_renamed(tool, &mut server, "server_label", "name");
    copy_renamed(tool, &mut server, "server_url", "url");
    copy_renamed(tool, &mut server, "server_type", "type");
    copy_renamed(tool, &mut server, "server_auth", "auth");
    copy_same(tool, &mut server, "command");
    copy_same(tool, &mut server, "args");
    copy_same(tool, &mut server, "env");
    Some(Value::Object(server))
}

fn convert_knowledge_base_scopes(value: Option<&Value>) -> Vec<KnowledgeBaseScope> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(convert_knowledge_base_scope)
        .collect()
}

fn convert_knowledge_base_scope(item: &Value) -> Option<KnowledgeBaseScope> {
    let object = item.as_object()?;
    let knowledge_base_id = read_i64_value(object.get("knowledge_base_id")?)?;
    if knowledge_base_id <= 0 {
        return None;
    }

    Some(KnowledgeBaseScope {
        knowledge_base_id,
        scope_restricted: object
            .get("scope_restricted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        document_ids: object
            .get("document_ids")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

fn normalize_kb_tool_access_mode(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(FULL_KB_TOOL_ACCESS_MODE)
        .to_owned()
}

fn object_field(value: &Value, key: &str) -> Map<String, Value> {
    value
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn extra_metadata(metadata: &Map<String, Value>) -> Map<String, Value> {
    metadata
        .iter()
        .filter(|(key, _)| !KNOWN_METADATA_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

const KNOWN_METADATA_KEYS: &[&str] = &[
    "task_id",
    "subtask_id",
    "team_namespace",
    "bot",
    "knowledge_base_scopes",
    "kb_tool_access_mode",
    "skip_git_clone",
    "new_session",
    "ephemeral",
    "fork_runtime",
    "inherited_sessions",
    "type",
    "workspace_source",
    "project_workspace_path",
    "workspace",
    "device_id",
    "message_id",
    "executor_name",
    "executor_namespace",
    "backend_url",
    "validation_params",
    "user_name",
    "auth_token",
    "skill_identity_token",
];

fn get_i64_optional(object: &Map<String, Value>, key: &str) -> Option<i64> {
    object.get(key).and_then(read_i64_value)
}

fn get_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn get_id_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(id_value_string)
}

fn id_value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn project_workspace_path(metadata: &Map<String, Value>) -> Option<String> {
    let workspace = metadata.get("workspace")?.as_object()?;
    workspace
        .get("project_workspace_path")
        .or_else(|| workspace.get("local_path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn metadata_user_string(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    metadata
        .get("user")
        .and_then(Value::as_object)?
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_i64_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
}

fn copy_renamed(source: &Value, target: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = source.get(from) {
        target.insert(to.to_owned(), value.clone());
    }
}

fn copy_same(source: &Value, target: &mut Map<String, Value>, key: &str) {
    copy_renamed(source, target, key, key);
}
