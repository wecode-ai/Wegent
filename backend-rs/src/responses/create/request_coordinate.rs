// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::super::{
    bot_config::{BotConfigInput, build_bot_config},
    dispatch::ExecutionRequest,
    ghost::{
        MergedGhostCapabilities, bot_system_prompt, load_ghost_chain, merge_ghost_capabilities,
    },
    mcp_servers::ghost_mcp_servers,
    model_config::{
        build_agent_config, inline_agent_config_ready, process_model_config_placeholders,
    },
    resolution::{resolve_bot, resolve_model_for_bot_with_override, resolve_model_name},
};
use super::{BuildExecutionRequestInput, dependency, model_resolution_error, resolve_shell_type};
use crate::{
    http_compat::FastApiError, llm_proxy::CredentialRequest, state::AppState,
    task_skills::kinds::KindCacheStore,
};

/// Publish each compiled server once. Executor merges duplicate definitions by
/// name and can otherwise carry headers across different endpoints.
pub(super) fn keep_compiled_mcp_servers(request: &mut ExecutionRequest) {
    let Some((leader, members)) = request
        .bot
        .as_array_mut()
        .and_then(|bots| bots.split_first_mut())
    else {
        return;
    };
    let Some(servers) = leader["mcp_servers"].as_array_mut() else {
        return;
    };
    // Skill MCPs are appended after Ghost MCPs, including late preloads.
    let mut names = HashSet::new();
    servers.reverse();
    servers.retain(|server| {
        server["name"]
            .as_str()
            .is_none_or(|name| names.insert(name.to_owned()))
    });
    servers.reverse();
    for member in members {
        member["mcp_servers"] = Value::Array(Vec::new());
    }
    request.mcp_servers.retain(|server| {
        server["name"]
            .as_str()
            .is_none_or(|name| !names.contains(name))
    });
}

pub(super) async fn members(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    runtime_model: Option<&Map<String, Value>>,
    leader_shell: &str,
) -> Result<Vec<Value>, FastApiError> {
    let mut configs = Vec::new();
    let cache = KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    for member in input.team.json.0["spec"]["members"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let reference = &member["botRef"];
        let Some(name) = reference["name"].as_str() else {
            continue;
        };
        let namespace = reference["namespace"].as_str().unwrap_or("default");
        if name == input.bot.name && namespace == input.bot.namespace {
            continue;
        }
        let Some(bot) = resolve_bot(&state.mysql, input.team.user_id, namespace, name)
            .await
            .map_err(dependency)?
        else {
            continue;
        };
        if bot.id == input.bot.id {
            continue;
        }
        let member_input = BuildExecutionRequestInput {
            bot: &bot,
            bot_role: member["role"]
                .as_str()
                .filter(|role| !role.is_empty())
                .unwrap_or("worker"),
            team_member_prompt: member["prompt"].as_str(),
            ..*input
        };
        configs.push(
            build_member(
                state,
                &member_input,
                &cache,
                runtime_model,
                leader_shell == "Codex",
            )
            .await?,
        );
    }
    Ok(configs)
}

async fn build_member(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    cache: &KindCacheStore<'_, impl brz_mysql::Mysql, impl brz_redis::Redis>,
    runtime_model: Option<&Map<String, Value>>,
    codex_leader: bool,
) -> Result<Value, FastApiError> {
    let spec = &input.bot.json.0["spec"];
    let capability_mode = spec["capability_mode"].as_str().unwrap_or("manual");
    let (shell_type, base_image) = resolve_shell_type(state, input).await?;
    let ghost_ref = &spec["ghostRef"];
    let ghost_namespace = ghost_ref["namespace"].as_str().unwrap_or("default");
    let ghost_name = ghost_ref["name"].as_str().unwrap_or("");
    let ghost = if capability_mode != "follow_device" && !ghost_name.is_empty() {
        let chain = load_ghost_chain(cache, input.team.user_id, ghost_namespace, ghost_name)
            .await
            .map_err(|error| {
                tracing::error!(%error, bot_id = input.bot.id, "failed to load team member Ghost");
                FastApiError::internal()
            })?;
        merge_ghost_capabilities(&chain)
    } else {
        MergedGhostCapabilities::default()
    };
    let system_prompt = bot_system_prompt(
        &state.mysql,
        input.team.user_id,
        ghost_namespace,
        ghost_name,
        input.team_member_prompt,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, bot_id = input.bot.id, "failed to read team member prompt");
        FastApiError::internal()
    })?;
    let agent_config = member_model(state, input, spec, runtime_model, codex_leader).await?;
    Ok(build_bot_config(&BotConfigInput {
        id: input.bot.id,
        name: &input.bot.name,
        shell_type: &shell_type,
        agent_config,
        system_prompt: &system_prompt,
        mcp_servers: ghost_mcp_servers(&ghost),
        plugins: ghost.plugins.clone(),
        skills: ghost.skills.iter().cloned().map(Value::String).collect(),
        skill_refs: Value::Object(ghost.skill_refs.clone()),
        preload_skills: if ghost.skills.is_empty() {
            Vec::new()
        } else {
            ghost.preload_skills.clone()
        },
        capability_mode,
        role: input.bot_role,
        base_image: base_image.as_deref(),
    }))
}

async fn member_model(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    spec: &Value,
    runtime_model: Option<&Map<String, Value>>,
    codex_leader: bool,
) -> Result<Value, FastApiError> {
    if let Some(model) = runtime_model {
        return Ok(serde_json::json!({
            "protocol": model.get("protocol"), "apiFormat": model.get("api_format"), "env": model,
        }));
    }
    let labels = &input.task_json["metadata"]["labels"];
    let force_override = labels["forceOverrideBotModel"].as_str() == Some("true");
    let override_name = labels["modelId"].as_str();
    let empty_config = Value::Object(Map::new());
    let raw = spec.get("agent_config").unwrap_or(&empty_config);
    let resolved = match resolve_model_name(spec, force_override, override_name)
        .filter(|_| !inline_agent_config_ready(raw, force_override, override_name))
    {
        Some(name) => resolve_model_for_bot_with_override(
            &state.mysql,
            &state.entity_resolvers,
            state.redis.as_ref(),
            input.user_id,
            &name,
            spec,
            &input.bot.name,
            override_name,
        )
        .await
        .map_err(model_resolution_error)?,
        None => None,
    };
    let model_spec = resolved.as_ref().map(|model| &model.json.0["spec"]);
    let mut config = build_agent_config(raw, force_override, override_name, model_spec);
    if codex_leader && let Some(env) = config.get_mut("env").and_then(Value::as_object_mut) {
        process_model_config_placeholders(
            env,
            input.user_id,
            input.user_name,
            raw,
            input.task_id,
            input.team,
        );
        if let Some(api_key) = env.get("api_key").and_then(Value::as_str) {
            let resolved = state
                .llm_proxy_credentials
                .provider_api_key(CredentialRequest {
                    api_key,
                    api_key_template: env.get("_api_key_template").and_then(Value::as_str),
                    user_id: input.user_id,
                    user_name: input.user_name,
                })
                .await?;
            env.insert("api_key".into(), Value::String(resolved));
        }
    }
    Ok(config)
}
