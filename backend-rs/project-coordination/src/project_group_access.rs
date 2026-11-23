// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Current collaboration-group grants, participant authority and assignment persistence.

use crate::{
    project_authority as authority, project_issues as issues,
    project_store::{self as store, COLUMNS, LIVE, Node},
};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use serde_json::{Value, json};
use wegent_backend_persistence::mysql_query::MysqlQuery;

#[derive(FromMysqlRow)]
struct Group {
    id: i64,
    user_id: i64,
    name: String,
    namespace: String,
    json: Json<Value>,
}
type Id = (i64,);

pub fn current_dispatch(assigned: &Value, context: &Value) -> bool {
    let snapshot = &context["collaboration_group"];
    let assignment_key = assigned["collaboration_group_assignment_key"]
        .as_str()
        .filter(|key| !key.is_empty());
    let group_id = authority::integer(&snapshot["id"]).filter(|id| *id > 0);
    let dispatch_key = context["assignment_key"].as_str().or_else(|| {
        context["run_id"].as_str().map(|run_id| {
            run_id
                .strip_prefix("collaboration-group:")
                .unwrap_or(run_id)
        })
    });
    context["dispatch_kind"] == "collaboration_group"
        && group_id.is_some()
        && group_id == authority::integer(&assigned["collaboration_group"]["id"])
        && group_id == authority::integer(&context["collaboration_group_id"])
        && assignment_key.is_some()
        && assignment_key == dispatch_key
}

async fn authorized_definition(
    mut mysql: &MysqlService,
    project_id: &str,
    id: &str,
    actor: i64,
) -> Result<Value> {
    authorized_definition_on(&mut mysql, project_id, id, actor).await
}

async fn authorized_definition_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    id: &str,
    actor: i64,
) -> Result<Value> {
    authority::require_on(query, project_id, actor).await?;
    let workspace = authority::parent_on(query, project_id).await?;
    let group:Option<Group>=query.fetch_optional("SELECT id,user_id,name,namespace,json FROM kinds WHERE id=? AND kind='CollaborationGroup' AND is_active=true",(id.parse::<i64>()?,)).await?;
    let group = group.context("Collaboration group is unavailable")?;
    let grant:Option<Id>=query.fetch_optional("SELECT id FROM resource_members WHERE resource_type='CollaborationGroup' AND resource_id=? AND entity_type='project' AND entity_id=? AND status='approved' AND role IN ('Owner','Maintainer','Developer') LIMIT 1",(group.id,project_id)).await?;
    if grant.is_none() {
        bail!("Collaboration group is not enabled in this project")
    }
    if group.namespace != format!("projects/{project_id}") {
        let grant:Option<Id>=query.fetch_optional("SELECT id FROM resource_members WHERE resource_type='CollaborationGroup' AND resource_id=? AND entity_type='workspace' AND entity_id=? AND status='approved' AND role IN ('Owner','Maintainer','Developer') LIMIT 1",(group.id,workspace.to_string())).await?;
        if grant.is_none() || group.namespace != format!("workspaces/{workspace}") {
            bail!("Collaboration group resource authorization is revoked")
        }
    }
    let spec = &group.json.0["spec"];
    let snapshot = json!({"id":group.id,"workspace_id":workspace,"owner_type":if group.namespace.starts_with("projects/"){"project"}else{"workspace"},"owner_id":if group.namespace.starts_with("projects/"){project_id.parse::<i64>()?}else{workspace},"name":group.name,"description":spec["description"].as_str().unwrap_or(""),"instructions":spec["instructions"].as_str().unwrap_or(""),"leader":spec.get("leader").filter(|value|value.is_object()).cloned().unwrap_or(json!({})),"members":spec["members"].as_array().cloned().unwrap_or_default(),"coordination_mode":spec["coordinationMode"].as_str().unwrap_or("manager"),"stages":spec["stages"].as_array().cloned().unwrap_or_default(),"execution_requirements":spec.get("executionRequirements").filter(|value|value.is_object()).cloned().unwrap_or(json!({"required_tags":[]})),"version":group.json.0["status"]["version"].as_i64().unwrap_or(1),"created_by_user_id":group.user_id});
    Ok(snapshot)
}

pub async fn authorize(
    mysql: &MysqlService,
    project_id: &str,
    id: &str,
    actor: i64,
) -> Result<Value> {
    let snapshot = authorized_definition(mysql, project_id, id, actor).await?;
    for member in participants(&snapshot)? {
        validate_member(mysql, project_id, member, actor).await?;
    }
    Ok(snapshot)
}

fn participants(group: &Value) -> Result<Vec<&Value>> {
    let mut values = vec![&group["leader"]];
    if let Some(members) = group["members"].as_array() {
        values.extend(members)
    }
    if let Some(stages) = group["stages"].as_array() {
        values.extend(
            stages
                .iter()
                .filter_map(|stage| stage.get("assignee").filter(|value| !value.is_null())),
        )
    }
    if values.iter().any(|value| {
        !matches!(value["kind"].as_str(), Some("human" | "agent")) || member_id(value).is_empty()
    }) {
        bail!("Collaboration group participants are invalid")
    }
    Ok(values)
}
pub fn member_id(value: &Value) -> String {
    value["id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| value["id"].as_i64().map(|id| id.to_string()))
        .unwrap_or_default()
}

async fn validate_member(
    mut mysql: &MysqlService,
    project_id: &str,
    member: &Value,
    actor: i64,
) -> Result<()> {
    validate_member_on(&mut mysql, project_id, member, actor).await
}

async fn validate_member_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    member: &Value,
    actor: i64,
) -> Result<()> {
    let id = member_id(member);
    if member["kind"] == "human" {
        let active: Option<Id> = query
            .fetch_optional(
                "SELECT id FROM users WHERE id=? AND is_active=true",
                (id.parse::<i64>()?,),
            )
            .await?;
        if active.is_none() {
            bail!("Collaboration group participant is unavailable")
        }
        authority::require_on(query, project_id, id.parse()?)
            .await
            .context("Collaboration group participant cannot execute")?;
    } else {
        let agent = resolve_agent_on(query, project_id, &id).await?;
        authority::agent_on(query, project_id, &agent.id, actor, true).await?;
    }
    Ok(())
}

pub async fn authorize_snapshot_on(
    query: &mut impl MysqlQuery,
    project_id: &str,
    snapshot: &Value,
    actor: i64,
) -> Result<()> {
    let current = authorized_definition_on(query, project_id, &member_id(snapshot), actor).await?;
    let identities: std::collections::BTreeSet<_> = participants(&current)?
        .iter()
        .map(|member| {
            (
                member["kind"].as_str().unwrap_or("").to_owned(),
                member_id(member),
            )
        })
        .collect();
    for member in participants(snapshot)? {
        if !identities.contains(&(
            member["kind"].as_str().unwrap_or("").to_owned(),
            member_id(member),
        )) {
            bail!("Collaboration group membership was revoked")
        }
        validate_member_on(query, project_id, member, actor).await?;
    }
    Ok(())
}

pub async fn resolve_agent(mut mysql: &MysqlService, project_id: &str, id: &str) -> Result<Node> {
    resolve_agent_on(&mut mysql, project_id, id).await
}

async fn resolve_agent_on(query: &mut impl MysqlQuery, project_id: &str, id: &str) -> Result<Node> {
    query.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE} AND (id=? OR CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wegent_team_id')) AS CHAR)=?) ORDER BY (id=?) DESC LIMIT 1"),(project_id,id,id,id)).await?.context("Collaboration group member Agent is unavailable")
}

pub async fn apply_assignment_on(
    tx: &mut impl MysqlTransaction,
    project: &Node,
    issue: &Node,
    actor: i64,
    automation: &Value,
) -> brz_mysql::MysqlResult<()> {
    let current = store::locked(tx, "task", &issue.id)
        .await?
        .ok_or(brz_mysql::MysqlError::RowNotFound)?;
    if current.version != issue.version {
        return Err(brz_mysql::MysqlError::InvalidQuery {
            reason: "Issue changed before group assignment".into(),
        });
    }
    let mut metadata = issue.meta();
    let revision = metadata["content_revision"].as_i64().unwrap_or(1) + 1;
    metadata["content_revision"] = json!(revision);
    if !metadata["read_revisions"].is_object() {
        metadata["read_revisions"] = json!({});
    }
    metadata["read_revisions"][actor.to_string()] = json!(revision);
    if issue.status != "in_progress" {
        issues::assignment_status_history(
            &mut metadata,
            project,
            &issue.status,
            "in_progress",
            actor,
        );
        issues::attribute_history(&mut metadata, "status_history", automation);
        if let Some(last) = metadata["status_history"]
            .as_array_mut()
            .and_then(|rows| rows.last_mut())
        {
            last["trigger"] = json!("collaboration_group_assignment");
        }
    }
    tx.execute("UPDATE loop_items SET assignee_user_id=0,assignee_agent_id='',assignee_team_id=0,status='in_progress',completed_at=?,sort_order=0,metadata=?,version=version+1,updated_by_user_id=?,updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",(store::UNSET,Json(metadata),actor,issue.id.as_str())).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_reply_requires_the_current_group_and_assignment() {
        let mut issue = json!({
            "collaboration_group": {"id": "42"},
            "collaboration_group_assignment_key": "current",
        });
        let dispatch = json!({
            "dispatch_kind": "collaboration_group",
            "collaboration_group": {"id": 42},
            "collaboration_group_id": "42",
            "assignment_key": "current",
        });
        assert!(current_dispatch(&issue, &dispatch));
        issue["collaboration_group_assignment_key"] = json!("reassigned");
        assert!(!current_dispatch(&issue, &dispatch));
        issue["collaboration_group_assignment_key"] = json!("current");
        issue["collaboration_group"]["id"] = json!("43");
        assert!(!current_dispatch(&issue, &dispatch));
    }
}
