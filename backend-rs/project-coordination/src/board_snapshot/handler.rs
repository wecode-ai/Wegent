// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/v1/cloud-projects/{project_id}/board-snapshot`.
//!
//! Mirrors `app.api.endpoints.cloud_projects.get_project_board_snapshot`:
//! `project_board_snapshot_service.get(db, project_id, current_user.id)`
//! returns `ProjectBoardSnapshotResponse { items, task_bindings, members,
//! agents }`.
//!
//! Source pipeline (`app.services.project_board_snapshot`):
//! 1. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup (the full twelve-column `users_<column>` projection);
//! 2. `list_item_views` — `cloud_project_service.get` runs
//!    `require_cloud_project_role` (re-read the project row plus the
//!    approved membership row for non-creators). For external providers
//!    (github/gitlab) the external loop-item provider lists issues from the
//!    provider API; for local projects `loop_item_service.list` reads
//!    `loop_items` rows for the project.
//! 3. `loop_item_service.list_project_task_bindings` — active
//!    `loop_items` execution rows whose `loop_item_id` is in the item list;
//! 4. `cloud_project_service.list_members` — approved `resource_members`
//!    joined with `users`, plus the creator when absent;
//! 5. `project_chat_service.list_agents` — active `loop_items` chat-agent
//!    rows for the project, filtered by visibility against the caller.
use serde::Serialize;

pub(crate) use super::agents::{AgentView, agent_to_view, agent_visible_to_user};
use super::members::{self, BoardMember};
use super::repository::{BoardSnapshotRepository, has_permission};
use crate::ProjectState;
use crate::auth::SessionUser;
use crate::board_snapshot::bindings::{BindingResponse, binding_response};
use crate::http_compat::FastApiError;
use crate::loop_tasks::http_error::HttpError;
use crate::loop_tasks::item_response::{LoopItemResponse, ProjectFacts, response_values_many};
use crate::loop_tasks::loop_repository::LoopItemRepository;

/// GET /api/v1/cloud-projects/{project_id}/board-snapshot: the board-snapshot
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/board-snapshot", group = project_coordination)]
async fn get_project_board_snapshot(
    #[inject(state)] state: &ProjectState,
    project_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<ProjectBoardSnapshotResponse, FastApiError> {
    board_snapshot(state, project_id, &current_user).await
}

/// The `ProjectBoardSnapshotResponse` payload returned by the source.
#[derive(Debug, Serialize)]
struct ProjectBoardSnapshotResponse {
    items: Vec<LoopItemResponse>,
    task_bindings: Vec<BindingResponse>,
    members: Vec<BoardMember>,
    agents: Vec<AgentView>,
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/board-snapshot`.
async fn board_snapshot(
    state: &ProjectState,
    project_id: &str,
    current_user: &SessionUser,
) -> Result<ProjectBoardSnapshotResponse, FastApiError> {
    let repository = BoardSnapshotRepository::new(&state.mysql);
    let project_number: i64 = project_id
        .parse()
        .map_err(|_| path_validation_error(project_id))?;

    // `project_board_snapshot_service.get`: `cloud_project_service.access(db,
    // project_id, user_id)` resolves the active project row and the caller's
    // effective role through one `project_access_query` statement.
    let access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    // The access helper loads the project entity once per ORM session
    // (`db.get(CloudProject, str(project_id))`) after resolving the role and
    // its permission sources.
    repository
        .project_entity(project_number)
        .await
        .map_err(internal_error)?;

    // `list_item_views(db, access, user_id)`: the source threads the resolved
    // `access` through every helper, so the whole request issues one
    // `project_access_query` statement.
    let items = list_item_views(state, project_number, &access, current_user).await?;

    // `if access.is_viewer`: a bare viewer receives only the items.
    if access.role == "Viewer" {
        return Ok(ProjectBoardSnapshotResponse {
            items,
            task_bindings: Vec::new(),
            members: Vec::new(),
            agents: Vec::new(),
        });
    }

    let project_id = access.project.id.clone();
    let item_ids: Vec<String> = items.iter().map(|item| item.id().to_string()).collect();

    // `loop_item_service.list_project_task_bindings_for_access`: the shared
    // access replaces the helper's own `Reporter` guard.
    if !has_permission(&access.role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let bindings = repository
        .list_project_task_bindings(&project_id, &item_ids)
        .await
        .map_err(internal_error)?;

    // `cloud_project_service.list_members_for_access`: the effective
    // participant roster and each member's permission provenance.
    let members = members::list_project_members(
        &state.mysql,
        &access.project,
        project_number,
        access.workspace_id,
        current_user.id,
    )
    .await
    .map_err(internal_error)?;

    // `project_chat_service.list_agents_for_access`: active chat-agent rows,
    // filtered by visibility against the caller. `include_archived` stays
    // false, so the helper's `Maintainer` guard cannot fire.
    let agents = repository
        .list_agents(&project_id, false)
        .await
        .map_err(internal_error)?;
    let mut visible_agents: Vec<AgentView> = Vec::new();
    for agent in agents
        .iter()
        .filter(|agent| agent_visible_to_user(agent, current_user.id))
    {
        visible_agents
            .push(agent_to_view(state, agent, current_user.id, &current_user.user_name).await?);
    }

    Ok(ProjectBoardSnapshotResponse {
        items,
        task_bindings: bindings.iter().map(binding_response).collect(),
        members,
        agents: visible_agents,
    })
}

/// `project_board_snapshot_service.list_item_views(db, access, user_id)`: the
/// project's active task rows projected through
/// `loop_item_service.response_values`. The source resolves `access` once in
/// `get` and threads it into this helper, `list_for_access`, and every
/// `response_values` call, so the request issues a single
/// `project_access_query` statement.
async fn list_item_views(
    state: &ProjectState,
    project_number: i64,
    access: &super::repository::ProjectAccess,
    current_user: &SessionUser,
) -> Result<Vec<LoopItemResponse>, FastApiError> {
    let project = &access.project;

    // External providers (github/gitlab) list issues through their provider
    // API: `external_loop_item_provider.list(db, project_id, user_id)` with no
    // assignee filter.
    if matches!(project.task_provider().as_str(), "github" | "gitlab") {
        return crate::loop_item_pages::list_external_items(
            &crate::ExternalIssueReads {
                mysql: &state.mysql,
                attachment_http: &state.attachment_http,
                jwt_key: &state.jwt_key,
            },
            project,
            &access.role,
            current_user.id,
            None,
            None,
        )
        .await;
    }

    // `loop_item_service.list_for_access`: the shared access satisfies the
    // helper's `Viewer` requirement, so no second role read runs.
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    // `has_permission(access.role, Maintainer)` decides whether the source
    // applies `visible_item_filter`.
    let visible_filter =
        (!has_permission(&access.role, "Maintainer")).then(|| project.default_issue_security());
    let item_rows = LoopItemRepository::new(&state.mysql)
        .list_project_task_items(&project.id, current_user.id, visible_filter)
        .await
        .map_err(internal_error)?;

    let visibility = project.visibility();
    let default_issue_security = project.default_issue_security();
    let facts = ProjectFacts {
        number: project_number,
        visibility: &visibility,
        provider_is_local: project.task_provider() == "local",
        created_by_user_id: project.created_by_user_id,
        default_issue_security,
    };
    response_values_many(
        &crate::LoopItemReads {
            mysql: &state.mysql,
            user_reader: state.user_reader.as_ref(),
        },
        &item_rows,
        &current_user.0,
        &facts,
        Some(access),
    )
    .await
    .map_err(HttpError::into_fastapi)
}

/// `404 "Cloud project not found"` (`require_cloud_project_role`).
fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Cloud project not found",
    )
}

/// FastAPI-style 422 for an unparsable `project_id` path parameter. The source
/// declares `project_id: int`, so a non-numeric path segment is rejected
/// before the handler runs.
fn path_validation_error(value: &str) -> FastApiError {
    // `validation_exception_handler` (`app/core/exceptions.py`) replaces
    // FastAPI's default array body with the application's own shape.
    FastApiError::request_validation(serde_json::json!([{
        "type": "int_parsing",
        "loc": ["path", "project_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    }]))
}

pub(crate) fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "board-snapshot dependency failure");
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn member_serializes_the_unified_permission_shape() {
        let member = BoardMember {
            id: 10,
            user_id: 86,
            user_name: "jiawei36".to_string(),
            email: Some("jiawei36@example.com".to_string()),
            role: "Maintainer".to_string(),
            direct_role: Some("Maintainer".to_string()),
            inherited_role: Some("Developer".to_string()),
            permission_sources: vec![
                members::PermissionSource::Workspace {
                    workspace_id: "353932".to_string(),
                    role: "Developer".to_string(),
                },
                members::PermissionSource::Direct {
                    role: "Maintainer".to_string(),
                },
            ],
            inherited_from_workspace_id: Some("353932".to_string()),
            can_be_assignee: true,
            capability_description: "owns review".to_string(),
        };
        let value = serde_json::to_value(&member).unwrap();
        assert_eq!(value["id"], 10);
        assert_eq!(value["user_id"], 86);
        assert_eq!(value["user_name"], "jiawei36");
        assert_eq!(value["email"], "jiawei36@example.com");
        assert_eq!(value["role"], "Maintainer");
        assert_eq!(value["direct_role"], "Maintainer");
        assert_eq!(value["inherited_role"], "Developer");
        assert_eq!(
            value["permission_sources"],
            json!([
                {"type": "workspace", "workspace_id": "353932", "role": "Developer"},
                {"type": "direct", "role": "Maintainer"}
            ])
        );
        assert_eq!(value["inherited_from_workspace_id"], "353932");
        assert_eq!(value["can_be_assignee"], true);
        assert_eq!(value["capability_description"], "owns review");
    }
}
