// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub task_id: i64,
    pub subtask_id: i64,
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
    pub fork_runtime: Option<Value>,
    pub inherited_sessions: Vec<Value>,
    #[serde(alias = "type")]
    pub task_type: Option<String>,
    pub workspace_source: Option<String>,
    pub project_workspace_path: Option<String>,
    pub device_id: Option<String>,
    pub message_id: Option<i64>,
    pub executor_name: Option<String>,
    pub executor_namespace: Option<String>,
    pub backend_url: Option<String>,
    pub validation_params: Value,
    pub user_name: Option<String>,
    pub auth_token: Option<String>,
    pub skill_identity_token: Option<String>,
}

impl Default for ExecutionRequest {
    fn default() -> Self {
        Self {
            task_id: 0,
            subtask_id: 0,
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
            fork_runtime: None,
            inherited_sessions: Vec::new(),
            task_type: None,
            workspace_source: None,
            project_workspace_path: None,
            device_id: None,
            message_id: None,
            executor_name: None,
            executor_namespace: None,
            backend_url: None,
            validation_params: Value::Object(Default::default()),
            user_name: None,
            auth_token: None,
            skill_identity_token: None,
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
            "claudecode" if is_codex_compatible_model(&self.model_config) => AgentKind::CodeX,
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
}

pub fn is_codex_compatible_model(model_config: &Value) -> bool {
    let provider_is_openai = get_string(model_config, "model")
        .is_some_and(|provider| provider.eq_ignore_ascii_case("openai"));
    let uses_responses_api = get_string(model_config, "api_format")
        .is_some_and(|value| value.eq_ignore_ascii_case("responses"))
        || get_string(model_config, "apiFormat")
            .is_some_and(|value| value.eq_ignore_ascii_case("responses"))
        || get_string(model_config, "protocol")
            .is_some_and(|value| value.eq_ignore_ascii_case("openai-responses"))
        || get_string(model_config, "wire_api")
            .is_some_and(|value| value.eq_ignore_ascii_case("responses"));

    provider_is_openai && uses_responses_api
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

fn get_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.as_object()?.get(key)?.as_str()
}
