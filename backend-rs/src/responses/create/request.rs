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
fn model_resolution_error(error: ModelResolutionError) -> FastApiError {
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
    build_request(state, input, false, &[], true).await
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
) -> Result<ExecutionRequest, FastApiError> {
    // `prepare_execution_request`'s generation-context enrichment
    // (`request_preparation.py:868-878`) runs before `builder.build`, so its
    // attachment reads stay ahead of the bot and model lookups.
    let generation = preflight::generation_context(
        &state.mysql,
        state.task_store.as_ref(),
        input.task_id,
        input.user_subtask_id,
        input.user_id,
    )
    .await?;

    // `_get_bot_for_subtask` (`request_builder.py:280`): the subtask's first
    // bot id is re-read as a Bot entity before the workspace and the model
    // config; the team's first member is only the fallback.
    let subtask_bot = super::subtask_bot::bot_by_id(&state.mysql, input.bot_ids.first().copied())
        .await
        .map_err(dependency)?;
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
    let user_info = build_user_metadata(&user_json);

    // Model config (`get_model_config_for_bot` + placeholder processing).
    // The source resolves this flat config in `_get_model_config`
    // (`request_builder.py:318`) before `_build_bot_config` (`:415`), whose
    // `_resolve_shell_info` (`:2211`) is the Shell read. Keep that order: both
    // `ValueError`s below abort the request before any Shell query.
    // `_find_model_with_namespace` reads the caller's groups only after the
    // private and referenced Model reads miss, so the resolver owns that read.
    let agent_config = bot_spec.get("agent_config").cloned().unwrap_or(Value::Null);
    let model_name = match resolve_model_name(&bot_spec, force_override, override_model_name) {
        Some(name) => name,
        // `get_model_config_for_bot`: `ValueError(f"Bot {bot.name} has no model
        // configured")`.
        None => return Err(flat_model_config_error(None, &input.bot.name)),
    };
    // `get_model_config_for_bot` owns the flat Chat Shell config: one
    // `_resolve_model_for_bot` call.
    let mut model_config = match resolve_model_for_bot_with_override(
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

    // Shell resolution (`_resolve_shell_info`) belongs to the later
    // `_build_bot_config` (`request_builder.py:415`), after the flat config.
    let (shell_type, base_image) = resolve_shell_type(state, input).await?;

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
    let mut skills = get_bot_skills(
        &state.mysql,
        &merged,
        capability_mode,
        input.user_id,
        input.user_preferences,
        &tokens,
        is_subscription,
        &format!("user:{}", input.user_id),
        &binding_context,
        Some(&skill_access),
        true,
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
    let bot_model_spec =
        if inline_agent_config_ready(&agent_config, force_override, override_model_name) {
            None
        } else {
            resolve_model_for_bot_with_override(
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
            .map(|model| model.json.0.get("spec").cloned().unwrap_or(Value::Null))
        };
    let built_agent_config = build_agent_config(
        &agent_config,
        force_override,
        override_model_name,
        bot_model_spec.as_ref(),
    );
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
    let current_contexts = contexts::contexts_by_subtask(&state.mysql, input.user_subtask_id)
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
    let mut bot_mcp_servers = bot_mcp_servers;
    if compile_coding_mcp && super::skills::is_coding_shell(&shell_type) {
        super::skills::append_coding_mcp(&mut bot_mcp_servers, &skills, &shell_type);
    }
    let bot_entry = build_bot_config(&BotConfigInput {
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
        capability_mode,
        role: input.bot_role,
        base_image: base_image.as_deref(),
    });

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
    )?;

    let collaboration = collaboration_model(team_json);

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
            bot_configs: std::slice::from_ref(&bot_entry),
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

    let mut request = ExecutionRequest {
        task_id: input.task_id,
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
        bot: Value::Array(vec![bot_entry]),
        mcp_servers,
        bot_name: input.bot.name.clone(),
        bot_namespace: input.bot.namespace.clone(),
        model_config: Value::Object(model_config),
        system_prompt,
        prompt: Value::String(input.message.to_string()),
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
        preload_skill_refs: Value::Object(
            skills
                .preload_skills
                .iter()
                .filter_map(|name| {
                    skills
                        .skill_refs
                        .get(name)
                        .map(|reference| (name.clone(), reference.clone()))
                })
                .collect(),
        ),
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
        &binding_context,
        &skill_access,
        &input.team.namespace,
    )
    .await?;
    if !resolved_api_key.is_empty() {
        // Let the deployment resolve its placeholders in both request sections.
        state
            .llm_proxy_credentials
            .replace_api_key_placeholder(&mut request.bot, &resolved_api_key);
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
    let shell = resolve_shell(&state.mysql, input.team.user_id, name, namespace)
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
mod tests {
    use super::super::model_config::strip_and_encode_wegent_headers;
    use super::*;
    use serde_json::{Map, json};

    #[test]
    fn deployment_default_headers_resolve_to_the_recorded_values() {
        // Recorded `model_config.default_headers`: the frozen
        // `EXECUTOR_ENV.DEFAULT_HEADERS` template with `task_data.*` paths
        // resolved, empty identity headers dropped, and the non-ASCII team name
        // base64-encoded.
        use brz_mysql::Json;
        let team = KindRow {
            id: 302_292,
            user_id: 6582,
            kind: "Team".into(),
            name: "示例团队".into(),
            namespace: "sample-group".into(),
            json: Json(serde_json::json!({})),
            is_active: 1,
            created_at: None,
            updated_at: None,
        };
        let mut config = Map::new();
        config.insert("api_key".into(), json!("${DEPLOYMENT_USER_API_KEY}"));
        config.insert(
            "default_headers".into(),
            json!({
                "x-runtime-source": "agent",
                "x-runtime-user": "${task_data.user.name}",
                "x-runtime-action": "wegent",
                "x-runtime-executor": "chat",
                "x-runtime-wegent-agent-namespace": "${task_data.team.namespace}",
                "x-runtime-wegent-agent-name": "${task_data.team.name}",
                "x-runtime-session-id": "${task_data.task_id}",
            }),
        );
        process_model_config_placeholders(
            &mut config,
            6582,
            "sample-service",
            &Value::Null,
            42,
            &team,
        );
        let headers = &config["default_headers"];
        assert_eq!(headers["x-runtime-source"], json!("agent"));
        assert_eq!(headers["x-runtime-user"], json!("sample-service"));
        assert_eq!(headers["x-runtime-action"], json!("wegent"));
        assert_eq!(headers["x-runtime-executor"], json!("chat"));
        assert_eq!(
            headers["x-runtime-wegent-agent-namespace"],
            json!("sample-group")
        );
        assert_eq!(
            headers["x-runtime-wegent-agent-name"],
            json!("b64:56S65L6L5Zui6Zif")
        );
        assert_eq!(headers["x-runtime-session-id"], json!("42"));
    }

    #[test]
    fn the_bot_model_config_is_resolved_before_the_knowledge_acl() {
        // Source builds the bot config — `build_agent_config_for_bot` ->
        // `_resolve_model_for_bot` — right after skills and before the
        // knowledge resolution (`request_builder.py:392-422`). That second
        // caller-group resolution repeats the ERP profile reads
        // (`erp:no_profile:{user}`) before the knowledge ACL's membership
        // checks; resolving it afterwards puts those reads behind
        // `erp:membership` and breaks the recorded Redis lane. The create flow
        // has no row-capable MySQL fake, so pin the call order at the source
        // level.
        let source = include_str!("request.rs");
        let skills = source
            .find("let mut skills = get_bot_skills(")
            .expect("skills resolution");
        let bot_config = source
            .find("let built_agent_config = build_agent_config(")
            .expect("bot config entry");
        let knowledge = source
            .find("let knowledge = resolve_knowledge(")
            .expect("knowledge resolution");
        assert!(
            skills < bot_config && bot_config < knowledge,
            "create prep must resolve skills, then the bot model config, then knowledge"
        );
    }

    #[test]
    fn base_prompt_wraps_the_own_prompt_and_member_prompt() {
        let chain = vec![GhostNode {
            namespace: "default".to_string(),
            spec: json!({"systemPrompt": "ghost"}),
        }];
        assert_eq!(
            base_system_prompt(&chain, None),
            "<base_prompt>\nghost\n</base_prompt>"
        );
        assert_eq!(
            base_system_prompt(&chain, Some("member")),
            "<base_prompt>\nghost\n\nmember\n</base_prompt>"
        );
        assert_eq!(base_system_prompt(&[], None), "");
    }

    #[test]
    fn wegent_identity_headers_are_stripped_and_encoded() {
        let mut headers = Map::new();
        headers.insert("wegent-agent-name".into(), json!("示例智能体"));
        headers.insert("wegent-agent-namespace".into(), json!(""));
        headers.insert("x-runtime-source".into(), json!("agent"));
        let processed = strip_and_encode_wegent_headers(headers);
        // The empty wegent-agent-* header is dropped.
        assert!(processed.get("wegent-agent-namespace").is_none());
        assert_eq!(processed["x-runtime-source"], json!("agent"));
        // The non-ASCII identity value is base64-encoded with the b64: prefix.
        let encoded = processed["wegent-agent-name"].as_str().unwrap();
        assert!(encoded.starts_with("b64:"));
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded[4..])
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "示例智能体");
    }
}
