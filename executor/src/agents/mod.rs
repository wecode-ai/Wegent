// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, env, future::Future, path::PathBuf, pin::Pin};

use serde_json::Value;

mod agno;
mod codex;
mod dify;
mod image_validator;

use crate::{
    claude_session,
    process::{CommandSpec, StreamProcessEngine},
    protocol::{AgentKind, ExecutionRequest},
    runner::{AgentEngine, ExecutionOutcome},
};

pub use agno::build_agno_options;
pub use codex::{
    request_codex_app_server, run_codex_app_server_turn, CodexAppServerEngine, CodexAppServerTurn,
    CodexNotificationSender,
};
pub use dify::{build_dify_config, saved_dify_task_id, DifyEngine};
pub use image_validator::ImageValidatorEngine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommandPlanner {
    claude_binary: String,
    codex_binary: String,
}

impl AgentCommandPlanner {
    pub fn new(claude_binary: impl Into<String>, codex_binary: impl Into<String>) -> Self {
        Self {
            claude_binary: claude_binary.into(),
            codex_binary: codex_binary.into(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(
            read_binary("CLAUDE_BINARY_PATH", "CLAUDE_BIN", "claude"),
            read_binary("CODEX_BINARY_PATH", "CODEX_BIN", "codex"),
        )
    }

    pub fn command_for(&self, request: &ExecutionRequest) -> Result<CommandSpec, String> {
        match request.resolved_agent_kind() {
            AgentKind::ClaudeCode => Ok(build_claude_command(request, &self.claude_binary)),
            AgentKind::CodeX => Ok(build_codex_app_server_command(&self.codex_binary)),
            agent_kind => Err(format!("unsupported agent kind: {agent_kind:?}")),
        }
    }
}

fn read_binary(primary: &str, secondary: &str, default: &str) -> String {
    env::var(primary)
        .ok()
        .or_else(|| env::var(secondary).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

#[derive(Debug, Clone)]
pub struct AgentProcessEngine {
    planner: AgentCommandPlanner,
}

impl AgentProcessEngine {
    pub fn new(planner: AgentCommandPlanner) -> Self {
        Self { planner }
    }
}

impl AgentEngine for AgentProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let planner = self.planner.clone();
        Box::pin(async move {
            match request.resolved_agent_kind() {
                AgentKind::CodeX => {
                    CodexAppServerEngine::new(planner.codex_binary)
                        .run(request)
                        .await
                }
                AgentKind::Dify => DifyEngine::new().run(request).await,
                AgentKind::ImageValidator => ImageValidatorEngine.run(request).await,
                _ => match planner.command_for(&request) {
                    Ok(spec) => StreamProcessEngine::new(spec).run(request).await,
                    Err(message) => ExecutionOutcome::Failed { message },
                },
            }
        })
    }
}

pub fn build_claude_command(request: &ExecutionRequest, binary: &str) -> CommandSpec {
    let mut spec = CommandSpec::new(binary)
        .arg("-p")
        .arg(prompt_text(&request.prompt))
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("bypassPermissions");

    if let Some(system_prompt) = execution_system_prompt(request) {
        spec = spec.arg("--append-system-prompt").arg(system_prompt);
    }

    if let Some(model) = model_id(request) {
        spec = spec.arg("--model").arg(model);
    }

    if let Some(session_id) = claude_session::load_saved_session_id(request) {
        spec = spec.arg("--resume").arg(session_id);
    }

    spec = apply_model_environment(spec, request);

    let task_dir = claude_task_dir(request);
    spec = apply_claude_workspace_environment(spec, task_dir.as_ref());
    if let Some(task_dir) = task_dir {
        spec = spec.cwd(task_dir);
    }

    spec
}

pub fn build_codex_app_server_command(binary: &str) -> CommandSpec {
    CommandSpec::new(binary).arg("app-server").arg("--stdio")
}

pub(crate) fn prompt_text(prompt: &Value) -> String {
    match prompt {
        Value::String(value) => value.clone(),
        value => value.to_string(),
    }
}

fn execution_system_prompt(request: &ExecutionRequest) -> Option<String> {
    let prompt = request.system_prompt.trim();
    if prompt.is_empty() {
        None
    } else {
        Some(prompt.to_owned())
    }
}

pub(crate) fn model_id(request: &ExecutionRequest) -> Option<String> {
    model_string(request, "model_id")
}

fn apply_model_environment(mut spec: CommandSpec, request: &ExecutionRequest) -> CommandSpec {
    let env_values = model_env(request);
    for (key, value) in &env_values {
        if is_process_env_key(key) {
            spec = spec.env(key, value);
        }
    }

    if !env_values.contains_key("ANTHROPIC_API_KEY") {
        if let Some(api_key) = env_values.get("api_key") {
            spec = spec.env("ANTHROPIC_API_KEY", api_key);
        }
    }

    if !env_values.contains_key("ANTHROPIC_BASE_URL") {
        if let Some(base_url) = env_values.get("base_url") {
            spec = spec.env("ANTHROPIC_BASE_URL", base_url);
        }
    }

    spec
}

fn apply_claude_workspace_environment(
    mut spec: CommandSpec,
    task_dir: Option<&PathBuf>,
) -> CommandSpec {
    let Some(task_dir) = task_dir else {
        return spec;
    };

    if !spec.envs().contains_key("CLAUDE_CONFIG_DIR") {
        spec = spec.env(
            "CLAUDE_CONFIG_DIR",
            task_dir.join(".claude").display().to_string(),
        );
    }
    if !spec.envs().contains_key("SKILLS_DIR") {
        spec = spec.env(
            "SKILLS_DIR",
            task_dir.join(".claude/skills").display().to_string(),
        );
    }

    spec
}

fn claude_task_dir(request: &ExecutionRequest) -> Option<PathBuf> {
    request
        .cwd()
        .map(PathBuf::from)
        .or_else(|| claude_session::preferred_task_dir(request))
}

fn model_string(request: &ExecutionRequest, key: &str) -> Option<String> {
    model_values(request).remove(key)
}

fn model_env(request: &ExecutionRequest) -> BTreeMap<String, String> {
    model_values(request)
}

fn model_values(request: &ExecutionRequest) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    collect_bot_agent_env(&request.bot, &mut values);
    collect_string_fields(request.model_config.as_object(), &mut values);
    collect_string_fields(
        request.model_config.get("env").and_then(Value::as_object),
        &mut values,
    );
    values
}

fn collect_bot_agent_env(bot: &Value, values: &mut BTreeMap<String, String>) {
    match bot {
        Value::Object(_) => collect_single_bot_agent_env(bot, values),
        Value::Array(bots) => {
            for bot in bots {
                collect_single_bot_agent_env(bot, values);
            }
        }
        _ => {}
    }
}

fn collect_single_bot_agent_env(bot: &Value, values: &mut BTreeMap<String, String>) {
    collect_string_fields(
        bot.get("agent_config")
            .and_then(|config| config.get("env"))
            .and_then(Value::as_object),
        values,
    );
}

fn collect_string_fields(
    fields: Option<&serde_json::Map<String, Value>>,
    values: &mut BTreeMap<String, String>,
) {
    let Some(fields) = fields else {
        return;
    };

    for (key, value) in fields {
        if let Some(value) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            values.insert(key.clone(), value.to_owned());
        }
    }
}

fn is_process_env_key(key: &str) -> bool {
    key.chars().all(|character| {
        character.is_ascii_uppercase() || character == '_' || character.is_ascii_digit()
    })
}
