// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Non-secret runner selection snapshots. Runtime claims retain ownership of
//! final runner affinity, local capacity and credential materialization.

use super::{
    authority,
    store::{self, COLUMNS, LIVE, Node},
};
use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(FromMysqlRow)]
struct Device {
    id: i64,
    json: brz_mysql::Json<Value>,
}
#[derive(FromMysqlRow)]
struct Grant {
    resource_id: i64,
    status: String,
    role: String,
}

pub(crate) async fn allowed_devices(
    state: &AppState,
    project_id: &str,
    agent_id: &str,
) -> Result<BTreeSet<i64>> {
    let workspace = authority::parent(state, project_id).await?;
    let workspace_grants:Vec<Grant>=state.mysql.fetch_all("SELECT resource_id,status,role FROM resource_members WHERE resource_type='Device' AND entity_type='workspace' AND entity_id=?",(workspace.to_string(),)).await?;
    let project_grants:Vec<Grant>=state.mysql.fetch_all("SELECT resource_id,status,role FROM resource_members WHERE resource_type='Device' AND entity_type='project' AND entity_id=?",(project_id,)).await?;
    let approved = |grant: &Grant| {
        grant.status == "approved"
            && matches!(grant.role.as_str(), "Owner" | "Maintainer" | "Developer")
    };
    let workspace_ids: BTreeSet<_> = workspace_grants
        .iter()
        .filter(|v| approved(v))
        .map(|v| v.resource_id)
        .collect();
    let mut ids: BTreeSet<_> = project_grants
        .iter()
        .filter(|v| approved(v) && workspace_ids.contains(&v.resource_id))
        .map(|v| v.resource_id)
        .collect();
    if agent_id.is_empty() {
        return Ok(ids);
    }
    let project = store::get(&state.mysql, "project", project_id)
        .await?
        .context("Project unavailable")?;
    let agents:Vec<Node>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND id=? AND cloud_project_id=? AND status='active' AND {LIVE}"),(agent_id,project_id)).await?;
    for agent in agents {
        if authority::truthy(&agent.metadata.0["authorization_version"])
            || agent.device_id.is_empty()
            || agent.created_by_user_id == 0
        {
            continue;
        }
        if let Some(device) = crate::device_identity::resolve_owned_device_alias(
            &state.mysql,
            agent.created_by_user_id,
            &agent.device_id,
        )
        .await?
        {
            let revoked = project.metadata.0["legacy_device_revocations"]
                .as_array()
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|v| authority::integer(v) == Some(device.id))
                });
            if !revoked
                && !workspace_grants
                    .iter()
                    .chain(&project_grants)
                    .any(|grant| grant.resource_id == device.id && !approved(grant))
            {
                ids.insert(device.id);
            }
        }
    }
    Ok(ids)
}

// Routing evaluates the independent source policy, project, issue and actor.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn resolve(
    state: &AppState,
    config: &Value,
    agent_id: &str,
    project_id: &str,
    issue: &Node,
    user_id: i64,
    selection: &Value,
    automatic: bool,
) -> Result<Value> {
    authority::require(state, project_id, user_id).await?;
    if !config["model_policy"].is_object() {
        bail!(
            "RUNNER_CONFIGURATION_REQUIRED: Review the agent execution environment and model configuration"
        )
    }
    let mut policy = config["execution_policy"].clone();
    let mut source = policy["mode"].as_str().unwrap_or("").to_owned();
    let binding = issue_binding(state, issue).await?;
    if source == "user_select" {
        if selection["execution_policy"].is_object()
            && selection["execution_policy"]["mode"] != "user_select"
        {
            policy = selection["execution_policy"].clone();
            source = "execution_selection".into();
        } else if automatic {
            bail!(
                "AUTOMATION_RUNNER_REQUIRED: Configure the automation's runner policy before enabling it"
            )
        } else if let Some(binding) = binding.as_ref() {
            policy = json!({"mode":"fixed","environment_id":binding});
            source = "issue_binding".into();
        } else {
            let user: crate::auth::UserRow = state
                .mysql
                .fetch_one(crate::user_reader::USER_BY_ID_QUERY, (user_id,))
                .await?;
            let preferences =
                serde_json::from_str::<Value>(&user.preferences).unwrap_or(Value::Null);
            let target = preferences["default_execution_target"]
                .as_str()
                .unwrap_or("");
            let device =
                crate::device_identity::resolve_owned_device_alias(&state.mysql, user_id, target)
                    .await?;
            if let Some(device) = device {
                policy = json!({"mode":"fixed","environment_id":device.id.to_string()});
                source = "personal_default".into();
            } else {
                bail!(
                    "RUNNER_SELECTION_REQUIRED: Select an execution environment or configure your personal default"
                )
            }
        }
    } else if selection["execution_policy"].is_object() && selection["execution_policy"] != policy {
        bail!("RUNNER_POLICY_FIXED: The agent's runner policy is fixed")
    }
    if !matches!(policy["mode"].as_str(), Some("project_pool" | "fixed")) {
        bail!("RUNNER_CONFIGURATION_REQUIRED: Invalid environment policy")
    }
    let allowed = allowed_devices(state, project_id, agent_id).await?;
    let all:Vec<Device>=state.mysql.fetch_all("SELECT id,json FROM kinds WHERE kind='Device' AND namespace='default' AND is_active=true",()).await?;
    let fixed = authority::integer(&policy["environment_id"]);
    let mut candidates: Vec<_> = all
        .into_iter()
        .filter(|device| {
            allowed.contains(&device.id) && (policy["mode"] != "fixed" || Some(device.id) == fixed)
        })
        .collect();
    if candidates.is_empty() {
        bail!(
            "RUNNER_ENVIRONMENT_UNAVAILABLE: No execution environment is authorized for this selection"
        )
    }
    if let Some(binding) = binding {
        candidates.retain(|device| device.id.to_string() == binding);
        if candidates.is_empty() {
            bail!(
                "ISSUE_RUNNER_CONFLICT: The Issue's runner does not satisfy this policy or is no longer authorized"
            )
        }
    }
    let model_policy = &config["model_policy"];
    let selected = &selection["model"];
    let mut model = if model_policy["mode"] == "fixed" {
        if selected.is_object() && selected != &model_policy["model"] {
            bail!("RUNNER_MODEL_FIXED: The agent's model is fixed")
        }
        model_policy["model"].clone()
    } else {
        selected.clone()
    };
    if !model.is_object() && !automatic && config["execution_policy"]["mode"] == "fixed" {
        let defaults: Vec<_> = candidates
            .iter()
            .map(|device| {
                device.json.0["spec"]["runnerCatalog"]["models"]
                    .as_array()
                    .and_then(|models| {
                        models.iter().find(|model| {
                            model["runtime"] == config["runtime"] && model["is_default"] == true
                        })
                    })
                    .cloned()
            })
            .collect();
        if let Some(first) = defaults.first().and_then(Option::as_ref)
            && defaults
                .iter()
                .all(|v| v.as_ref().is_some_and(|v| same_model(v, first)))
        {
            model = identity(first);
        }
    }
    if !model.is_object() {
        bail!("RUNNER_MODEL_REQUIRED: Select a model before starting this execution")
    }
    if model["runtime"] != config["runtime"] {
        bail!("RUNNER_RUNTIME_MISMATCH: The model does not support the agent's runtime")
    }
    model = identity(&model);
    if model["source"] == "cloud" {
        require_cloud_model(state, user_id, &model).await?;
    } else if model["source"] == "native" && config["execution_policy"]["mode"] != "fixed" {
        bail!("RUNNER_MODEL_UNAVAILABLE: Local models require a fixed environment")
    }
    candidates.retain(|device| supports(&device.json.0, &model));
    if candidates.is_empty() {
        bail!(
            "RUNNER_MODEL_UNAVAILABLE: No authorized environment supports the selected model; choose an environment or repair its model configuration"
        )
    }
    Ok(
        json!({"version":1,"execution_policy":policy,"model":model,"source":source,"model_source":if model_policy["mode"]=="fixed"{"agent_fixed"}else if selected.is_object(){"execution_selection"}else{"environment_default"}}),
    )
}

pub(crate) async fn candidates_for_snapshot(
    state: &AppState,
    project: &str,
    agent: &str,
    snapshot: &Value,
) -> Result<BTreeSet<i64>> {
    let allowed = allowed_devices(state, project, agent).await?;
    let devices:Vec<Device>=state.mysql.fetch_all("SELECT id,json FROM kinds WHERE kind='Device' AND namespace='default' AND is_active=true",()).await?;
    let fixed = authority::integer(&snapshot["execution_policy"]["environment_id"]);
    Ok(devices
        .into_iter()
        .filter(|device| {
            allowed.contains(&device.id)
                && (snapshot["execution_policy"]["mode"] != "fixed" || Some(device.id) == fixed)
                && supports(&device.json.0, &snapshot["model"])
        })
        .map(|device| device.id)
        .collect())
}

fn identity(model: &Value) -> Value {
    let mut value = json!({"runtime":model["runtime"],"provider":model["provider"],"model_id":model["model_id"]});
    for key in ["source", "cloud_model"] {
        if !model[key].is_null() {
            value[key] = model[key].clone()
        }
    }
    value
}
fn same_model(a: &Value, b: &Value) -> bool {
    a["runtime"] == b["runtime"] && a["provider"] == b["provider"] && a["model_id"] == b["model_id"]
}
fn supports(device: &Value, model: &Value) -> bool {
    let catalog = &device["spec"]["runnerCatalog"];
    let models = catalog["models"].as_array();
    if model["source"] == "cloud" {
        catalog["runtimes"]
            .as_array()
            .is_some_and(|v| v.contains(&model["runtime"]))
            || models.is_some_and(|models| models.iter().any(|v| v["runtime"] == model["runtime"]))
    } else {
        models.is_some_and(|models| models.iter().any(|v| same_model(v, model)))
    }
}

pub(crate) async fn require_cloud_model(
    state: &AppState,
    user_id: i64,
    model: &Value,
) -> Result<()> {
    let reference = &model["cloud_model"];
    let name = reference["name"]
        .as_str()
        .context("Cloud model identity is unavailable")?;
    let user: crate::auth::UserRow = state
        .mysql
        .fetch_one(crate::user_reader::USER_BY_ID_QUERY, (user_id,))
        .await?;
    let model_type = reference["type"]
        .as_str()
        .context("Cloud model identity is unavailable")?;
    let namespace = reference["namespace"]
        .as_str()
        .context("Cloud model identity is unavailable")?;
    let owner = authority::integer(&reference["resource_user_id"])
        .context("Cloud model identity is unavailable")?;
    let config =
        crate::llm_proxy::resolve_model_config(state, &user, name, model_type, namespace, owner)
            .await
            .map_err(|error| {
                anyhow::anyhow!("RUNNER_MODEL_UNAVAILABLE: Cloud model is unavailable: {error:?}")
            })?;
    crate::llm_proxy::model_config::resolve_llm_proxy_protocol(name, &config).map_err(|error| {
        anyhow::anyhow!("RUNNER_MODEL_UNAVAILABLE: Cloud model protocol is invalid: {error:?}")
    })?;
    Ok(())
}

pub(crate) async fn issue_binding(state: &AppState, issue: &Node) -> Result<Option<String>> {
    let metadata = &issue.metadata.0;
    if authority::truthy(&metadata["runner_binding_conflict"]) {
        bail!(
            "ISSUE_RUNNER_CONFIGURATION_REQUIRED: Historical executions used conflicting or unavailable runners; review the Issue binding"
        )
    }
    if !metadata["runner_binding"].is_null() {
        let id = authority::integer(&metadata["runner_binding"]["environment_id"])
            .filter(|v| *v > 0)
            .context("ISSUE_RUNNER_CONFIGURATION_REQUIRED: Invalid Issue runner binding")?;
        return Ok(Some(id.to_string()));
    }
    #[derive(FromMysqlRow)]
    struct History {
        owner_id: i64,
        alias: String,
    }
    let history:Vec<History>=state.mysql.fetch_all("SELECT DISTINCT executor_owner_user_id AS owner_id,runtime_device_id AS alias FROM loop_item_executions WHERE loop_item_id=? AND runtime_device_id<>'' UNION SELECT DISTINCT task_user_id AS owner_id,device_id AS alias FROM loop_items WHERE resource_type='execution' AND loop_item_id=? AND device_id IS NOT NULL AND device_id<>''",(issue.id.as_str(),issue.id.as_str())).await?;
    let mut ids = BTreeSet::new();
    for value in history {
        let id = crate::device_identity::resolve_owned_device_alias(
            &state.mysql,
            value.owner_id,
            &value.alias,
        )
        .await?
        .map(|device| device.id.to_string())
        .unwrap_or_else(|| format!("unresolved:{}:{}", value.owner_id, value.alias));
        ids.insert(id);
    }
    if ids.is_empty() {
        return Ok(None);
    }
    if ids.len() == 1 && !ids.first().unwrap().starts_with("unresolved:") {
        return Ok(ids.pop_first());
    }
    bail!(
        "ISSUE_RUNNER_CONFIGURATION_REQUIRED: Historical executions used conflicting or unavailable runners; review the Issue binding"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_models_match_full_identity_while_cloud_uses_runtime_support() {
        let device = json!({"spec":{"runnerCatalog":{"models":[{"runtime":"codex","provider":"a","model_id":"m"}],"runtimes":["claude_code"]}}});
        assert!(supports(
            &device,
            &json!({"runtime":"codex","provider":"a","model_id":"m","source":"native"})
        ));
        assert!(!supports(
            &device,
            &json!({"runtime":"codex","provider":"b","model_id":"m","source":"native"})
        ));
        assert!(supports(
            &device,
            &json!({"runtime":"claude_code","source":"cloud"})
        ));
    }
}
