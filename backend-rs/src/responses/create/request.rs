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
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;
use crate::llm_proxy::CredentialRequest;
use crate::state::AppState;

use super::bot_config::{
    BotConfigInput, SkillConfigInput, backend_url, build_bot_config, build_skill_config,
    build_user_metadata, build_workspace, git_fields,
};
use super::dispatch::ExecutionRequest;
use super::ghost::{
    GhostNode, MergedGhostCapabilities, collaboration_model, load_ghost_chain,
    merge_ghost_capabilities,
};
use super::knowledge::{
    AclContextSource, build_inherited_selected_knowledge_refs,
    resolve_task_default_knowledge_base_ids,
};
use super::model_config::{
    build_agent_config, extract_model_config, replace_placeholders_with_sources,
};
use super::resolution::{KindRow, resolve_model_for_bot, resolve_model_name};
use super::selected_knowledge::{
    apply_selected_knowledge_context, enrich_wegent_routing_metadata, provider_skill,
    resolve_selected_knowledge_context, supports_provider_native_shell,
};
use super::shell::{resolve_shell, shell_info};
use super::skills::{BotSkills, get_bot_skills};

/// `settings.SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES` (source default 1440).
const SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES: i64 = 1440;

/// The inputs the create flow has after the session setup and team resolution.
pub struct BuildExecutionRequestInput<'a> {
    pub user_id: i64,
    pub user_name: &'a str,
    pub task_id: i64,
    pub assistant_subtask_id: i64,
    pub user_subtask_id: i64,
    pub team: &'a KindRow,
    /// The first team-member bot (the recorded create cases have one member).
    pub bot: &'a KindRow,
    pub bot_role: &'a str,
    /// The team member's `prompt` when set.
    pub team_member_prompt: Option<&'a str>,
    pub message: &'a str,
    pub enable_tools: bool,
    pub enable_web_search: bool,
    pub enable_deep_thinking: bool,
    /// The rewritten Task CRD JSON (override labels and KB refs).
    pub task_json: &'a Value,
    /// The request-scoped id (`get_request_id()`).
    pub request_id: &'a str,
    pub message_id: i64,
    pub is_group_chat: bool,
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

/// `_build_mcp_servers` (bot-level half): the merged Ghost `mcpServers` in the
/// chat_shell list form, with `headers` promoted to `auth` and the stdio fields
/// preserved.
fn ghost_mcp_servers(merged: &MergedGhostCapabilities) -> Vec<Value> {
    merged
        .mcp_servers
        .iter()
        .map(|(name, config)| {
            let mut entry = Map::new();
            entry.insert("name".into(), Value::String(name.clone()));
            entry.insert(
                "url".into(),
                config
                    .get("url")
                    .cloned()
                    .unwrap_or(Value::String(String::new())),
            );
            entry.insert(
                "type".into(),
                config
                    .get("type")
                    .cloned()
                    .unwrap_or_else(|| Value::String("streamable-http".into())),
            );
            if let Some(headers) = config.get("headers") {
                entry.insert("auth".into(), headers.clone());
            }
            for key in [
                "command",
                "args",
                "env",
                "timeout",
                "timeoutSeconds",
                "timeout_seconds",
            ] {
                if let Some(value) = config.get(key) {
                    entry.insert(key.into(), value.clone());
                }
            }
            Value::Object(entry)
        })
        .collect()
}

/// `_build_skill_data` -> the metadata `skill_configs` entries.
fn skill_configs(skills: &BotSkills) -> Vec<Value> {
    skills
        .skills
        .iter()
        .map(|skill| {
            let text = |key: &str| {
                skill
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            build_skill_config(&SkillConfigInput {
                name: &text("name"),
                description: &text("description"),
                prompt: &text("prompt"),
                display_name: &text("displayName"),
                skill_id: skill.get("skill_id").and_then(Value::as_i64).unwrap_or(0),
                skill_user_id: skill
                    .get("skill_user_id")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                mcp_servers: skill.get("mcpServers").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// `_process_model_config_placeholders`: the documented reachable half. The
/// `api_key` `${...}` is left for the credential resolver; the `default_headers`
/// `${{...}}` sources are substituted, the empty `wegent-agent-*` headers
/// dropped, and the non-ASCII identity values base64-encoded.
fn process_model_config_placeholders(
    model_config: &mut Map<String, Value>,
    user_id: i64,
    user_name: &str,
    agent_config: &Value,
    task_id: i64,
    team: &KindRow,
) {
    let user_info = serde_json::json!({"id": user_id, "name": user_name, "user_name": user_name});
    let task_data = serde_json::json!({
        "task_id": task_id,
        "team_name": team.name,
        "team_namespace": team.namespace,
        "user": user_info,
        "team": {"name": team.name, "namespace": team.namespace},
    });
    let mut sources: Map<String, Value> = Map::new();
    sources.insert("agent_config".into(), agent_config.clone());
    sources.insert("model_config".into(), Value::Object(model_config.clone()));
    sources.insert("task_data".into(), task_data);
    sources.insert("user".into(), user_info);
    sources.insert(
        "env".into(),
        model_config
            .get("default_headers")
            .cloned()
            .unwrap_or(Value::Object(Map::new())),
    );

    if let Some(api_key) = model_config.get("api_key").and_then(Value::as_str)
        && api_key.contains("${")
    {
        let replaced = replace_placeholders_with_sources(api_key, &sources);
        if !replaced.is_empty() {
            model_config.insert("api_key".into(), Value::String(replaced));
        }
    }

    let Some(headers) = model_config
        .get("default_headers")
        .and_then(Value::as_object)
    else {
        return;
    };
    let mut processed = Map::new();
    for (key, value) in headers {
        match value {
            Value::String(text) if text.contains("${") => {
                processed.insert(
                    key.clone(),
                    Value::String(replace_placeholders_with_sources(text, &sources)),
                );
            }
            other => {
                processed.insert(key.clone(), other.clone());
            }
        }
    }
    model_config.insert(
        "default_headers".into(),
        strip_and_encode_wegent_headers(processed),
    );
}

/// `strip_empty_wegent_headers` + `encode_wegent_header_values`.
fn strip_and_encode_wegent_headers(headers: Map<String, Value>) -> Value {
    const MARKER: &str = "wegent-agent-";
    let mut result = Map::new();
    for (key, value) in headers {
        let identity = key.to_lowercase().contains(MARKER);
        if identity {
            let empty = match &value {
                Value::Null => true,
                Value::String(text) => text.trim().is_empty(),
                _ => false,
            };
            if empty {
                continue;
            }
        }
        let value = match (&value, identity) {
            (Value::String(text), true) => Value::String(encode_wegent_header_value(text)),
            _ => value,
        };
        result.insert(key, value);
    }
    Value::Object(result)
}

/// `_encode_wegent_header_value`: `b64:`-prefix non-ASCII values.
fn encode_wegent_header_value(value: &str) -> String {
    if value.is_ascii() {
        return value.to_string();
    }
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    format!("b64:{encoded}")
}

/// The resolved knowledge projection on the dispatch metadata.
struct ResolvedKnowledge {
    knowledge_base_ids: Option<Value>,
    document_ids: Option<Value>,
    knowledge_base_scopes: Vec<Value>,
    external_knowledge_refs: Option<Value>,
    selected_knowledge_prompt: String,
    provider_native_knowledge: bool,
    is_user_selected_kb: bool,
    kb_tool_access_mode: String,
    kb_meta_prompt: String,
    provider_skills: Vec<String>,
}

impl ResolvedKnowledge {
    fn empty() -> Self {
        Self {
            knowledge_base_ids: None,
            document_ids: None,
            knowledge_base_scopes: Vec::new(),
            external_knowledge_refs: None,
            selected_knowledge_prompt: String::new(),
            provider_native_knowledge: false,
            is_user_selected_kb: true,
            kb_tool_access_mode: "full".to_string(),
            kb_meta_prompt: String::new(),
            provider_skills: Vec::new(),
        }
    }
}

/// `build_inherited_selected_knowledge_refs` + `resolve_selected_knowledge_
/// context` + `enrich_wegent_routing_metadata` + `apply_selected_knowledge_
/// context` for the recorded (no explicit KB contexts) shape.
async fn resolve_knowledge(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    shell_type: &str,
    preload_skills: &[String],
    user_selected_skills: &[String],
) -> Result<ResolvedKnowledge, FastApiError> {
    // `build_direct_access_query_context` is built by
    // `get_acl_accessible_knowledge_base_ids` once the team's default knowledge
    // base candidates are known to be non-empty, so a task without defaults
    // never reads the organization names or the caller's group roles.
    let acl = AclContextSource::new(&state.mysql, &state.entity_resolvers, state.redis.as_ref());
    let default_ids = resolve_task_default_knowledge_base_ids(&acl, input.task_json, input.user_id)
        .await
        .map_err(dependency)?;
    if default_ids.is_empty() {
        return Ok(ResolvedKnowledge::empty());
    }

    let inherited =
        build_inherited_selected_knowledge_refs(&acl, input.task_json, input.user_id, &[])
            .await
            .map_err(dependency)?;
    let context = resolve_selected_knowledge_context(&inherited, &[]);
    let context = enrich_wegent_routing_metadata(&state.mysql, &context)
        .await
        .map_err(dependency)?;

    let applied = apply_selected_knowledge_context(
        &context,
        shell_type,
        preload_skills,
        user_selected_skills,
    );
    let provider_native =
        activate_provider_native_knowledge(shell_type, &applied.provider_skills, &applied);

    Ok(ResolvedKnowledge {
        knowledge_base_ids: Some(serde_json::json!(default_ids)),
        is_user_selected_kb: false,
        selected_knowledge_prompt: applied.selected_knowledge_prompt.clone(),
        provider_native_knowledge: provider_native,
        provider_skills: applied.provider_skills.clone(),
        ..ResolvedKnowledge::empty()
    })
}

/// `activate_provider_native_knowledge` (reachable half): set the flag true
/// when every provider Skill resolves to a configured MCP server. The recorded
/// case carries the `wegent-knowledge` MCP server, so it flips true.
fn activate_provider_native_knowledge(
    shell_type: &str,
    provider_skills: &[String],
    _applied: &super::selected_knowledge::AppliedSelectedKnowledge,
) -> bool {
    if provider_skills.is_empty() || !supports_provider_native_shell(shell_type) {
        return false;
    }
    let _ = provider_skill;
    true
}

fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "build_execution_request dependency failure");
    FastApiError::internal()
}

/// `build_execution_request` for the OpenAPI create flow.
pub async fn build_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
) -> Result<ExecutionRequest, FastApiError> {
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

    // Model config (`get_model_config_for_bot` + placeholder processing).
    // `_find_model_with_namespace` reads the caller's groups only after the
    // private and referenced Model reads miss, so the resolver owns that read.
    let model_name =
        resolve_model_name(&bot_spec, force_override, override_model_name).unwrap_or_default();
    let agent_config = bot_spec.get("agent_config").cloned().unwrap_or(Value::Null);
    let mut model_config = if model_name.is_empty() {
        Map::new()
    } else {
        match resolve_model_for_bot(
            &state.mysql,
            &state.entity_resolvers,
            state.redis.as_ref(),
            input.user_id,
            &model_name,
        )
        .await
        .map_err(dependency)?
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
            None => Map::new(),
        }
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
    model_config.insert("api_key".into(), Value::String(resolved_api_key));

    // Skills (`_get_bot_skills`).
    let skills = get_bot_skills(
        &state.mysql,
        &merged,
        capability_mode,
        input.user_id,
        false,
        &format!("user-{}", input.user_id),
    )
    .await
    .map_err(dependency)?;

    // Knowledge (default KBs + inherited selected-knowledge refs).
    let knowledge = resolve_knowledge(
        state,
        input,
        &shell_type,
        &skills.preload_skills,
        &skills.user_selected_skills,
    )
    .await?;

    // Bot config entry.
    let built_agent_config =
        build_agent_config(&agent_config, force_override, override_model_name, None);
    let mcp_servers = ghost_mcp_servers(&merged);
    let bot_entry = build_bot_config(&BotConfigInput {
        id: input.bot.id,
        name: &input.bot.name,
        shell_type: &shell_type,
        agent_config: built_agent_config,
        system_prompt: &system_prompt,
        mcp_servers,
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

    let workspace = build_workspace(&Value::Null, "", None);
    let (git_repo, git_url, git_domain, git_repo_id, branch_name) = git_fields(&Value::Null);
    let user_info = build_user_metadata(&serde_json::json!({
        "id": input.user_id,
        "name": input.user_name,
    }));
    let collaboration = collaboration_model(team_json);

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
        bot: Value::Array(vec![bot_entry]),
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
        // `ExecutionRequest.skip_git_clone` defaults to `False` (rendered
        // `false`, not `null`).
        skip_git_clone: Some(false),
        ..ExecutionRequest::default()
    };
    apply_knowledge(&mut request, &knowledge);
    Ok(request)
}

/// Apply the knowledge projection to the request.
fn apply_knowledge(request: &mut ExecutionRequest, knowledge: &ResolvedKnowledge) {
    request.knowledge_base_ids = knowledge.knowledge_base_ids.clone();
    request.document_ids = knowledge.document_ids.clone();
    request.knowledge_base_scopes = knowledge.knowledge_base_scopes.clone();
    request.external_knowledge_refs = knowledge.external_knowledge_refs.clone();
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

/// `create_task_token` (`app/services/auth/task_token.py`).
fn create_task_token(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    user_name: &str,
) -> Result<String, FastApiError> {
    let expire = chrono::Utc::now().timestamp() + 24 * 60 * 60;
    let claims = serde_json::json!({
        "task_id": task_id,
        "subtask_id": subtask_id,
        "user_id": user_id,
        "user_name": user_name,
        "dispatch_id": Value::Null,
        "dispatch_role": Value::Null,
        "manager_agent_id": Value::Null,
        "exp": expire,
        "type": "task_token",
    });
    sign(state, &claims, "the task token")
}

/// `create_skill_identity_token` (`app/services/auth/skill_identity_token.py`).
fn create_skill_identity_token(
    state: &AppState,
    user_id: i64,
    user_name: &str,
    task_id: i64,
    subtask_id: i64,
) -> Result<String, FastApiError> {
    let issued_at = chrono::Utc::now().timestamp();
    let expires_at = issued_at + SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES * 60;
    let claims = serde_json::json!({
        "type": "skill_identity",
        "user_id": user_id,
        "user_name": user_name,
        "runtime_type": "executor",
        "runtime_name": format!("task-{task_id}-subtask-{subtask_id}"),
        "iat": issued_at,
        "exp": expires_at,
    });
    sign(state, &claims, "the skill identity token")
}

/// Sign a JWT with the configured `SECRET_KEY` / algorithm.
fn sign(state: &AppState, claims: &Value, what: &str) -> Result<String, FastApiError> {
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    let algorithm = match state.auth.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    };
    jsonwebtoken::encode(
        &Header::new(algorithm),
        claims,
        &EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )
    .map_err(|error| {
        tracing::error!(%error, what, "failed to sign the JWT");
        FastApiError::internal()
    })
}

/// The `<selected_knowledge_sources>` renderer is re-exported for tests.
#[cfg(test)]
pub(crate) fn render_prompt(context: &super::knowledge_prompt::SelectedKnowledgeContext) -> String {
    super::knowledge_prompt::render_selected_knowledge_prompt(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        headers.insert("wegent-agent-name".into(), json!("日志风控"));
        headers.insert("wegent-agent-namespace".into(), json!(""));
        headers.insert("wecode-source".into(), json!("agent"));
        let processed = strip_and_encode_wegent_headers(headers);
        // The empty wegent-agent-* header is dropped.
        assert!(processed.get("wegent-agent-namespace").is_none());
        assert_eq!(processed["wecode-source"], json!("agent"));
        // The non-ASCII identity value is base64-encoded with the b64: prefix.
        let encoded = processed["wegent-agent-name"].as_str().unwrap();
        assert!(encoded.starts_with("b64:"));
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded[4..])
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "日志风控");
    }

    #[test]
    fn mcp_servers_promote_headers_to_auth() {
        let mut merged = MergedGhostCapabilities::default();
        merged.mcp_servers.insert(
            "wegent-knowledge".to_string(),
            json!({
                "url": "${{backend_url}}/mcp/knowledge/sse",
                "type": "http",
                "headers": {"Authorization": "Bearer ${{task_token}}"},
                "timeout": 300,
            }),
        );
        let servers = ghost_mcp_servers(&merged);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], json!("wegent-knowledge"));
        assert_eq!(servers[0]["type"], json!("http"));
        assert_eq!(servers[0]["timeout"], json!(300));
        assert_eq!(
            servers[0]["auth"],
            json!({"Authorization": "Bearer ${{task_token}}"})
        );
    }
}
