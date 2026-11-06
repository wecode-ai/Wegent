// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::{json, Map, Value};

use crate::{
    agent_session,
    attachments::{
        append_text_to_vision_prompt, convert_openai_to_anthropic_content, create_multimodal_query,
    },
    hooks::pre_execute::{PreExecuteContext, PreExecuteHook},
    interactive_mcp::build_interactive_form_answer_query,
    local::capabilities::restore_enabled_claude_plugin_cache,
    logging::{log_executor_event, task_fields},
    process::CommandSpec,
    protocol::ExecutionRequest,
};

/// Trusted launch inputs supplied by the application before command planning.
pub struct ClaudeLaunchContext<'a> {
    pub task_identity_environment: BTreeMap<String, String>,
    pub artifact_instructions: &'a str,
    pub control_instructions: Option<&'a str>,
}

const FILE_EDIT_HOOK_COMMAND_ENV: &str = "WEGENT_FILE_EDIT_HOOK_COMMAND";
const CLAUDE_FILE_EDIT_HOOK_MATCHER: &str = "Write|Edit|MultiEdit|NotebookEdit";
const CLAUDE_MAX_CONTEXT_TOKENS_ENV: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
const CLAUDE_AUTO_COMPACT_WINDOW_ENV: &str = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const CLAUDE_MAX_OUTPUT_TOKENS_ENV: &str = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
const CLAUDE_MODEL_ENV: &str = "ANTHROPIC_MODEL";
const LONG_CONTEXT_MODEL_SUFFIXES: [&str; 2] = ["[1m]", "+1m"];
const DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS: u64 = 96_000;
const LONG_CONTEXT_MODEL_WINDOW: u64 = 1_000_000;
const LONG_CONTEXT_AUTO_COMPACT_WINDOW: u64 = 800_000;
/// Input cap of the upstream Anthropic-compatible route; keep the auto-compact
/// window below it so a compacted request still leaves room for its output.
const UPSTREAM_CONTEXT_HARD_CAP: u64 = 1_048_568;
const DEFAULT_CLAUDE_MODEL_ENV: &[&str] = &[
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
];
const DEFAULT_CLAUDE_SETTINGS_ENV: &[&str] = &[
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
    "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
    "ENABLE_TOOL_SEARCH",
];

pub fn build_claude_command(
    request: &ExecutionRequest,
    binary: &str,
    launch: &ClaudeLaunchContext<'_>,
) -> CommandSpec {
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
        let prompt = claude_prompt_text(request);
        spec = spec.arg("--input-format").arg("stream-json").stdin(format!(
            "{}\n",
            json!({
                "type": "user",
                "session_id": "",
                "message": {
                    "role": "user",
                    "content": prompt
                },
                "parent_tool_use_id": null
            })
        ));
    }

    let mut spec = spec
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--disallowedTools")
        .arg("EnterWorktree")
        .arg("--permission-mode")
        .arg(claude_permission_mode(request));

    if let Some(system_prompt) = execution_system_prompt(request, launch) {
        spec = spec.arg("--append-system-prompt").arg(system_prompt);
    }

    let model_id = model_id(request);
    let context_budget = claude_context_budget(request, model_id.as_deref());
    if let Some(model) = context_budget
        .as_ref()
        .and_then(|budget| budget.model_alias.as_deref())
        .or(model_id.as_deref())
    {
        spec = spec.arg("--model").arg(model);
    }

    if let Some(session_id) = agent_session::load_saved_session_id(request) {
        spec = spec.arg("--resume").arg(session_id);
    }

    spec = apply_model_environment(spec, request, context_budget.as_ref());
    spec = apply_task_identity_environment(spec, launch);
    spec = apply_git_environment(spec, request);
    spec = apply_claude_header_environment(spec, request);

    let task_dir = claude_task_dir(request);
    spec = apply_claude_workspace_environment(spec, request, task_dir.as_ref());
    if let Some(task_dir) = task_dir {
        spec = spec.cwd(task_dir);
    }

    spec
}

fn claude_permission_mode(request: &ExecutionRequest) -> &str {
    match request
        .extra
        .get("claude_permission_mode")
        .and_then(Value::as_str)
    {
        Some(mode @ ("acceptEdits" | "plan" | "auto" | "bypassPermissions")) => mode,
        Some("default") | Some(_) | None => "bypassPermissions",
    }
}

pub fn prompt_text(prompt: &Value) -> String {
    match prompt {
        Value::String(value) => value.clone(),
        value => value.to_string(),
    }
}

fn claude_prompt_text(request: &ExecutionRequest) -> String {
    let prompt = claude_prompt_value(request);
    let text = prompt_text(&prompt);
    let emphasis = wegent_plugin_packages::services::skill_deployer::build_skill_emphasis_prompt(
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
    if let Some(selected_knowledge_prompt) = selected_knowledge_prompt(request) {
        prompt = crate::prompt_enrichment::inject_selected_knowledge_prompt(
            &prompt,
            selected_knowledge_prompt,
        );
    }
    let emphasis = wegent_plugin_packages::services::skill_deployer::build_skill_emphasis_prompt(
        &user_selected_skills(request),
    );
    if !emphasis.is_empty() && prompt.as_array().is_some() {
        prompt = append_text_to_vision_prompt(&prompt, &emphasis, true);
    }
    prompt
}

fn selected_knowledge_prompt(request: &ExecutionRequest) -> Option<&str> {
    request
        .extra
        .get("selected_knowledge_prompt")
        .or_else(|| request.extra.get("selectedKnowledgePrompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
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

pub fn execution_system_prompt(
    request: &ExecutionRequest,
    launch: &ClaudeLaunchContext<'_>,
) -> Option<String> {
    let prompt = request.system_prompt.trim();
    let base_prompt = if !prompt.is_empty() {
        Some(prompt)
    } else {
        primary_bot(request)
            .and_then(|bot| bot.get("system_prompt"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if request.extra.get("enable_tools").and_then(Value::as_bool) == Some(false) {
        return base_prompt.map(ToOwned::to_owned);
    }
    Some(
        [
            base_prompt,
            Some(launch.artifact_instructions),
            launch.control_instructions,
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n"),
    )
}

pub fn model_id(request: &ExecutionRequest) -> Option<String> {
    model_string(request, "model_id")
}

fn apply_task_identity_environment(
    mut spec: CommandSpec,
    launch: &ClaudeLaunchContext<'_>,
) -> CommandSpec {
    for (key, value) in &launch.task_identity_environment {
        spec = spec.env(key, value);
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

    let mut default_headers = merge_missing_header_map(
        extract_default_headers(request),
        vec![
            ("wecode-action".to_owned(), "wegent".to_owned()),
            ("wecode-source".to_owned(), "wegent-local".to_owned()),
            ("wecode-executor".to_owned(), "claudecode".to_owned()),
        ],
    );
    // Attach the session (task) id so providers can correlate model usage.
    let task_id = request.task_id.trim();
    if !task_id.is_empty() {
        // The request's task id is authoritative; replace any stale value.
        default_headers.retain(|(key, _)| !headers_match(key, "wecode-session-id"));
        default_headers.push(("wecode-session-id".to_owned(), task_id.to_owned()));
    }
    // Cloud model routes carry the gateway identity header; only then should the
    // gateway-forwarded session header be forced into custom headers below.
    let targets_gateway = default_headers
        .iter()
        .chain(custom_headers.iter())
        .any(|(key, _)| headers_match(key, "X-Wegent-Model-Type"));
    if let Some(project_id) = project_id(request) {
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

    // The merge above preserves any wecode-session-id already present in
    // ANTHROPIC_CUSTOM_HEADERS; replace it with the request's task id.
    if !task_id.is_empty() {
        custom_headers.retain(|(key, _)| !headers_match(key, "wecode-session-id"));
        custom_headers.push(("wecode-session-id".to_owned(), task_id.to_owned()));
        if targets_gateway {
            // Cloud routes additionally carry the gateway-forwarded variant;
            // it must also win over any configured custom value.
            custom_headers.retain(|(key, _)| {
                !headers_match(key, "X-Wegent-Upstream-Header-wecode-session-id")
            });
            custom_headers.push((
                "X-Wegent-Upstream-Header-wecode-session-id".to_owned(),
                task_id.to_owned(),
            ));
        }
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

    let isolated = wegent_native_home::instance_home::request_home(request).is_some();
    if isolated || !spec.envs().contains_key("CLAUDE_CONFIG_DIR") {
        spec = spec.env("CLAUDE_CONFIG_DIR", config_dir.display().to_string());
    }
    if isolated || !spec.envs().contains_key("SKILLS_DIR") {
        let skills_dir = claude_skills_dir(request, &config_dir, task_dir);
        spec = spec.env("SKILLS_DIR", skills_dir.display().to_string());
    }

    spec
}

pub fn claude_task_dir(request: &ExecutionRequest) -> Option<PathBuf> {
    request
        .cwd()
        .map(PathBuf::from)
        .or_else(|| agent_session::preferred_task_dir(request))
}

pub fn claude_config_dir(
    request: &ExecutionRequest,
    _task_dir: Option<&PathBuf>,
) -> Option<PathBuf> {
    wegent_native_home::instance_home::request_home(request).or_else(|| {
        Some(
            std::env::var_os("WEGENT_CLAUDE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(home_claude_dir),
        )
    })
}

fn claude_skills_dir(
    request: &ExecutionRequest,
    config_dir: &Path,
    task_dir: Option<&PathBuf>,
) -> PathBuf {
    if wegent_native_home::instance_home::request_home(request).is_some() {
        return config_dir.join("skills");
    }
    if has_task_skill_names(request) {
        if let Some(task_dir) = task_dir {
            return task_dir.join(".claude/skills");
        }
    }
    config_dir.join("skills")
}

pub fn has_task_skill_names(request: &ExecutionRequest) -> bool {
    primary_bot(request).is_some_and(|bot| {
        !wegent_plugin_packages::services::skill_deployer::collect_skill_names_for_deployment(
            bot, request,
        )
        .is_empty()
    })
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
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".claude")
}

fn project_id(request: &ExecutionRequest) -> Option<String> {
    let value = wegent_plugin_packages::local::capabilities::get_project_id(request);
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

mod model_environment;
use model_environment::*;
mod settings;
pub use settings::{
    configure_claude_default_settings, configure_claude_file_edit_hooks,
    restore_claude_plugin_cache, run_pre_execute_hook,
};
