// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Project Agent bindings compile the current Team, Bot, Ghost and Model.

use super::{authority, store::Node};
use crate::{
    responses::create::{ghost, resolution, shell},
    state::AppState,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

fn config_metadata(raw: &Value) -> Value {
    let mut config = json!({});
    for key in [
        "runtime",
        "wegent_team_id",
        "permission_migration_reason",
        "execution_policy",
        "model_policy",
        "default_runtime_profile_id",
        "model",
        "model_type",
    ] {
        config[key] = raw[key].clone();
    }
    for (key, default) in [
        ("execution_environment", json!("local")),
        ("execution_mode", json!("auto")),
        ("plugins", json!([])),
        ("additional_skills", json!([])),
        ("mcp_servers", json!({})),
        ("model_options", json!({})),
        ("system_prompt", json!("")),
        ("routing_configuration_required", json!(false)),
    ] {
        config[key] = raw.get(key).cloned().unwrap_or(default);
    }
    config["visibility"] = json!(
        raw["visibility"]
            .as_str()
            .filter(|value| matches!(*value, "public" | "creator_admin" | "private"))
            .unwrap_or("public")
    );
    config["workspace_policy"] = json!(
        raw["workspace_policy"]
            .as_str()
            .filter(|value| matches!(*value, "project" | "git_worktree"))
            .unwrap_or("project")
    );
    config["max_concurrent_executions"] = json!(
        raw["max_concurrent_executions"]
            .as_i64()
            .filter(|value| (1..=20).contains(value))
            .unwrap_or(1)
    );
    config["capability_mode"] = raw["capability_mode"].clone();
    config
}

/// `validate_team_execution_readiness` (`execution/team_readiness.py`): every
/// Team member's Bot, Ghost, Shell and (when the Bot declares no execution
/// policy) Model must resolve for an authorized Team. Authorization itself is
/// the caller's job, so this never re-queries the Team.
pub(crate) async fn readiness(
    state: &AppState,
    team: &resolution::KindRow,
    execution_user: i64,
) -> Result<()> {
    let resolvers = state.entity_resolvers.for_execution();
    let directory = state
        .entity_resolvers
        .execution_directory(state.erp.as_ref());
    let members = team.json.0["spec"]["members"]
        .as_array()
        .context("Team has no members")?;
    if members.is_empty() {
        bail!("Team has no members")
    }
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(directory),
        resolvers: Some(&resolvers),
    };
    // `_validate_team_member` reads the Bot and its single Ghost reference
    // through `kindReader.get_by_name_and_namespace` (cached version/value
    // reads), never the whole Ghost chain, then resolves the Shell and, when
    // the Bot declares no execution policy, its Model.
    let mut checked: Vec<(String, String)> = Vec::new();
    for member in members {
        let reference = &member["botRef"];
        let namespace = reference["namespace"]
            .as_str()
            .unwrap_or("default")
            .to_owned();
        let name = reference["name"].as_str().unwrap_or("").to_owned();
        if checked
            .iter()
            .any(|ref_| ref_.0 == namespace && ref_.1 == name)
        {
            continue;
        }
        checked.push((namespace.clone(), name.clone()));
        let bot = cache
            .get_by_name_and_namespace_row(team.user_id, "Bot", &namespace, &name)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?
            .with_context(|| format!("Team member Bot '{namespace}/{name}' is unavailable"))?;
        let bot_json = serde_json::to_value(&bot.kinds_json.0).unwrap_or_else(|_| json!({}));
        let spec = &bot_json["spec"];
        let ghost_namespace = spec["ghostRef"]["namespace"]
            .as_str()
            .unwrap_or("default")
            .to_owned();
        let ghost_name = spec["ghostRef"]["name"].as_str().unwrap_or("").to_owned();
        cache
            .get_by_name_and_namespace_row(team.user_id, "Ghost", &ghost_namespace, &ghost_name)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?
            .with_context(|| {
                format!(
                    "Bot '{namespace}/{name}' Ghost '{ghost_namespace}/{ghost_name}' is unavailable"
                )
            })?;
        shell::resolve_shell(
            &state.mysql,
            &resolvers,
            state.redis.as_ref(),
            team.user_id,
            spec["shellRef"]["name"].as_str().unwrap_or(""),
            spec["shellRef"]["namespace"].as_str().unwrap_or("default"),
        )
        .await?
        .context("Wegent Team member Shell is unavailable")?;
        if !spec["execution_policy"].is_object() {
            let name = resolution::resolve_model_name(spec, false, None).unwrap_or_default();
            let model = resolution::resolve_model_for_bot(
                &state.mysql,
                &resolvers,
                state.redis.as_ref(),
                execution_user,
                &name,
            )
            .await?
            .context("Wegent Team member Model is unavailable")?;
            crate::responses::create::model_config::extract_model_config(&model.json.0["spec"])
                .context("Wegent Team member Model configuration is unavailable")?;
        }
    }
    Ok(())
}

pub(crate) async fn compile(state: &AppState, agent: &Node, execution_user: i64) -> Result<Value> {
    let resolvers = state.entity_resolvers.for_execution();
    let directory = state
        .entity_resolvers
        .execution_directory(state.erp.as_ref());
    let mut config = config_metadata(&agent.metadata.0);
    let runtime = config["runtime"].as_str().unwrap_or("").to_owned();
    if !matches!(runtime.as_str(), "codex" | "claude_code" | "wegent") {
        bail!("Project chat agent '{}' has no valid runtime", agent.id)
    }
    if authority::truthy(&config["routing_configuration_required"]) {
        bail!(
            "RUNNER_CONFIGURATION_REQUIRED: Review the migrated agent's environment and model policies"
        )
    }
    if !matches!(
        config["capability_mode"].as_str(),
        Some("follow_device" | "manual")
    ) {
        config["capability_mode"] =
            json!(if ["model", "plugins", "additional_skills", "mcp_servers"]
                .iter()
                .any(|key| authority::truthy(&config[*key]))
            {
                "manual"
            } else {
                "follow_device"
            });
    }
    config["execution_device_id"] = json!(agent.device_id);
    if runtime != "wegent" {
        return Ok(config);
    }
    let team_id = authority::integer(&config["wegent_team_id"])
        .context("Project Agent has an invalid Team binding")?;
    let team = authority::team(state, &agent.cloud_project_id, team_id).await?;
    readiness(state, &team, execution_user).await?;
    let members = team.json.0["spec"]["members"]
        .as_array()
        .context("Team has no members")?;
    if members.is_empty() {
        bail!("Team has no members")
    }
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(directory),
        resolvers: Some(&resolvers),
    };
    if team.json.0["spec"]["collaborationModel"] != "solo" || members.len() != 1 {
        return Ok(config);
    }
    let member = &members[0];
    let reference = &member["botRef"];
    let bot = resolution::resolve_bot(
        &state.mysql,
        team.user_id,
        reference["namespace"].as_str().unwrap_or("default"),
        reference["name"].as_str().unwrap_or(""),
    )
    .await?
    .context("Team Bot is unavailable")?;
    let spec = &bot.json.0["spec"];
    let shell = shell::resolve_shell(
        &state.mysql,
        &resolvers,
        state.redis.as_ref(),
        team.user_id,
        spec["shellRef"]["name"].as_str().unwrap_or(""),
        spec["shellRef"]["namespace"].as_str().unwrap_or("default"),
    )
    .await?
    .context("Team Shell is unavailable")?;
    let native = match shell.json.0["spec"]["shellType"].as_str() {
        Some("Codex") => "codex",
        Some("ClaudeCode") => "claude_code",
        _ => return Ok(config),
    };
    let chain = ghost::load_ghost_chain(
        &cache,
        team.user_id,
        spec["ghostRef"]["namespace"].as_str().unwrap_or("default"),
        spec["ghostRef"]["name"].as_str().unwrap_or(""),
    )
    .await?;
    let own = chain.last().context("Team Ghost is unavailable")?;
    let merged = ghost::merge_ghost_capabilities(if spec["capability_mode"] == "follow_device" {
        &[]
    } else {
        &chain
    });
    if authority::truthy(&spec["routing_configuration_required"]) {
        bail!(
            "RUNNER_CONFIGURATION_REQUIRED: Review the migrated agent's environment and model policies"
        )
    }
    let policy_model = &spec["model_policy"]["model"];
    let cloud = &policy_model["cloud_model"];
    let has_policy = spec["execution_policy"].is_object();
    let has_cloud = policy_model["source"] == "cloud" && cloud.is_object();
    let mut model_options = json!({});
    let (model_name, model_type) = if has_policy {
        if has_cloud {
            model_options = json!({"weworkCloudModelNamespace":cloud["namespace"].as_str().unwrap_or("default"),"weworkCloudModelResourceUserId":authority::integer(&cloud["resource_user_id"]).unwrap_or(0).to_string()});
            (
                cloud["name"].as_str().unwrap_or("").into(),
                cloud["type"].as_str().unwrap_or("user").into(),
            )
        } else {
            (
                policy_model["model_id"].as_str().unwrap_or("").into(),
                "runtime".into(),
            )
        }
    } else {
        let name = resolution::resolve_model_name(spec, false, None).unwrap_or_default();
        let model = if spec["modelRef"].is_object() {
            resolution::model_by_name_namespace(
                &state.mysql,
                execution_user,
                spec["modelRef"]["name"].as_str().unwrap_or(""),
                spec["modelRef"]["namespace"].as_str().unwrap_or("default"),
            )
            .await?
        } else {
            None
        };
        let kind = if let Some(model) = model {
            model_options = json!({"weworkCloudModelNamespace":model.namespace,"weworkCloudModelResourceUserId":model.user_id.to_string()});
            if model.user_id == 0 {
                "public"
            } else if model.namespace == "default" {
                "user"
            } else {
                "group"
            }
        } else {
            "runtime"
        };
        (name, kind.to_owned())
    };
    let additional:Vec<_>=merged.skills.iter().map(|name|json!({"name":name,"namespace":merged.skill_refs.get(name).and_then(|v|v["namespace"].as_str()).or_else(||merged.skill_namespaces.get(name).and_then(Value::as_str)).unwrap_or("default")})).collect();
    let prompt = [
        own.spec["systemPrompt"].as_str().unwrap_or("").trim(),
        member["prompt"].as_str().unwrap_or(""),
    ]
    .into_iter()
    .filter(|v| !v.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    config["runtime"] = json!(native);
    config["model"] = json!(model_name);
    config["model_type"] = json!(model_type);
    config["model_options"] = model_options;
    config["system_prompt"] = json!(if prompt.is_empty() {
        prompt
    } else {
        format!("<base_prompt>\n{prompt}\n</base_prompt>")
    });
    config["additional_skills"] = json!(additional);
    config["mcp_servers"] = json!(merged.mcp_servers);
    for key in ["execution_policy", "model_policy"] {
        if spec[key].is_object() {
            config[key] = spec[key].clone();
        }
    }
    Ok(config)
}
