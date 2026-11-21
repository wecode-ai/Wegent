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
use serde_json::json;

use crate::auth::UserRow;
use crate::board_snapshot;
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::state::AppState;

pub(crate) use collaboration_access::access_sql as project_access_statement;
pub(crate) use wegent_project_coordination::cloud_projects::response::CloudProjectBody;
pub(crate) use wegent_project_coordination::cloud_projects::{
    CloudMetadataInput, LOOP_ITEMS_COLUMNS, ProjectAccessRow, ProjectListRow,
    WORKSPACE_ID_EXPRESSION, authorized_project, collaboration_access, entity_columns, members,
    project_access_details, project_access_point_statement, project_permission_statement,
    role_for_priority,
};

pub(crate) use wegent_project_coordination::cloud_projects::{
    cloud_project_not_found, internal_error, parse_project_id, project_access,
};

/// Project assistant roster and one-transaction Issue fan-out.
mod assistant_roster;
mod collaboration_metrics;

pub(crate) use wegent_project_coordination::cloud_projects::metadata_board_statuses;

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

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/cloud-projects/:project_id/chat-agents";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
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
