//! Portable, non-secret execution requirements used by the local queue.
use super::TaskRuntimeError;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum ExecutionPolicy {
    ProjectPool,
    Fixed { environment_id: String },
    UserSelect,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum ModelPolicy {
    Fixed { model: ModelIdentity },
    UserSelect,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ModelIdentity {
    runtime: String,
    provider: String,
    model_id: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    cloud_model: Option<CloudModelReference>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct CloudModelReference {
    name: String,
    #[serde(rename = "type")]
    model_type: String,
    namespace: String,
    resource_user_id: u64,
}

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.to_owned())
}

pub(crate) fn validate_policies(
    environment: Option<&Value>,
    model: Option<&Value>,
) -> Result<(), TaskRuntimeError> {
    let environment = environment.filter(|value| !value.is_null());
    let model = model.filter(|value| !value.is_null());
    if environment.is_none() && model.is_none() {
        return Ok(());
    }
    let environment: ExecutionPolicy =
        serde_json::from_value(environment.cloned().unwrap_or(Value::Null))
            .map_err(|_| invalid("RUNNER_CONFIGURATION_REQUIRED: select an environment policy"))?;
    let model: ModelPolicy = serde_json::from_value(model.cloned().unwrap_or(Value::Null))
        .map_err(|_| invalid("RUNNER_CONFIGURATION_REQUIRED: select a model policy"))?;
    let fixed_environment = matches!(&environment, ExecutionPolicy::Fixed { .. });
    if matches!(&environment, ExecutionPolicy::Fixed { environment_id } if environment_id.trim().is_empty())
    {
        return Err(invalid("RUNNER_ENVIRONMENT_REQUIRED: choose a runner"));
    }
    if let ModelPolicy::Fixed { model } = model {
        if model.source.as_deref() == Some("native") && !fixed_environment {
            return Err(invalid(
                "RUNNER_MODEL_UNAVAILABLE: local models require a fixed environment",
            ));
        }
        if !["codex", "claude_code"].contains(&model.runtime.as_str())
            || model.provider.trim().is_empty()
            || model.model_id.trim().is_empty()
        {
            return Err(invalid(
                "RUNNER_MODEL_REQUIRED: choose a stable model identity",
            ));
        }
        match (model.source.as_deref(), model.cloud_model.as_ref()) {
            (Some("cloud"), Some(reference))
                if !reference.name.trim().is_empty()
                    && !reference.namespace.trim().is_empty()
                    && ["public", "user", "group"].contains(&reference.model_type.as_str()) => {}
            (None | Some("native"), None) => {}
            _ => return Err(invalid("RUNNER_MODEL_REQUIRED: invalid model source")),
        }
    }
    Ok(())
}

pub(crate) fn validate_claim(
    payload: &Value,
    catalog: Option<&Value>,
    device: &str,
) -> Result<(), TaskRuntimeError> {
    let Some(routing) = payload.get("runnerRouting") else {
        return Ok(());
    };
    if routing.get("environment_id").and_then(Value::as_str) != Some(device) {
        return Err(invalid(
            "ISSUE_RUNNER_CONFLICT: execution belongs to a different runner",
        ));
    }
    let model = routing
        .get("model")
        .ok_or_else(|| invalid("RUNNER_MODEL_REQUIRED"))?;
    if let Some(runtime) = payload
        .get("runtime")
        .or_else(|| payload.pointer("/runnerPolicy/runtime"))
        .and_then(Value::as_str)
    {
        if model["runtime"] != runtime {
            return Err(invalid(
                "RUNNER_RUNTIME_MISMATCH: the model does not support the agent runtime",
            ));
        }
    }
    let available = if model["source"] == "cloud" {
        catalog.is_some_and(|catalog| {
            catalog["runtimes"]
                .as_array()
                .is_some_and(|runtimes| runtimes.contains(&model["runtime"]))
                || catalog["models"].as_array().is_some_and(|models| {
                    models
                        .iter()
                        .any(|item| item["runtime"] == model["runtime"])
                })
        })
    } else {
        catalog
            .and_then(|c| c.get("models"))
            .and_then(Value::as_array)
            .is_some_and(|models| {
                models.iter().any(|candidate| {
                    ["runtime", "provider", "model_id"]
                        .iter()
                        .all(|key| candidate.get(key) == model.get(key))
                })
            })
    };
    if !available {
        return Err(invalid(
            "RUNNER_MODEL_UNAVAILABLE: runner no longer supports the selected model",
        ));
    }
    Ok(())
}

pub(crate) fn validate_model_runtime(
    policy: Option<&Value>,
    runtime: &str,
) -> Result<(), TaskRuntimeError> {
    if let Some(policy) = policy {
        if policy["mode"] == "fixed" && policy["model"]["runtime"] != runtime {
            return Err(invalid(
                "RUNNER_RUNTIME_MISMATCH: the model does not support the agent runtime",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_automation(
    agent: &Value,
    selection: &Value,
) -> Result<(), TaskRuntimeError> {
    if agent["routing_configuration_required"] == true {
        return Err(invalid(
            "RUNNER_CONFIGURATION_REQUIRED: review the migrated agent policies",
        ));
    }
    if agent
        .get("execution_policy")
        .filter(|v| !v.is_null())
        .is_none()
    {
        return Ok(());
    }
    if agent["execution_policy"]["mode"] == "user_select"
        && !matches!(
            selection["execution_policy"]["mode"].as_str(),
            Some("fixed" | "project_pool")
        )
    {
        return Err(invalid(
            "AUTOMATION_RUNNER_REQUIRED: configure the environment before enabling automation",
        ));
    }
    if agent["model_policy"]["mode"] == "user_select" && !selection["model"].is_object() {
        return Err(invalid(
            "RUNNER_MODEL_REQUIRED: configure the automation model",
        ));
    }
    Ok(())
}

pub(crate) fn resolve_pending(
    payload: &mut Value,
    catalog: Option<&Value>,
    device: &str,
) -> Result<(), TaskRuntimeError> {
    use serde_json::json;
    if payload.get("runnerRouting").is_none() {
        let Some(config) = payload.get("runnerPolicy") else {
            return Ok(());
        };
        let selection = payload.get("runnerSelection").unwrap_or(&Value::Null);
        let mut policy = &config["execution_policy"];
        if policy["mode"] == "user_select" {
            policy = &selection["execution_policy"];
        }
        match policy["mode"].as_str() {
            Some("fixed") if policy["environment_id"] == device => {}
            // Local projects and their queue are owned by this executor. Prepared
            // directory records are a cache, never runner authorization.
            Some("project_pool") => {}
            Some("fixed") => {
                return Err(invalid(
                    "RUNNER_ENVIRONMENT_UNAVAILABLE: runner is not authorized by this policy",
                ))
            }
            _ => return Err(invalid("RUNNER_SELECTION_REQUIRED: select an environment")),
        }
        let model = if config["model_policy"]["mode"] == "fixed" {
            &config["model_policy"]["model"]
        } else {
            &selection["model"]
        };
        if !model.is_object() {
            return Err(invalid("RUNNER_MODEL_REQUIRED: select a model"));
        }
        payload["runnerRouting"] = json!({
            "version":1,
            "execution_policy":policy,"model":model,"environment_id":device,
            "source":if config["execution_policy"]["mode"] == "user_select" {"execution_selection"} else {config["execution_policy"]["mode"].as_str().unwrap_or_default()},
            "model_source":if config["model_policy"]["mode"] == "fixed" {"agent_fixed"} else {"execution_selection"}
        });
    }
    if let Some(config) = payload.get("runnerPolicy") {
        let model = &payload["runnerRouting"]["model"];
        if model["source"] == "native" && config["execution_policy"]["mode"] != "fixed" {
            return Err(invalid(
                "RUNNER_MODEL_UNAVAILABLE: local models require a fixed environment",
            ));
        }
        if config["model_policy"]["mode"] == "fixed" && config["model_policy"]["model"] != *model {
            return Err(invalid(
                "RUNNER_MODEL_FIXED: the execution does not satisfy the agent model policy",
            ));
        }
        if config["execution_policy"]["mode"] == "fixed"
            && config["execution_policy"]["environment_id"] != device
        {
            return Err(invalid(
                "ISSUE_RUNNER_CONFLICT: the agent requires another runner",
            ));
        }
    }
    validate_claim(payload, catalog, device)?;
    let routing = &payload["runnerRouting"];
    let model = &routing["model"];
    let model_config = if model["source"] == "cloud" {
        let reference = model["cloud_model"].clone();
        let model_config = payload
            .get("modelConfig")
            .or_else(|| payload.pointer("/executionRequest/model_config"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        payload["modelId"] = reference["name"].clone();
        payload["modelType"] = reference["type"].clone();
        payload["modelOptions"] = json!({
            "weworkCloudModelNamespace": reference["namespace"],
            "weworkCloudModelResourceUserId": reference["resource_user_id"].to_string(),
        });
        payload["runnerRouting"]["account_label"] = json!("cloud_gateway");
        model_config
    } else {
        let selected = catalog
            .and_then(|v| v["models"].as_array())
            .and_then(|models| {
                models.iter().find(|candidate| {
                    ["runtime", "provider", "model_id"]
                        .iter()
                        .all(|key| candidate.get(key) == model.get(key))
                })
            })
            .ok_or_else(|| invalid("RUNNER_MODEL_UNAVAILABLE"))?;
        let model_config =
            json!({"model_id":selected["local_model_id"],"model_provider":selected["provider"]});
        payload["modelId"] = selected["local_model_id"].clone();
        payload["modelType"] = json!("runtime");
        payload["modelOptions"] = json!({"runnerModelProvider":selected["provider"]});
        payload["runnerRouting"]["account_label"] = selected["account_label"].clone();
        model_config
    };
    payload["modelConfig"] = model_config.clone();
    payload["runnerRouting"]["version"] = json!(1);
    if payload.get("executionRequest").is_none() && payload.get("execution_request").is_none() {
        // Automation compiles its native request on the environment, without a desktop session.
        let request = crate::protocol::ExecutionRequest {
            task_id: payload["taskId"].as_str().unwrap_or_default().to_owned(),
            subtask_id: uuid::Uuid::new_v4().to_string(),
            bot: payload["bot"].clone(),
            model_config: model_config.clone(),
            system_prompt: payload["projectInstructions"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            prompt: payload["message"].clone(),
            new_session: true,
            device_id: Some(device.to_owned()),
            extra: serde_json::Map::from_iter([
                ("origin".into(), payload["origin"].clone()),
                (
                    "additional_skills".into(),
                    payload["additionalSkills"].clone(),
                ),
                (
                    "project_plugin_ids".into(),
                    json!(payload["projectPlugins"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|plugin| plugin["id"].as_str())
                        .collect::<Vec<_>>()),
                ),
                ("preload_skills".into(), payload["additionalSkills"].clone()),
                (
                    "user_selected_skills".into(),
                    payload["additionalSkills"].clone(),
                ),
            ]),
            ..Default::default()
        };
        payload["executionRequest"] =
            serde_json::to_value(request).map_err(|_| invalid("Cannot compile runner request"))?;
    }
    for key in ["executionRequest", "execution_request"] {
        if let Some(request) = payload.get_mut(key).filter(|v| v.is_object()) {
            request["model_config"] = model_config.clone();
        }
    }
    if let Some(profiles) = payload
        .get_mut("memberRuntimeProfiles")
        .and_then(Value::as_array_mut)
    {
        for profile in profiles {
            if let Some(variants) = profile
                .get_mut("modelRuntimeProfiles")
                .and_then(Value::as_array_mut)
            {
                for variant in variants {
                    resolve_pending(&mut variant["runtimePayload"], catalog, device)?;
                }
            }
            resolve_pending(&mut profile["runtimePayload"], catalog, device)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_policy_pairs_and_nonempty_fixed_environment() {
        assert!(validate_policies(
            Some(&json!({"mode":"fixed","environment_id":""})),
            Some(&json!({"mode":"user_select"}))
        )
        .is_err());
        assert!(validate_policies(Some(&json!({"mode":"project_pool"})), None).is_err());
        assert!(validate_policies(
            Some(&json!({"mode":"project_pool"})),
            Some(&json!({"mode":"user_select"}))
        )
        .is_ok());
    }

    #[test]
    fn model_identity_and_affinity_are_both_required() {
        let model = json!({"runtime":"codex","provider":"openai","model_id":"test"});
        let payload = json!({"runnerRouting":{"environment_id":"runner-a","model":model}});
        assert!(validate_claim(&payload, Some(&json!({"models":[model]})), "runner-a").is_ok());
        assert!(validate_claim(&payload, Some(&json!({"models":[model]})), "runner-b").is_err());
        assert!(validate_claim(
            &payload,
            Some(&json!({"models":[{"runtime":"codex","provider":"other","model_id":"test"}]})),
            "runner-a"
        )
        .is_err());
    }
}
