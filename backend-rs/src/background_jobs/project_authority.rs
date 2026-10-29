// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Revalidation uses the shared project role query and the current revocable
//! workspace resource grants. Definition ownership never grants project use.

use super::store::{COLUMNS, LIVE, Node};
use crate::{
    responses::create::resolution::{self, KindRow},
    state::AppState,
};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, MysqlRow};

#[derive(FromMysqlRow)]
struct Parent {
    workspace_id: i64,
}
#[derive(FromMysqlRow)]
struct Grant {
    status: String,
    role: String,
}

pub(crate) async fn require(state: &AppState, project_id: &str, user_id: i64) -> Result<i64> {
    let statement = crate::cloud_projects::project_access_point_statement(
        i32::try_from(user_id)?,
        project_id.parse()?,
    );
    let access: Option<MysqlRow> = state.mysql.fetch_optional(statement, ()).await?;
    let access = access.context("Project not found or membership revoked")?;
    let priority: i64 = access.get_required("anon_3_priority")?;
    if priority > 2 {
        bail!("Insufficient permission to execute in this project")
    }
    parent(state, project_id).await
}

pub(crate) async fn require_issue(
    state: &AppState,
    project: &Node,
    issue: &Node,
    user: i64,
) -> Result<()> {
    if issue.cloud_project_id != project.id {
        bail!("Issue is not in this project")
    }
    let row: Option<MysqlRow> = state
        .mysql
        .fetch_optional(
            crate::cloud_projects::project_access_point_statement(
                i32::try_from(user)?,
                project.id.parse()?,
            ),
            (),
        )
        .await?;
    let row = row.context("Project membership is revoked or unavailable")?;
    let priority: i64 = row.get_required("anon_3_priority")?;
    if priority > 2 {
        bail!("Insufficient permission to execute in this project")
    }
    let security = issue.metadata.0["security_level"]
        .as_str()
        .filter(|v| matches!(*v, "open" | "related"))
        .unwrap_or(
            if project.metadata.0["default_issue_security"] == "related" {
                "related"
            } else {
                "open"
            },
        );
    if priority <= 1
        || security == "open"
        || issue.created_by_user_id == user
        || issue.assignee_user_id == user
    {
        return Ok(());
    }
    let related = crate::loop_tasks::loop_repository::LoopItemRepository::new(&state.mysql)
        .is_related_item(&issue.id, i32::try_from(user)?)
        .await?;
    if !related {
        bail!("Issue is not accessible")
    }
    Ok(())
}

pub(crate) async fn parent(state: &AppState, project_id: &str) -> Result<i64> {
    let row:Option<Parent>=state.mysql.fetch_optional("SELECT CAST(MIN(grant_row.entity_id) AS SIGNED) AS workspace_id FROM resource_members grant_row JOIN kinds workspace ON workspace.id=CAST(grant_row.entity_id AS SIGNED) AND workspace.kind='CollaborationWorkspace' AND workspace.is_active=true WHERE grant_row.resource_type='CloudProject' AND grant_row.resource_id=CAST(? AS SIGNED) AND grant_row.entity_type='workspace' AND grant_row.status='approved' GROUP BY grant_row.resource_id HAVING COUNT(DISTINCT grant_row.entity_id)=1",(project_id,)).await?;
    Ok(row
        .context("Project has no unique active Workspace parent")?
        .workspace_id)
}

pub(crate) async fn team(state: &AppState, project_id: &str, team_id: i64) -> Result<KindRow> {
    let workspace = parent(state, project_id).await?;
    let team = resolution::team_by_id(&state.mysql, team_id)
        .await?
        .context("Agent resource authorization is revoked or unavailable")?;
    let grant:Option<Grant>=state.mysql.fetch_optional("SELECT status,role FROM resource_members WHERE resource_type='Team' AND resource_id=? AND entity_type='workspace' AND entity_id=? LIMIT 1",(team_id,workspace.to_string())).await?;
    let bindings:Vec<Node>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE} AND CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wegent_team_id')) AS SIGNED)=?"),(project_id,team_id)).await?;
    if bindings.is_empty() {
        bail!("Agent is not enabled in this project")
    }
    match grant {
        Some(grant) if approved(&grant) => {}
        None if bindings.iter().any(|binding| {
            !truthy(&binding.metadata.0["authorization_version"])
                && (team.user_id == 0 || binding.created_by_user_id == team.user_id)
        }) => {}
        _ => bail!("Agent resource authorization is revoked or unavailable"),
    }
    Ok(team)
}

fn approved(grant: &Grant) -> bool {
    grant.status == "approved"
        && matches!(grant.role.as_str(), "Owner" | "Maintainer" | "Developer")
}

pub(crate) async fn agent(
    state: &AppState,
    project_id: &str,
    agent_id: &str,
    user_id: i64,
    check_visibility: bool,
) -> Result<Node> {
    let agent:Option<Node>=state.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE}"),(agent_id,project_id)).await?;
    let agent = agent.context("Agent is not enabled in this project")?;
    if check_visibility
        && agent.metadata.0["visibility"] == "private"
        && agent.created_by_user_id != user_id
    {
        bail!("Private Agent is not shared with this member")
    }
    if let Some(team_id) = integer(&agent.metadata.0["wegent_team_id"]).filter(|v| *v != 0) {
        team(state, project_id, team_id).await?;
    } else {
        let workspace = parent(state, project_id).await?;
        let grant:Option<Grant>=state.mysql.fetch_optional("SELECT status,role FROM resource_members WHERE resource_type='Workspace' AND resource_id=? AND entity_type='project_agent' AND entity_id=? LIMIT 1",(workspace,agent_id)).await?;
        if !grant.as_ref().is_some_and(approved)
            && (grant.is_some() || truthy(&agent.metadata.0["authorization_version"]))
        {
            bail!("Agent resource authorization is revoked or unavailable")
        }
    }
    Ok(agent)
}

pub(crate) fn integer(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
}
pub(crate) fn truthy(value: &serde_json::Value) -> bool {
    crate::json_compat::python_truthy(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revoked_and_view_only_resource_grants_do_not_authorize_execution() {
        assert!(approved(&Grant {
            status: "approved".into(),
            role: "Developer".into()
        }));
        assert!(!approved(&Grant {
            status: "pending".into(),
            role: "Owner".into()
        }));
        assert!(!approved(&Grant {
            status: "approved".into(),
            role: "Viewer".into()
        }));
    }
}
