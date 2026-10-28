//! Durable snapshots are inputs, never continuing permission grants (CP15/16).

use anyhow::{Context, Result, bail};
use brz_mysql::FromMysqlRow;

use super::super::project::{
    agents, authority, groups, issues, routing,
    store::{self, LIVE},
};
use super::{
    model::{COLUMNS, Execution},
    state,
};
use crate::AppState;

pub(super) async fn sweep(app: &AppState) -> Result<Vec<Execution>> {
    let mut pending: Vec<Execution> = app
        .mysql
        .fetch_all(
            format!("SELECT {COLUMNS} FROM loop_item_executions WHERE status='cancel_requested'"),
            (),
        )
        .await?;
    let rows:Vec<Execution>=app.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE status IN ('pending_approval','waiting_runtime','queued','claimed','running')"),()).await?;
    for row in rows {
        if !authorized(app, &row).await?
            && let Some(cancelled) = state::cancel(
                app,
                &row,
                "Collaboration authorization revoked: issue_or_resource_unavailable",
            )
            .await?
            && cancelled.status == "cancel_requested"
        {
            pending.push(cancelled);
        }
    }
    Ok(pending)
}

pub(super) async fn authorized(app: &AppState, row: &Execution) -> Result<bool> {
    match require(app, row).await {
        Ok(()) => Ok(true),
        Err(error) if infrastructure(&error) => Err(error),
        Err(_) => Ok(false),
    }
}

pub(super) fn infrastructure(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error.is::<brz_mysql::MysqlError>()
            || error.is::<brz_http::Error>()
            || error
                .downcast_ref::<issues::ProviderRequestError>()
                .is_some_and(|error| error.status != 404)
    })
}

async fn require(app: &AppState, row: &Execution) -> Result<()> {
    authority::require(app, &row.cloud_project_id, row.assigner_user_id).await?;
    let project = store::get(&app.mysql, "project", &row.cloud_project_id)
        .await?
        .context("Project unavailable")?;
    let issue = issues::load(app, &project, &row.loop_item_id, row.assigner_user_id).await?;
    authority::require_issue(app, &project, &issue, row.assigner_user_id).await?;
    group(app, row).await?;
    agent_use(app, row, &row.agent_id, row.team_id).await?;
    if row.execution_environment != "wegent" {
        let device = if row.runtime_device_id.is_empty() {
            &row.execution_device_id
        } else {
            &row.runtime_device_id
        };
        if !device.is_empty() {
            let device = crate::device_identity::resolve_owned_device_alias(
                &app.mysql,
                row.executor_owner_user_id,
                device,
            )
            .await?
            .context("Device unavailable")?;
            if !routing::allowed_devices(app, &row.cloud_project_id, &row.agent_id)
                .await?
                .contains(&device.id)
            {
                bail!("Device authorization revoked")
            }
        }
    }
    Ok(())
}

async fn agent_use(
    app: &AppState,
    row: &Execution,
    agent_id: &str,
    mut team_id: i64,
) -> Result<()> {
    if !agent_id.is_empty() {
        let agent = store::get(&app.mysql, "chat_agent", agent_id).await?;
        if let Some(agent) = agent {
            let agent = authority::agent(
                app,
                &row.cloud_project_id,
                &agent.id,
                row.assigner_user_id,
                true,
            )
            .await?;
            team_id = authority::integer(&agent.metadata.0["wegent_team_id"]).unwrap_or(0);
            if !row.assignment_pending() {
                let selection = row.selection();
                let id = selection["runtime_profile_id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .or_else(|| {
                        agent.metadata.0["default_runtime_profile_id"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                    });
                if let Some(id) = id {
                    #[derive(FromMysqlRow)]
                    struct Profile {
                        id: String,
                    }
                    let profile:Option<Profile>=app.mysql.fetch_optional(format!("SELECT id FROM loop_items WHERE id=? AND resource_type='runtime_profile' AND status='active' AND {LIVE}"),(id,)).await?;
                    if profile.as_ref().is_none_or(|profile| profile.id.is_empty()) {
                        bail!("Runtime profile unavailable")
                    }
                }
                if team_id != 0 {
                    agents::compile(app, &agent, row.assigner_user_id).await?;
                }
            }
        } else if let Ok(id) = agent_id.parse::<i64>() {
            team_id = id;
        } else {
            bail!("Agent unavailable")
        }
    }
    if team_id != 0 {
        authority::team(app, &row.cloud_project_id, team_id).await?;
    }
    Ok(())
}

async fn group(app: &AppState, row: &Execution) -> Result<()> {
    let context = row.context();
    let snapshot = &context["collaboration_group"];
    if !snapshot.is_object() {
        return Ok(());
    }
    groups::authorize_snapshot(app, &row.cloud_project_id, snapshot, row.assigner_user_id).await?;
    let mut members = vec![&snapshot["leader"]];
    if let Some(others) = snapshot["members"].as_array() {
        members.extend(others);
    }
    if let Some(stages) = snapshot["stages"].as_array() {
        members.extend(
            stages
                .iter()
                .filter_map(|stage| stage.get("assignee").filter(|value| !value.is_null())),
        );
    }
    for member in members {
        if member["kind"] == "agent" {
            let id = member["id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| member["id"].as_i64().map(|id| id.to_string()))
                .context("Invalid group Agent identity")?;
            agent_use(app, row, &id, 0).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_outages_never_become_collaboration_revocations() {
        for status in [401, 403, 429, 500, 503] {
            assert!(infrastructure(&anyhow::Error::new(
                issues::ProviderRequestError { status }
            )));
        }
        assert!(!infrastructure(&anyhow::Error::new(
            issues::ProviderRequestError { status: 404 }
        )));
        assert!(infrastructure(&anyhow::Error::new(
            brz_mysql::MysqlError::QueryTimedOut
        )));
        assert!(!infrastructure(&anyhow::anyhow!(
            "Agent resource authorization revoked"
        )));
    }
}
