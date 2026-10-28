// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Admission creates the authoritative execution and immutable, non-secret
//! Runtime V2 intent. Runtime remains the owner of claims and termination.

use super::{authority, profile, routing, store::Node};
use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};

pub(crate) struct Admission {
    pub owner: i64,
    pub assigner: i64,
    pub agent_id: String,
    pub team_id: i64,
    pub environment: String,
    pub device_id: String,
    pub context: Value,
    pub runtime_selection: Value,
    pub config: Value,
    pub requires_approval: bool,
    pub waiting_runtime: bool,
}
pub(crate) struct Execution {
    pub id: i64,
    pub status: String,
    pub device_id: String,
}

#[derive(FromMysqlRow)]
struct Previous {
    id: i64,
    attempt_no: i64,
}

pub(crate) async fn prepare(state: &AppState, issue: &Node, input: &mut Admission) -> Result<()> {
    authority::require(state, &issue.cloud_project_id, input.assigner).await?;
    if !input.agent_id.is_empty() {
        authority::agent(
            state,
            &issue.cloud_project_id,
            &input.agent_id,
            input.assigner,
            true,
        )
        .await?;
    }
    if input.team_id != 0 {
        authority::team(state, &issue.cloud_project_id, input.team_id).await?;
    }
    if !input.device_id.is_empty() {
        let device = crate::device_identity::resolve_owned_device_alias(
            &state.mysql,
            input.owner,
            &input.device_id,
        )
        .await?
        .context("Execution device is unavailable")?;
        if !routing::allowed_devices(state, &issue.cloud_project_id, &input.agent_id)
            .await?
            .contains(&device.id)
        {
            bail!("Execution authorization is revoked or unavailable")
        }
        if let Some(identity) = crate::device_identity::resolve_runtime_route_identity(
            &state.mysql,
            input.owner,
            &input.device_id,
        )
        .await?
        {
            input.device_id = identity.runtime_device_id;
        }
    }
    validate_non_secret_plugins(&input.context["project_plugins"])?;
    Ok(())
}

pub(crate) async fn enqueue_on(
    tx: &mut impl MysqlTransaction,
    state: &AppState,
    issue: &Node,
    run: &Node,
    input: &Admission,
) -> MysqlResult<Execution> {
    let scope = if !input.agent_id.is_empty() {
        format!("project_robot:{}", issue.id)
    } else if input.team_id != 0 {
        format!("wegent_team:{}", issue.id)
    } else {
        format!(
            "automation:{}",
            if run.id.is_empty() {
                &issue.id
            } else {
                &run.id
            }
        )
    };
    let status = if input.waiting_runtime {
        "waiting_runtime"
    } else if input.requires_approval {
        "pending_approval"
    } else {
        "queued"
    };
    let payload = json!({"schema_version":2,"runtime_selection":input.runtime_selection,"origin_context":input.context});
    let previous:Option<Previous>=tx.fetch_optional("SELECT id,attempt_no FROM loop_item_executions WHERE execution_scope=? ORDER BY id DESC LIMIT 1 FOR UPDATE",(scope.as_str(),)).await?;
    let attempt = previous
        .as_ref()
        .map_or(1, |previous| previous.attempt_no + 1);
    let previous_id = previous.as_ref().map_or(0, |previous| previous.id);
    let now = Utc::now().naive_utc();
    let note = if input.waiting_runtime {
        "Select a model or workspace before this execution can start"
    } else {
        ""
    };
    let args = vec![
        crate::sql_support::StatementArg::Str(issue.id.clone()),
        crate::sql_support::StatementArg::Str(issue.cloud_project_id.clone()),
        crate::sql_support::StatementArg::Int(input.owner),
        crate::sql_support::StatementArg::Str(input.agent_id.clone()),
        crate::sql_support::StatementArg::Int(input.team_id),
        crate::sql_support::StatementArg::Str(run.id.clone()),
        crate::sql_support::StatementArg::Str(input.environment.clone()),
        crate::sql_support::StatementArg::Str(input.device_id.clone()),
        crate::sql_support::StatementArg::Int(input.assigner),
        crate::sql_support::StatementArg::Str(status.into()),
        crate::sql_support::StatementArg::Int(priority(&issue.priority)),
        crate::sql_support::StatementArg::DateTime(now),
        crate::sql_support::StatementArg::Int(attempt),
        crate::sql_support::StatementArg::Int(previous_id),
        crate::sql_support::StatementArg::Str(scope.clone()),
        crate::sql_support::StatementArg::Str(note.into()),
        crate::sql_support::StatementArg::Str(
            if input.requires_approval {
                "pending"
            } else {
                ""
            }
            .into(),
        ),
        crate::sql_support::StatementArg::Str(payload.to_string()),
    ];
    let inserted=tx.execute("INSERT INTO loop_item_executions (loop_item_id,cloud_project_id,executor_owner_user_id,agent_id,team_id,automation_run_id,execution_environment,execution_device_id,assigner_user_id,status,priority_weight,queued_at,attempt_no,previous_execution_id,execution_scope,execution_note,approval_status,execution_payload,error_message,max_retries,observed_state,sync_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'',1,'unconfirmed','pending')",args).await?;
    let id = inserted.last_insert_id as i64;
    let runtime_task_id = input.context["comment_continue_task_id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("codex-queue-{id}"));
    tx.execute(
        "UPDATE loop_item_executions SET runtime_task_id=? WHERE id=?",
        (runtime_task_id, id),
    )
    .await?;
    if !input.waiting_runtime
        && input.team_id == 0
        && !input.device_id.is_empty()
        && input.runtime_selection["executor_kind"] != "collaboration_group_dispatch"
    {
        let request = profile::build(state, issue, id, input)
            .await
            .map_err(|error| brz_mysql::MysqlError::InvalidQuery {
                reason: error.to_string(),
            })?;
        validate_non_secret_plugins(&request["projectPlugins"]).map_err(|error| {
            brz_mysql::MysqlError::InvalidQuery {
                reason: error.to_string(),
            }
        })?;
        let mut payload = payload.clone();
        payload["runtime_request"] = request;
        tx.execute("UPDATE loop_item_executions SET execution_payload=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(payload.to_string(),id)).await?;
    }
    tx.execute("UPDATE loop_items SET status=?,device_id=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='automation_run'",(if input.waiting_runtime{"waiting_device"}else if input.requires_approval{"pending"}else{"queued"},input.device_id.as_str(),run.id.as_str())).await?;
    Ok(Execution {
        id,
        status: status.into(),
        device_id: input.device_id.clone(),
    })
}

fn priority(value: &str) -> i64 {
    match value {
        "low" => 10,
        "medium" => 20,
        "high" => 30,
        "urgent" => 40,
        _ => 0,
    }
}

fn validate_non_secret_plugins(plugins: &Value) -> Result<()> {
    if plugins.is_null() {
        return Ok(());
    }
    let plugins = plugins
        .as_array()
        .context("Project plugin configuration must be a list")?;
    for plugin in plugins {
        let plugin = plugin
            .as_object()
            .context("Project plugin configuration must be an object")?;
        if let Some(config) = plugin.get("config").filter(|v| !v.is_null()) {
            if !config.is_object() {
                bail!("Plugin config must be an object")
            }
            validate_non_secret_json(config)?;
        }
        if let Some(references) = plugin
            .get("credential_refs")
            .or_else(|| plugin.get("credentialRefs"))
            .filter(|v| !v.is_null())
        {
            let references = references
                .as_array()
                .context("Plugin credential_refs must be a list")?;
            for reference in references {
                if !reference.is_object()
                    || ["name", "ref"].iter().any(|key| {
                        reference[*key]
                            .as_str()
                            .is_none_or(|value| value.trim().is_empty())
                    })
                {
                    bail!("Plugin credential_refs require non-empty name and ref")
                }
            }
        }
    }
    Ok(())
}

fn validate_non_secret_json(value: &Value) -> Result<()> {
    use std::sync::LazyLock;
    static BOUNDARY: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new("([a-z0-9])([A-Z])").expect("static pattern"));
    static NORMALIZE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new("[^a-z0-9]+").expect("static pattern"));
    static PRIVATE_KEY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new("(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----").expect("static pattern")
    });
    match value {
        Value::Object(values) => {
            for (key, value) in values {
                let split = BOUNDARY.replace_all(key, "${1}_${2}").to_lowercase();
                let normalized = NORMALIZE
                    .replace_all(&split, "_")
                    .trim_matches('_')
                    .to_owned();
                if [
                    "api_key",
                    "apikey",
                    "app_secret",
                    "auth_token",
                    "authorization",
                    "bearer_token",
                    "client_secret",
                    "credential",
                    "credentials",
                    "password",
                    "passwd",
                    "private_key",
                    "private_key_pem",
                    "pwd",
                    "refresh_token",
                    "secret",
                    "signing_key",
                    "token",
                ]
                .contains(&normalized.as_str())
                    || normalized.contains("private_key")
                    || [
                        "_api_key",
                        "_auth_token",
                        "_credential",
                        "_credentials",
                        "_password",
                        "_private_key",
                        "_secret",
                        "_token",
                    ]
                    .iter()
                    .any(|suffix| normalized.ends_with(suffix))
                {
                    bail!("Plugin config must not contain credentials; use credential_refs")
                }
                validate_non_secret_json(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_non_secret_json(value)?;
            }
        }
        Value::String(value) if PRIVATE_KEY.is_match(value) => {
            bail!("Plugin config must not contain private key material; use credential_refs")
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_rejects_persisted_plugin_credentials() {
        assert!(
            validate_non_secret_plugins(
                &json!([{"id":"a","config":{"nested":[{"clientSecret":"secret"}]}}])
            )
            .is_err()
        );
        assert!(validate_non_secret_plugins(&json!([{"id":"a","version":"1","credential_refs":[{"name":"auth","ref":"vault:auth"}]}])).is_ok());
    }
}
