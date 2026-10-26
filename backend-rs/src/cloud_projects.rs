// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud-project reads and migration candidates.
//!
//! The selected project list, detail and execution-environment APIs use
//! `collaboration_access` to enforce the approved CP contract. A single query
//! resolves explicit and inherited grants, a unique active parent, provenance,
//! and read-only public discovery. Historical creators receive no implicit grant.
//!
//! Unselected route bodies remain migration candidates. Route ownership is
//! defined by config/routes.toml.
use brz_http_server::StatusCode;
use brz_json::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow};
use chrono::NaiveDateTime;
use serde_json::json;

use crate::auth::{SessionUser, UserRow};
use crate::board_snapshot;
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::state::AppState;

mod response;

pub(crate) use response::{CloudProjectBody, WorkspaceContext};

/// `ProjectWorkflowDefinition` rendering for the project response body.
mod workflow_definition;

/// Execution-environment route for `GET /api/v1/cloud-projects/{project_id}/execution-environments`.
mod execution_environments;

/// Collaboration-group route for
/// `GET /api/v1/cloud-projects/{project_id}/collaboration-groups`.
mod collaboration_groups;

mod access;
mod collaboration_access;
mod environment_authorization;
/// `cloud_project_service.list_members` and the collaboration-permission
/// reads shared by the project projections.
pub(crate) mod members;

/// Resolve a point read with the same CP grants as the project catalog.
pub(crate) async fn authorized_project<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> Result<Option<(ProjectListRow, &'static str)>, brz_mysql::MysqlError> {
    Ok(
        collaboration_access::authorized_projects(mysql, user_id, Some(project_id), None)
            .await?
            .into_iter()
            .next()
            .and_then(|access| {
                role_for_priority(access.priority).map(|role| (access.project, role))
            }),
    )
}

pub(crate) use access::{
    LOOP_ITEMS_COLUMNS, WORKSPACE_ID_COLUMN, entity_columns, project_access_point_statement,
    role_for_priority,
};

/// `PATCH /api/v1/cloud-projects/{project_id}`: update one cloud project.
mod update;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CloudMetadataInput {
    pub membership_mode: Option<String>,
    pub legacy_device_revocations: Option<OpaqueJson>,
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

impl CloudMetadataInput {
    /// `CloudProject.membership_mode`: `inherit` unless the metadata stores
    /// another explicit mode.
    pub(crate) fn membership_mode(&self) -> &str {
        self.membership_mode.as_deref().unwrap_or("inherit")
    }

    /// `CloudProjectService._member_capabilities(project)`: the metadata
    /// `member_capabilities` object reduced to trimmed, non-empty string
    /// descriptions keyed by member id.
    pub(crate) fn member_capabilities(&self) -> std::collections::HashMap<String, String> {
        let Some(values) = self.member_capabilities.as_ref().map(OpaqueJson::to_value) else {
            return std::collections::HashMap::new();
        };
        let Some(values) = values.as_object() else {
            return std::collections::HashMap::new();
        };
        values
            .iter()
            .filter_map(|(member_id, description)| {
                let description = description.as_str()?.trim();
                (!description.is_empty()).then(|| (member_id.clone(), description.to_string()))
            })
            .collect()
    }
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
/// reduced to one row. The accessible active project and the aggregated role
/// priority come from the single statement; `None` means no permission source
/// granted the caller access (the source raises `404 "Cloud project not
/// found"`).
pub(crate) struct ProjectAccessRow {
    pub project: ProjectListRow,
    pub priority: i64,
}

/// `require_cloud_project_role` including the `project_sources` reads that the
/// source performs on every access check even when the caller ignores them.
pub(crate) async fn project_access_details<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> Result<Option<ProjectAccessRow>, brz_mysql::MysqlError> {
    // The source inlines the user and project ids into the statement, so it
    // carries no bind parameters.
    let statement = project_access_point_statement(user_id, project_id);
    let row: Option<MysqlRow> = mysql.fetch_optional(statement, ()).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    // The joined aggregate supplies the caller's role priority and the leading
    // scalar subquery the parent workspace id; read both before the typed
    // project projection consumes the row.
    let priority: i64 = row.get_required("anon_3_priority")?;
    let workspace_id: Option<i64> = row.get("anon_1")?;
    let project = ProjectListRow::from_mysql_row(row)?;
    // `check` resolves permission provenance after the role query.
    members::record_project_sources(mysql, project_id, user_id, workspace_id, user_id).await?;
    Ok(Some(ProjectAccessRow { project, priority }))
}

/// [`project_access_details`] reduced to the project row and role priority.
pub(crate) async fn project_access<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> Result<Option<(ProjectListRow, i64)>, brz_mysql::MysqlError> {
    Ok(project_access_details(mysql, project_id, user_id)
        .await?
        .map(|access| (access.project, access.priority)))
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
) -> Result<collaboration_access::CollaborativeProjectList, FastApiError> {
    cloud_projects(state, &current_user, &query).await
}

/// Handler body for `GET /api/v1/cloud-projects`.
///
/// Mirrors `app.api.endpoints.cloud_projects.list_cloud_projects` ->
/// Resolve projects, effective roles, provenance and parent navigation in one read.
async fn cloud_projects(
    state: &AppState,
    current_user: &SessionUser,
    params: &CloudProjectListQuery,
) -> Result<collaboration_access::CollaborativeProjectList, FastApiError> {
    let workspace_id = params.validated()?;
    let projects = collaboration_access::authorized_projects(
        &state.mysql,
        current_user.0.id,
        None,
        workspace_id,
    )
    .await
    .map_err(internal_error)?;

    let items = projects
        .iter()
        .map(|project| project.response(current_user.0.id, &current_user.0.user_name))
        .collect();

    Ok(collaboration_access::CollaborativeProjectList { items })
}

/// GET /api/v1/cloud-projects/{project_id}: the single-cloud-project free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id")]
async fn get_cloud_project(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<collaboration_access::CollaborativeProject, FastApiError> {
    cloud_project(
        &state.mysql,
        project_id,
        current_user.0.id,
        &current_user.0.user_name,
    )
    .await
}

/// `project_id: int` path parameter: FastAPI parses it as an integer and
/// raises a 422 `int_parsing` validation error for any other text.
pub(crate) fn parse_project_id(project_id: &str) -> Result<i64, FastApiError> {
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
/// Reuse the list policy and response so inherited roles and permission
/// sources remain identical when opening a project or authorizing a Stand-in.
async fn cloud_project<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
    user_name: &str,
) -> Result<collaboration_access::CollaborativeProject, FastApiError> {
    let project_number = parse_project_id(project_id)?;
    let project =
        collaboration_access::authorized_projects(mysql, user_id, Some(project_number), None)
            .await
            .map_err(internal_error)?
            .into_iter()
            .next()
            .ok_or_else(cloud_project_not_found)?;
    Ok(project.response(user_id, user_name))
}

pub(crate) fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// Query parameters for `GET /api/v1/cloud-projects/{project_id}/chat-agents`.
///
/// The source declares `include_archived: bool = False`; archived rows are
/// only returned to a caller with at least `Maintainer` on the project.
#[derive(Debug, Default, serde::Deserialize)]
pub struct ChatAgentListQuery {
    #[serde(default)]
    pub include_archived: bool,
}

/// GET /api/v1/cloud-projects/{project_id}/chat-agents: the chat-agents free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/chat-agents")]
async fn list_project_chat_agents(
    #[inject(state)] state: &AppState,
    project_id: &str,
    query: brz_http_server::Query<ChatAgentListQuery>,
    #[auth] current_user: FlexibleUser,
) -> Result<Vec<board_snapshot::handler::AgentView>, FastApiError> {
    project_chat_agents(state, project_id, current_user.0, query.include_archived).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/chat-agents`.
///
/// Mirrors `app.api.endpoints.cloud_projects.list_project_chat_agents` ->
/// `project_chat_service.list_agents(db, user_id, project_id, include_archived)`.
/// The source pipeline:
/// 1. `get_current_user_jwt_apikey_tasktoken` — JWT, API-key, or task-token
///    authentication plus the labeled `users` lookup (the recorded exchange
///    matches the standard twelve-column projection).
/// 2. `require_cloud_project_role(db, project_id, user_id, Viewer)` — the
///    set-based `project_access_query` point form resolves the active project
///    row and the caller's effective role; the same call resolves permission
///    sources and re-reads the `CloudProject` entity. No grant for the caller
///    raises `404 "Cloud project not found"`, and a caller the union only
///    reaches at `RestrictedAnalyst` priority fails the `Viewer` permission
///    check with `403 {"detail": "Insufficient permission"}`.
/// 3. With `include_archived`, a second `require_cloud_project_role` at
///    `Maintainer`.
/// 4. `ProjectChatAgent` scan — chat-agent rows
///    (`resource_type='chat_agent'`, unset `deleted_at`) for the requested
///    statuses ordered by `created_at ASC`, filtered by `project_agent_visible`
///    against the caller; each row is projected by `agent_to_view`.
async fn project_chat_agents(
    state: &AppState,
    project_id: &str,
    current_user: UserRow,
    include_archived: bool,
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

    // `require_cloud_project_role(db, project_id, user_id, Viewer)`:
    // `list_agents` forwards `project_id=str(project_id)`, so the recorded
    // `project_access_query` binds the string project id.
    let access = require_cloud_project_role(state, number, current_user.id).await?;

    // `has_permission(role, Viewer)`: RestrictedAnalyst (a signed-in-user-only
    // visitor) fails and the source raises
    // `403 {"detail": "Insufficient permission"}`.
    if !board_snapshot::repository::has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `if include_archived: require_cloud_project_role(..., Maintainer)`.
    if include_archived {
        let access = require_cloud_project_role(state, number, current_user.id).await?;
        if !board_snapshot::repository::has_permission(&access.role, "Maintainer") {
            return Err(FastApiError::forbidden("Insufficient permission"));
        }
    }

    // `project_chat_service.list_agents`: chat-agent rows for the project,
    // filtered by visibility against the caller.
    let repository = board_snapshot::repository::BoardSnapshotRepository::new(&state.mysql);
    let agents = repository
        .list_agents(project_id, include_archived)
        .await
        .map_err(internal_error)?;
    let mut visible_agents: Vec<board_snapshot::handler::AgentView> = Vec::new();
    for agent in agents
        .iter()
        .filter(|agent| board_snapshot::handler::agent_visible_to_user(agent, current_user.id))
    {
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

/// `require_cloud_project_role(db, project_id, user_id, required_role)`:
/// the access statement, the permission-source reads, and the `CloudProject`
/// entity re-read that the source performs before comparing the role.
async fn require_cloud_project_role(
    state: &AppState,
    project_id: i64,
    user_id: i32,
) -> Result<board_snapshot::repository::ProjectAccess, FastApiError> {
    let repository = board_snapshot::repository::BoardSnapshotRepository::new(&state.mysql);
    let access = repository
        .require_cloud_project_role(project_id, user_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    // `db.get(CloudProject, str(project_id))` runs after the role query; the
    // row only feeds the returned access value, but the read stays
    // request-owned.
    repository
        .project_entity(project_id)
        .await
        .map_err(internal_error)?;
    Ok(access)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cp06_cp13_detail_uses_catalog_authorization_and_denies_missing_access() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let result = cloud_project(&mysql, "1001", 52, "historical-creator").await;
        let error = result
            .err()
            .expect("missing authorization must deny access");
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.detail_message(), Some("Cloud project not found"));

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        let expected = collaboration_access::access_sql(52, Some(1001), None)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(queries[0].sql, expected);
    }

    #[tokio::test]
    async fn detail_rejects_invalid_project_id_before_querying_permissions() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let result = cloud_project(&mysql, "invalid", 52, "reader").await;
        let error = result.err().expect("invalid project ID must be rejected");
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&error.validation_detail()).unwrap(),
            json!([{
                "type": "int_parsing",
                "loc": ["path", "project_id"],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": "invalid",
            }])
        );
        assert!(mysql.queries().is_empty());
    }

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

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/cloud-projects/:project_id/chat-agents";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(
            &http::Method::GET,
            "/api/v1/cloud-projects/2753648597973755964/chat-agents"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
