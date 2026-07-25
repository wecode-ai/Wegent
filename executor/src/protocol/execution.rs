// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

pub const FULL_KB_TOOL_ACCESS_MODE: &str = "full";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentKind {
    ClaudeCode,
    CodeX,
    Agno,
    Dify,
    ImageValidator,
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeBaseScope {
    pub knowledge_base_id: i64,
    pub scope_restricted: bool,
    pub document_ids: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExecutionRequest {
    #[serde(default, deserialize_with = "deserialize_id_string")]
    pub task_id: String,
    #[serde(default, alias = "turn_id", deserialize_with = "deserialize_id_string")]
    pub subtask_id: String,
    pub team_namespace: Option<String>,
    pub bot: Value,
    pub model_config: Value,
    pub system_prompt: String,
    pub prompt: Value,
    pub history: Vec<Value>,
    pub mcp_servers: Vec<Value>,
    pub knowledge_base_scopes: Vec<KnowledgeBaseScope>,
    pub kb_tool_access_mode: String,
    pub skip_git_clone: bool,
    pub new_session: bool,
    pub ephemeral: bool,
    pub fork_runtime: Option<Value>,
    pub inherited_sessions: Vec<Value>,
    #[serde(alias = "type")]
    pub task_type: Option<String>,
    pub workspace_source: Option<String>,
    pub project_workspace_path: Option<String>,
    #[serde(
        default,
        alias = "runtimeWorkspaceRoots",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub runtime_workspace_roots: Vec<String>,
    #[serde(alias = "runtimeProjectKey")]
    pub runtime_project_key: Option<String>,
    #[serde(alias = "runtimeProjectName")]
    pub runtime_project_name: Option<String>,
    pub device_id: Option<String>,
    pub message_id: Option<i64>,
    pub executor_name: Option<String>,
    pub executor_namespace: Option<String>,
    pub backend_url: Option<String>,
    pub validation_params: Value,
    pub user_name: Option<String>,
    pub auth_token: Option<String>,
    pub skill_identity_token: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn deserialize_id_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    match Value::deserialize(deserializer)? {
        Value::String(value) => Ok(value),
        Value::Number(value) => Ok(value.to_string()),
        Value::Null => Ok(String::new()),
        other => Err(de::Error::custom(format!(
            "expected string or number id, got {other}"
        ))),
    }
}

impl Default for ExecutionRequest {
    fn default() -> Self {
        Self {
            task_id: String::new(),
            subtask_id: String::new(),
            team_namespace: None,
            bot: Value::Array(Vec::new()),
            model_config: Value::Object(Default::default()),
            system_prompt: String::new(),
            prompt: Value::String(String::new()),
            history: Vec::new(),
            mcp_servers: Vec::new(),
            knowledge_base_scopes: Vec::new(),
            kb_tool_access_mode: FULL_KB_TOOL_ACCESS_MODE.to_owned(),
            skip_git_clone: false,
            new_session: false,
            ephemeral: false,
            fork_runtime: None,
            inherited_sessions: Vec::new(),
            task_type: None,
            workspace_source: None,
            project_workspace_path: None,
            runtime_workspace_roots: Vec::new(),
            runtime_project_key: None,
            runtime_project_name: None,
            device_id: None,
            message_id: None,
            executor_name: None,
            executor_namespace: None,
            backend_url: None,
            validation_params: Value::Object(Default::default()),
            user_name: None,
            auth_token: None,
            skill_identity_token: None,
            extra: Map::new(),
        }
    }
}

impl ExecutionRequest {
    pub fn resolved_shell_type(&self) -> Option<String> {
        if self
            .task_type
            .as_deref()
            .is_some_and(|task_type| task_type.eq_ignore_ascii_case("validation"))
        {
            return Some("imagevalidator".to_owned());
        }

        extract_shell_type(&self.bot)
    }

    pub fn resolved_agent_kind(&self) -> AgentKind {
        let Some(shell_type) = self.resolved_shell_type() else {
            return AgentKind::Unsupported(String::new());
        };

        match shell_type.as_str() {
            "claudecode" => AgentKind::ClaudeCode,
            "codex" => AgentKind::CodeX,
            "agno" => AgentKind::Agno,
            "dify" => AgentKind::Dify,
            "imagevalidator" => AgentKind::ImageValidator,
            _ => AgentKind::Unsupported(shell_type),
        }
    }

    pub fn cwd(&self) -> Option<&str> {
        self.project_workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    pub fn variable_context(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Map::new()));
        let Value::Object(object) = &mut value else {
            return Value::Object(Map::new());
        };
        if let Some(task_type) = &self.task_type {
            object.insert("type".to_owned(), Value::String(task_type.clone()));
        }
        if let Some(auth_token) = &self.auth_token {
            object.insert("task_token".to_owned(), Value::String(auth_token.clone()));
        }
        value
    }

    pub fn git_url(&self) -> Option<String> {
        value_string(self.extra.get("git_url"))
            .or_else(|| value_string(self.extra.get("gitUrl")))
            .or_else(|| value_path_string(&self.extra, &["workspace", "repository", "gitUrl"]))
            .or_else(|| value_path_string(&self.extra, &["workspace", "repository", "git_url"]))
            .or_else(|| value_path_string(&self.extra, &["repository", "gitUrl"]))
            .or_else(|| value_path_string(&self.extra, &["repository", "git_url"]))
    }
}

fn extract_shell_type(bot: &Value) -> Option<String> {
    let candidate = match bot {
        Value::Object(object) => object.get("shell_type"),
        Value::Array(bots) => bots.first().and_then(|first| first.get("shell_type")),
        _ => None,
    }?;

    candidate
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn value_path_string(root: &Map<String, Value>, path: &[&str]) -> Option<String> {
    let mut current = root.get(*path.first()?)?;
    for key in &path[1..] {
        current = current.as_object()?.get(*key)?;
    }
    value_string(Some(current))
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::ExecutionRequest;
    use serde_json::json;

    #[test]
    fn deserializes_numeric_task_identity_as_strings() {
        let request: ExecutionRequest = serde_json::from_value(json!({
            "task_id": 123,
            "subtask_id": 456
        }))
        .expect("numeric task identity should deserialize");

        assert_eq!(request.task_id, "123");
        assert_eq!(request.subtask_id, "456");
    }

    #[test]
    fn deserializes_string_task_identity_as_strings() {
        let request: ExecutionRequest = serde_json::from_value(json!({
            "task_id": "task-123",
            "subtask_id": "subtask-456"
        }))
        .expect("string task identity should deserialize");

        assert_eq!(request.task_id, "task-123");
        assert_eq!(request.subtask_id, "subtask-456");
    }
}
