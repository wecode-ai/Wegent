// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects` — list cloud projects accessible to the
//! current user
//! (`app.api.endpoints.cloud_projects.list_cloud_projects`, router prefix
//! `/v1/cloud-projects` under the app prefix `/api`).
//!
//! Source pipeline:
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — JWT session decode
//!    plus the labeled `users` lookup (the full twelve-column
//!    `users_<column>` projection);
//! 2. `cloud_project_service.list_project_responses` ->
//!    `cloud_project_visibility.project_access_query` — one statement that
//!    unions the four grant sources (direct `CloudProject` membership with the
//!    role-priority `CASE`, `Workspace`-membership inheritance, public /
//!    `public_restricted` projects, and projects the caller created), reduces
//!    each project to `min(priority)` and joins the active `loop_items`
//!    project rows ordered by `updated_at DESC, id`. The source documents the
//!    contract as "two SELECTs regardless of the number of returned
//!    projects"; the joined `anon_1.priority` column is the caller's
//!    `access_role`, so no per-project authorization read is issued;
//! 3. `_parent_contexts` — one `resource_members`/`kinds` read that resolves
//!    the parent `CollaborationWorkspace` (`workspace_id` plus
//!    `workspace_context`) for every listed project; the query is skipped
//!    when the list is empty.
//!
//! The per-project body derives from the `loop_items` row plus its
//! `metadata` JSON (`CloudProjectResponse.populate_tags` in
//! `app.schemas.cloud_project`); see the `response` submodule.
use crate::json_compat::{JsonProjection, OpaqueJson};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow};
use chrono::NaiveDateTime;
use serde_json::json;

use crate::auth::{SessionUser, UserRow};
use crate::board_snapshot;
use crate::http_compat::FastApiError;
use crate::state::AppState;

mod response;

pub(crate) use response::{CloudProjectBody, ProjectListResponse, WorkspaceContext};

mod access;

pub(crate) use access::{
    LOOP_ITEMS_COLUMNS, ProjectAccessMode, project_access_statement, role_for_priority,
};

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CloudMetadataInput {
    pub visibility: Option<String>,
    pub task_provider: Option<String>,
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

/// `list_project_responses` first read: the accessible projects with the
/// caller's resolved role priority, newest first. An optional `workspace_id`
/// narrows the list through `workspace_project_ids`.
async fn accessible_projects<M: Mysql>(
    mysql: &M,
    user_id: i32,
    workspace_id: Option<i64>,
) -> Result<Vec<(ProjectListRow, i64)>, brz_mysql::MysqlError> {
    let user_id_text = user_id.to_string();
    let sql = project_access_statement(ProjectAccessMode::List {
        workspace_filtered: workspace_id.is_some(),
    });
    let rows: Vec<MysqlRow> = match workspace_id {
        Some(workspace_id) => {
            mysql
                .fetch_all(
                    sql,
                    (
                        user_id_text.as_str(),
                        user_id_text.as_str(),
                        i64::from(user_id),
                        workspace_id,
                    ),
                )
                .await?
        }
        None => {
            mysql
                .fetch_all(
                    sql,
                    (
                        user_id_text.as_str(),
                        user_id_text.as_str(),
                        i64::from(user_id),
                    ),
                )
                .await?
        }
    };
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

    let items = projects
        .iter()
        .map(|(project, priority)| {
            response::project_response(
                project,
                current_user.0.id,
                &current_user.0.user_name,
                // The union only produces the five mapped priorities; the
                // source indexes `ROLES_BY_PRIORITY` with a plain lookup.
                role_for_priority(*priority).unwrap_or("RestrictedAnalyst"),
                contexts.get(&project.id),
            )
        })
        .collect();

    Ok(ProjectListResponse { items })
}

/// The `require_cloud_project_role` project re-read
/// (`cloud_project_service.access`); the recorded COM_QUERY inlines the
/// snowflake id as an integer literal instead of a bound parameter.
pub(crate) async fn access_project<M: Mysql>(
    mysql: &M,
    project_id: &str,
) -> Result<Option<ProjectListRow>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.id = {project_id} AND loop_items.status = 'active' \
         AND loop_items.resource_type IN ('project') \n LIMIT 1",
    );
    mysql.fetch_optional(sql, ()).await
}

/// The `require_cloud_project_role` membership lookup for a non-creator.
pub(crate) async fn membership_role<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct RoleRow {
        #[mysql(rename = "resource_members_role")]
        role: String,
    }
    let row: Option<RoleRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type, \
             resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.entity_display_name AS resource_members_entity_display_name, \
             resource_members.user_id AS resource_members_user_id, \
             resource_members.`role` AS resource_members_role, \
             resource_members.status AS resource_members_status, \
             resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
             resource_members.share_link_id AS resource_members_share_link_id, \
             resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
             resource_members.reviewed_at AS resource_members_reviewed_at, \
             resource_members.copied_resource_id AS resource_members_copied_resource_id, \
             resource_members.requested_at AS resource_members_requested_at, \
             resource_members.created_at AS resource_members_created_at, \
             resource_members.updated_at AS resource_members_updated_at \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = {project_id} \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '{user_id}' \
             AND resource_members.status = 'approved' \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.role))
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
/// 2. `require_cloud_project_role(db, project_id, user_id, Reporter)` —
///    re-read the active project row (inlined snowflake id) and, for
///    non-creators, the approved `resource_members` membership row. Public
///    visitors resolve to `RestrictedAnalyst`, which fails the Reporter
///    permission check and the source raises `403 {"detail": "Insufficient
///    permission"}`.
/// 3. `ProjectChatAgent` scan — active `loop_items` chat-agent rows
///    (`resource_type='chat_agent'`, `status='active'`, unset `deleted_at`)
///    ordered by `created_at ASC`, filtered by `_agent_visible_to_user`
///    against the caller's role.
async fn project_chat_agents(
    state: &AppState,
    project_id: &str,
    current_user: UserRow,
) -> Result<Vec<board_snapshot::handler::AgentView>, FastApiError> {
    // `require_cloud_project_role`: re-read the active project row plus the
    // approved membership row for non-creators. The source passes
    // `project_id=str(project_id)` (a string) to `list_agents`, which forwards
    // it to `require_cloud_project_role`; SQLAlchemy renders the string value
    // as a quoted string literal, so the recorded COM_QUERY has
    // `loop_items.id = '8869148083931743937'` (not an unquoted integer).
    // `access_project` inlines `{project_id}` without quotes (matching the
    // integer-literal recording of other endpoints like loop-item-pages), so
    // the chat-agents handler inlines its own project and membership lookups
    // with quoted string literals to match this endpoint's recording.
    let project: Option<ProjectListRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.id = '{project_id}' AND loop_items.status = 'active' \
                 AND loop_items.resource_type IN ('project') \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(internal_error)?;
    let project = project.ok_or_else(|| {
        FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Cloud project not found",
        )
    })?;

    let role = if project.created_by_user_id == current_user.id {
        "Owner".to_string()
    } else {
        let current_user_id = current_user.id;
        // `require_cloud_project_role` membership lookup for a non-creator.
        // Like the project lookup, the recorded SQL inlines the snowflake id
        // as a quoted string literal because the source passes `str(project_id)`.
        #[derive(Debug, FromMysqlRow)]
        struct RoleRow {
            #[mysql(rename = "resource_members_role")]
            role: String,
        }
        let row: Option<RoleRow> = state
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT resource_members.id AS resource_members_id, \
                 resource_members.resource_type AS resource_members_resource_type, \
                 resource_members.resource_id AS resource_members_resource_id, \
                 resource_members.entity_type AS resource_members_entity_type, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.entity_display_name AS resource_members_entity_display_name, \
                 resource_members.user_id AS resource_members_user_id, \
                 resource_members.`role` AS resource_members_role, \
                 resource_members.status AS resource_members_status, \
                 resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
                 resource_members.share_link_id AS resource_members_share_link_id, \
                 resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
                 resource_members.reviewed_at AS resource_members_reviewed_at, \
                 resource_members.copied_resource_id AS resource_members_copied_resource_id, \
                 resource_members.requested_at AS resource_members_requested_at, \
                 resource_members.created_at AS resource_members_created_at, \
                 resource_members.updated_at AS resource_members_updated_at \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'CloudProject' \
                 AND resource_members.resource_id = '{project_id}' \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{current_user_id}' \
                 AND resource_members.status = 'approved' \n LIMIT 1"
                ),
                (),
            )
            .await
            .map_err(internal_error)?;
        match row {
            Some(row) => row.role,
            None if project
                .metadata
                .as_ref()
                .and_then(|json| json.0.value.as_ref())
                .and_then(|metadata| metadata.visibility.as_deref())
                == Some("public") =>
            {
                "RestrictedAnalyst".to_string()
            }
            None => {
                return Err(FastApiError::detail(
                    brz_http_server::StatusCode::NOT_FOUND,
                    "Cloud project not found",
                ));
            }
        }
    };

    // `has_permission(role, Reporter)`: RestrictedAnalyst (public visitor)
    // fails and the source raises `403 {"detail": "Insufficient permission"}`.
    if !board_snapshot::repository::has_permission(&role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `project_chat_service.list_agents`: active chat-agent rows for the
    // project, filtered by visibility against the caller.
    let repository = board_snapshot::repository::BoardSnapshotRepository::new(&state.mysql);
    let agents = repository
        .list_agents(project_id)
        .await
        .map_err(internal_error)?;
    let visible_agents: Vec<board_snapshot::handler::AgentView> = agents
        .iter()
        .filter(|agent| {
            board_snapshot::handler::agent_visible_to_user(agent, current_user.id, &role)
        })
        .map(board_snapshot::handler::agent_to_view)
        .collect();

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
