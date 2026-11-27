//! Shared execution policy helpers for stand-ins and project coordinators.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_background_stand_in_execution(
        &self,
        payload: Value,
        config: &Value,
    ) -> Result<Value, AppIpcError> {
        let catalog = if config["model"].is_null() {
            self.runner_catalog().await?
        } else {
            Value::Null
        };
        let mut config = config.clone();
        config["model"] = background_stand_in_model(&config, &catalog)?;
        self.prepare_stand_in_execution(payload, &config).await
    }

    pub(super) async fn normalize_stand_in_agent(
        &self,
        mut agent: Value,
    ) -> Result<Value, AppIpcError> {
        if !matches!(agent["runtime"].as_str(), Some("codex" | "claude_code")) {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "Choose a Codex or Claude Code agent",
            ));
        }
        if !agent["execution_policy"].is_object() || !agent["model_policy"].is_object() {
            return Err(AppIpcError::new(
                "agent_configuration_required",
                "Configure the agent environment and model before enabling Stand-in",
            ));
        }
        if agent["execution_policy"]["mode"] == "fixed"
            && agent["execution_policy"]["environment_id"] != self.device_id
        {
            // Cloud policies identify a Device resource; local routing uses its Executor id.
            let devices = self
                .runtime_http(reqwest::Method::GET, "/devices/online", None)
                .await?;
            let matches = devices["items"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|device| {
                    device["id"].to_string().trim_matches('"')
                        == agent["execution_policy"]["environment_id"]
                            .to_string()
                            .trim_matches('"')
                        && ["device_id", "app_device_id"]
                            .iter()
                            .any(|key| device[key] == self.device_id)
                });
            if !matches {
                return Err(AppIpcError::new(
                    "agent_device_conflict",
                    "The selected agent requires another device",
                ));
            }
            agent["execution_policy"]["environment_id"] = json!(self.device_id);
        }
        Ok(agent)
    }
}

pub(super) fn apply_stand_in_agent(
    payload: &mut Value,
    agent: &Value,
    catalog: &Value,
    device: &str,
    selected_model: Option<&Value>,
) -> Result<(), AppIpcError> {
    copy_stand_in_team(payload, agent)?;
    resolve_stand_in_routing(payload, agent, catalog, device, selected_model)
}

pub(super) fn bot_instructions(base: &str, bot: &Value) -> String {
    [
        Some(base),
        bot["system_prompt"].as_str(),
        bot["prompt"].as_str(),
    ]
    .into_iter()
    .flatten()
    .filter(|text| !text.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

pub(super) fn lead_instructions(base: &str, mode: Option<&str>, bots: &Value) -> String {
    if mode == Some("pipeline") {
        // The stage compiler adds only the currently executing member's instructions.
        base.to_owned()
    } else {
        bot_instructions(base, &bots[0])
    }
}

pub(super) fn copy_stand_in_team(payload: &mut Value, agent: &Value) -> Result<(), AppIpcError> {
    if !agent["id"].as_str().is_some_and(|id| !id.is_empty())
        || !agent["bot"].as_array().is_some_and(|bots| !bots.is_empty())
    {
        return Err(AppIpcError::new(
            "stand_in_team_missing",
            "Bound Team has no executable Bots",
        ));
    }
    payload["projectInstructions"] = json!(lead_instructions(
        agent["system_prompt"].as_str().unwrap_or_default(),
        agent["collaboration_model"].as_str(),
        &agent["bot"],
    ));
    payload["additionalSkills"] = agent["additional_skills"].clone();
    payload["projectPlugins"] = agent["plugins"].clone();
    payload["teamRef"] = agent["id"].clone();
    payload["collaboration_model"] = agent["collaboration_model"].clone();
    payload["bot"] = agent["bot"].clone();
    Ok(())
}

pub(super) fn resolve_stand_in_routing(
    payload: &mut Value,
    agent: &Value,
    catalog: &Value,
    device: &str,
    selected_model: Option<&Value>,
) -> Result<(), AppIpcError> {
    if let Some(model) = selected_model {
        let fixed = &agent["model_policy"];
        if fixed["mode"] == "fixed"
            && ["runtime", "provider", "model_id", "cloud_model"]
                .iter()
                .any(|key| model[*key] != fixed["model"][*key])
        {
            return Err(AppIpcError::new(
                "agent_model_conflict",
                "The selected agent requires its fixed model",
            ));
        }
    }
    let runtime = agent["runtime"].as_str().unwrap_or("codex");
    let default_model = default_stand_in_model(catalog, runtime).unwrap_or(&Value::Null);
    payload["runtime"] = json!(runtime);
    payload["runnerPolicy"] = json!({"runtime":runtime,"execution_policy":agent["execution_policy"],"model_policy":agent["model_policy"]});
    payload["runnerSelection"] = json!({"execution_policy":{"mode":"fixed","environment_id":device},"model":selected_model.unwrap_or(default_model)});
    crate::task_runtime::runner_routing::resolve_pending(payload, Some(catalog), device)
        .map_err(settings_error)
}

pub(super) fn default_stand_in_model<'a>(catalog: &'a Value, runtime: &str) -> Option<&'a Value> {
    let mut defaults = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["runtime"] == runtime && model["is_default"] == true);
    let selected = defaults.next()?;
    defaults.next().is_none().then_some(selected)
}

/// Resolve the explicit primary Codex model or the unique native default without consulting agents.
pub(super) fn background_stand_in_model(
    config: &Value,
    catalog: &Value,
) -> Result<Value, AppIpcError> {
    let selected = config.get("model").filter(|model| !model.is_null());
    let model = selected.or_else(|| default_stand_in_model(catalog, "codex"));
    model
        .filter(|model| model["runtime"] == "codex")
        .cloned()
        .ok_or_else(|| {
            AppIpcError::new(
                "model_unavailable",
                "Configure an available Codex model for the primary stand-in",
            )
        })
}

pub(super) fn cloud_agent_profile(row: &Value) -> Result<Value, AppIpcError> {
    let team = row["wegentTeamId"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            AppIpcError::new(
                "stand_in_team_missing",
                "Project leader has no saved Team binding",
            )
        })?;
    Ok(json!({
        "version":row["version"],
        "id":team.to_string(),"wegentTeamId":team,"name":row["name"],"runtime":row["runtime"],"status":row["status"],"can_use":row["canUse"],
        "execution_policy":row["executionPolicy"],"model_policy":row["modelPolicy"],"system_prompt":row["systemPrompt"],
        "additional_skills":row["additionalSkills"],"plugins":row["plugins"],"mcp_servers":row["mcpServers"]
    }))
}

#[cfg(test)]
mod background_model_tests {
    use super::*;

    fn catalog() -> Value {
        json!({"models":[
            {"runtime":"claude_code","provider":"claude","model_id":"claude-default","is_default":true},
            {"runtime":"codex","provider":"native","model_id":"native-default","is_default":true},
            {"runtime":"codex","provider":"native","model_id":"other","is_default":false}
        ]})
    }

    #[test]
    fn background_model_uses_the_current_runtime_default_without_a_responsibility() {
        let config = json!({"enabled":true,"prompt":"","preferences":"","connections":[{"policy":{"automatic":true,"askBeforeAct":true,"immediate":false}}]});
        let before = config.clone();
        let model = background_stand_in_model(&config, &catalog()).unwrap();
        assert_eq!(model["model_id"], "native-default");
        assert_eq!(model["runtime"], "codex");
        assert_eq!(
            config, before,
            "Resolving the model must not save settings or alter grants"
        );
    }

    #[test]
    fn background_model_preserves_explicit_selection_even_when_it_is_not_the_default() {
        let explicit =
            json!({"runtime":"codex","provider":"deleted-provider","model_id":"deleted-model"});
        assert_eq!(
            background_stand_in_model(&json!({"model":explicit}), &catalog()).unwrap(),
            explicit
        );
        assert_eq!(
            background_stand_in_model(
                &json!({"model":{"runtime":"claude_code","model_id":"chosen"}}),
                &catalog()
            )
            .unwrap_err()
            .code,
            "model_unavailable"
        );
        assert_eq!(
            background_stand_in_model(&json!({"model":{}}), &catalog())
                .unwrap_err()
                .code,
            "model_unavailable"
        );
    }

    #[test]
    fn background_model_never_picks_an_arbitrary_model_when_default_is_missing_or_ambiguous() {
        for models in [
            json!([]),
            json!([{"runtime":"codex","model_id":"first","is_default":false}]),
            json!([
                {"runtime":"codex","model_id":"first","is_default":true},
                {"runtime":"codex","model_id":"second","is_default":true}
            ]),
        ] {
            assert_eq!(
                background_stand_in_model(&json!({}), &json!({"models":models}))
                    .unwrap_err()
                    .code,
                "model_unavailable"
            );
        }
    }
}
