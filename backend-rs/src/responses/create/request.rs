// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `build_execution_request` for the create flow
//! (`app/services/chat/trigger/unified.py:build_execution_request` ->
//! `request_preparation.py:prepare_execution_request` ->
//! `execution/request_builder.py:TaskRequestBuilder.build`).
//!
//! The OpenAPI `POST /api/v1/responses` path builds the request with no chat
//! payload, so `web_runtime_guidance` is false, no model-options override is
//! read, and a task-level model override only appears when `setup_chat_session`
//! stored it as `labels.modelId` / `labels.forceOverrideBotModel`.
//!
//! This module assembles the [`ExecutionRequest`] from the CRDs and the
//! already-resolved session, composing the staged helpers rather than
//! reimplementing them.
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::llm_proxy::CredentialRequest;
use crate::state::AppState;

use super::bot_config::{
    BotConfigInput, backend_url, build_bot_config, build_user_metadata, build_workspace, git_fields,
};
use super::contexts;
use super::dispatch::ExecutionRequest;
use super::ghost::{GhostNode, collaboration_model, load_ghost_chain, merge_ghost_capabilities};
use super::knowledge_resolution::{ResolvedKnowledge, resolve_knowledge};
use super::mcp_servers::{
    ghost_mcp_servers, load_system_mcp_servers, merge_mcp_servers, request_mcp_servers,
};
use super::model_config::{
    build_agent_config, extract_model_config, inline_agent_config_ready,
    process_model_config_placeholders,
};
use super::preflight;
use super::resolution::{
    KindRow, ModelResolutionError, flat_model_config_error, resolve_model_for_bot_with_override,
    resolve_model_name,
};
use super::shell::{resolve_shell, shell_info};
use super::skill_generation;
use super::skills::{BotSkills, SkillAccess, SkillBindingContext, get_bot_skills};
use super::tokens::{create_skill_identity_token, create_task_token};

#[path = "request_coordinate.rs"]
mod coordinate;

/// The inputs the create flow has after the session setup and team resolution.
pub struct BuildExecutionRequestInput<'a> {
    pub user_id: i64,
    pub user_name: &'a str,
    /// The request user's `users.git_info` (the reloaded ORM row the source
    /// hands to `_build_user_info`). The create path classifies it into the
    /// Git identity and `git_auth_transport`.
    pub user_git_info: &'a Value,
    /// The request user's `users.preferences` (`NOT NULL`, default `"{}"`),
    /// read by `_build_skill_data`'s user-managed provider branch. Every
    /// build path resolves the request `User` row before dispatch (the create
    /// flow and each native job builder), so a loaded row always supplies its
    /// stored document; `None` remains only for a caller without a user row.
    pub user_preferences: Option<&'a str>,
    pub task_id: i64,
    pub assistant_subtask_id: i64,
    pub user_subtask_id: i64,
    pub team: &'a KindRow,
    /// The first team-member bot (the recorded create cases have one member).
    pub bot: &'a KindRow,
    pub bot_role: &'a str,
    /// The team member's `prompt` when set.
    pub team_member_prompt: Option<&'a str>,
    /// The assistant subtask's `bot_ids` (`_get_bot_for_subtask`'s input; the
    /// create flow writes the team's bot ids onto the pair it inserts).
    pub bot_ids: &'a [i64],
    pub message: &'a str,
    /// The API `reasoning` selection (`ReasoningConfig`).
    pub reasoning: Option<&'a super::reasoning::ReasoningConfig>,
    pub enable_tools: bool,
    pub enable_web_search: bool,
    pub enable_deep_thinking: bool,
    /// The rewritten Task CRD JSON (override labels and KB refs).
    pub task_json: &'a Value,
    /// The request-scoped id (`get_request_id()`).
    pub request_id: &'a str,
    pub message_id: i64,
    pub is_group_chat: bool,
    /// The Task row's `project_id` (`_merge_project_workspace`); `0` when the
    /// Task carries none.
    pub task_project_id: i64,
    /// The assistant subtask row's `executor_name` / `executor_namespace`.
    pub executor_name: &'a str,
    pub executor_namespace: &'a str,
    /// `subtask.executor_deleted_at`: the create flow inserts a fresh
    /// assistant subtask, so its value is always false there.
    pub executor_deleted: bool,
    /// `TaskRequestBuilder.build`'s `new_session` argument; the create and
    /// background builders use the source default.
    pub new_session: bool,
    /// `build_execution_request(knowledge_base_refs=...)`: this request's
    /// normalized knowledge-base refs (`_get_current_knowledge_base_refs`).
    pub knowledge_base_refs: &'a [super::schema::KbToolRef],
    /// `build_execution_request(knowledge_base_names=...)`: the legacy
    /// name-only fallback used only when `knowledge_base_refs` is empty.
    pub knowledge_base_names: &'a [super::schema::KbToolRef],
    /// `web_runtime_guidance` (`request_preparation.py:751-755`): the
    /// `/chat` entry point sets it when the payload's `client_origin` is the
    /// frontend; the OpenAPI path passes `false`.
    pub web_runtime_guidance: bool,
    /// Whether the caller already performed `_get_bot_for_subtask` for this
    /// request. Source resolves that Bot once inside `TaskRequestBuilder.build`
    /// and reuses the row for the team-member lookup; a caller that resolved
    /// the same first-`bot_ids` Bot itself (the `/chat` trigger) sets this so
    /// the builder reuses [`Self::bot`] instead of issuing a second identical
    /// `kinds` read.
    pub subtask_bot_resolved: bool,
}

/// `WEB_RUNTIME_GUIDANCE_MARKER` / `WEB_RUNTIME_GUIDANCE_CLOSE`
/// (`request_builder.py:71-72`).
const WEB_RUNTIME_GUIDANCE_MARKER: &str = "<wegent_runtime_guidance>";
const WEB_RUNTIME_GUIDANCE_CLOSE: &str = "</wegent_runtime_guidance>";

/// `_append_web_runtime_guidance` (`request_builder.py:1023-1082`): inject the
/// Wegent web UI runtime guidance into the system prompt.
async fn with_web_runtime_guidance(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    shell_type: &str,
    workspace: &Value,
    system_prompt: String,
) -> String {
    if system_prompt.contains(WEB_RUNTIME_GUIDANCE_MARKER) {
        return system_prompt;
    }
    let project_workspace = workspace.get("project").cloned().unwrap_or(Value::Null);
    // `_extract_task_device_id(task) or project_workspace.get("device_id")`.
    let task_device_id = input
        .task_json
        .pointer("/spec/device_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            project_workspace
                .get("device_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
    let device_type = match task_device_id.as_deref() {
        Some(device_id) => web_runtime_device_type(state, input.user_id, device_id).await,
        None => None,
    };
    let workspace_source = project_workspace
        .get("workspace_source")
        .and_then(Value::as_str);
    let workspace_path = project_workspace
        .get("project_workspace_path")
        .and_then(Value::as_str);
    let execution_target_type = project_workspace
        .get("execution_target_type")
        .and_then(Value::as_str);
    web_runtime_guidance_text(
        shell_type,
        device_type.as_deref(),
        task_device_id.is_some(),
        execution_target_type,
        workspace_source,
        workspace_path,
        &system_prompt,
    )
}

/// The pure half of `_append_web_runtime_guidance`: the guidance block and its
/// placement after the trimmed base prompt.
fn web_runtime_guidance_text(
    shell_type: &str,
    device_type: Option<&str>,
    has_device_id: bool,
    execution_target_type: Option<&str>,
    workspace_source: Option<&str>,
    workspace_path: Option<&str>,
    system_prompt: &str,
) -> String {
    if system_prompt.contains(WEB_RUNTIME_GUIDANCE_MARKER) {
        return system_prompt.to_string();
    }
    let environment = web_runtime_environment(
        shell_type,
        device_type,
        has_device_id,
        execution_target_type,
    );
    let mut workspace_details = Vec::new();
    if let Some(source) = workspace_source {
        workspace_details.push(format!("- workspace source: {source}"));
    }
    if let Some(path) = workspace_path {
        workspace_details.push(format!("- workspace path: {path}"));
    }
    let mut lines = vec![
        WEB_RUNTIME_GUIDANCE_MARKER.to_string(),
        "This request was started from the Wegent web UI.".to_string(),
        "Runtime environment:".to_string(),
        format!("- You are running in: {environment}."),
    ];
    lines.extend(workspace_details);
    lines.extend(
        [
            "",
            "User-facing file access:",
            "- Do not assume the user can access local paths, container paths, \
             terminal sessions, or files you create directly.",
            "- For final user-facing deliverables, follow the runtime-provided \
             artifact declaration or file-delivery instructions before your final \
             response. Writing a file alone does not publish an artifact card.",
            "- After successful delivery, mention the filename and direct the user \
             to its artifact card in the conversation to preview or download it. \
             Do not claim a downloadable artifact is available if delivery failed \
             or was not performed.",
            "- Use \"View the task files\" / \"查看任务文件\" only for browsing workspace \
             files, such as source code or intermediate files, not as a substitute \
             for delivering final user-facing files.",
            "- Keep paths in your answer as useful context when relevant, but do \
             not present a runtime path as the only way for the user to get a file.",
            "",
            "Interaction rules:",
            "- Match Wegent's web interaction model instead of giving generic \
             sandbox or local-terminal instructions.",
            "- If the task runs on a selected device, remember that generated \
             files remain on that device; the artifact card provides access after \
             successful declaration, without uploading file contents to Backend.",
            WEB_RUNTIME_GUIDANCE_CLOSE,
        ]
        .map(str::to_string),
    );
    let guidance = lines.join("\n");
    let base_prompt = system_prompt.trim_end();
    if base_prompt.is_empty() {
        guidance
    } else {
        format!("{base_prompt}\n\n{guidance}")
    }
}

/// `_describe_web_runtime_environment` (`request_builder.py:1084-1116`).
fn web_runtime_environment(
    shell_type: &str,
    device_type: Option<&str>,
    has_device_id: bool,
    execution_target_type: Option<&str>,
) -> &'static str {
    if has_device_id {
        return match device_type {
            Some("local" | "app") => "local device selected in Wegent",
            Some("cloud") => "cloud device or remote sandbox selected in Wegent",
            _ => "selected Wegent device",
        };
    }
    match execution_target_type {
        Some("cloud") => return "Wegent-managed cloud sandbox",
        Some("local") => return "local device configured for this workspace project",
        _ => {}
    }
    match shell_type {
        "ClaudeCode" | "Agno" | "Codex" => "Wegent-managed disposable execution sandbox",
        "Dify" => "external service configured by the selected bot",
        "Chat" => "Wegent web chat runtime",
        _ => "Wegent-managed execution runtime",
    }
}

/// `_get_device_type` (`request_builder.py:1127-1150`): resolve a Device CRD
/// type; any failure leaves the environment label without a device.
async fn web_runtime_device_type(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Option<String> {
    match crate::device_upgrade::owned_active_device(state, user_id, device_id).await {
        Ok(Some(device)) => device
            .json
            .get("spec")
            .and_then(|spec| spec.get("deviceType"))
            .and_then(Value::as_str)
            .map(str::to_string),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(
                ?error,
                device_id,
                "failed to resolve device type for guidance"
            );
            None
        }
    }
}

/// `_get_base_system_prompt`: the bot's own Ghost prompt (last in the chain),
/// with the team-member prompt appended and wrapped in `<base_prompt>`.
fn base_system_prompt(chain: &[GhostNode], team_member_prompt: Option<&str>) -> String {
    let own_prompt = chain
        .last()
        .map(|node| {
            node.spec
                .get("systemPrompt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    let mut prompts: Vec<String> = Vec::new();
    if !own_prompt.is_empty() {
        prompts.push(own_prompt);
    }
    if let Some(member) = team_member_prompt.filter(|value| !value.trim().is_empty()) {
        prompts.push(member.to_string());
    }
    let combined = prompts.join("\n\n");
    if combined.is_empty() {
        String::new()
    } else {
        format!("<base_prompt>\n{combined}\n</base_prompt>")
    }
}

/// `_build_skill_data` -> the metadata `skill_configs` entries: the resolved
/// Skills list itself (`resolved_skills`), including each entry's present-null
/// text fields and its truthiness-gated optional keys.
fn skill_configs(skills: &BotSkills) -> Vec<Value> {
    skills.skills.clone()
}

/// `_derive_task_mode`: the Task labels' `taskType` then `type`, defaulting to
/// `chat`.
fn task_mode(task_json: &Value) -> String {
    task_json
        .get("metadata")
        .and_then(|metadata| metadata.get("labels"))
        .and_then(|labels| {
            labels
                .get("taskType")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    labels
                        .get("type")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                })
        })
        .unwrap_or("chat")
        .to_string()
}

pub(super) fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "build_execution_request dependency failure");
    FastApiError::internal()
}

/// `_resolve_model_for_bot`'s failures: a read failure is the create flow's
/// dependency error; a task-override whitelist rejection is the source
/// `ValueError`, which the endpoint renders as `400`.
pub(super) fn model_resolution_error(error: ModelResolutionError) -> FastApiError {
    match error {
        ModelResolutionError::Mysql(error) => dependency(error),
        ModelResolutionError::Disallowed(message) => {
            FastApiError::detail(brz_http_server::StatusCode::BAD_REQUEST, message)
        }
    }
}

/// `build_execution_request` for the OpenAPI create flow.
pub async fn build_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
) -> Result<ExecutionRequest, FastApiError> {
    build_request(state, input, false, &[], true, None).await
}

/// Socket.IO chat passes user-selected skills through the standard compiler,
/// including the access checks and provider OAuth handling.
pub(crate) async fn build_chat_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    preload_skills: &[Value],
    generation: Option<&Value>,
    model_options: Option<&Value>,
    created_git_repository: Option<&Value>,
) -> Result<ExecutionRequest, FastApiError> {
    let runtime_model = super::socket_runtime_model::resolve(state, input, model_options).await?;
    build_request_with_runtime(
        state,
        input,
        false,
        preload_skills,
        true,
        generation,
        ExecutionOverrides {
            runtime_model,
            created_git_repository,
            include_coordinate_members: true,
        },
    )
    .await
}

/// Subscription-selected skills pass through the ordinary metadata and MCP
/// compiler rather than being appended as unresolved request objects.
pub(crate) async fn build_subscription_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    preload_skills: &[Value],
) -> Result<ExecutionRequest, FastApiError> {
    super::background::build(state, input, true, preload_skills).await
}

/// Background jobs compile every Team member; existing API defaults stay intact.
pub(crate) async fn build_background_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
) -> Result<ExecutionRequest, FastApiError> {
    super::background::build(state, input, false, &[]).await
}

pub(super) async fn build_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    is_subscription: bool,
    preload_skills: &[Value],
    compile_coding_mcp: bool,
    generation: Option<&Value>,
) -> Result<ExecutionRequest, FastApiError> {
    build_request_with_runtime(
        state,
        input,
        is_subscription,
        preload_skills,
        compile_coding_mcp,
        generation,
        ExecutionOverrides::default(),
    )
    .await
}

#[derive(Default)]
struct ExecutionOverrides<'a> {
    runtime_model: Option<serde_json::Map<String, Value>>,
    created_git_repository: Option<&'a Value>,
    include_coordinate_members: bool,
}

async fn build_request_with_runtime(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    is_subscription: bool,
    preload_skills: &[Value],
    compile_coding_mcp: bool,
    generation: Option<&Value>,
    overrides: ExecutionOverrides<'_>,
) -> Result<ExecutionRequest, FastApiError> {
    let ExecutionOverrides {
        runtime_model,
        created_git_repository,
        include_coordinate_members,
    } = overrides;
    // `prepare_execution_request`'s generation-context enrichment
    // (`request_preparation.py:868-878`) runs before `builder.build`, so its
    // attachment reads stay ahead of the bot and model lookups.
    let selected_generation = generation;
    let generation = preflight::generation_context(
        &state.mysql,
        state.task_store.as_ref(),
        input.task_id,
        input.user_subtask_id,
        input.user_id,
        generation,
    )
    .await?;

    // `_get_bot_for_subtask` (`request_builder.py:280`): the subtask's first
    // bot id is re-read as a Bot entity before the workspace and the model
    // config; the team's first member is only the fallback. A caller that
    // already resolved that same Bot (the `/chat` trigger, whose team-member
    // lookup needs the row) passes it in and skips the second identical read.
    let subtask_bot = if input.subtask_bot_resolved {
        None
    } else {
        super::subtask_bot::bot_by_id(&state.mysql, input.bot_ids.first().copied())
            .await
            .map_err(dependency)?
    };
    let input = &BuildExecutionRequestInput {
        bot: subtask_bot.as_ref().unwrap_or(input.bot),
        ..*input
    };
    let bot_spec = input.bot.json.0.get("spec").cloned().unwrap_or(Value::Null);
    let team_json = &input.team.json.0;

    let labels = input
        .task_json
        .get("metadata")
        .and_then(|metadata| metadata.get("labels"));
    let override_model_name = labels
        .and_then(|labels| labels.get("modelId"))
        .and_then(Value::as_str);
    let force_override = labels
        .and_then(|labels| labels.get("forceOverrideBotModel"))
        .and_then(Value::as_str)
        == Some("true");

    // `_build_workspace` runs before `_get_model_config`, so its Workspace and
    // Project reads are part of the source contract even when the model
    // lookup fails.
    let preflight::WorkspaceReads {
        workspace_resource,
        project_config,
    } = preflight::workspace(
        &state.mysql,
        state.task_store.as_ref(),
        input.task_json,
        input.task_project_id,
        input.user_id,
        created_git_repository,
    )
    .await;
    let project_repository = project_config
        .as_ref()
        .and_then(super::project_workspace::project_repository);
    let project_entry = project_config.as_ref().and_then(|config| {
        super::project_workspace::project_workspace_entry(config, input.task_project_id)
    });
    let (workspace_repository, workspace_branch) = match &project_repository {
        Some((repository, branch)) => (repository.clone(), branch.clone()),
        None => workspace_resource.unwrap_or((Value::Null, String::new())),
    };
    let mut workspace = build_workspace(&workspace_repository, &workspace_branch, None);
    if let (Some(entry), Value::Object(map)) = (project_entry, &mut workspace) {
        map.insert("project".into(), entry);
    }
    let (git_repo, git_url, git_domain, git_repo_id, branch_name) =
        git_fields(&workspace_repository);
    if created_git_repository.is_some() && git_url.trim().is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Git workspace is missing a repository URL",
        ));
    }
    // `_build_user_info` + `classify_git_auth_transport`: match the user's
    // stored Git account against the task's resolved domain, resolve/encrypt
    // its token, and classify the transport the executor must expect.
    let git_identity = crate::background_jobs::git_credentials::resolve_identity(
        state.repository_tokens.as_ref(),
        input.user_git_info,
        git_domain.as_deref(),
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "build_execution_request git identity failure");
        FastApiError::internal()
    })?;
    let mut user_json = serde_json::json!({
        "id": input.user_id,
        "name": input.user_name,
    });
    if let Value::Object(map) = &mut user_json {
        for (name, value) in crate::background_jobs::git_credentials::identity_fields(&git_identity)
        {
            map.insert(name.into(), value);
        }
    }
    let mut user_info = build_user_metadata(&user_json);
    state
        .user_info_extension
        .decorate(input.user_preferences, &mut user_info)
        .await;

    // Model config (`get_model_config_for_bot` + placeholder processing).
    // The source resolves this flat config in `_get_model_config`
    // (`request_builder.py:318`) before `_build_bot_config` (`:415`), whose
    // `_resolve_shell_info` (`:2211`) is the Shell read. Keep that order: both
    // `ValueError`s below abort the request before any Shell query.
    // `_find_model_with_namespace` reads the caller's groups only after the
    // private and referenced Model reads miss, so the resolver owns that read.
    let agent_config = bot_spec.get("agent_config").cloned().unwrap_or(Value::Null);
    let (mut model_config, model_name) = if let Some(config) = runtime_model.as_ref() {
        (config.clone(), None)
    } else {
        let model_name = match resolve_model_name(&bot_spec, force_override, override_model_name) {
            Some(name) => name,
            // `get_model_config_for_bot`: `ValueError(f"Bot {bot.name} has no model
            // configured")`.
            None => return Err(flat_model_config_error(None, &input.bot.name)),
        };
        // `get_model_config_for_bot` owns the flat Chat Shell config: one
        // `_resolve_model_for_bot` call.
        let config = match resolve_model_for_bot_with_override(
            &state.mysql,
            &state.entity_resolvers,
            state.redis.as_ref(),
            input.user_id,
            &model_name,
            &bot_spec,
            &input.bot.name,
            override_model_name,
        )
        .await
        .map_err(model_resolution_error)?
        {
            Some(model) => {
                let spec = model.json.0.get("spec").cloned().unwrap_or(Value::Null);
                let mut config = extract_model_config(&spec).map_err(|error| {
                    tracing::error!(%error, "failed to extract the model config");
                    FastApiError::internal()
                })?;
                config.insert("model_name".into(), Value::String(model.name.clone()));
                config.insert(
                    "model_namespace".into(),
                    Value::String(model.namespace.clone()),
                );
                config
            }
            // `_resolve_model_for_bot` returned no Model for the bot's modelRef.
            None => return Err(flat_model_config_error(Some(&model_name), &input.bot.name)),
        };
        (config, Some(model_name))
    };
    process_model_config_placeholders(
        &mut model_config,
        input.user_id,
        input.user_name,
        &agent_config,
        input.task_id,
        input.team,
    );

    // The api_key credential resolution (`resolve_llm_proxy_provider_api_key`).
    let api_key = model_config
        .get("api_key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let resolved_api_key = state
        .llm_proxy_credentials
        .provider_api_key(CredentialRequest {
            api_key: &api_key,
            api_key_template: model_config
                .get("_api_key_template")
                .and_then(Value::as_str),
            user_id: input.user_id,
            user_name: input.user_name,
        })
        .await?;
    model_config.insert("api_key".into(), Value::String(resolved_api_key.clone()));
    // `merge_model_reasoning` (`request_preparation.py:902-919`): the API
    // `reasoning` selection overrides the Model's default, and the Model's
    // `think_config` is the fallback only when nothing is selected.
    super::reasoning::merge_model_reasoning(&mut model_config, input.reasoning);

    super::model_config::apply_generation_params(&mut model_config, selected_generation).map_err(
        |message| FastApiError::detail(brz_http_server::StatusCode::BAD_REQUEST, message),
    )?;

    // The ghost chain reads through the deployment's cached kind reader.
    let ghost_ref = bot_spec.get("ghostRef");
    let kinds_cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let chain = load_ghost_chain(
        &kinds_cache,
        input.team.user_id,
        ghost_ref
            .and_then(|reference| reference.get("namespace"))
            .and_then(Value::as_str)
            .unwrap_or("default"),
        ghost_ref
            .and_then(|reference| reference.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "failed to load the bot ghost chain");
        FastApiError::internal()
    })?;
    let merged = merge_ghost_capabilities(&chain);

    let capability_mode = bot_spec
        .get("capability_mode")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let system_prompt = base_system_prompt(&chain, input.team_member_prompt);

    // Skills (`_get_bot_skills`). `_build_skill_binding_context`: a group-owned
    // Team also reads its group `SkillBinding` rows; every automatic binding is
    // filtered by the task mode, team id and project id.
    let task_mode = task_mode(input.task_json);
    let binding_context = SkillBindingContext {
        mode: &task_mode,
        agent_id: input.team.id,
        project_id: (input.task_project_id > 0).then_some(input.task_project_id),
        group_namespace: (input.team.namespace != "default")
            .then_some(input.team.namespace.as_str()),
    };
    let skill_access = SkillAccess {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: state.erp.as_ref(),
        resolvers: &state.entity_resolvers,
    };
    // `_apply_user_mcp_oauth_header` (`request_builder.py:2029-2036`).
    let tokens = crate::user_mcp_oauth::token_service(input.user_id, &state.mysql);
    let user_default_target_id = format!("user:{}", input.user_id);
    let binding_refs = super::skills::list_user_default_skill_refs(
        &state.mysql,
        input.user_id,
        &user_default_target_id,
        &binding_context,
        Some(&skill_access),
    )
    .await
    .map_err(dependency)?;
    let mut skills = get_bot_skills(
        &state.mysql,
        &merged,
        capability_mode,
        input.user_id,
        input.user_preferences,
        &tokens,
        is_subscription,
        &user_default_target_id,
        Some(&skill_access),
        Some(binding_refs),
    )
    .await?;
    // `_inject_conditional_provider_skills` (`request_builder.py:2626`): the
    // prompt's provider keywords preload provider runtime Skills as
    // `{"name", "namespace": "default", "is_public": true}` references. They
    // join the caller's explicit preloads and resolve through the ordinary
    // Skill loader, landing before the injected available Skill (`skills`
    // `preload_insert_at`) as the source's resolution order does.
    let mut requested_skills: Vec<Value> = preload_skills.to_vec();
    super::skills::inject_conditional_provider_skills(input.message, &mut requested_skills);
    super::skills::append_requested_skills(
        &state.mysql,
        &mut skills,
        &requested_skills,
        input.user_id,
        input.user_preferences,
        &tokens,
        &input.team.namespace,
        &skill_access,
    )
    .await?;
    // `apply_skill_generation_to_skills` (`skill_generation.py:80-99`): the
    // enriched generation value is written into the resolved skill entries.
    skill_generation::apply_skill_generation_to_skills(
        &mut skills.skills,
        input.team.user_id,
        generation.as_ref(),
        Some(input.message),
    );

    // As in the Python builder, resolve the Bot's Shell after resolving its
    // Skills. The legacy bindShells field is carried as Skill metadata.
    let (shell_type, base_image) = resolve_shell_type(state, input).await?;

    // `_append_web_runtime_guidance` (`request_builder.py:551-566`): the
    // chat entry point injects the Wegent web runtime guidance into the
    // system prompt after the shell, workspace and device are known.
    let system_prompt = if input.web_runtime_guidance {
        with_web_runtime_guidance(state, input, &shell_type, &workspace, system_prompt).await
    } else {
        system_prompt
    };

    // Bot config entry (`build_agent_config_for_bot`). A bot whose inline
    // `agent_config.env` already carries `model` and `api_key` (and no forced
    // override) returns it unchanged. Every other bot calls
    // `_resolve_model_for_bot` again — the flat config above is
    // `get_model_config_for_bot`, a separate call — so the private/referenced
    // Model reads and `_find_model_with_namespace`'s caller-group lookup run
    // twice, exactly as the recorded `get_user_groups` pairs show.
    //
    // Source builds the bot config right after skills and before the knowledge
    // resolution (`request_builder.py:392-422`), so the second caller-group
    // resolution — and its ERP identity/cache reads — precedes the knowledge
    // ACL's membership checks. Keep that order: moving this after
    // `resolve_knowledge` shifts the `erp:no_profile` reads behind the
    // `erp:membership` reads and desynchronizes the recorded Redis lane.
    let bot_model_spec = if let Some(model_name) = model_name
        .as_deref()
        .filter(|_| !inline_agent_config_ready(&agent_config, force_override, override_model_name))
    {
        resolve_model_for_bot_with_override(
            &state.mysql,
            &state.entity_resolvers,
            state.redis.as_ref(),
            input.user_id,
            model_name,
            &bot_spec,
            &input.bot.name,
            override_model_name,
        )
        .await
        .map_err(model_resolution_error)?
        .map(|model| model.json.0.get("spec").cloned().unwrap_or(Value::Null))
    } else {
        None
    };
    let built_agent_config = if let Some(runtime_model) = runtime_model.as_ref() {
        serde_json::json!({"protocol": runtime_model["protocol"], "apiFormat": runtime_model["api_format"], "env": runtime_model})
    } else {
        build_agent_config(
            &agent_config,
            force_override,
            override_model_name,
            bot_model_spec.as_ref(),
        )
    };
    // `_build_runtime_system_prompt` (`request_builder.py:2312`):
    // `get_bot_system_prompt` re-reads the bot's own Ghost by
    // (owner, kind = 'Ghost', name, namespace) instead of reusing the chain the
    // skills resolved, then appends the team member prompt.
    let bot_system_prompt = super::ghost::bot_system_prompt(
        &state.mysql,
        input.team.user_id,
        ghost_ref
            .and_then(|reference| reference.get("namespace"))
            .and_then(Value::as_str)
            .unwrap_or("default"),
        ghost_ref
            .and_then(|reference| reference.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(""),
        input.team_member_prompt,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "failed to read the bot system prompt");
        FastApiError::internal()
    })?;

    let collaboration = collaboration_model(team_json);
    let coordinate_team = include_coordinate_members && collaboration == "coordinate";
    let mut member_configs = if coordinate_team {
        coordinate::members(state, input, runtime_model.as_ref(), &shell_type).await?
    } else {
        Vec::new()
    };
    if coordinate_team && super::skills::is_coding_shell(&shell_type) {
        super::skills::extend_resolved_skills_from_bot_configs(
            &kinds_cache,
            &member_configs,
            &mut skills,
            input.user_preferences,
            &tokens,
            input.team.user_id,
            &input.team.namespace,
        )
        .await?;
    }

    // `build_execution_request` (`unified.py:277-306`): persist the request's
    // knowledge-base refs before `current_contexts` is loaded, and keep the
    // in-memory Task scope refs that the selected-knowledge construction reads.
    let normalized_kb_refs = super::kb_context_creation::normalized_refs(
        input.knowledge_base_refs,
        input.knowledge_base_names,
    );
    let knowledge_task_json =
        super::kb_context_creation::persist_request_kb_contexts(state, input, normalized_kb_refs)
            .await?;

    // Knowledge (default KBs + inherited selected-knowledge refs). The current
    // subtask's contexts are the explicit-ref input (`unified.py:306`).
    let current_contexts =
        contexts::current_contexts_by_subtask(&state.mysql, input.user_subtask_id)
            .await
            .map_err(dependency)?;
    let knowledge = resolve_knowledge(
        state,
        input,
        &knowledge_task_json,
        &shell_type,
        &skills.preload_skills,
        &skills.user_selected_skills,
        &current_contexts,
    )
    .await?;
    // `_build_mcp_servers`: deployment-level servers first, then the bot's
    // Ghost servers (bot entries win by name). `metadata.bot[].mcp_servers`
    // keeps only the bot-level list.
    let bot_mcp_servers = ghost_mcp_servers(&merged);
    // The request-level list (the chatbot `tools`) uses the source's separate
    // `_build_mcp_servers` shape: the Ghost mapping key is the label, so a
    // config-level `name` stays a metadata-only override.
    let request_bot_mcp_servers = request_mcp_servers(&merged);
    let system_mcp_servers = if input.team.user_id == 0 {
        // `_is_system_agent_team`: system-owned public agents skip
        // `CHAT_MCP_SERVERS`.
        Vec::new()
    } else {
        load_system_mcp_servers()
    };
    let mcp_servers = merge_mcp_servers(system_mcp_servers, request_bot_mcp_servers);
    // `_prepare_mcp_for_coding_executor` (`request_builder.py:2684`): a coding
    // shell merges the resolved Skills' MCP servers into the Bot entry and
    // normalizes them for that shell. It runs after the coordinate merge, so a
    // multi-Bot build compiles the leader once its final Skill set is fixed
    // (`background::finalize`) and asks this single-Bot build to skip it.
    // `ExecutionRequest.mcp_servers` (the `tools` list) comes from the separate
    // `_build_mcp_servers` and keeps the Ghost/deployment servers.
    let leader = build_bot_config(&BotConfigInput {
        id: input.bot.id,
        name: &input.bot.name,
        shell_type: &shell_type,
        agent_config: built_agent_config,
        system_prompt: &bot_system_prompt,
        mcp_servers: bot_mcp_servers,
        plugins: merged.plugins.clone(),
        skills: skills
            .skills
            .iter()
            .filter_map(|skill| skill.get("name").cloned())
            .collect(),
        skill_refs: Value::Object(skills.skill_refs.clone()),
        // `list(merged.preload_skills) if ghost_skills else []`: the merged
        // Ghost chain's preload skills; empty when the chain declares none.
        preload_skills: if merged.skills.is_empty() {
            Vec::new()
        } else {
            merged.preload_skills.clone()
        },
        capability_mode,
        role: input.bot_role,
        base_image: base_image.as_deref(),
    });

    let mut bot_configs = vec![leader];
    bot_configs.append(&mut member_configs);
    if super::skills::is_coding_shell(&shell_type) {
        if coordinate_team {
            super::background::merge_leader_capabilities(&mut bot_configs);
            for bot in &mut bot_configs {
                super::skills::sync_bot_skill_refs(bot, &skills.skill_refs);
            }
        }
        if compile_coding_mcp {
            let leader = &mut bot_configs[0];
            let mut servers = leader["mcp_servers"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            super::skills::append_coding_mcp(&mut servers, &skills, &shell_type);
            leader["mcp_servers"] = Value::Array(servers);
        }
    }

    // Tokens.
    let auth_token = create_task_token(
        state,
        input.task_id,
        input.assistant_subtask_id,
        input.user_id,
        input.user_name,
    )?;
    let skill_identity_token = create_skill_identity_token(
        state,
        input.user_id,
        input.user_name,
        input.task_id,
        input.assistant_subtask_id,
        // `_generate_skill_identity_token` (`request_builder.py:3410`): the
        // assistant subtask's persisted `executor_name`, with the
        // `task-…-subtask-…` fallback only when it is empty.
        input.executor_name,
    )?;

    // `_build_session_context` (`request_builder.py:554`): the persisted
    // executor sessions and the legacy bindings. It is the last read of the
    // source builder, and its predicate decides whether the assistant-subtask
    // listing is issued at all.
    let (inherited_sessions, legacy_session_bindings) = super::session_context::build(
        &state.mysql,
        &super::session_context::SessionContextInput {
            task_id: input.task_id,
            // A Task the create flow may build for is owned by the request
            // user (`get_owned_active_task` / the newly inserted row).
            task_user_id: input.user_id,
            user_id: input.user_id,
            bot_configs: &bot_configs,
            task_json: input.task_json,
            executor_deleted: input.executor_deleted,
            new_session: input.new_session,
            // The deployment's task/subtask table templates; the session
            // context renders its statements against the task's shard exactly
            // like the completion path's `Tables`.
            table_templates: state.task_store.table_templates(),
        },
    )
    .await
    .map_err(dependency)?;

    // `_process_contexts` (`unified.py:464`): the executor attachment payload
    // is built from the user subtask's attachment contexts at this position,
    // one read per call like the source.
    let attachment_contexts = contexts::attachments_by_subtask(&state.mysql, input.user_subtask_id)
        .await
        .map_err(dependency)?;
    let attachments: Vec<Value> = attachment_contexts
        .iter()
        .map(contexts::executor_attachment_payload)
        .collect();

    let prompt = contexts::attachment_prompt(
        &attachment_contexts,
        input.message,
        input.task_id,
        &shell_type,
        &model_config,
        state.internal_chat.attachment_inject_max_chars,
    );
    let mut request = ExecutionRequest {
        task_id: input.task_id,
        // `TaskRequestBuilder.build`'s `task_title=task.json.spec.title`.
        task_title: input
            .task_json
            .pointer("/spec/title")
            .and_then(Value::as_str)
            .map(str::to_string),
        subtask_id: input.assistant_subtask_id,
        user_subtask_id: Some(input.user_subtask_id),
        team_id: input.team.id,
        team_name: input.team.name.clone(),
        team_namespace: Some(input.team.namespace.clone()),
        user: user_info,
        user_id: input.user_id,
        user_name: input.user_name.to_string(),
        // `_build_request_task_data(user)`: the enabled user-configured MCP
        // services, or `null` when the caller has none.
        task_data: crate::mcp_user_service::build_request_task_data(input.user_preferences)?,
        bot: Value::Array(bot_configs),
        mcp_servers,
        bot_name: input.bot.name.clone(),
        bot_namespace: input.bot.namespace.clone(),
        model_config: Value::Object(model_config),
        system_prompt,
        prompt,
        enable_tools: input.enable_tools,
        enable_web_search: input.enable_web_search,
        enable_deep_thinking: input.enable_deep_thinking,
        skill_names: skills
            .skills
            .iter()
            .filter_map(|skill| skill.get("name").cloned())
            .collect(),
        skill_configs: skill_configs(&skills),
        preload_skills: skills
            .preload_skills
            .iter()
            .map(|name| Value::String(name.clone()))
            .collect(),
        user_selected_skills: skills
            .user_selected_skills
            .iter()
            .map(|name| Value::String(name.clone()))
            .collect(),
        skill_refs: Value::Object(skills.skill_refs.clone()),
        preload_skill_refs: super::skills::preload_skill_refs(&skills),
        auth_token,
        skill_identity_token,
        backend_url: backend_url(),
        workspace,
        request_id: input.request_id.to_string(),
        message_id: Some(input.message_id),
        is_group_chat: input.is_group_chat,
        collaboration_model: collaboration.clone(),
        mode: Some(collaboration),
        git_repo: Some(git_repo),
        git_url: Some(git_url),
        git_domain,
        git_repo_id: Some(git_repo_id),
        branch_name: Some(branch_name),
        git_auth_transport: git_identity.transport.to_string(),
        // The assistant subtask row carries `""` for both executor fields.
        executor_name: Some(input.executor_name.to_string()),
        executor_namespace: Some(input.executor_namespace.to_string()),
        // `ExecutionRequest.skip_git_clone` defaults to `False` (rendered
        // `false`, not `null`).
        skip_git_clone: Some(false),
        attachments,
        fork_runtime: super::session_context::fork_runtime(input.task_json),
        inherited_sessions,
        legacy_session_bindings,
        new_session: input.new_session,
        ..ExecutionRequest::default()
    };
    // Device-dispatch contract values (`ExecutionRequest.to_dict`): the Task
    // project and mode labels the device payload renders. `timezone` keeps the
    // contract default; the chat builder has no user-timezone input.
    request.device_project_id = input.task_project_id;
    request.device_task_mode = task_mode.clone();
    apply_knowledge(&mut request, &knowledge);
    // `unified.py:367-391`: re-resolve the provider Skill context processing
    // appended after the initial build. The post-processing builder selects
    // the subtask Bot again and re-resolves its Ghost chain, so the late
    // resolution reads live capabilities instead of the initial `merged`.
    super::skills::resolve_request_preload_skills(
        &state.mysql,
        &mut request,
        &super::skills::late_bot_reads(
            &kinds_cache,
            input.bot_ids,
            &input.team.json.0,
            input.team.user_id,
        ),
        input.user_id,
        input.user_preferences,
        &tokens,
        is_subscription,
        &skill_access,
        &input.team.namespace,
    )
    .await?;
    if coordinate_team && super::skills::is_coding_shell(&shell_type) {
        coordinate::keep_compiled_mcp_servers(&mut request);
    }
    if !resolved_api_key.is_empty() {
        // The key belongs to the primary model unless an explicit runtime
        // override gives every team member the same model.
        let bots = if runtime_model.is_some() {
            &mut request.bot
        } else {
            &mut request.bot[0]
        };
        state
            .llm_proxy_credentials
            .replace_api_key_placeholder(bots, &resolved_api_key);
        state
            .llm_proxy_credentials
            .replace_api_key_placeholder(&mut request.model_config, &resolved_api_key);
    }
    // `apply_provider_configuration_guidance` (`request_builder.py:631`): the
    // single authoritative guide is refreshed after every Skill resolution,
    // including the request- and knowledge-scoped preloads added above.
    crate::provider_guidance::apply_provider_configuration_guidance(&mut request);
    // `_apply_user_runtime_config` (`request_preparation.py:655`): it runs in
    // `prepare_execution_request`, after `TaskRequestBuilder.build` returned, so
    // its two kind reads follow every read above.
    super::runtime_config::apply_user_runtime_config(
        state,
        &mut request.model_config,
        input.user_id,
        input.user_preferences,
    )
    .await?;
    Ok(request)
}

/// Apply the knowledge projection to the request.
fn apply_knowledge(request: &mut ExecutionRequest, knowledge: &ResolvedKnowledge) {
    request.knowledge_base_ids = knowledge.knowledge_base_ids.clone();
    request.document_ids = knowledge.document_ids.clone();
    request.knowledge_base_scopes = knowledge.knowledge_base_scopes.clone();
    request.external_knowledge_refs = Some(knowledge.external_knowledge_refs.clone());
    request.selected_knowledge_prompt = knowledge.selected_knowledge_prompt.clone();
    request.provider_native_knowledge = knowledge.provider_native_knowledge;
    request.is_user_selected_kb = knowledge.is_user_selected_kb;
    request.kb_tool_access_mode = Some(knowledge.kb_tool_access_mode.clone());
    request.kb_meta_prompt = knowledge.kb_meta_prompt.clone();
    for skill in &knowledge.provider_skills {
        if !request
            .preload_skills
            .iter()
            .any(|existing| existing.as_str() == Some(skill.as_str()))
        {
            request.preload_skills.push(Value::String(skill.clone()));
        }
        if !request
            .user_selected_skills
            .iter()
            .any(|existing| existing.as_str() == Some(skill.as_str()))
        {
            request
                .user_selected_skills
                .push(Value::String(skill.clone()));
        }
    }
}

/// The resolved shell type + base image for the bot's `shellRef`.
async fn resolve_shell_type(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
) -> Result<(String, Option<String>), FastApiError> {
    let shell_ref = input
        .bot
        .json
        .0
        .get("spec")
        .and_then(|spec| spec.get("shellRef"));
    let Some(shell_ref) = shell_ref else {
        return Ok(("Chat".to_string(), None));
    };
    let name = shell_ref.get("name").and_then(Value::as_str).unwrap_or("");
    let namespace = shell_ref
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    // `_resolve_shell_info(bot, team.user_id)` is keyed by the *team's* owner,
    // not the caller (`request_builder.py:2193,2228`), so the owner/search
    // order follows the bot's owning namespace.
    let shell = resolve_shell(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        input.team.user_id,
        name,
        namespace,
    )
    .await
    .map_err(dependency)?
    .ok_or_else(|| {
        FastApiError::detail(
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
            format!("Shell reference '{namespace}/{name}' is unavailable"),
        )
    })?;
    Ok(shell_info(&shell.json.0))
}

/// The `<selected_knowledge_sources>` renderer is re-exported for tests.
#[cfg(test)]
pub(crate) fn render_prompt(context: &super::knowledge_prompt::SelectedKnowledgeContext) -> String {
    super::knowledge_prompt::render_selected_knowledge_prompt(context)
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod request_tests;

#[cfg(test)]
#[path = "request_inline_tests.rs"]
mod tests;
