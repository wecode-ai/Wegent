//! Removing a project definition never deletes the shared Agent resource or execution history.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};
use wegent_protocol::collaboration::{group_references_agent, is_managed_project_agent};

use crate::{ProjectState, http_compat::FastApiError};
use wegent_identity::flexible_auth::FlexibleUser;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteInput {
    version: i64,
}

#[derive(FromMysqlRow)]
struct AgentRow {
    name: String,
    version: i64,
    created_by_user_id: Option<i32>,
    metadata: Option<Json<Value>>,
}

#[derive(FromMysqlRow)]
struct GroupRow {
    definition: Json<Value>,
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Deleted,
    Missing,
    Changed,
    Private,
    Managed,
    Referenced,
}

#[brz_http_server::delete("/api/v1/cloud-projects/:project_id/chat-agents/:agent_id", group = project_coordination)]
async fn delete_project_agent(
    #[inject(state)] state: &ProjectState,
    project_id: &str,
    agent_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: DeleteInput = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "Invalid Agent version")
    })?;
    remove(&state.mysql, project_id, agent_id, user.id, input.version).await
}

pub(super) async fn remove<M: Mysql>(
    mysql: &M,
    project_id: &str,
    agent_id: &str,
    user_id: i32,
    version: i64,
) -> Result<Value, FastApiError> {
    if version < 1 {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid Agent version",
        ));
    }
    let number = super::parse_project_id(project_id)?;
    let Some((_, role)) = super::authorized_project(mysql, number, user_id)
        .await
        .map_err(super::internal_error)?
    else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Cloud project not found",
        ));
    };
    if !super::members::has_permission(role, "Maintainer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let outcome = mysql.with_transaction(async |tx| {
        let project: Option<(String,)> = tx.fetch_optional(
            "SELECT id FROM loop_items WHERE id=? AND resource_type='project' AND status='active' FOR UPDATE", (project_id,)
        ).await?;
        if project.is_none() { return Ok(Outcome::Missing); }
        let agent: Option<AgentRow> = tx.fetch_optional(
            "SELECT name,version,created_by_user_id,metadata FROM loop_items WHERE id=? AND cloud_project_id=? AND resource_type='chat_agent' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE", (agent_id, project_id)
        ).await?;
        let Some(agent) = agent else { return Ok(Outcome::Missing); };
        if agent.metadata.as_ref().is_some_and(|value| value.0["visibility"] == "private") && agent.created_by_user_id != Some(user_id) { return Ok(Outcome::Private); }
        if is_managed_project_agent(&agent.name) { return Ok(Outcome::Managed); }
        if agent.version != version { return Ok(Outcome::Changed); }
        let groups: Vec<GroupRow> = tx.fetch_all(
            "SELECT kinds.json AS definition FROM kinds INNER JOIN resource_members ON resource_members.resource_id=kinds.id AND resource_members.resource_type='CollaborationGroup' WHERE kinds.kind='CollaborationGroup' AND kinds.is_active=1 AND resource_members.entity_type='project' AND resource_members.entity_id=? AND resource_members.status='approved' FOR UPDATE", (project_id,)
        ).await?;
        if groups.iter().any(|group| group_references_agent(&group.definition.0["spec"], agent_id, agent.metadata.as_ref().and_then(|metadata| metadata.0["wegent_team_id"].as_i64()))) { return Ok(Outcome::Referenced); }
        let changed = tx.execute(
            "UPDATE loop_items SET status='archived',deleted_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),version=version+1 WHERE id=? AND cloud_project_id=? AND resource_type='chat_agent' AND version=?", (agent_id, project_id, version)
        ).await?;
        Ok(if changed.rows_affected == 1 { Outcome::Deleted } else { Outcome::Changed })
    }).await.map_err(super::internal_error)?;
    match outcome {
        Outcome::Deleted => Ok(json!({})),
        Outcome::Missing => Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Project Agent not found",
        )),
        Outcome::Private => Err(FastApiError::forbidden(
            "Private Agent is not shared with this member",
        )),
        Outcome::Managed => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "PROJECT_AGENT_MANAGED: the current-device Agent cannot be deleted",
        )),
        Outcome::Referenced => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "PROJECT_AGENT_IN_USE: replace or remove the Agent from its collaboration groups first",
        )),
        Outcome::Changed => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Project Agent changed; refresh and try again",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_inaccessible_projects_before_reading_or_mutating_agents() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let error = remove(&mysql, "101", "agent", 7, 1).await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(mysql.queries().len(), 1);
        assert!(
            !mysql.queries()[0]
                .sql
                .contains("resource_type='chat_agent'")
        );
    }

    #[tokio::test]
    async fn rejects_invalid_versions_without_database_access() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert_eq!(
            remove(&mysql, "101", "agent", 7, 0)
                .await
                .unwrap_err()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert!(mysql.queries().is_empty());
    }
}
