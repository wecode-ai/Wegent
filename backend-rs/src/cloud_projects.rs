// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud-project read endpoints
//! (`app.api.endpoints.cloud_projects`, router prefix `/v1/cloud-projects`
//! under the app prefix `/api`):
//!
//! - `GET /api/v1/cloud-projects` — list the projects accessible to the
//!   current user (`list_cloud_projects`);
//! - `GET /api/v1/cloud-projects/{project_id}` — one project by id
//!   (`get_cloud_project`).
//!
//! Shared pipeline:
//! 1. `security.get_current_user[_jwt_apikey_tasktoken]` — JWT session decode
//!    plus the labeled `users` lookup (the full twelve-column
//!    `users_<column>` projection);
//! 2. `cloud_project_visibility.project_access_query` — one statement that
//!    unions the four grant sources (direct `CloudProject` membership with the
//!    role-priority `CASE`, `Workspace`-membership inheritance, grants to the
//!    `authenticated_users` entity, and projects the caller created), reduces
//!    each project to `min(priority)` and joins the active `loop_items`
//!    project rows. The joined `anon_1.priority` column is the caller's
//!    `access_role`, so no per-project authorization read is issued. The point
//!    form pushes the requested id into every branch and keeps one row;
//! 3. `_parent_contexts` — one `resource_members`/`kinds` read that resolves
//!    the parent `CollaborationWorkspace` (`workspace_id` plus
//!    `workspace_context`); the query is skipped when the list is empty;
//! 4. `_all_user_grant_roles` — one `resource_members` read that resolves the
//!    approved `authenticated_users` grant driving `visibility` and
//!    `public_access`.
//!
//! The per-project body derives from the `loop_items` row plus its
//! `metadata` JSON (`CloudProjectResponse.populate_tags` in
//! `app.schemas.cloud_project`); see the `response` submodule.
use brz_http_server::StatusCode;
use brz_json::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow};
use chrono::NaiveDateTime;
use serde_json::json;

use crate::auth::{SessionUser, UserRow};
use crate::board_snapshot;
use crate::http_compat::FastApiError;
use crate::state::AppState;

mod response;

pub(crate) use response::{CloudProjectBody, ProjectListResponse, WorkspaceContext};

/// `ProjectWorkflowDefinition` rendering for the project response body.
mod workflow_definition;

/// Execution-environment route for `GET /api/v1/cloud-projects/{project_id}/execution-environments`.
mod execution_environments;

/// Collaboration-group route for
/// `GET /api/v1/cloud-projects/{project_id}/collaboration-groups`.
mod collaboration_groups;

mod access;

pub(crate) use access::{
    LOOP_ITEMS_COLUMNS, ProjectAccessMode, entity_columns, project_access_statement,
    role_for_priority,
};

/// `PATCH /api/v1/cloud-projects/{project_id}`: update one cloud project.
mod update;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CloudMetadataInput {
    pub visibility: Option<String>,
    pub task_provider: Option<String>,
    pub default_issue_security: Option<String>,
    pub provider_config: Option<OpaqueJson>,
    pub card_display: Option<OpaqueJson>,
    pub board_config: Option<OpaqueJson>,
    pub ai_automation: Option<OpaqueJson>,
    pub pull_request_automation: Option<OpaqueJson>,
    pub workflow_definition: Option<OpaqueJson>,
    pub workflow_automation_id: Option<OpaqueJson>,
    pub execution_environment: Option<OpaqueJson>,
    pub tags: Option<OpaqueJson>,
    pub member_capabilities: Option<OpaqueJson>,
}

/// `loop_items` project-row columns consumed by the list projection.
///
/// The recorded projection lists all 60 mapped columns labeled
/// `loop_items_<column>`; only the fields below feed the response, but the
/// full labeled projection is selected so the prepared statement matches the
/// recorded exchange for replay.
#[derive(Debug, FromMysqlRow)]
pub struct ProjectListRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_public_id")]
    pub public_id: Option<String>,
    #[mysql(rename = "loop_items_project_key")]
    pub project_key: Option<String>,
    #[mysql(rename = "loop_items_name")]
    pub name: Option<String>,
    #[mysql(rename = "loop_items_description")]
    pub description: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: i32,
    #[mysql(rename = "loop_items_status")]
    pub status: String,
    #[mysql(rename = "loop_items_version")]
    pub version: i64,
    #[mysql(rename = "loop_items_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    pub metadata: Option<Json<JsonProjection<CloudMetadataInput>>>,
}

/// `_parent_contexts`: the parent `CollaborationWorkspace` of every listed
/// project in one read, keyed by the project id.
const PARENT_CONTEXTS_SQL: &str = "\
SELECT resource_members.resource_id AS resource_members_resource_id, kinds.id AS kinds_id, kinds.name AS kinds_name, CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\\\"metadata\\\"'), '$.\\\"publicId\\\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\\\"metadata\\\"'), '$.\\\"publicId\\\"')) END AS anon_1 \n\
FROM resource_members INNER JOIN kinds ON kinds.id = CAST(resource_members.entity_id AS SIGNED INTEGER) \n\
WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id IN ({placeholders}) AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true";

/// `?, ?, ...` placeholders for one dynamic `IN (...)` list.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// `responses._all_user_grant_roles`: the approved all-signed-in-users grant
/// rows for the listed projects.
const ALL_USER_GRANT_ROLES_SQL: &str = "\
SELECT resource_members.resource_id AS resource_members_resource_id, resource_members.`role` AS resource_members_role \n\
FROM resource_members \n\
WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id IN ({placeholders}) AND resource_members.entity_type = 'authenticated_users' AND resource_members.entity_id = '*' AND resource_members.status = 'approved'";

/// `list_project_responses` first read: the accessible projects with the
/// caller's resolved role priority, newest first. An optional `workspace_id`
/// narrows the list through `workspace_project_ids`.
async fn accessible_projects<M: Mysql>(
    mysql: &M,
    user_id: i32,
    workspace_id: Option<i64>,
) -> Result<Vec<(ProjectListRow, i64)>, brz_mysql::MysqlError> {
    let sql = project_access_statement(ProjectAccessMode::List { workspace_id }, user_id, None);
    let rows: Vec<MysqlRow> = mysql.fetch_all(sql, ()).await?;
    rows.into_iter()
        .map(|row| {
            // The joined aggregate supplies `access_role`; read it before the
            // typed project projection consumes the row.
            let priority: i64 = row.get_required("anon_1_priority")?;
            ProjectListRow::from_mysql_row(row).map(|project| (project, priority))
        })
        .collect()
}

/// `_parent_contexts`: resolve the parent `CollaborationWorkspace` of every
/// listed project. The source skips the query entirely for an empty list.
async fn parent_contexts<M: Mysql>(
    mysql: &M,
    project_ids: &[String],
) -> Result<std::collections::HashMap<String, WorkspaceContext>, brz_mysql::MysqlError> {
    if project_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct ParentContextRow {
        /// `resource_members.resource_id` — the cloud project id.
        #[mysql(rename = "resource_members_resource_id")]
        project_id: i64,
        /// `kinds.id` — the parent collaboration workspace id.
        #[mysql(rename = "kinds_id")]
        workspace_id: i32,
        #[mysql(rename = "kinds_name")]
        name: String,
        /// `kinds.json.metadata.publicId`, read through the JSON path.
        #[mysql(rename = "anon_1")]
        public_id: Option<Vec<u8>>,
    }
    let placeholder_list = placeholders(project_ids.len());
    let sql = PARENT_CONTEXTS_SQL.replace("{placeholders}", &placeholder_list);
    let ids: Vec<i64> = project_ids
        .iter()
        .map(|project_id| {
            project_id
                .parse::<i64>()
                .map_err(|_| brz_mysql::MysqlError::InvalidQuery {
                    reason: format!("project id {project_id:?} is not numeric"),
                })
        })
        .collect::<Result<_, _>>()?;
    let rows: Vec<ParentContextRow> = mysql.fetch_all(sql, ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let context = WorkspaceContext {
                id: row.workspace_id.to_string(),
                public_id: row
                    .public_id
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default(),
                name: row.name,
            };
            (row.project_id.to_string(), context)
        })
        .collect())
}

/// `responses._all_user_grant_roles`: the stored role of the approved
/// all-signed-in-users (`authenticated_users`) grant for every listed project.
/// The source skips the query entirely for an empty list.
async fn all_user_grant_roles<M: Mysql>(
    mysql: &M,
    project_ids: &[String],
) -> Result<std::collections::HashMap<String, String>, brz_mysql::MysqlError> {
    if project_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct GrantRow {
        /// `resource_members.resource_id` — the cloud project id.
        #[mysql(rename = "resource_members_resource_id")]
        project_id: i64,
        #[mysql(rename = "resource_members_role")]
        role: String,
    }
    let placeholder_list = placeholders(project_ids.len());
    let sql = ALL_USER_GRANT_ROLES_SQL.replace("{placeholders}", &placeholder_list);
    let ids: Vec<i64> = project_ids
        .iter()
        .map(|project_id| {
            project_id
                .parse::<i64>()
                .map_err(|_| brz_mysql::MysqlError::InvalidQuery {
                    reason: format!("project id {project_id:?} is not numeric"),
                })
        })
        .collect::<Result<_, _>>()?;
    let rows: Vec<GrantRow> = mysql.fetch_all(sql, ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.project_id.to_string(), row.role))
        .collect())
}

/// `require_cloud_project_role`: the point form of `project_access_query`,
/// reduced to one row. Returns the accessible active project row and the
/// aggregated role priority, or `None` when no permission source grants the
/// caller access (the source raises `404 "Cloud project not found"`).
async fn project_access<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> Result<Option<(ProjectListRow, i64)>, brz_mysql::MysqlError> {
    // The source inlines the user and project ids into the statement, so it
    // carries no bind parameters.
    let statement = project_access_statement(ProjectAccessMode::Point, user_id, Some(project_id));
    let row: Option<MysqlRow> = mysql.fetch_optional(statement, ()).await?;
    row.map(|row| {
        // The joined aggregate supplies the caller's role priority; read it
        // before the typed project projection consumes the row.
        let priority: i64 = row.get_required("anon_1_priority")?;
        ProjectListRow::from_mysql_row(row).map(|project| (project, priority))
    })
    .transpose()
}

/// `workspace_id` query parameter (`Query(default=None)`): the optional parent
/// workspace filter for `list_cloud_projects`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CloudProjectListQuery {
    pub workspace_id: Option<String>,
}

impl CloudProjectListQuery {
    /// FastAPI parses `workspace_id` as `int | None`; a value that is not an
    /// integer is a 422 validation error.
    fn validated(&self) -> Result<Option<i64>, FastApiError> {
        let Some(workspace_id) = self.workspace_id.as_deref() else {
            return Ok(None);
        };
        workspace_id.parse::<i64>().map(Some).map_err(|_| {
            FastApiError::validation(json!([{
                "type": "int_parsing",
                "loc": ["query", "workspace_id"],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": workspace_id,
            }]))
        })
    }
}

/// GET /api/v1/cloud-projects: the cloud-projects free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects")]
async fn list_cloud_projects(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<CloudProjectListQuery>,
) -> Result<ProjectListResponse, FastApiError> {
    cloud_projects(state, &current_user, &query).await
}

/// Handler body for `GET /api/v1/cloud-projects`.
///
/// Mirrors `app.api.endpoints.cloud_projects.list_cloud_projects` ->
/// `list_project_responses(db, current_user, workspace_id)`: one
/// `project_access_query` read supplying both the projects and the caller's
/// role priority, followed by one `_parent_contexts` read for the parent
/// workspace navigation context of every listed project.
async fn cloud_projects(
    state: &AppState,
    current_user: &SessionUser,
    params: &CloudProjectListQuery,
) -> Result<ProjectListResponse, FastApiError> {
    let workspace_id = params.validated()?;
    let projects = accessible_projects(&state.mysql, current_user.0.id, workspace_id)
        .await
        .map_err(internal_error)?;

    // `_parent_contexts(db, [str(project.id) for project, _ in rows])` resolves
    // the parent collaboration workspace of every listed project in one read.
    let project_ids: Vec<String> = projects
        .iter()
        .map(|(project, _)| project.id.clone())
        .collect();
    let contexts = parent_contexts(&state.mysql, &project_ids)
        .await
        .map_err(internal_error)?;
    // `_all_user_grant_roles(db, [str(project.id) ...])` resolves the
    // all-signed-in-users grant that drives `visibility`/`public_access`.
    let all_user_roles = all_user_grant_roles(&state.mysql, &project_ids)
        .await
        .map_err(internal_error)?;

    let items = projects
        .iter()
        .map(|(project, priority)| {
            response::project_response(
                project,
                current_user.0.id,
                &current_user.0.user_name,
                // The union only produces the mapped priorities; the
                // source indexes `ROLES_BY_PRIORITY` with a plain lookup.
                role_for_priority(*priority).unwrap_or("RestrictedAnalyst"),
                all_user_roles.get(&project.id).map(String::as_str),
                contexts.get(&project.id),
            )
        })
        .collect();

    Ok(ProjectListResponse { items })
}

/// GET /api/v1/cloud-projects/{project_id}: the single-cloud-project free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id")]
async fn get_cloud_project(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<CloudProjectBody, FastApiError> {
    cloud_project(state, project_id, &current_user).await
}

/// `project_id: int` path parameter: FastAPI parses it as an integer and
/// raises a 422 `int_parsing` validation error for any other text.
fn parse_project_id(project_id: &str) -> Result<i64, FastApiError> {
    project_id.parse::<i64>().map_err(|_| {
        FastApiError::validation(json!([{
            "type": "int_parsing",
            "loc": ["path", "project_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": project_id,
        }]))
    })
}

/// `404 "Cloud project not found"` raised by `require_cloud_project_role` when
/// no permission source resolves the project.
fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found")
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}`.
///
/// Mirrors `app.api.endpoints.cloud_projects.get_cloud_project`:
/// `cloud_project_service.get(db, project_id, current_user.id)` resolves the
/// project through one `require_cloud_project_role` read, then
/// `_project_response(db, project, current_user)` =
/// `responses.project_response` re-runs `require_cloud_project_role` for the
/// effective role and adds the `_parent_contexts` and `_all_user_grant_roles`
/// reads before rendering `CloudProjectResponse`.
async fn cloud_project(
    state: &AppState,
    project_id: &str,
    current_user: &SessionUser,
) -> Result<CloudProjectBody, FastApiError> {
    let project_number = parse_project_id(project_id)?;
    // `cloud_project_service.get` -> `require_cloud_project_role(...).project`.
    let (project, _) = project_access(&state.mysql, project_number, current_user.0.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;

    // `_project_response` re-runs `require_cloud_project_role(db,
    // int(project.id), current_user.id, Viewer)` for the resolved role.
    let project_number: i64 = project.id.parse().map_err(|_| cloud_project_not_found())?;
    let (_, role_priority) = project_access(&state.mysql, project_number, current_user.0.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;

    let project_ids = [project.id.clone()];
    let contexts = parent_contexts(&state.mysql, &project_ids)
        .await
        .map_err(internal_error)?;
    let all_user_roles = all_user_grant_roles(&state.mysql, &project_ids)
        .await
        .map_err(internal_error)?;

    Ok(response::project_response(
        &project,
        current_user.0.id,
        &current_user.0.user_name,
        // The point union only emits priorities 0..=4, all of which satisfy the
        // Viewer requirement; the source indexes `ROLES_BY_PRIORITY` plainly.
        role_for_priority(role_priority).unwrap_or("RestrictedAnalyst"),
        all_user_roles.get(&project.id).map(String::as_str),
        contexts.get(&project.id),
    ))
}

pub(crate) fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// GET /api/v1/cloud-projects/{project_id}/chat-agents: the chat-agents free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/chat-agents")]
async fn list_project_chat_agents(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<Vec<board_snapshot::handler::AgentView>, FastApiError> {
    project_chat_agents(state, project_id, current_user.0).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/chat-agents`.
///
/// Mirrors `app.api.endpoints.cloud_projects.list_project_chat_agents` ->
/// `project_chat_service.list_agents(db, user_id, project_id)`. The source
/// pipeline:
/// 1. `get_current_user_jwt_apikey_tasktoken` — the same JWT decode and
///    labeled `users` lookup as `get_current_user` (the recorded `users`
///    exchange matches the standard twelve-column projection). The target's
///    `get_current_user` reproduces that lookup.
/// 2. `require_cloud_project_role(db, project_id, user_id, Viewer)` — the
///    set-based `project_access_query` point form resolves the active project
///    row and the caller's effective role in one statement. No grant for the
///    caller raises `404 "Cloud project not found"`, and a caller the union
///    only reaches at `RestrictedAnalyst` priority fails the `Viewer`
///    permission check with `403 {"detail": "Insufficient permission"}`.
/// 3. `ProjectChatAgent` scan — active `loop_items` chat-agent rows
///    (`resource_type='chat_agent'`, `status='active'`, unset `deleted_at`)
///    ordered by `created_at ASC`, filtered by `_agent_visible_to_user`
///    against the caller's role.
async fn project_chat_agents(
    state: &AppState,
    project_id: &str,
    current_user: UserRow,
) -> Result<Vec<board_snapshot::handler::AgentView>, FastApiError> {
    // The source route declares `project_id: int`; FastAPI rejects a
    // non-integer path segment with a 422 before the handler runs.
    let number: i64 = project_id.parse().map_err(|_| {
        FastApiError::validation([json!({
            "type": "int_parsing",
            "loc": ["path", "project_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": project_id,
        })])
    })?;

    // `list_agents` forwards `project_id=str(project_id)` to
    // `require_cloud_project_role`, so the recorded `project_access_query`
    // binds the string project id; `require_cloud_project_role` reproduces
    // that statement's point form.
    let repository = board_snapshot::repository::BoardSnapshotRepository::new(&state.mysql);
    let access = repository
        .require_cloud_project_role(number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            FastApiError::detail(
                brz_http_server::StatusCode::NOT_FOUND,
                "Cloud project not found",
            )
        })?;

    // `has_permission(role, Viewer)`: RestrictedAnalyst (a signed-in-user-only
    // visitor) fails and the source raises
    // `403 {"detail": "Insufficient permission"}`.
    if !board_snapshot::repository::has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `project_chat_service.list_agents`: active chat-agent rows for the
    // project, filtered by visibility against the caller.
    let agents = repository
        .list_agents(project_id)
        .await
        .map_err(internal_error)?;
    let mut visible_agents: Vec<board_snapshot::handler::AgentView> = Vec::new();
    for agent in agents.iter().filter(|agent| {
        board_snapshot::handler::agent_visible_to_user(agent, current_user.id, &access.role)
    }) {
        visible_agents.push(
            board_snapshot::handler::agent_to_view(
                state,
                agent,
                current_user.id,
                &current_user.user_name,
            )
            .await?,
        );
    }

    Ok(visible_agents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_render_one_marker_per_project() {
        assert_eq!(placeholders(1), "?");
        assert_eq!(placeholders(3), "?, ?, ?");
    }

    #[test]
    fn parent_contexts_statement_queries_every_project() {
        let sql = PARENT_CONTEXTS_SQL.replace("{placeholders}", &placeholders(2));
        assert!(sql.contains("resource_members.resource_id IN (?, ?)"));
        assert!(sql.contains("kinds.kind = 'CollaborationWorkspace'"));
        assert!(sql.contains(r#"'$.\"publicId\"'"#));
        assert!(!sql.contains("{placeholders}"));
    }

    #[test]
    fn workspace_id_accepts_integers_and_rejects_other_text() {
        let parsed = CloudProjectListQuery {
            workspace_id: Some("353932".to_string()),
        }
        .validated()
        .unwrap();
        assert_eq!(parsed, Some(353932));
        assert_eq!(
            CloudProjectListQuery { workspace_id: None }
                .validated()
                .unwrap(),
            None
        );

        let error = CloudProjectListQuery {
            workspace_id: Some("abc".to_string()),
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&error.validation_detail()).unwrap(),
            json!([{
                "type": "int_parsing",
                "loc": ["query", "workspace_id"],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": "abc",
            }])
        );
    }
}
