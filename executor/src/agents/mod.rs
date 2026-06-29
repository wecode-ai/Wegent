// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, env, fs, future::Future, path::PathBuf, pin::Pin};

use serde_json::{Map, Value};

mod agno;
mod claude_options;
mod codex;
mod dify;
mod git_auth;
mod git_workspace;
mod image_validator;
pub mod interactive_mcp;
mod runtime_capabilities;

use crate::{
    agents::interactive_mcp::build_interactive_form_answer_query,
    attachments::{
        append_text_to_vision_prompt, convert_openai_to_anthropic_content, create_multimodal_query,
    },
    claude_session,
    hooks::pre_execute::{PreExecuteContext, PreExecuteHook},
    logging::{log_executor_event, task_fields},
    process::{CommandSpec, StreamProcessEngine},
    protocol::{AgentKind, ExecutionRequest},
    runner::{AgentEngine, ExecutionOutcome},
};

pub use agno::build_agno_options;
pub use claude_options::{extract_claude_options, ClaudeOptions};
pub use codex::{
    run_codex_app_server_turn, CodexAppServerClient, CodexAppServerEngine, CodexAppServerTurn,
    CodexCancellationState, CodexNotificationSender, CodexTurnInterrupter,
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
        Self::new(resolve_claude_binary(), resolve_codex_binary())
    }

    pub fn command_for(&self, request: &ExecutionRequest) -> Result<CommandSpec, String> {
        match request.resolved_agent_kind() {
            AgentKind::ClaudeCode => Ok(build_claude_command(request, &self.claude_binary)),
            AgentKind::CodeX => Ok(build_codex_app_server_command(&self.codex_binary)),
            agent_kind => Err(format!("unsupported agent kind: {agent_kind:?}")),
        }
    }
}

pub fn resolve_codex_binary() -> String {
    read_binary("CODEX_BINARY_PATH", "CODEX_BIN", "codex")
}

fn resolve_claude_binary() -> String {
    read_binary("CLAUDE_BINARY_PATH", "CLAUDE_BIN", "claude")
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
            let agent_kind = request.resolved_agent_kind();
            let mut fields = task_fields(request.task_id, request.subtask_id);
            fields.push(("agent", format!("{agent_kind:?}")));
            log_executor_event("agent dispatch", &fields);

            match agent_kind {
                AgentKind::CodeX => {
                    runtime_capabilities::prepare_codex_runtime(&request).await;
                    CodexAppServerEngine::new(planner.codex_binary)
                        .run(request)
                        .await
                }
                AgentKind::Dify => DifyEngine::new().run(request).await,
                AgentKind::ImageValidator => ImageValidatorEngine.run(request).await,
                _ => {
                    let request = if agent_kind == AgentKind::ClaudeCode {
                        let request =
                            runtime_capabilities::prepare_claude_execution_request(request).await;
                        match git_workspace::prepare_git_workspace(request).await {
                            Ok(request) => request,
                            Err(message) => {
                                let mut failed_fields = fields.clone();
                                failed_fields.push(("error_len", message.len().to_string()));
                                log_executor_event(
                                    "git workspace preparation failed",
                                    &failed_fields,
                                );
                                return ExecutionOutcome::Failed { message };
                            }
                        }
                    } else {
                        request
                    };
                    match planner.command_for(&request) {
                        Ok(mut spec) => {
                            let mut command_fields = fields.clone();
                            command_fields.push(("program", spec.program().to_owned()));
                            command_fields.push(("arg_count", spec.args().len().to_string()));
                            if let Some(cwd) = spec.current_dir() {
                                command_fields.push(("cwd", cwd.display().to_string()));
                            }
                            log_executor_event("command planned", &command_fields);
                            if request.resolved_agent_kind() == AgentKind::ClaudeCode {
                                spec = runtime_capabilities::prepare_claude_runtime(&request, spec)
                                    .await
                                    .unwrap_or_else(|error| {
                                        let mut failed_fields =
                                            task_fields(request.task_id, request.subtask_id);
                                        failed_fields.push(("error_len", error.len().to_string()));
                                        log_executor_event(
                                            "claude runtime capability preparation failed",
                                            &failed_fields,
                                        );
                                        build_claude_command(&request, &planner.claude_binary)
                                    });
                                git_auth::setup_git_authentication(&request).await;
                                run_pre_execute_hook(&request, &spec).await;
                            }
                            StreamProcessEngine::new(spec).run(request).await
                        }
                        Err(message) => {
                            let mut failed_fields = fields;
                            failed_fields.push(("error_len", message.len().to_string()));
                            log_executor_event("command planning failed", &failed_fields);
                            ExecutionOutcome::Failed { message }
                        }
                    }
                }
            }
        })
    }
}

async fn run_pre_execute_hook(request: &ExecutionRequest, spec: &CommandSpec) {
    let hook = PreExecuteHook::from_env();
    if !hook.enabled() {
        return;
    }

    let task_dir = spec
        .current_dir()
        .cloned()
        .or_else(|| request.cwd().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = fs::create_dir_all(&task_dir);

    let mut fields = task_fields(request.task_id, request.subtask_id);
    fields.push(("cwd", task_dir.display().to_string()));
    log_executor_event("pre-execute hook started", &fields);
    let exit = hook
        .execute(PreExecuteContext {
            task_dir,
            task_id: (request.task_id > 0).then_some(request.task_id),
            git_url: request.git_url(),
        })
        .await;
    fields.push(("exit_code", exit.code.to_string()));
    fields.push(("stdout_len", exit.stdout.len().to_string()));
    fields.push(("stderr_len", exit.stderr.len().to_string()));
    if exit.code == 0 {
        log_executor_event("pre-execute hook finished", &fields);
    } else {
        log_executor_event("pre-execute hook failed", &fields);
    }
}

pub fn build_claude_command(request: &ExecutionRequest, binary: &str) -> CommandSpec {
    let mut spec = CommandSpec::new(binary).arg("-p");
    if let Some(query) = interactive_form_answer_query(request) {
        spec = spec
            .arg("--input-format")
            .arg("stream-json")
            .stdin(format!("{query}\n"));
    } else if let Some(query) = claude_content_block_stdin_query(request) {
        spec = spec
            .arg("--input-format")
            .arg("stream-json")
            .stdin(format!("{query}\n"));
    } else {
        spec = spec.arg(claude_prompt_text(request));
    }

    let mut spec = spec
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
    spec = apply_task_identity_environment(spec, request);
    spec = apply_git_environment(spec, request);
    spec = apply_claude_header_environment(spec, request);

    let task_dir = claude_task_dir(request);
    spec = apply_claude_workspace_environment(spec, request, task_dir.as_ref());
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

fn claude_prompt_text(request: &ExecutionRequest) -> String {
    let prompt = claude_prompt_value(request);
    let text = prompt_text(&prompt);
    let emphasis = crate::services::skill_deployer::build_skill_emphasis_prompt(
        &user_selected_skills(request),
    );
    if emphasis.is_empty() {
        text
    } else {
        format!("{emphasis}\n\n{text}")
    }
}

fn claude_content_block_stdin_query(request: &ExecutionRequest) -> Option<String> {
    let prompt = claude_prompt_value(request);
    prompt.as_array()?;
    let anthropic_content = convert_openai_to_anthropic_content(&prompt);
    let query = create_multimodal_query(&anthropic_content);
    query
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|value| !value.is_empty())
}

fn claude_prompt_value(request: &ExecutionRequest) -> Value {
    let mut prompt = kb_meta_prompt(request)
        .map(|kb_meta_prompt| {
            crate::prompt_enrichment::inject_kb_meta_prompt(
                &request.prompt,
                kb_meta_prompt,
                is_user_selected_kb(request),
                request.task_type.as_deref(),
            )
        })
        .unwrap_or_else(|| request.prompt.clone());
    let emphasis = crate::services::skill_deployer::build_skill_emphasis_prompt(
        &user_selected_skills(request),
    );
    if !emphasis.is_empty() && prompt.as_array().is_some() {
        prompt = append_text_to_vision_prompt(&prompt, &emphasis, true);
    }
    prompt
}

fn interactive_form_answer_query(request: &ExecutionRequest) -> Option<String> {
    let answer = request.extra.get("interactive_form_answer")?;
    build_interactive_form_answer_query(answer)
        .ok()
        .map(|query| query.to_string())
}

fn kb_meta_prompt(request: &ExecutionRequest) -> Option<&str> {
    request
        .extra
        .get("kb_meta_prompt")
        .or_else(|| request.extra.get("kbMetaPrompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_user_selected_kb(request: &ExecutionRequest) -> bool {
    request
        .extra
        .get("is_user_selected_kb")
        .or_else(|| request.extra.get("isUserSelectedKb"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn execution_system_prompt(request: &ExecutionRequest) -> Option<String> {
    let prompt = request.system_prompt.trim();
    if !prompt.is_empty() {
        return Some(prompt.to_owned());
    }

    primary_bot(request)
        .and_then(|bot| bot.get("system_prompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
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

fn apply_task_identity_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
) -> CommandSpec {
    if let Some(auth_token) = non_empty(request.auth_token.as_deref()) {
        spec = spec.env("AUTH_TOKEN", auth_token);
    }
    if let Some(token) = non_empty(request.skill_identity_token.as_deref()) {
        spec = spec.env("WEGENT_SKILL_IDENTITY_TOKEN", token);
    }
    if let Some(user_name) = non_empty(request.user_name.as_deref()) {
        spec = spec.env("WEGENT_SKILL_USER_NAME", user_name);
    }
    spec
}

fn apply_git_environment(mut spec: CommandSpec, request: &ExecutionRequest) -> CommandSpec {
    for (source_key, env_key) in [
        ("git_domain", "GIT_DOMAIN"),
        ("git_repo", "GIT_REPO"),
        ("git_repo_id", "GIT_REPO_ID"),
        ("branch_name", "BRANCH_NAME"),
    ] {
        if let Some(value) = extra_string(request, source_key) {
            spec = spec.env(env_key, value);
        }
    }
    if let Some(git_url) = request.git_url() {
        spec = spec.env("GIT_URL", git_url);
    }
    spec
}

fn apply_claude_header_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
) -> CommandSpec {
    let process_custom_headers = env::var("ANTHROPIC_CUSTOM_HEADERS").unwrap_or_default();
    let runtime_custom_headers = spec
        .envs()
        .get("ANTHROPIC_CUSTOM_HEADERS")
        .cloned()
        .unwrap_or_default();
    let mut custom_headers = merge_anthropic_custom_headers([
        process_custom_headers.as_str(),
        runtime_custom_headers.as_str(),
    ]);

    let mut default_headers = extract_default_headers(request);
    if let Some(project_id) = project_id(request) {
        default_headers = merge_missing_header_map(
            default_headers,
            vec![
                ("wecode-action".to_owned(), "wegent".to_owned()),
                ("wecode-source".to_owned(), "wegent-local".to_owned()),
                ("wecode-executor".to_owned(), "claudecode".to_owned()),
            ],
        );
        default_headers = merge_header_map(
            default_headers,
            vec![("wecode-project".to_owned(), project_id)],
        );
    }

    if !default_headers.is_empty() {
        let serialized_default_headers = serde_json::to_string(&headers_to_json(&default_headers))
            .expect("header map should serialize");
        spec = spec
            .env("DEFAULT_HEADERS", serialized_default_headers.clone())
            .env("default_headers", serialized_default_headers);
        custom_headers = merge_missing_header_map(custom_headers, default_headers);
    }

    if !custom_headers.is_empty() {
        spec = spec.env(
            "ANTHROPIC_CUSTOM_HEADERS",
            headers_to_anthropic_custom_headers(&custom_headers),
        );
    }

    spec
}

fn apply_claude_workspace_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
    task_dir: Option<&PathBuf>,
) -> CommandSpec {
    let Some(config_dir) = claude_config_dir(request, task_dir) else {
        return spec;
    };

    if !spec.envs().contains_key("CLAUDE_CONFIG_DIR") {
        spec = spec.env("CLAUDE_CONFIG_DIR", config_dir.display().to_string());
    }
    if !spec.envs().contains_key("SKILLS_DIR") {
        spec = spec.env(
            "SKILLS_DIR",
            config_dir.join("skills").display().to_string(),
        );
    }

    spec
}

pub(crate) fn claude_task_dir(request: &ExecutionRequest) -> Option<PathBuf> {
    request
        .cwd()
        .map(PathBuf::from)
        .or_else(|| claude_session::preferred_task_dir(request))
}

pub(crate) fn claude_config_dir(
    request: &ExecutionRequest,
    task_dir: Option<&PathBuf>,
) -> Option<PathBuf> {
    if project_id(request).is_some() {
        return Some(home_claude_dir());
    }
    task_dir.map(|task_dir| task_dir.join(".claude"))
}

fn user_selected_skills(request: &ExecutionRequest) -> Vec<String> {
    request
        .extra
        .get("user_selected_skills")
        .or_else(|| request.extra.get("userSelectedSkills"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn home_claude_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".claude")
}

fn project_id(request: &ExecutionRequest) -> Option<String> {
    let value = crate::local::capabilities::get_project_id(request);
    (!value.is_empty()).then_some(value)
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

fn primary_bot(request: &ExecutionRequest) -> Option<&Value> {
    match &request.bot {
        Value::Array(bots) => bots.first(),
        Value::Object(_) => Some(&request.bot),
        _ => None,
    }
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

type HeaderMap = Vec<(String, String)>;

fn extract_default_headers(request: &ExecutionRequest) -> HeaderMap {
    for key in ["DEFAULT_HEADERS", "default_headers"] {
        let Some(value) = model_env_value(request, key) else {
            continue;
        };
        let headers = parse_header_map(&value);
        if !headers.is_empty() {
            return headers;
        }
    }
    Vec::new()
}

fn model_env_value(request: &ExecutionRequest, key: &str) -> Option<Value> {
    let mut value = None;
    collect_bot_agent_env_value(&request.bot, key, &mut value);
    if let Some(candidate) = request.model_config.get(key) {
        value = Some(candidate.clone());
    }
    if let Some(candidate) = request.model_config.get("env").and_then(|env| env.get(key)) {
        value = Some(candidate.clone());
    }
    value
}

fn collect_bot_agent_env_value(bot: &Value, key: &str, value: &mut Option<Value>) {
    match bot {
        Value::Object(_) => collect_single_bot_agent_env_value(bot, key, value),
        Value::Array(bots) => {
            for bot in bots {
                collect_single_bot_agent_env_value(bot, key, value);
            }
        }
        _ => {}
    }
}

fn collect_single_bot_agent_env_value(bot: &Value, key: &str, value: &mut Option<Value>) {
    if let Some(candidate) = bot
        .get("agent_config")
        .and_then(|config| config.get("env"))
        .and_then(|env| env.get(key))
    {
        *value = Some(candidate.clone());
    }
}

fn parse_header_map(value: &Value) -> HeaderMap {
    match value {
        Value::Object(object) => parse_header_object(object),
        Value::String(text) => parse_header_text(text),
        _ => Vec::new(),
    }
}

fn parse_header_object(object: &Map<String, Value>) -> HeaderMap {
    object
        .iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            header_value_string(value).map(|value| (key.to_owned(), value))
        })
        .collect()
}

fn parse_header_text(text: &str) -> HeaderMap {
    let stripped = text.trim();
    if stripped.is_empty() {
        return Vec::new();
    }
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(stripped) {
        return parse_header_object(&object);
    }
    parse_header_lines(stripped)
}

fn parse_header_lines(text: &str) -> HeaderMap {
    text.lines()
        .filter_map(|line| {
            let stripped = line.trim();
            let (key, value) = stripped.split_once(':')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_owned(), value.trim().to_owned()))
        })
        .collect()
}

fn header_value_string(value: &Value) -> Option<String> {
    match value {
        Value::Null | Value::Array(_) | Value::Object(_) => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(_) | Value::Number(_) => Some(value.to_string()),
    }
}

fn merge_anthropic_custom_headers<'a>(header_sets: impl IntoIterator<Item = &'a str>) -> HeaderMap {
    header_sets
        .into_iter()
        .filter(|headers| !headers.trim().is_empty())
        .fold(Vec::new(), |merged, headers| {
            merge_header_map(merged, parse_header_text(headers))
        })
}

fn merge_header_map(mut existing: HeaderMap, new_headers: HeaderMap) -> HeaderMap {
    for (key, value) in new_headers {
        existing.retain(|(existing_key, _)| !headers_match(existing_key, &key));
        existing.push((key, value));
    }
    existing
}

fn merge_missing_header_map(mut existing: HeaderMap, default_headers: HeaderMap) -> HeaderMap {
    for (key, value) in default_headers {
        if existing
            .iter()
            .any(|(existing_key, _)| headers_match(existing_key, &key))
        {
            continue;
        }
        existing.push((key, value));
    }
    existing
}

fn headers_match(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn headers_to_json(headers: &HeaderMap) -> Value {
    let mut object = Map::new();
    for (key, value) in headers {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(object)
}

fn headers_to_anthropic_custom_headers(headers: &HeaderMap) -> String {
    headers
        .iter()
        .map(|(key, value)| format!("{key}: {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn extra_string(request: &ExecutionRequest, key: &str) -> Option<String> {
    request
        .extra
        .get(key)
        .and_then(Value::as_str)
        .and_then(|value| non_empty(Some(value)))
        .map(ToOwned::to_owned)
}
