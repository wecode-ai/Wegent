// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use futures_util::{stream, StreamExt};
use serde_json::{json, Map, Value};

use crate::{
    agents::{
        interactive_mcp::build_interactive_form_answer_query, task_identity::task_identity_env,
    },
    attachments::{
        append_text_to_vision_prompt, convert_openai_to_anthropic_content, create_multimodal_query,
    },
    claude_session,
    hooks::pre_execute::{PreExecuteContext, PreExecuteHook},
    local::{
        backend::HttpPackageProvider,
        capabilities::{
            restore_enabled_claude_plugin_cache, CapabilityPackageProvider, SkillSyncSpec,
        },
    },
    logging::{log_executor_event, push_error_fields, task_fields},
    process::CommandSpec,
    protocol::ExecutionRequest,
    services::skill_deployer::{build_skill_deployment_plan, SkillDeploymentOptions},
};

const FILE_EDIT_HOOK_COMMAND_ENV: &str = "WEGENT_FILE_EDIT_HOOK_COMMAND";
const CLAUDE_FILE_EDIT_HOOK_MATCHER: &str = "Write|Edit|MultiEdit|NotebookEdit";
const CLAUDE_TASK_SKILL_DOWNLOAD_CONCURRENCY: usize = 4;
const SKILL_MANIFEST_FILE: &str = ".wegent-skills.json";
const DEFAULT_HAIKU_MODEL_ENV: &str = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
const DEFAULT_CLAUDE_SETTINGS_ENV: &[&str] = &[
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
    "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
    "ENABLE_TOOL_SEARCH",
];

pub(super) fn restore_claude_plugin_cache(request: &ExecutionRequest, spec: &CommandSpec) {
    let Some(config_dir) = spec
        .envs()
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return;
    };

    let mut fields = task_fields(request.task_id, request.subtask_id);
    fields.push(("config_dir", config_dir.display().to_string()));
    match restore_enabled_claude_plugin_cache(&config_dir) {
        Ok(restored) if !restored.is_empty() => {
            fields.push(("restored_count", restored.len().to_string()));
            log_executor_event("claude plugin cache restored", &fields);
        }
        Ok(_) => {}
        Err(error) => {
            fields.push(("error_len", error.to_string().len().to_string()));
            log_executor_event("claude plugin cache restore failed", &fields);
        }
    }
}

pub(super) fn configure_claude_file_edit_hooks(request: &ExecutionRequest, spec: &CommandSpec) {
    let Some(command) = env::var(FILE_EDIT_HOOK_COMMAND_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(config_dir) = spec
        .envs()
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    let settings_path = PathBuf::from(config_dir).join("settings.json");
    let mut fields = task_fields(request.task_id, request.subtask_id);
    fields.push(("settings", settings_path.display().to_string()));

    match write_claude_file_edit_hook_settings(&settings_path, &command) {
        Ok(()) => log_executor_event("claude file edit hooks configured", &fields),
        Err(error) => {
            fields.push(("error_len", error.len().to_string()));
            log_executor_event("claude file edit hooks failed", &fields);
        }
    }
}

pub(super) fn configure_claude_default_settings(request: &ExecutionRequest, spec: &CommandSpec) {
    let Some(config_dir) = spec
        .envs()
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    let settings_path = PathBuf::from(config_dir).join("settings.json");
    let fields = task_fields(request.task_id, request.subtask_id);

    match write_claude_default_settings(&settings_path) {
        Ok(()) => log_executor_event("claude default settings configured", &fields),
        Err(error) => {
            let mut failed_fields = fields;
            failed_fields.push(("error_len", error.len().to_string()));
            log_executor_event("claude default settings failed", &failed_fields);
        }
    }
}

fn write_claude_default_settings(settings_path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut settings = read_claude_settings(settings_path);
    let Some(settings_object) = settings.as_object_mut() else {
        return Err("Claude settings root must be an object".to_owned());
    };
    settings_object.insert("includeCoAuthoredBy".to_owned(), Value::Bool(true));
    settings_object.insert(
        "skipDangerousModePermissionPrompt".to_owned(),
        Value::Bool(false),
    );

    let env = object_field(&mut settings, "env");
    for key in DEFAULT_CLAUDE_SETTINGS_ENV {
        env.insert(
            (*key).to_owned(),
            Value::String(claude_settings_env_value(key)),
        );
    }

    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path, format!("{content}\n")).map_err(|error| error.to_string())
}

fn claude_settings_env_value(key: &str) -> String {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_claude_settings_env_value(key).to_owned())
}

fn default_claude_settings_env_value(key: &str) -> &'static str {
    match key {
        "ENABLE_TOOL_SEARCH" => "true",
        _ => "0",
    }
}

fn write_claude_file_edit_hook_settings(
    settings_path: &PathBuf,
    command: &str,
) -> Result<(), String> {
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut settings = read_claude_settings(settings_path);
    let hooks = object_field(&mut settings, "hooks");
    ensure_file_edit_hook(hooks, "PreToolUse", command);
    ensure_file_edit_hook(hooks, "PostToolUse", command);

    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path, format!("{content}\n")).map_err(|error| error.to_string())
}

fn read_claude_settings(settings_path: &PathBuf) -> Value {
    fs::read_to_string(settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn object_field<'a>(parent: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !parent.is_object() {
        *parent = Value::Object(Map::new());
    }
    let object = parent.as_object_mut().expect("parent object initialized");
    let value = object
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("child object initialized")
}

fn ensure_file_edit_hook(hooks: &mut Map<String, Value>, event: &str, command: &str) {
    let value = hooks
        .entry(event.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !value.is_array() {
        *value = Value::Array(Vec::new());
    }
    let groups = value.as_array_mut().expect("event hooks initialized");
    groups.retain(|group| !file_edit_hook_group_matches(group));
    groups.push(json!({
        "matcher": CLAUDE_FILE_EDIT_HOOK_MATCHER,
        "hooks": [
            {
                "type": "command",
                "command": command
            }
        ]
    }));
}

fn file_edit_hook_group_matches(group: &Value) -> bool {
    group
        .get("matcher")
        .and_then(Value::as_str)
        .is_some_and(|matcher| matcher == CLAUDE_FILE_EDIT_HOOK_MATCHER)
        || group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| hooks.iter().any(is_wegent_file_edit_hook))
}

fn is_wegent_file_edit_hook(hook: &Value) -> bool {
    hook.get("type").and_then(Value::as_str) == Some("command")
        && hook
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains("/api/file-edit-log"))
}

pub(super) async fn run_pre_execute_hook(request: &ExecutionRequest, spec: &CommandSpec) {
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

    spec = apply_default_haiku_model_environment(spec, request);

    spec
}

fn apply_default_haiku_model_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
) -> CommandSpec {
    if spec.envs().contains_key(DEFAULT_HAIKU_MODEL_ENV) {
        return spec;
    }

    let value = model_string(request, DEFAULT_HAIKU_MODEL_ENV)
        .or_else(process_default_haiku_model)
        .or_else(|| model_id(request));

    if let Some(value) = value {
        spec = spec.env(DEFAULT_HAIKU_MODEL_ENV, value);
    }

    spec
}

fn process_default_haiku_model() -> Option<String> {
    env::var(DEFAULT_HAIKU_MODEL_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn apply_task_identity_environment(
    mut spec: CommandSpec,
    request: &ExecutionRequest,
) -> CommandSpec {
    for (key, value) in task_identity_env(request) {
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
        let skills_dir = claude_skills_dir(request, &config_dir, task_dir);
        spec = spec.env("SKILLS_DIR", skills_dir.display().to_string());
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
    _request: &ExecutionRequest,
    _task_dir: Option<&PathBuf>,
) -> Option<PathBuf> {
    Some(home_claude_dir())
}

fn claude_skills_dir(
    request: &ExecutionRequest,
    config_dir: &Path,
    task_dir: Option<&PathBuf>,
) -> PathBuf {
    if is_standalone_project_zero(request) && has_task_skill_names(request) {
        if let Some(task_dir) = task_dir {
            return task_dir.join(".claude/skills");
        }
    }
    config_dir.join("skills")
}

fn is_standalone_project_zero(request: &ExecutionRequest) -> bool {
    let standalone = request
        .extra
        .get("standalone_chat_workspace")
        .or_else(|| request.extra.get("standaloneChatWorkspace"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    standalone && project_id(request).as_deref() == Some("0")
}

fn has_task_skill_names(request: &ExecutionRequest) -> bool {
    primary_bot(request).is_some_and(|bot| {
        !crate::services::skill_deployer::collect_skill_names_for_deployment(bot, request)
            .is_empty()
    })
}

pub(super) async fn deploy_claude_task_skills(request: &ExecutionRequest, spec: &CommandSpec) {
    if !has_task_skill_names(request) {
        return;
    }
    let Some(skills_dir) = spec.envs().get("SKILLS_DIR").map(PathBuf::from) else {
        return;
    };
    let Some(bot_config) = primary_bot(request) else {
        return;
    };
    let Some(plan) = build_skill_deployment_plan(
        bot_config,
        request,
        SkillDeploymentOptions {
            skills_dir,
            clear_cache: false,
            skip_existing: false,
        },
    ) else {
        return;
    };
    let Some(backend_url) = task_backend_url(request) else {
        return;
    };

    let provider = HttpPackageProvider::new(backend_url, plan.auth_token.clone());
    stream::iter(plan.skills.iter().cloned())
        .map(|skill_name| {
            let provider = provider.clone();
            let plan = &plan;
            async move {
                let Some(skill_ref) = plan.resolved_skill_map.get(&skill_name) else {
                    return;
                };
                let target = plan.skills_dir.join(&skill_name);
                let Some(cache_miss_reason) =
                    claude_task_skill_cache_miss_reason(&target, skill_ref)
                else {
                    return;
                };
                let mut fields = task_fields(request.task_id, request.subtask_id);
                fields.push(("skill", skill_name.clone()));
                fields.push(("target", target.display().to_string()));
                fields.push(("reason", cache_miss_reason));
                fields.push(("skill_id", skill_ref.skill_id.to_string()));
                fields.push(("namespace", skill_ref.namespace.clone()));
                fields.push((
                    "content_hash",
                    skill_ref.content_hash.clone().unwrap_or_default(),
                ));
                log_executor_event("claude task skill cache miss", &fields);
                let spec = SkillSyncSpec {
                    name: skill_name.clone(),
                    skill_id: skill_ref.skill_id,
                    namespace: skill_ref.namespace.clone(),
                    is_public: skill_ref.is_public,
                    content_hash: skill_ref.content_hash.clone(),
                };
                match provider.stage_skill(&spec, &target).await {
                    Ok(()) => {
                        let _ = write_claude_task_skill_marker(&target, skill_ref);
                        log_executor_event("claude task skill deployed", &fields)
                    }
                    Err(error) => {
                        push_error_fields(&mut fields, error);
                        log_executor_event("claude task skill deployment failed", &fields);
                    }
                }
            }
        })
        .buffer_unordered(CLAUDE_TASK_SKILL_DOWNLOAD_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
}

fn claude_task_skill_cache_miss_reason(
    target: &Path,
    skill_ref: &crate::services::skill_deployer::SkillRef,
) -> Option<String> {
    if !target.join("SKILL.md").is_file() {
        return Some("missing_skill_file".to_owned());
    }
    let manifest_status = claude_task_skill_manifest_cache_status(target, skill_ref);
    if manifest_status.is_ok() {
        return None;
    }
    let marker_status = claude_task_skill_marker_cache_status(target, skill_ref);
    if marker_status.is_ok() {
        return None;
    }
    Some(format!(
        "manifest={};marker={}",
        manifest_status.unwrap_err(),
        marker_status.unwrap_err()
    ))
}

fn claude_task_skill_manifest_cache_status(
    target: &Path,
    skill_ref: &crate::services::skill_deployer::SkillRef,
) -> Result<(), String> {
    let Some(skill_name) = target.file_name().and_then(|value| value.to_str()) else {
        return Err("invalid_target".to_owned());
    };
    let Some(skills_dir) = target.parent() else {
        return Err("missing_skills_dir".to_owned());
    };
    let path = skills_dir.join(SKILL_MANIFEST_FILE);
    let value = read_json_value(&path)?;
    let Some(record) = value.get(skill_name) else {
        return Err("record_missing".to_owned());
    };
    claude_task_skill_record_cache_status(record, skill_ref)
}

fn claude_task_skill_marker_cache_status(
    target: &Path,
    skill_ref: &crate::services::skill_deployer::SkillRef,
) -> Result<(), String> {
    let value = read_json_value(&target.join(".wegent-skill.json"))?;
    claude_task_skill_record_cache_status(&value, skill_ref)
}

fn read_json_value(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("read_failed({error})"))?;
    serde_json::from_str::<Value>(&content).map_err(|error| format!("parse_failed({error})"))
}

fn claude_task_skill_record_cache_status(
    record: &Value,
    skill_ref: &crate::services::skill_deployer::SkillRef,
) -> Result<(), String> {
    if is_claude_task_skill_record_current(record, skill_ref) {
        Ok(())
    } else {
        Err(format!("record_mismatch({})", skill_record_summary(record)))
    }
}

fn is_claude_task_skill_record_current(
    record: &Value,
    skill_ref: &crate::services::skill_deployer::SkillRef,
) -> bool {
    if record.get("skill_id").and_then(Value::as_i64) != Some(skill_ref.skill_id)
        || record.get("namespace").and_then(Value::as_str) != Some(skill_ref.namespace.as_str())
    {
        return false;
    }
    match skill_ref.content_hash.as_deref() {
        Some(content_hash) => {
            record.get("content_hash").and_then(Value::as_str) == Some(content_hash)
        }
        None => true,
    }
}

fn skill_record_summary(record: &Value) -> String {
    format!(
        "skill_id={},namespace={},content_hash={}",
        record
            .get("skill_id")
            .and_then(Value::as_i64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "<missing>".to_owned()),
        record
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("<missing>"),
        record
            .get("content_hash")
            .and_then(Value::as_str)
            .unwrap_or("<missing>")
    )
}

fn write_claude_task_skill_marker(
    target: &Path,
    skill_ref: &crate::services::skill_deployer::SkillRef,
) -> std::io::Result<()> {
    let marker = json!({
        "skill_id": skill_ref.skill_id,
        "namespace": &skill_ref.namespace,
        "content_hash": skill_ref.content_hash,
    });
    fs::write(
        target.join(".wegent-skill.json"),
        serde_json::to_vec_pretty(&marker)?,
    )
}

fn task_backend_url(_request: &ExecutionRequest) -> Option<String> {
    env::var("WEGENT_BACKEND_URL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("TASK_API_DOMAIN")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        key: &'static str,
        old_value: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old_value = env::var(key).ok();
            env::set_var(key, value);
            Self { key, old_value }
        }

        fn remove(key: &'static str) -> Self {
            let old_value = env::var(key).ok();
            env::remove_var(key);
            Self { key, old_value }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old_value {
                env::set_var(self.key, value);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn task_backend_url_falls_back_to_task_api_domain() {
        let _lock = crate::test_env::lock();
        let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
        let _task_api = EnvGuard::set("TASK_API_DOMAIN", "http://backend.local:8000");

        let request = ExecutionRequest::default();

        assert_eq!(
            task_backend_url(&request),
            Some("http://backend.local:8000".to_owned())
        );
    }

    #[test]
    fn task_backend_url_prefers_env_over_payload_backend_url() {
        let _lock = crate::test_env::lock();
        let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
        let _task_api = EnvGuard::set("TASK_API_DOMAIN", "http://env-backend.local:8000");

        let request = ExecutionRequest {
            backend_url: Some("http://payload-backend.invalid".to_owned()),
            ..ExecutionRequest::default()
        };

        assert_eq!(
            task_backend_url(&request),
            Some("http://env-backend.local:8000".to_owned())
        );
    }
}
