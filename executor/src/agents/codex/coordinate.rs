// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Map Wegent coordinate members to native Codex agent roles.

use sha2::{Digest, Sha256};

use super::*;
use local_model_proxy::{CoordinateMemberRoute, MEMBER_MODEL_MARKER};

const CATALOG_KEY: &str = "codex_coordinate_model_catalog";

fn coordinate_bots(request: &ExecutionRequest) -> Option<&Vec<Value>> {
    request
        .extra
        .get("mode")
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.trim().eq_ignore_ascii_case("coordinate"))
        .then(|| request.bot.as_array().filter(|bots| bots.len() > 1))
        .flatten()
}

pub(super) async fn prepare_catalog(request: &mut ExecutionRequest) -> Result<(), String> {
    request.extra.remove(CATALOG_KEY);
    let needs_catalog = coordinate_bots(request).is_some_and(|bots| {
        bots.iter()
            .skip(1)
            .filter_map(|bot| bot.pointer("/agent_config/env"))
            .any(|env| member_model(env).is_some())
    });
    if needs_catalog {
        let catalog = codex_model_catalog::effective_catalog().await?;
        request.extra.insert(CATALOG_KEY.to_owned(), catalog);
    }
    Ok(())
}

pub(super) fn configure(
    request: &ExecutionRequest,
    launch: &mut CodexLaunchConfig,
) -> Result<(), String> {
    let Some(bots) = coordinate_bots(request) else {
        return Ok(());
    };
    configure_in(
        request,
        launch,
        bots,
        &executor_home().join("codex-coordinate"),
    )
}

fn configure_in(
    request: &ExecutionRequest,
    launch: &mut CodexLaunchConfig,
    bots: &[Value],
    root: &Path,
) -> Result<(), String> {
    let directory = root.join(digest(&request.task_id));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create Codex coordinate directory: {error}"))?;
    let directory = fs::canonicalize(directory)
        .map_err(|error| format!("failed to resolve Codex coordinate directory: {error}"))?;
    let mut routes = HashMap::new();
    let mut aliases = Vec::new();
    let mut roles = Vec::new();
    for (index, bot) in bots.iter().enumerate().skip(1) {
        let name = format!("wegent_member_{index}");
        let description = member_description(bot, index);
        let mut config = member_config(bot, &launch.user_developer_instructions);
        if let Some((alias, model, route)) = member_route(request, bot, &name, launch)? {
            config["model"] = toml_edit::value(alias.clone());
            aliases.push((alias.clone(), model));
            routes.insert(alias, route);
        }
        let content = config.to_string();
        let path = directory.join(format!("{name}-{}.toml", digest(&content)));
        replace_config(&path, content)
            .map_err(|error| format!("failed to write Codex member {name}: {error}"))?;
        launch
            .thread_config
            .insert(format!("agents.{name}.description"), json!(description));
        launch.thread_config.insert(
            format!("agents.{name}.config_file"),
            json!(path.to_string_lossy()),
        );
        roles.push(format!("- `{name}`: {description}"));
    }
    if let Some(registration) = launch.local_proxy_registration.as_deref() {
        local_model_proxy::set_coordinate_members(&registration.0, routes)?;
    }
    configure_model_catalog(request, launch, &directory, &aliases)?;
    launch
        .thread_config
        .insert("agents.enabled".to_owned(), json!(true));
    launch.user_developer_instructions.push_str(&format!(
        "\n\nWegent team coordination:\nYou are the lead bot. Delegate suitable bounded tasks \
         to the configured team members using spawn_agent with the matching agent_type. \
         Their role configurations supply their instructions and models; do not override them. \
         Collect their results and complete the user's task.\n{}",
        roles.join("\n")
    ));
    Ok(())
}

fn member_description(bot: &Value, index: usize) -> String {
    let name = non_empty_config(bot, "name").unwrap_or_else(|| format!("Member {index}"));
    non_empty_config(bot, "description")
        .map(|description| format!("{name}: {description}"))
        .unwrap_or(name)
}

fn member_config(bot: &Value, user_instructions: &str) -> toml_edit::DocumentMut {
    let mut config = toml_edit::DocumentMut::new();
    let prompt = non_empty_config(bot, "system_prompt");
    config["developer_instructions"] = toml_edit::value(codex_thread_developer_instructions(
        user_instructions,
        prompt.as_deref().unwrap_or_default(),
    ));
    let env = bot.pointer("/agent_config/env").unwrap_or(&Value::Null);
    if let Some(model) = member_model(env) {
        config["model"] = toml_edit::value(model);
    }
    if let Some(reasoning) = codex_reasoning_config(env) {
        let reasoning = normalize_reasoning(Some(reasoning));
        if let Some(effort) = reasoning.effort {
            config["model_reasoning_effort"] = toml_edit::value(effort);
        }
        if let Some(summary) = reasoning.summary {
            config["model_reasoning_summary"] = toml_edit::value(summary);
        }
    }
    config
}

fn member_route(
    request: &ExecutionRequest,
    bot: &Value,
    role: &str,
    launch: &CodexLaunchConfig,
) -> Result<Option<(String, String, CoordinateMemberRoute)>, String> {
    let Some(env) = bot
        .pointer("/agent_config/env")
        .filter(|env| env.is_object())
    else {
        return Ok(None);
    };
    let Some(model) = member_model(env) else {
        return Ok(None);
    };
    let explicit_upstream = local_model_proxy::upstream_from_model_config(env);
    let has_provider_settings = [
        "base_url",
        "baseUrl",
        "api_key",
        "apiKey",
        "auth_token",
        "model_provider",
        "codex_model_provider",
        "default_headers",
        "proxy",
        "proxy_url",
    ]
    .iter()
    .any(|key| env.get(*key).is_some_and(|value| !value.is_null()));
    if explicit_upstream.is_none() && has_provider_settings {
        return Err(format!(
            "Codex coordinate member {role} has provider settings without a base URL"
        ));
    }
    let Some(registration) = launch.local_proxy_registration.as_deref() else {
        if explicit_upstream.is_some() {
            return Err("Codex coordinate members with an independent provider require a configured API provider for the lead bot".to_owned());
        }
        // Native Codex roles inherit their parent's login/provider when only a model is set.
        return Ok(None);
    };
    let alias = format!(
        "{model}{MEMBER_MODEL_MARKER}{}",
        digest(&format!("{}:{role}", request.task_id))
    );
    let mut upstream = match explicit_upstream {
        Some(upstream) => upstream,
        None => {
            let mut upstream = local_model_proxy::coordinate_leader_upstream(&registration.0)?;
            upstream.model_id = non_empty_config(env, "model_id");
            upstream
        }
    };
    upstream.routing_model_id = Some(alias.clone());
    Ok(Some((
        alias,
        model,
        CoordinateMemberRoute::new(upstream, vision_sidecar_upstream(env)?),
    )))
}

fn member_model(env: &Value) -> Option<String> {
    codex_request_model(&ExecutionRequest {
        model_config: env.clone(),
        ..ExecutionRequest::default()
    })
}

fn configure_model_catalog(
    request: &ExecutionRequest,
    launch: &mut CodexLaunchConfig,
    directory: &Path,
    aliases: &[(String, String)],
) -> Result<(), String> {
    if aliases.is_empty() {
        return Ok(());
    }
    let mut catalog = request
        .extra
        .get(CATALOG_KEY)
        .cloned()
        .ok_or_else(|| "Codex coordinate model catalog was not prepared".to_owned())?;
    let models = catalog["models"]
        .as_array_mut()
        .ok_or_else(|| "Codex model catalog is missing its models array".to_owned())?;
    for (alias, base) in aliases {
        let mut profile = models.iter().find(|model| model["slug"] == *base).cloned()
            .ok_or_else(|| format!("Codex member model {base} has no catalog profile; configure its codex_catalog_model_id"))?;
        profile["slug"] = json!(alias);
        profile["visibility"] = json!("hide");
        models.push(profile);
    }
    let content = serde_json::to_string(&catalog)
        .map_err(|error| format!("failed to serialize Codex member models: {error}"))?;
    let path = directory.join(format!("models-{}.json", digest(&content)));
    replace_config(&path, content)
        .map_err(|error| format!("failed to write Codex member model catalog: {error}"))?;
    launch.thread_config.insert(
        "model_catalog_json".to_owned(),
        json!(path.to_string_lossy()),
    );
    Ok(())
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinate_members_have_native_roles_prompts_models_and_private_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let request = ExecutionRequest {
            task_id: "coordinate-role-test".to_owned(),
            extra: Map::from_iter([(CATALOG_KEY.to_owned(), codex_model_catalog::catalog())]),
            bot: json!([
                {"name": "Lead", "system_prompt": "lead-only"},
                {"name": "评审员", "system_prompt": "Review \"safety\"\ncarefully.",
                 "agent_config": {"env": {"model_id": "gpt-5.6-luna",
                   "api_key": "member-secret", "base_url": "https://member.example/v1",
                   "reasoning": {"effort": "high"}}}},
                {"name": "评审员", "system_prompt": "Check tests."}
            ]),
            ..ExecutionRequest::default()
        };
        let mut launch = CodexLaunchConfig {
            user_developer_instructions: "Shared instructions".to_owned(),
            ..Default::default()
        };
        configure_codex_router(
            &mut launch,
            &request.task_id,
            local_model_proxy::upstream_from_model_config(&json!({
                "base_url": "https://leader.example/v1", "api_key": "leader-secret"
            }))
            .unwrap(),
            Some("gpt-5.6-sol".to_owned()),
            false,
            None,
        );

        configure_in(
            &request,
            &mut launch,
            request.bot.as_array().unwrap(),
            temp.path(),
        )
        .unwrap();

        let params = thread_start_params(&request, &launch);
        assert!(launch.config_overrides.iter().all(
            |value| !value.starts_with("agents.") && !value.starts_with("model_catalog_json=")
        ));
        let config = &params["config"];
        let path = config["agents.wegent_member_1.config_file"]
            .as_str()
            .unwrap();
        let text = fs::read_to_string(path).unwrap();
        let role: toml_edit::DocumentMut = text.parse().unwrap();
        assert_eq!(
            role["developer_instructions"].as_str(),
            Some(
                codex_thread_developer_instructions(
                    "Shared instructions",
                    "Review \"safety\"\ncarefully."
                )
                .as_str()
            )
        );
        assert_eq!(role["model_reasoning_effort"].as_str(), Some("high"));
        assert!(role["model"]
            .as_str()
            .unwrap()
            .starts_with("gpt-5.6-luna--wegent-member-"));
        assert!(!text.contains("member-secret"));
        assert!(!text.contains("lead-only"));
        assert_eq!(config["agents.wegent_member_2.description"], "评审员");
        assert!(params["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("wegent_member_2"));
        let catalog: Value = serde_json::from_str(
            &fs::read_to_string(config["model_catalog_json"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert!(catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["slug"] == role["model"].as_str().unwrap()));
    }

    #[test]
    fn coordinate_unconfigured_member_inherits_model_and_other_modes_are_unchanged() {
        let mut launch = CodexLaunchConfig::default();
        let request = ExecutionRequest {
            bot: json!([{}, {}]),
            ..Default::default()
        };
        configure(&request, &mut launch).unwrap();
        assert!(launch.config_overrides.is_empty());
        assert!(launch.thread_config.is_empty());
        assert!(member_route(&request, &json!({}), "member", &launch)
            .unwrap()
            .is_none());
    }

    #[test]
    fn coordinate_member_preserves_web_model_reasoning() {
        let bot = json!({"agent_config": {"env": {
            "think_config": {"reasoning": {"effort": "high", "summary": "detailed"}}
        }}});
        let config = member_config(&bot, "");
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("high"));
        assert_eq!(config["model_reasoning_summary"].as_str(), Some("detailed"));
    }

    #[test]
    fn coordinate_file_errors_are_reported() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let request = ExecutionRequest::default();
        let result = configure_in(
            &request,
            &mut CodexLaunchConfig::default(),
            &[json!({}), json!({})],
            temp.path(),
        );
        assert!(result
            .unwrap_err()
            .contains("failed to create Codex coordinate directory"));
    }

    #[test]
    fn coordinate_native_login_retains_member_model_without_provider_overrides() {
        let request = ExecutionRequest::default();
        let bot = json!({"agent_config": {"env": {"model_id": "gpt-5.6-luna"}}});
        let config = member_config(&bot, "");
        assert_eq!(config["model"].as_str(), Some("gpt-5.6-luna"));
        assert!(
            member_route(&request, &bot, "reviewer", &CodexLaunchConfig::default())
                .unwrap()
                .is_none()
        );
        let invalid =
            json!({"agent_config": {"env": {"model_id": "gpt-5.6-luna", "api_key": "custom"}}});
        assert!(member_route(
            &request,
            &invalid,
            "reviewer",
            &CodexLaunchConfig::default()
        )
        .unwrap_err()
        .contains("without a base URL"));
    }

    #[test]
    fn coordinate_catalog_preserves_upstream_profiles_and_rejects_unknown_aliases() {
        let directory = tempfile::tempdir().unwrap();
        let mut catalog = codex_model_catalog::catalog();
        let mut profile = catalog["models"][0].clone();
        profile["slug"] = json!("upstream-only-model");
        profile["context_window"] = json!(123_456);
        catalog["models"]
            .as_array_mut()
            .unwrap()
            .push(profile.clone());
        let request = ExecutionRequest {
            extra: Map::from_iter([(CATALOG_KEY.to_owned(), catalog)]),
            ..Default::default()
        };
        let mut launch = CodexLaunchConfig::default();
        configure_model_catalog(
            &request,
            &mut launch,
            directory.path(),
            &[("member-alias".to_owned(), "upstream-only-model".to_owned())],
        )
        .unwrap();
        let stored: Value = serde_json::from_str(
            &fs::read_to_string(launch.thread_config["model_catalog_json"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let models = stored["models"].as_array().unwrap();
        assert!(models.contains(&profile));
        let member = models
            .iter()
            .find(|model| model["slug"] == "member-alias")
            .unwrap();
        assert_eq!(member["context_window"], 123_456);
        assert!(configure_model_catalog(
            &request,
            &mut launch,
            directory.path(),
            &[("missing-alias".to_owned(), "missing-profile".to_owned())]
        )
        .unwrap_err()
        .contains("has no catalog profile"));
    }

    #[tokio::test]
    async fn coordinate_inherited_models_do_not_load_a_catalog() {
        let mut request = ExecutionRequest {
            bot: json!([{}, {"system_prompt": "Review"}]),
            extra: Map::from_iter([
                ("mode".to_owned(), json!("coordinate")),
                (CATALOG_KEY.to_owned(), json!({"untrusted": true})),
            ]),
            ..Default::default()
        };
        prepare_catalog(&mut request).await.unwrap();
        assert!(!request.extra.contains_key(CATALOG_KEY));
    }
}
