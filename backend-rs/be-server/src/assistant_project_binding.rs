//! Adopt an owner's portable roster using independently authorized project Agents.
use super::{Definition, SessionUser, internal, storage, valid_definition};
use crate::{http_compat::FastApiError, state::AppState};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use wegent_project_coordination::project_authority as authority;
use wegent_protocol::assistant_share::AssistantTeamDefinition;

#[path = "assistant_project_team.rs"]
mod source_team;
use source_team::PortableTeam;

pub(super) const BINDING: &str = "PersonalTeamProjectBinding";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Adoption {
    root: Definition,
    member_agent_ids: BTreeMap<String, String>,
    #[serde(default)]
    member_team_definitions: BTreeMap<String, PortableTeam>,
    #[serde(default)]
    member_source_team_ids: BTreeMap<String, i64>,
    expected_revision: Option<u64>,
}

#[derive(Serialize)]
pub(super) struct Adopted {
    group_id: String,
    publication_id: String,
    revision: u64,
}

fn valid_mapping(team: &AssistantTeamDefinition, agents: &BTreeMap<String, String>) -> bool {
    team.members.keys().eq(agents.keys())
        && agents.values().all(|id| !id.is_empty() && id.len() <= 64)
        && agents.values().collect::<BTreeSet<_>>().len() == agents.len()
        && team.name.chars().count() <= 100
        && team
            .members
            .values()
            .all(|duty| duty.chars().count() <= 2000)
}

#[derive(FromMysqlRow)]
struct Group {
    id: i64,
    document: Json<Value>,
}

fn apply_roster(doc: &mut Value, team: &AssistantTeamDefinition, revision: u64) -> bool {
    let source = &mut doc["metadata"]["personalTeamSource"];
    if let Some(agents) = source["agents"].as_object_mut() {
        agents.retain(|role, _| team.members.contains_key(role));
    }
    if team.name.chars().count() > 100
        || team
            .members
            .values()
            .any(|duty| duty.chars().count() > 2000)
    {
        return false;
    }
    let mut members = Vec::with_capacity(team.members.len());
    let mut leader = None;
    for (role, duty) in &team.members {
        let Some(agent) = source["agents"].get(role) else {
            return false;
        };
        let member =
            json!({"kind":"agent","id":agent["id"],"name":agent["name"],"responsibility":duty});
        if role == &team.lead_id {
            leader = Some(member.clone());
        }
        members.push(member);
    }
    let Some(leader) = leader else { return false };
    let ids: BTreeSet<_> = members
        .iter()
        .filter_map(|member| member["id"].as_str())
        .collect();
    for stage in doc["spec"]["stages"].as_array_mut().into_iter().flatten() {
        if let Some(id) = stage["assignee"]["id"].as_str()
            && (!ids.contains(id) || stage["assignee"]["id"] == leader["id"])
        {
            stage["assignee"] = Value::Null;
        }
    }
    doc["metadata"]["name"] = json!(team.name);
    doc["metadata"]["personalTeamSource"]["revision"] = json!(revision);
    doc["spec"]["leader"] = leader;
    doc["spec"]["members"] = Value::Array(members);
    doc["status"]["state"] = json!("active");
    true
}

async fn persist_group(
    tx: &mut impl MysqlTransaction,
    group: &mut Group,
    team: &AssistantTeamDefinition,
    revision: u64,
) -> MysqlResult<()> {
    let doc = &mut group.document.0;
    let renamed = doc["metadata"]["name"] != team.name;
    let collision = if renamed {
        tx.fetch_optional::<_,_,i64>(
            "SELECT 1 FROM resource_members own JOIN resource_members other ON other.entity_type='project' AND other.entity_id=own.entity_id AND other.resource_type='CollaborationGroup' AND other.status='approved' JOIN kinds g ON g.id=other.resource_id AND g.kind='CollaborationGroup' AND g.is_active=TRUE AND g.name=? WHERE own.resource_type='CollaborationGroup' AND own.resource_id=? AND own.entity_type='project' AND own.status='approved' AND g.id<>own.resource_id LIMIT 1",
            (team.name.as_str(),group.id)).await?.is_some()
    } else {
        false
    };
    if collision || !apply_roster(doc, team, revision) {
        doc["status"]["state"] = json!("binding_required");
        doc["status"]["bindingIssue"] = json!(if collision {
            "name_conflict"
        } else {
            "member_mapping"
        });
        doc["metadata"]["personalTeamSource"]["revision"] = json!(revision);
    } else if let Some(status) = doc["status"].as_object_mut() {
        status.remove("bindingIssue");
    }
    doc["status"]["version"] = json!(doc["status"]["version"].as_u64().unwrap_or(0) + 1);
    let name = doc["metadata"]["name"].as_str().unwrap_or(&team.name);
    tx.execute(
        "UPDATE kinds SET json=?,name=?,updated_at=NOW() WHERE id=? AND kind='CollaborationGroup'",
        (Json(&*doc), name, group.id),
    )
    .await?;
    Ok(())
}

/// Update adopted rosters in the same transaction as their owner's revision.
pub(super) async fn refresh(
    tx: &mut impl MysqlTransaction,
    publication: i32,
    team: &AssistantTeamDefinition,
    revision: u64,
) -> MysqlResult<()> {
    let projects: Vec<(String, i64)> = tx
        .fetch_all(
            "SELECT DISTINCT p.entity_id, publication.user_id
             FROM resource_members b
             JOIN kinds publication ON publication.id=b.resource_id
                AND publication.kind='PersonalAssistantPublication'
             JOIN resource_members p ON p.resource_type='CollaborationGroup'
                AND p.resource_id=CAST(b.entity_id AS UNSIGNED)
                AND p.entity_type='project' AND p.status='approved'
             WHERE b.resource_type=? AND b.resource_id=?
               AND b.entity_type='collaboration_group' AND b.status='approved'
             ORDER BY p.entity_id",
            (BINDING, publication),
        )
        .await?;
    for (project, owner) in projects {
        if !lock_project(tx, &project).await? {
            continue;
        }
        match authority::execution_priority_on(&mut &mut *tx, &project, owner).await {
            Ok(priority) if priority <= 1 => {}
            Err(error) if error.is::<brz_mysql::MysqlError>() => {
                return Err(error.downcast().unwrap());
            }
            _ => continue,
        }
        let group: Option<Group> = tx.fetch_optional("SELECT g.id,g.json AS document FROM resource_members b JOIN kinds g ON g.id=CAST(b.entity_id AS UNSIGNED) AND g.kind='CollaborationGroup' AND g.is_active=TRUE JOIN resource_members p ON p.resource_type='CollaborationGroup' AND p.resource_id=g.id AND p.entity_type='project' AND p.status='approved' AND p.entity_id=? WHERE b.resource_type=? AND b.resource_id=? AND b.entity_type='collaboration_group' AND b.status='approved' FOR UPDATE",(project,BINDING,publication)).await?;
        if let Some(mut group) = group {
            persist_group(tx, &mut group, team, revision).await?;
        }
    }
    Ok(())
}

#[brz_http_server::put("/api/v1/cloud-projects/:project_id/personal-team-bindings/:source_id")]
pub(super) async fn adopt(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    project_id: i64,
    source_id: &str,
    body: Adoption,
) -> Result<Adopted, FastApiError> {
    let Definition::Team(team) = &body.root else {
        return Err(invalid());
    };
    if team.id != source_id
        || !valid_definition(&body.root)
        || !valid_mapping(team, &body.member_agent_ids)
        || !body
            .member_team_definitions
            .keys()
            .chain(body.member_source_team_ids.keys())
            .all(|role| team.members.contains_key(role))
        || !team.members.keys().all(|role| {
            body.member_source_team_ids.contains_key(role)
                || body.member_team_definitions.contains_key(role)
        })
    {
        return Err(invalid());
    }
    let project = project_id.to_string();
    let mut preview = source_team::Preview::default();
    for (role, portable) in &body.member_team_definitions {
        if body.member_source_team_ids.contains_key(role) {
            continue;
        }
        if preview.teams.is_empty()
            && authority::execution_priority(&state.mysql, &project, i64::from(user.0.id))
                .await
                .map_err(project_access_error)?
                > 1
        {
            return Err(FastApiError::forbidden(
                "Project Maintainer access required",
            ));
        }
        let agent = authority::agent(
            &state.mysql,
            &project,
            &body.member_agent_ids[role],
            i64::from(user.0.id),
            true,
        )
        .await
        .map_err(project_access_error)?;
        if !portable
            .matches_config(state, &agent, &mut preview)
            .await
            .map_err(internal)?
        {
            return Err(source_mismatch());
        }
    }
    state
        .mysql
        .with_transaction(async |tx| bind_on(&preview, tx, user.0.id, &project, &body, team).await)
        .await
        .map_err(internal)?
}

async fn lock_project(tx: &mut impl MysqlTransaction, project: &str) -> MysqlResult<bool> {
    let locked: Option<i64> = tx.fetch_optional("SELECT 1 FROM loop_items WHERE resource_type='project' AND id=? AND status='active' FOR UPDATE",(project,)).await?;
    Ok(locked.is_some())
}

async fn bind_on(
    preview: &source_team::Preview,
    tx: &mut impl MysqlTransaction,
    owner: i32,
    project: &str,
    body: &Adoption,
    team: &AssistantTeamDefinition,
) -> MysqlResult<Result<Adopted, FastApiError>> {
    if !storage::lock_publisher(tx, owner).await? || !lock_project(tx, project).await? {
        return Ok(Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Project unavailable",
        )));
    }
    match authority::execution_priority_on(&mut &mut *tx, project, i64::from(owner)).await {
        Ok(priority) if priority <= 1 => (),
        Err(error) if error.is::<brz_mysql::MysqlError>() => return Err(error.downcast().unwrap()),
        _ => {
            return Ok(Err(FastApiError::forbidden(
                "Project Maintainer access required",
            )));
        }
    }
    if !preview.current(tx).await? {
        return Ok(Err(source_mismatch()));
    }
    let mut agents = serde_json::Map::new();
    for (role, id) in &body.member_agent_ids {
        match authority::agent_on(&mut &mut *tx, project, id, i64::from(owner), true).await {
            Ok(agent) => {
                let Some(id) = source_team::team_id(&agent) else {
                    return Ok(Err(source_mismatch()));
                };
                let matches = match body.member_source_team_ids.get(role) {
                    Some(source) => {
                        agent.metadata.0["runtime"] == "wegent"
                            && *source == id
                            && crate::stand_in_account::owns_role_team(tx, owner, role, id).await?
                    }
                    None => preview.teams.get(&agent.id) == Some(&id),
                };
                if !matches {
                    return Ok(Err(source_mismatch()));
                }
                agents.insert(
                    role.clone(),
                    json!({"id":agent.id,"name":agent.name,"teamId":id}),
                );
            }
            Err(error) if error.is::<brz_mysql::MysqlError>() => {
                return Err(error.downcast().unwrap());
            }
            Err(_) => return Ok(Err(FastApiError::forbidden("Project Agent unavailable"))),
        }
    }
    let old = storage::publication(tx, owner, "team", &team.id).await?;
    if old.as_ref().is_some_and(|p| p.definition.0 != body.root) {
        return Ok(Err(source_changed()));
    }
    let namespace = format!("projects/{project}");
    let existing: Option<Group> = match &old {
            Some(p) => tx.fetch_optional("SELECT g.id,g.json AS document FROM resource_members b JOIN kinds g ON g.id=CAST(b.entity_id AS UNSIGNED) WHERE b.resource_type=? AND b.resource_id=? AND b.entity_type='collaboration_group' AND b.status='approved' AND g.kind='CollaborationGroup' AND g.namespace=? AND g.user_id=? AND g.is_active=TRUE ORDER BY g.id DESC LIMIT 1 FOR UPDATE",(BINDING,p.id,namespace.as_str(),owner)).await?,
            None => None,
        };
    if let (Some(group), Some(publication)) = (&existing, &old) {
        let source = &group.document.0["metadata"]["personalTeamSource"];
        if group.document.0["status"]["state"] == "active"
            && source["publicationId"] == publication.id
            && source["revision"] == publication.revision
            && source["agents"].as_object() == Some(&agents)
        {
            return Ok(Ok(Adopted {
                group_id: group.id.to_string(),
                publication_id: publication.id.to_string(),
                revision: publication.revision,
            }));
        }
    }
    if body
        .expected_revision
        .is_some_and(|version| version != old.as_ref().map_or(0, |p| p.revision))
    {
        return Ok(Err(source_changed()));
    }
    let collision:Option<i64> = tx.fetch_optional("SELECT g.id FROM kinds g JOIN resource_members p ON p.resource_type='CollaborationGroup' AND p.resource_id=g.id AND p.entity_type='project' AND p.entity_id=? AND p.status='approved' WHERE g.kind='CollaborationGroup' AND g.name=? AND g.is_active=TRUE AND g.id<>? LIMIT 1",(project,team.name.as_str(),existing.as_ref().map_or(0,|g|g.id))).await?;
    if collision.is_some() {
        return Ok(Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "A project group already uses this name",
        )));
    }
    let (publication_id, revision) = match old {
        Some(p) => (p.id, p.revision),
        None => (storage::insert_publication(tx, owner, &body.root).await?, 1),
    };
    let source = json!({"publicationId":publication_id,"revision":revision,"agents":agents});
    let group_id = if let Some(mut group) = existing {
        group.document.0["metadata"]["personalTeamSource"] = source;
        persist_group(tx, &mut group, team, revision).await?;
        group.id
    } else {
        let mut document = json!({"apiVersion":"agent.wecode.io/v1","kind":"CollaborationGroup","metadata":{"personalTeamSource":source},"spec":{"description":"","instructions":"","coordinationMode":"manager","stages":[],"executionRequirements":{"required_tags":[]}},"status":{"version":1}});
        apply_roster(&mut document, team, revision);
        let id=tx.execute("INSERT INTO kinds(user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,'CollaborationGroup',?,?,?,TRUE,NOW(),NOW())",(owner,namespace.as_str(),team.name.as_str(),Json(document))).await?.last_insert_id as i64;
        tx.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,`role`,status,invited_by_user_id,requested_at,created_at,updated_at) VALUES ('CollaborationGroup',?,'project',?,'Developer','approved',?,NOW(),NOW(),NOW()),(?,?,'collaboration_group',?,'Developer','approved',?,NOW(),NOW(),NOW())",(id,project,owner,BINDING,publication_id,id.to_string(),owner)).await?;
        id
    };
    Ok(Ok(Adopted {
        group_id: group_id.to_string(),
        publication_id: publication_id.to_string(),
        revision,
    }))
}

fn project_access_error(error: anyhow::Error) -> FastApiError {
    match error.downcast::<brz_mysql::MysqlError>() {
        Ok(error) => internal(error),
        Err(_) => FastApiError::forbidden("Project or Agent access denied"),
    }
}

fn source_changed() -> FastApiError {
    FastApiError::detail(StatusCode::CONFLICT, "Refresh the personal team definition")
}

fn source_mismatch() -> FastApiError {
    FastApiError::detail(
        StatusCode::CONFLICT,
        "Project Agent does not run the selected personal role Team",
    )
}

fn invalid() -> FastApiError {
    FastApiError::detail(
        StatusCode::UNPROCESSABLE_ENTITY,
        "Every personal team role must map to one distinct project Agent",
    )
}

#[cfg(test)]
#[path = "assistant_project_binding_tests.rs"]
pub(super) mod tests;
