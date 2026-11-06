// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The dispatch payload the executor-manager / chat-shell `/v1/responses`
//! endpoints receive.
//!
//! `execution_dispatcher.dispatch` converts the `ExecutionRequest` into an
//! OpenAI-Responses-shaped body and posts it with an AsyncOpenAI client. The
//! recorded `queued` case (`2834ba9c`) pins the envelope:
//! `{model, stream, input, instructions, tools, background, metadata,
//! model_config}` — `metadata` carries 70 keys (`task_id`, `subtask_id`, `user`,
//! `team_id`, `bot`, `knowledge_base_ids`, `callback_url`, `collaboration_model`,
//! …) and `model_config` 18 (`api_key`, `base_url`, `model_id`, `model`,
//! `default_headers`, `protocol`, `context_window`, `think_config`, …).
//!
//! The envelope (field names and order) is modeled here; the per-field values
//! are assembled by [`assemble`] from the resolved team/bot/model CRDs and the
//! execution request, ported incrementally.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) use super::openai_client::{
    OPENAI_ACCEPT, OPENAI_DUMMY_AUTHORIZATION, apply_openai_client_headers,
};

/// The `/v1/responses` request body. Keys serialize in this order, matching the
/// recorded body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchPayload {
    pub model: String,
    pub stream: bool,
    pub input: String,
    pub instructions: String,
    /// `tools=tools if tools else None`: the source passes an empty tool set
    /// as `None`, which the OpenAI client serializes as JSON `null` rather
    /// than an empty array, so the key stays present with a null value.
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
    /// The executor-manager dispatch sends `background: true`; the chat-shell
    /// SSE dispatch does not include the key at all, so it stays absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    pub metadata: Map<String, Value>,
    pub model_config: Map<String, Value>,
}

impl DispatchPayload {
    /// An empty payload with the recorded key order (values are filled by
    /// [`assemble`]).
    pub fn new() -> Self {
        Self {
            model: String::new(),
            stream: false,
            input: String::new(),
            instructions: String::new(),
            tools: None,
            background: None,
            metadata: Map::new(),
            model_config: Map::new(),
        }
    }
}

impl Default for DispatchPayload {
    fn default() -> Self {
        Self::new()
    }
}

/// The `metadata` keys in the order recorded for the `queued` case.
pub const METADATA_KEY_ORDER: &[&str] = &[
    "task_id",
    "subtask_id",
    "user",
    "user_id",
    "user_name",
    "team_id",
    "team_name",
    "team_namespace",
    "team_owner",
    "bot",
    "bot_name",
    "bot_namespace",
    "message_id",
    "user_message_id",
    "user_subtask_id",
    "is_group_chat",
    "history_limit",
    "stateless",
    "enable_tools",
    "enable_web_search",
    "enable_clarification",
    "enable_deep_thinking",
    "enable_tool_output_guard",
    "search_engine",
    "skill_names",
    "skill_configs",
    "preload_skills",
    "user_selected_skills",
    "skill_refs",
    "preload_skill_refs",
    "knowledge_base_ids",
    "document_ids",
    "external_knowledge_refs",
    "selected_knowledge_prompt",
    "provider_native_knowledge",
    "knowledge_base_scopes",
    "is_user_selected_kb",
    "kb_tool_access_mode",
    "kb_meta_prompt",
    "task_data",
    "interactive_form_answer",
    "attachments",
    "auth_token",
    "skill_identity_token",
    "backend_url",
    "workspace",
    "is_subscription",
    "request_id",
    "executor_name",
    "executor_namespace",
    "skip_git_clone",
    "fork_runtime",
    "inherited_sessions",
    "legacy_session_bindings",
    "executor_image",
    "executor_type",
    "type",
    "mode",
    "subtask_next_id",
    "subtask_title",
    "task_title",
    "git_repo",
    "git_url",
    "git_domain",
    "git_repo_id",
    "branch_name",
    "git_auth_transport",
    "validation_params",
    "sandbox_metadata",
    "callback_url",
    "new_session",
    "collaboration_model",
];

/// The `model_config` keys in the order recorded for the `queued` case.
pub const MODEL_CONFIG_KEY_ORDER: &[&str] = &[
    "api_key",
    "base_url",
    "model_id",
    "model",
    "default_headers",
    "api_format",
    "protocol",
    "context_window",
    "max_output_tokens",
    "modelType",
    "videoConfig",
    "think_config",
    "temperature",
    "supports_developer_role",
    "modelCapabilities",
    "model_name",
    "model_namespace",
    "reasoning",
];

/// The execution request the converter consumes
/// (`shared/models/execution.py:ExecutionRequest`). Defaults match the source
/// dataclass.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct ExecutionRequest {
    pub task_id: i64,
    pub subtask_id: i64,
    pub subtask_next_id: Option<i64>,
    pub team_id: i64,
    pub team_name: String,
    pub team_namespace: Option<String>,
    /// `ExecutionRequest.team_owner` (`default_factory=dict`).
    pub team_owner: Value,
    pub subtask_title: Option<String>,
    pub task_title: Option<String>,
    pub user: Value,
    pub user_id: i64,
    pub user_name: String,
    pub bot: Value,
    pub bot_name: String,
    pub bot_namespace: String,
    pub model_config: Value,
    pub system_prompt: String,
    pub prompt: Value,
    pub history: Vec<Value>,
    pub kb_meta_prompt: String,
    pub enable_tools: bool,
    pub enable_web_search: bool,
    pub enable_clarification: bool,
    pub enable_deep_thinking: bool,
    pub enable_tool_output_guard: bool,
    pub search_engine: Option<String>,
    pub skill_names: Vec<Value>,
    pub skill_configs: Vec<Value>,
    pub preload_skills: Vec<Value>,
    pub user_selected_skills: Vec<Value>,
    pub skill_refs: Value,
    pub preload_skill_refs: Value,
    pub mcp_servers: Vec<Value>,
    pub knowledge_base_ids: Option<Value>,
    pub document_ids: Option<Value>,
    pub knowledge_base_scopes: Vec<Value>,
    pub external_knowledge_refs: Option<Value>,
    pub selected_knowledge_prompt: String,
    pub provider_native_knowledge: bool,
    pub is_user_selected_kb: bool,
    pub kb_tool_access_mode: Option<String>,
    pub task_data: Option<Value>,
    pub interactive_form_answer: Option<Value>,
    pub attachments: Vec<Value>,
    pub auth_token: String,
    pub skill_identity_token: String,
    pub backend_url: String,
    pub workspace: Value,
    pub is_subscription: bool,
    pub request_id: String,
    pub executor_name: Option<String>,
    pub executor_namespace: Option<String>,
    pub skip_git_clone: Option<bool>,
    pub fork_runtime: Option<Value>,
    pub inherited_sessions: Vec<Value>,
    /// `ExecutionRequest.legacy_session_bindings` (`default_factory=list`).
    pub legacy_session_bindings: Vec<Value>,
    pub executor_image: Option<String>,
    pub executor_type: Option<String>,
    pub r#type: Option<String>,
    pub mode: Option<String>,
    pub git_repo: Option<String>,
    pub git_url: Option<String>,
    pub git_domain: Option<String>,
    pub git_repo_id: Option<i64>,
    pub branch_name: Option<String>,
    pub git_auth_transport: String,
    pub validation_params: Option<Value>,
    pub sandbox_metadata: Option<Value>,
    pub callback_url: Option<String>,
    pub new_session: bool,
    pub collaboration_model: String,
    pub message_id: Option<i64>,
    pub user_message_id: Option<i64>,
    pub user_subtask_id: Option<i64>,
    pub is_group_chat: bool,
    pub history_limit: Option<i64>,
    pub stateless: bool,
}

impl Default for ExecutionRequest {
    fn default() -> Self {
        Self {
            task_id: 0,
            subtask_id: 0,
            subtask_next_id: None,
            team_id: 0,
            team_name: String::new(),
            team_namespace: None,
            team_owner: Value::Object(Map::new()),
            subtask_title: None,
            task_title: None,
            user: Value::Object(Map::new()),
            user_id: 0,
            user_name: String::new(),
            bot: Value::Array(Vec::new()),
            bot_name: String::new(),
            bot_namespace: String::new(),
            model_config: Value::Object(Map::new()),
            system_prompt: String::new(),
            prompt: Value::String(String::new()),
            history: Vec::new(),
            kb_meta_prompt: String::new(),
            enable_tools: true,
            enable_web_search: false,
            enable_clarification: false,
            enable_deep_thinking: true,
            enable_tool_output_guard: true,
            search_engine: None,
            skill_names: Vec::new(),
            skill_configs: Vec::new(),
            preload_skills: Vec::new(),
            user_selected_skills: Vec::new(),
            skill_refs: Value::Object(Map::new()),
            preload_skill_refs: Value::Object(Map::new()),
            mcp_servers: Vec::new(),
            knowledge_base_ids: None,
            document_ids: None,
            knowledge_base_scopes: Vec::new(),
            external_knowledge_refs: None,
            selected_knowledge_prompt: String::new(),
            provider_native_knowledge: false,
            is_user_selected_kb: true,
            kb_tool_access_mode: None,
            task_data: None,
            interactive_form_answer: None,
            attachments: Vec::new(),
            auth_token: String::new(),
            skill_identity_token: String::new(),
            backend_url: String::new(),
            workspace: Value::Object(Map::new()),
            is_subscription: false,
            request_id: String::new(),
            executor_name: None,
            executor_namespace: None,
            skip_git_clone: None,
            fork_runtime: None,
            inherited_sessions: Vec::new(),
            legacy_session_bindings: Vec::new(),
            executor_image: None,
            executor_type: None,
            r#type: None,
            mode: None,
            git_repo: None,
            git_url: None,
            git_domain: None,
            git_repo_id: None,
            branch_name: None,
            git_auth_transport: "none".to_string(),
            validation_params: None,
            sandbox_metadata: None,
            callback_url: None,
            new_session: false,
            collaboration_model: "single".to_string(),
            message_id: None,
            user_message_id: None,
            user_subtask_id: None,
            is_group_chat: false,
            history_limit: None,
            stateless: false,
        }
    }
}

/// `normalize_kb_tool_access_mode`: `value or "full"`.
pub fn normalize_kb_tool_access_mode(value: Option<&str>) -> String {
    value
        .filter(|v| !v.is_empty())
        .unwrap_or("full")
        .to_string()
}

/// `OpenAIRequestConverter.from_execution_request`: the dispatch payload.
///
/// `stream` and `background` are the dispatch-mode overrides the dispatcher
/// passes to the OpenAI client (`stream=False, background=true` for the
/// executor-manager HTTP+callback path; `stream=True` for SSE).
pub fn assemble(request: &ExecutionRequest, stream: bool, background: bool) -> DispatchPayload {
    let input = if request.history.is_empty() {
        request.prompt.clone()
    } else {
        let mut messages = request.history.clone();
        if !matches!(&request.prompt, Value::String(text) if text.is_empty()) {
            messages.push(serde_json::json!({"role": "user", "content": request.prompt}));
        }
        Value::Array(messages)
    };
    let prompt_text = match &input {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };

    let tools = if request.mcp_servers.is_empty() {
        None
    } else {
        Some(request.mcp_servers.iter().map(mcp_tool).collect())
    };

    let mut metadata = Map::new();
    metadata.insert("task_id".into(), serde_json::json!(request.task_id));
    metadata.insert("subtask_id".into(), serde_json::json!(request.subtask_id));
    metadata.insert("user".into(), request.user.clone());
    metadata.insert("user_id".into(), serde_json::json!(request.user_id));
    metadata.insert("user_name".into(), serde_json::json!(request.user_name));
    metadata.insert("team_id".into(), serde_json::json!(request.team_id));
    metadata.insert("team_name".into(), serde_json::json!(request.team_name));
    metadata.insert(
        "team_namespace".into(),
        serde_json::json!(request.team_namespace),
    );
    metadata.insert("team_owner".into(), request.team_owner.clone());
    metadata.insert("bot".into(), request.bot.clone());
    metadata.insert("bot_name".into(), serde_json::json!(request.bot_name));
    metadata.insert(
        "bot_namespace".into(),
        serde_json::json!(request.bot_namespace),
    );
    metadata.insert("message_id".into(), serde_json::json!(request.message_id));
    metadata.insert(
        "user_message_id".into(),
        serde_json::json!(request.user_message_id),
    );
    metadata.insert(
        "user_subtask_id".into(),
        serde_json::json!(request.user_subtask_id),
    );
    metadata.insert(
        "is_group_chat".into(),
        serde_json::json!(request.is_group_chat),
    );
    metadata.insert(
        "history_limit".into(),
        serde_json::json!(request.history_limit),
    );
    metadata.insert("stateless".into(), serde_json::json!(request.stateless));
    metadata.insert(
        "enable_tools".into(),
        serde_json::json!(request.enable_tools),
    );
    metadata.insert(
        "enable_web_search".into(),
        serde_json::json!(request.enable_web_search),
    );
    metadata.insert(
        "enable_clarification".into(),
        serde_json::json!(request.enable_clarification),
    );
    metadata.insert(
        "enable_deep_thinking".into(),
        serde_json::json!(request.enable_deep_thinking),
    );
    metadata.insert(
        "enable_tool_output_guard".into(),
        serde_json::json!(request.enable_tool_output_guard),
    );
    metadata.insert(
        "search_engine".into(),
        serde_json::json!(request.search_engine),
    );
    metadata.insert("skill_names".into(), serde_json::json!(request.skill_names));
    metadata.insert(
        "skill_configs".into(),
        serde_json::json!(request.skill_configs),
    );
    metadata.insert(
        "preload_skills".into(),
        serde_json::json!(request.preload_skills),
    );
    metadata.insert(
        "user_selected_skills".into(),
        serde_json::json!(request.user_selected_skills),
    );
    metadata.insert("skill_refs".into(), request.skill_refs.clone());
    metadata.insert(
        "preload_skill_refs".into(),
        request.preload_skill_refs.clone(),
    );
    metadata.insert(
        "knowledge_base_ids".into(),
        serde_json::json!(request.knowledge_base_ids),
    );
    metadata.insert(
        "document_ids".into(),
        serde_json::json!(request.document_ids),
    );
    metadata.insert(
        "external_knowledge_refs".into(),
        serde_json::json!(request.external_knowledge_refs),
    );
    metadata.insert(
        "selected_knowledge_prompt".into(),
        serde_json::json!(request.selected_knowledge_prompt),
    );
    metadata.insert(
        "provider_native_knowledge".into(),
        serde_json::json!(request.provider_native_knowledge),
    );
    metadata.insert(
        "knowledge_base_scopes".into(),
        Value::Array(request.knowledge_base_scopes.clone()),
    );
    metadata.insert(
        "is_user_selected_kb".into(),
        serde_json::json!(request.is_user_selected_kb),
    );
    metadata.insert(
        "kb_tool_access_mode".into(),
        serde_json::json!(normalize_kb_tool_access_mode(
            request.kb_tool_access_mode.as_deref()
        )),
    );
    metadata.insert(
        "kb_meta_prompt".into(),
        serde_json::json!(request.kb_meta_prompt),
    );
    metadata.insert("task_data".into(), serde_json::json!(request.task_data));
    metadata.insert(
        "interactive_form_answer".into(),
        serde_json::json!(request.interactive_form_answer),
    );
    metadata.insert("attachments".into(), serde_json::json!(request.attachments));
    metadata.insert("auth_token".into(), serde_json::json!(request.auth_token));
    metadata.insert(
        "skill_identity_token".into(),
        serde_json::json!(request.skill_identity_token),
    );
    metadata.insert("backend_url".into(), serde_json::json!(request.backend_url));
    metadata.insert("workspace".into(), request.workspace.clone());
    metadata.insert(
        "is_subscription".into(),
        serde_json::json!(request.is_subscription),
    );
    metadata.insert("request_id".into(), serde_json::json!(request.request_id));
    metadata.insert(
        "executor_name".into(),
        serde_json::json!(request.executor_name),
    );
    metadata.insert(
        "executor_namespace".into(),
        serde_json::json!(request.executor_namespace),
    );
    metadata.insert(
        "skip_git_clone".into(),
        serde_json::json!(request.skip_git_clone),
    );
    metadata.insert(
        "fork_runtime".into(),
        serde_json::json!(request.fork_runtime),
    );
    metadata.insert(
        "inherited_sessions".into(),
        serde_json::json!(request.inherited_sessions),
    );
    metadata.insert(
        "legacy_session_bindings".into(),
        serde_json::json!(request.legacy_session_bindings),
    );
    metadata.insert(
        "executor_image".into(),
        serde_json::json!(request.executor_image),
    );
    metadata.insert(
        "executor_type".into(),
        serde_json::json!(request.executor_type),
    );
    metadata.insert("type".into(), serde_json::json!(request.r#type));
    metadata.insert("mode".into(), serde_json::json!(request.mode));
    metadata.insert(
        "subtask_next_id".into(),
        serde_json::json!(request.subtask_next_id),
    );
    metadata.insert(
        "subtask_title".into(),
        serde_json::json!(request.subtask_title),
    );
    metadata.insert("task_title".into(), serde_json::json!(request.task_title));
    metadata.insert("git_repo".into(), serde_json::json!(request.git_repo));
    metadata.insert("git_url".into(), serde_json::json!(request.git_url));
    metadata.insert("git_domain".into(), serde_json::json!(request.git_domain));
    metadata.insert("git_repo_id".into(), serde_json::json!(request.git_repo_id));
    metadata.insert("branch_name".into(), serde_json::json!(request.branch_name));
    metadata.insert(
        "git_auth_transport".into(),
        serde_json::json!(request.git_auth_transport),
    );
    metadata.insert(
        "validation_params".into(),
        serde_json::json!(request.validation_params),
    );
    metadata.insert(
        "sandbox_metadata".into(),
        serde_json::json!(request.sandbox_metadata),
    );
    metadata.insert(
        "callback_url".into(),
        serde_json::json!(request.callback_url),
    );
    metadata.insert("new_session".into(), serde_json::json!(request.new_session));
    metadata.insert(
        "collaboration_model".into(),
        serde_json::json!(request.collaboration_model),
    );

    let model = request
        .model_config
        .get("model_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    DispatchPayload {
        model,
        stream,
        input: prompt_text,
        instructions: request.system_prompt.clone(),
        tools,
        // Only the executor-manager dispatch carries `background=true`; the
        // chat-shell body has no such key.
        background: background.then_some(true),
        metadata,
        model_config: match &request.model_config {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        },
    }
}

/// One `mcp_servers` entry as an OpenAI `mcp` tool.
fn mcp_tool(server: &Value) -> Value {
    let mut tool = Map::new();
    tool.insert("type".into(), Value::String("mcp".into()));
    tool.insert(
        "server_label".into(),
        Value::String(string_field(server, "name")),
    );
    tool.insert(
        "server_url".into(),
        Value::String(string_field(server, "url")),
    );
    tool.insert(
        "server_type".into(),
        Value::String(match server.get("type").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => "streamable-http".to_string(),
        }),
    );
    tool.insert("require_approval".into(), Value::String("never".into()));
    let auth = server.get("auth").or_else(|| server.get("headers"));
    if let Some(auth) = auth.filter(|value| !value.is_null()) {
        tool.insert("server_auth".into(), auth.clone());
    }
    for key in ["command", "args", "env"] {
        if let Some(value) = server.get(key) {
            tool.insert(key.into(), value.clone());
        }
    }
    Value::Object(tool)
}

/// A top-level string field, `""` when absent.
fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_keys_serialize_in_the_recorded_order() {
        let payload = DispatchPayload {
            model: "qwen3.7-plus".to_string(),
            stream: false,
            input: "prompt".to_string(),
            instructions: "system".to_string(),
            tools: Some(vec![json!({"type": "mcp"})]),
            background: Some(true),
            metadata: Map::new(),
            model_config: Map::new(),
        };
        let rendered = serde_json::to_string(&payload).expect("serialize");
        let value: Value = serde_json::from_str(&rendered).expect("parse");
        let keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        assert_eq!(
            keys,
            [
                "model",
                "stream",
                "input",
                "instructions",
                "tools",
                "background",
                "metadata",
                "model_config",
            ]
        );
    }

    #[test]
    fn chat_shell_envelope_omits_background_and_keeps_recorded_metadata() {
        // Recorded chat-shell body keys: model, stream, input, instructions,
        // tools, metadata, model_config — no `background` (the executor
        // dispatch is the only caller that sends it).
        let request = ExecutionRequest {
            model_config: json!({"model_id": "qwen3.7-flash"}),
            ..ExecutionRequest::default()
        };
        let payload = assemble(&request, true, false);
        assert_eq!(payload.background, None);
        let value = serde_json::to_value(&payload).expect("serialize");
        let keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "model",
                "stream",
                "input",
                "instructions",
                "tools",
                "metadata",
                "model_config",
            ]
        );
        // `ExecutionRequest.team_owner` / `legacy_session_bindings` defaults.
        assert_eq!(value["metadata"]["team_owner"], json!({}));
        assert_eq!(value["metadata"]["legacy_session_bindings"], json!([]));
        let metadata_keys: Vec<&str> = value["metadata"]
            .as_object()
            .expect("metadata")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(metadata_keys, METADATA_KEY_ORDER);
    }

    #[test]
    fn assemble_orders_metadata_after_the_recorded_keys() {
        let request = ExecutionRequest {
            model_config: json!({"model_id": "qwen3.7-plus"}),
            system_prompt: "system".to_string(),
            prompt: json!("prompt"),
            team_id: 239_729,
            ..ExecutionRequest::default()
        };
        let payload = assemble(&request, false, true);
        assert_eq!(payload.model, "qwen3.7-plus");
        assert!(!payload.stream);
        assert_eq!(payload.background, Some(true));
        assert_eq!(payload.input, "prompt");
        assert_eq!(payload.instructions, "system");
        let keys: Vec<&str> = payload.metadata.keys().map(String::as_str).collect();
        assert_eq!(keys, METADATA_KEY_ORDER);
        assert_eq!(payload.metadata["team_id"], json!(239_729));
        assert_eq!(payload.metadata["kb_tool_access_mode"], json!("full"));
        assert_eq!(payload.metadata["collaboration_model"], json!("single"));
        assert_eq!(payload.metadata["enable_tools"], json!(true));
    }

    #[test]
    fn mcp_servers_become_mcp_tools() {
        let request = ExecutionRequest {
            mcp_servers: vec![json!({"name": "srv", "url": "http://x", "type": "sse"})],
            ..ExecutionRequest::default()
        };
        let payload = assemble(&request, false, true);
        assert_eq!(
            payload.tools,
            Some(vec![json!({
                "type": "mcp",
                "server_label": "srv",
                "server_url": "http://x",
                "server_type": "sse",
                "require_approval": "never",
            })])
        );
    }

    #[test]
    fn request_mcp_tool_carries_the_mapping_key_and_auth_only() {
        // `openai_converter.py:130-155`: the tool label is the entry's `name`
        // (the Ghost mapping key, per `_build_mcp_servers`), `auth` becomes
        // `server_auth`, and non-tool fields such as `timeout` stay out.
        let request = ExecutionRequest {
            mcp_servers: vec![json!({
                "name": "market-cmapi00074002",
                "url": "https://dashscope.example/api/v1/mcps/market-cmapi00074002/mcp",
                "type": "streamable-http",
                "auth": {"Authorization": "Bearer example-token"},
                "timeout": 60,
            })],
            ..ExecutionRequest::default()
        };
        let payload = assemble(&request, false, true);
        assert_eq!(
            payload.tools,
            Some(vec![json!({
                "type": "mcp",
                "server_label": "market-cmapi00074002",
                "server_url": "https://dashscope.example/api/v1/mcps/market-cmapi00074002/mcp",
                "server_type": "streamable-http",
                "require_approval": "never",
                "server_auth": {"Authorization": "Bearer example-token"},
            })])
        );
    }

    /// An empty tool set serializes as JSON `null` — the shape the source's
    /// `tools=tools if tools else None` produces — and not as `[]`.
    #[test]
    fn an_empty_tool_set_serializes_as_null() {
        let request = ExecutionRequest::default();
        let payload = assemble(&request, false, true);
        assert_eq!(payload.tools, None);
        let value = serde_json::to_value(&payload).expect("serialize");
        assert!(
            value.get("tools").is_some(),
            "the key stays present: {value}"
        );
        assert_eq!(value["tools"], Value::Null);
    }

    #[test]
    fn recorded_key_orders_are_documented() {
        // The recorded chat-shell body carries 72 metadata keys.
        assert_eq!(METADATA_KEY_ORDER.len(), 72);
        assert_eq!(METADATA_KEY_ORDER[0], "task_id");
        assert_eq!(METADATA_KEY_ORDER[71], "collaboration_model");
        assert_eq!(MODEL_CONFIG_KEY_ORDER.len(), 18);
        assert_eq!(MODEL_CONFIG_KEY_ORDER[0], "api_key");
        assert_eq!(MODEL_CONFIG_KEY_ORDER[13], "supports_developer_role");
        assert_eq!(MODEL_CONFIG_KEY_ORDER[17], "reasoning");
    }
}
