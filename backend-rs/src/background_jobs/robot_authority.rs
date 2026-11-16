//! Durable snapshots are inputs, never continuing permission grants (CP15/16).

use anyhow::{Context, Result, bail};
use brz_mysql::FromMysqlRow;

use super::super::project::{
    agents, authority, groups, issues,
    store::{LIVE, Node},
};
use super::{
    model::{COLUMNS, Execution},
    state,
};
use crate::AppState;
use crate::plugins_marketplace::query::PluginQuery;

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

pub(crate) async fn authorized(app: &AppState, row: &Execution) -> Result<bool> {
    authorized_on(app, &mut &app.mysql, row, None).await
}

/// Validate the current local Issue and revocable grants using the caller's
/// writer transaction when preparing or claiming a row.
pub(crate) async fn authorized_on(
    app: &AppState,
    query: &mut impl PluginQuery,
    row: &Execution,
    locked_issue: Option<&Node>,
) -> Result<bool> {
    match require_on(app, query, row, locked_issue).await {
        Ok(()) => Ok(true),
        Err(error) if infrastructure(&error) => Err(error),
        Err(_) => Ok(false),
    }
}

pub(crate) fn infrastructure(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error.is::<brz_mysql::MysqlError>()
            || error.is::<brz_http::Error>()
            || error
                .downcast_ref::<issues::ProviderRequestError>()
                .is_some_and(|error| error.status != 404)
    })
}

async fn require_on(
    app: &AppState,
    query: &mut impl PluginQuery,
    row: &Execution,
    locked_issue: Option<&Node>,
) -> Result<()> {
    let access =
        authority::execution_access_on(query, &row.cloud_project_id, row.assigner_user_id).await?;
    let project = access.project;
    // The unlocked preflight refreshes external-provider Issues before the
    // writer locks their local carrier.
    let fetched;
    let issue = match locked_issue {
        Some(issue) => issue,
        None => {
            fetched = issues::load_execution_issue(
                app,
                &project,
                &row.loop_item_id,
                row.assigner_user_id,
            )
            .await?;
            &fetched
        }
    };
    authority::require_issue_with_priority_on(
        query,
        &project,
        issue,
        row.assigner_user_id,
        access.priority,
    )
    .await?;
    let context = row.context();
    if context["comment_continue_task_id"].as_str().is_some()
        && context["dispatch_kind"] == "collaboration_group"
        && !groups::current_dispatch(&issue.metadata.0, &context)
    {
        bail!("Collaboration dispatch is no longer active");
    }
    crate::project_coordination::require_execution_binding_on(
        query,
        &row.cloud_project_id,
        row.assigner_user_id,
        &context,
    )
    .await?;
    group_on(app, query, row, access.workspace_id).await?;
    agent_use_on(
        app,
        query,
        row,
        access.workspace_id,
        &row.agent_id,
        row.team_id,
    )
    .await?;
    if row.execution_environment != "wegent" {
        let device = if row.runtime_device_id.is_empty() {
            &row.execution_device_id
        } else {
            &row.runtime_device_id
        };
        if !device.is_empty() {
            // `_device_authorized`: the environment consent first, then the
            // reported Runtime identity.
            let environments = authority::execution_environment_ids_on(
                query,
                &row.cloud_project_id,
                &row.agent_id,
            )
            .await?;
            let device = crate::device_identity::resolve_owned_device_alias_on(
                query,
                row.executor_owner_user_id,
                device,
            )
            .await?
            .context("Device unavailable")?;
            if !environments.contains(&device.id)
                && !row.permits_personal_device(
                    super::super::project::device_access::personal_owner(
                        row.executor_owner_user_id,
                        &device.json,
                    ),
                    device.id,
                )
            {
                bail!("Device authorization revoked")
            }
        }
    }
    Ok(())
}

async fn agent_use_on(
    app: &AppState,
    query: &mut impl PluginQuery,
    row: &Execution,
    workspace_id: i64,
    agent_id: &str,
    mut team_id: i64,
) -> Result<()> {
    if !agent_id.is_empty() {
        let agent = authority::agent_execution_on(
            query,
            &row.cloud_project_id,
            workspace_id,
            agent_id,
            row.assigner_user_id,
        )
        .await?;
        if let Some(agent) = agent {
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
                    let profile:Option<Profile>=query.fetch_optional(format!("SELECT id FROM loop_items WHERE id=? AND resource_type='runtime_profile' AND status='active' AND {LIVE}"),(id,)).await?;
                    if profile.as_ref().is_none_or(|profile| profile.id.is_empty()) {
                        bail!("Runtime profile unavailable")
                    }
                }
                // The Source validates readiness only after the second
                // `require_project_team`, on the Team that check authorized.
            }
        } else if let Ok(id) = agent_id.parse::<i64>() {
            team_id = id;
        } else {
            bail!("Agent unavailable")
        }
    }
    if team_id != 0 {
        let team =
            authority::team_execution_on(query, &row.cloud_project_id, workspace_id, team_id)
                .await?;
        if !row.assignment_pending() {
            agents::readiness(app, &team, row.assigner_user_id).await?;
        }
    }
    Ok(())
}

async fn group_on(
    app: &AppState,
    query: &mut impl PluginQuery,
    row: &Execution,
    workspace: i64,
) -> Result<()> {
    let context = row.context();
    let snapshot = &context["collaboration_group"];
    if !snapshot.is_object() {
        return Ok(());
    }
    groups::authorize_snapshot_on(query, &row.cloud_project_id, snapshot, row.assigner_user_id)
        .await?;
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
            agent_use_on(app, query, row, workspace, &id, 0).await?;
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
