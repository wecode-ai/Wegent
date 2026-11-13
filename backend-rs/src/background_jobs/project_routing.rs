// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Non-secret runner selection snapshots. Runtime claims retain ownership of
//! final runner affinity, local capacity and credential materialization.

use super::{
    authority,
    store::{self, COLUMNS, LIVE, Node},
};
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(FromMysqlRow)]
struct Device {
    id: i64,
    user_id: i64,
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
    allowed_devices_on(&mut &state.mysql, project_id, agent_id).await
}

pub(crate) async fn allowed_devices_on(
    query: &mut impl PluginQuery,
    project_id: &str,
    agent_id: &str,
) -> Result<BTreeSet<i64>> {
    let workspace = authority::parent_on(query, project_id).await?;
    let workspace_grants:Vec<Grant>=query.fetch_all("SELECT resource_id,status,role FROM resource_members WHERE resource_type='Device' AND entity_type='workspace' AND entity_id=?",(workspace.to_string(),)).await?;
    let project_grants:Vec<Grant>=query.fetch_all("SELECT resource_id,status,role FROM resource_members WHERE resource_type='Device' AND entity_type='project' AND entity_id=?",(project_id,)).await?;
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
    let project = store::get_on(query, "project", project_id)
        .await?
        .context("Project unavailable")?;
    let agents:Vec<Node>=query.fetch_all(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND id=? AND cloud_project_id=? AND status='active' AND {LIVE}"),(agent_id,project_id)).await?;
    for agent in agents {
        if authority::truthy(&agent.metadata.0["authorization_version"])
            || agent.device_id.is_empty()
            || agent.created_by_user_id == 0
        {
            continue;
        }
        if let Some(device) = crate::device_identity::resolve_owned_device_alias_on(
            query,
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
    let all:Vec<Device>=state.mysql.fetch_all("SELECT id,user_id,json FROM kinds WHERE kind='Device' AND namespace='default' AND is_active=true",()).await?;
    let fixed = authority::integer(&policy["environment_id"]);
    let mut candidates: Vec<_> = all
        .into_iter()
        .filter(|device| {
            (allowed.contains(&device.id)
                || super::device_access::personal_fixed_device(
                    &policy,
                    user_id,
                    automatic,
                    super::device_access::personal_owner(device.user_id, &device.json.0),
                    device.id,
                ))
                && (policy["mode"] != "fixed" || Some(device.id) == fixed)
        })
        .collect();
    if candidates.is_empty() {
        super::routing_diagnostics::EnvironmentDenial {
            project_id,
            issue_id: &issue.id,
            agent_id,
            user_id,
            policy: &policy,
            policy_source: &source,
            authorized_ids: &allowed,
        }
        .record(&mut &state.mysql)
        .await;
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
        if selected.is_object() && identity(selected) != identity(&model_policy["model"]) {
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
    actor: i64,
    automatic: bool,
) -> Result<BTreeSet<i64>> {
    candidates_for_snapshot_on(
        &mut &state.mysql,
        project,
        agent,
        snapshot,
        actor,
        automatic,
    )
    .await
}

pub(crate) async fn candidates_for_snapshot_on(
    query: &mut impl PluginQuery,
    project: &str,
    agent: &str,
    snapshot: &Value,
    actor: i64,
    automatic: bool,
) -> Result<BTreeSet<i64>> {
    let allowed = allowed_devices_on(query, project, agent).await?;
    let devices:Vec<Device>=query.fetch_all("SELECT id,user_id,json FROM kinds WHERE kind='Device' AND namespace='default' AND is_active=true",()).await?;
    let fixed = authority::integer(&snapshot["execution_policy"]["environment_id"]);
    Ok(devices
        .into_iter()
        .filter(|device| {
            (allowed.contains(&device.id)
                || super::device_access::personal_fixed_device(
                    &snapshot["execution_policy"],
                    actor,
                    automatic,
                    super::device_access::personal_owner(device.user_id, &device.json.0),
                    device.id,
                ))
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
    cloud_model_selection(state, user_id, model).await?;
    Ok(())
}

/// Resolve the stable model identity for a claimed runner. Cloud credentials
/// stay behind the gateway, and local credentials stay on the device.
pub(crate) async fn runner_model_selection(
    state: &AppState,
    user_id: i64,
    device: &Value,
    model: &Value,
) -> Result<Option<Value>> {
    if model["source"] == "cloud" {
        return cloud_model_selection(state, user_id, model).await.map(Some);
    }
    Ok(native_model_selection(device, model))
}

fn native_model_selection(device: &Value, model: &Value) -> Option<Value> {
    let native = device["spec"]["runnerCatalog"]["models"]
        .as_array()?
        .iter()
        .find(|entry| same_model(entry, model))?;
    let id = native["local_model_id"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    let provider = native["provider"]
        .as_str()
        .filter(|value| !value.is_empty())?;
    Some(json!({
        "model": id,
        "model_type": "runtime",
        "model_options": {"runnerModelProvider": provider},
        "account_label": native["account_label"].as_str().unwrap_or_default(),
    }))
}

async fn cloud_model_selection(state: &AppState, user_id: i64, model: &Value) -> Result<Value> {
    use crate::llm_proxy::model_config::Protocol;
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
    let protocol = crate::llm_proxy::model_config::resolve_llm_proxy_protocol(name, &config)
        .map_err(|error| {
            anyhow::anyhow!("RUNNER_MODEL_UNAVAILABLE: Cloud model protocol is invalid: {error:?}")
        })?;
    let protocol = match protocol {
        Protocol::OpenAiResponses => "openai-responses",
        Protocol::OpenAiChatCompletions => "openai-chat-completions",
        Protocol::AnthropicMessages => "anthropic-messages",
    };
    Ok(json!({
        "model": name,
        "model_type": model_type,
        "model_options": {
            "weworkCloudModelNamespace": namespace,
            "weworkCloudModelResourceUserId": owner.to_string(),
            "weworkCloudModelUpstreamApiFormat": protocol,
        },
        "account_label": format!("cloud_gateway:user:{user_id}"),
    }))
}

pub(crate) async fn issue_binding(state: &AppState, issue: &Node) -> Result<Option<String>> {
    issue_binding_on(&mut &state.mysql, issue).await
}

pub(crate) async fn issue_binding_on(
    query: &mut impl PluginQuery,
    issue: &Node,
) -> Result<Option<String>> {
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
    let history:Vec<History>=query.fetch_all("SELECT DISTINCT executor_owner_user_id AS owner_id,runtime_device_id AS alias FROM loop_item_executions WHERE loop_item_id=? AND runtime_device_id<>'' UNION SELECT DISTINCT task_user_id AS owner_id,device_id AS alias FROM loop_items WHERE resource_type='execution' AND loop_item_id=? AND device_id IS NOT NULL AND device_id<>''",(issue.id.as_str(),issue.id.as_str())).await?;
    let mut ids = BTreeSet::new();
    for value in history {
        let id = crate::device_identity::resolve_owned_device_alias_on(
            query,
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

    #[tokio::test]
    async fn personal_snapshot_candidates_recheck_current_owner_without_sharing() {
        use crate::sql_test_support::mysql_rows::{MysqlRows, Value as Col};
        use std::sync::{
            Arc,
            atomic::{AtomicI64, Ordering},
        };

        let owner = Arc::new(AtomicI64::new(7));
        let current_owner = owner.clone();
        let database = MysqlRows::start_results(move |sql| {
            if sql.contains("AS workspace_id") {
                let row = vec![("workspace_id", Col::I64(9))];
                return (row.clone(), vec![row]);
            }
            if sql.contains("FROM resource_members") {
                return (vec![("resource_id", Col::I64(0)), ("status", Col::Text(String::new())), ("role", Col::Text(String::new()))], vec![]);
            }
            assert!(sql.contains("kind='Device' AND namespace='default' AND is_active=true"), "{sql}");
            let row = vec![
                ("id", Col::I64(42)),
                ("user_id", Col::I64(current_owner.load(Ordering::SeqCst))),
                ("json", Col::Text(json!({"spec":{"runnerCatalog":{"models":[{"runtime":"codex","provider":"p","model_id":"m"}]}}}).to_string())),
            ];
            (row.clone(), vec![row])
        }).await;
        let mut snapshot = json!({"execution_policy":{"mode":"fixed","environment_id":"42"},"model":{"runtime":"codex","provider":"p","model_id":"m"}});
        for (actor, automatic, expected) in [
            (7, false, BTreeSet::from([42])),
            (8, false, BTreeSet::new()),
            (7, true, BTreeSet::new()),
        ] {
            assert_eq!(
                candidates_for_snapshot_on(
                    &mut &database.mysql,
                    "project",
                    "",
                    &snapshot,
                    actor,
                    automatic
                )
                .await
                .unwrap(),
                expected
            );
        }
        owner.store(8, Ordering::SeqCst);
        assert!(
            candidates_for_snapshot_on(&mut &database.mysql, "project", "", &snapshot, 7, false)
                .await
                .unwrap()
                .is_empty()
        );
        owner.store(7, Ordering::SeqCst);
        snapshot["execution_policy"] = json!({"mode":"project_pool"});
        assert!(
            candidates_for_snapshot_on(&mut &database.mysql, "project", "", &snapshot, 7, false)
                .await
                .unwrap()
                .is_empty()
        );
        snapshot["execution_policy"] = json!({"mode":"fixed","environment_id":"42"});
        snapshot["model"]["provider"] = json!("other-provider");
        assert!(
            candidates_for_snapshot_on(&mut &database.mysql, "project", "", &snapshot, 7, false)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn runner_identity_accepts_absent_optional_fields_from_socket_clients() {
        let selected = json!({"runtime":"codex","provider":"openai","model_id":"model"});
        let mut stored = selected.clone();
        stored["source"] = Value::Null;
        stored["cloud_model"] = Value::Null;
        assert_eq!(identity(&selected), identity(&stored));
        stored["model_id"] = json!("different-model");
        assert_ne!(identity(&selected), identity(&stored));
    }

    #[test]
    fn native_selection_uses_the_local_id_without_persisting_credentials() {
        let catalog = json!({"spec": {"runnerCatalog": {"models": [{
            "runtime": "codex", "provider": "openai", "model_id": "catalog-1",
            "local_model_id": "local-1", "account_label": "work", "api_key": "ignored",
        }]}}});
        let model = json!({"runtime": "codex", "provider": "openai", "model_id": "catalog-1"});
        assert_eq!(
            native_model_selection(&catalog, &model),
            Some(json!({
                "model": "local-1", "model_type": "runtime",
                "model_options": {"runnerModelProvider": "openai"}, "account_label": "work",
            }))
        );
        let wrong_runtime =
            json!({"runtime": "claude_code", "provider": "openai", "model_id": "catalog-1"});
        assert!(native_model_selection(&catalog, &wrong_runtime).is_none());
    }

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
