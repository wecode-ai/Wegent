// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Visibility and projection of a project's chat agents.

use serde_json::json;

use crate::ProjectState;
use crate::auth::UserRow;
use crate::cloud_projects::{cloud_project_not_found, internal_error};
use crate::http_compat::FastApiError;
use wegent_identity::flexible_auth::FlexibleUser;

use super::{agents, repository};

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
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/chat-agents", group = project_coordination)]
async fn list_project_chat_agents(
    #[inject(state)] state: &ProjectState,
    project_id: &str,
    query: brz_http_server::Query<ChatAgentListQuery>,
    #[auth] current_user: FlexibleUser,
) -> Result<Vec<agents::AgentView>, FastApiError> {
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
    state: &ProjectState,
    project_id: &str,
    current_user: UserRow,
    include_archived: bool,
) -> Result<Vec<agents::AgentView>, FastApiError> {
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
    if !repository::has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `if include_archived: require_cloud_project_role(..., Maintainer)`.
    if include_archived {
        let access = require_cloud_project_role(state, number, current_user.id).await?;
        if !repository::has_permission(&access.role, "Maintainer") {
            return Err(FastApiError::forbidden("Insufficient permission"));
        }
    }

    // `project_chat_service.list_agents`: chat-agent rows for the project,
    // filtered by visibility against the caller.
    let repository = repository::BoardSnapshotRepository::new(&state.mysql);
    let agents = repository
        .list_agents(project_id, include_archived)
        .await
        .map_err(internal_error)?;
    let mut visible_agents: Vec<agents::AgentView> = Vec::new();
    for agent in agents
        .iter()
        .filter(|agent| agents::agent_visible_to_user(agent, current_user.id))
    {
        visible_agents.push(
            agents::agent_to_view(state, agent, current_user.id, &current_user.user_name).await?,
        );
    }

    Ok(visible_agents)
}

/// `require_cloud_project_role(db, project_id, user_id, required_role)`:
/// the access statement, the permission-source reads, and the `CloudProject`
/// entity re-read that the source performs before comparing the role.
async fn require_cloud_project_role(
    state: &ProjectState,
    project_id: i64,
    user_id: i32,
) -> Result<repository::ProjectAccess, FastApiError> {
    let repository = repository::BoardSnapshotRepository::new(&state.mysql);
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
