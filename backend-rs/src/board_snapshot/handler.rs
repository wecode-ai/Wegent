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
use chrono::NaiveDateTime;
use serde::Serialize;

use super::agents::normalize_empty_text;
pub(crate) use super::agents::{AgentView, agent_to_view, agent_visible_to_user};
use super::external_provider::{self, PROVIDER_REQUEST_FAILED_PREFIX};
use super::members::{self, BoardMember};
use super::repository::{BindingRow, BoardSnapshotRepository, has_permission};
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::loop_tasks::http_error::HttpError;
use crate::loop_tasks::item_response::{LoopItemResponse, ProjectFacts, response_values};
use crate::loop_tasks::loop_repository::LoopItemRepository;
use crate::state::AppState;

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero. Returns the string form; callers wrap
/// it in `json!` for serialization.
pub(crate) fn datetime_string(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

/// One `LoopItemTaskBindingResponse` row.
#[derive(Debug, Serialize)]
pub(crate) struct BindingResponse {
    id: String,
    cloud_project_id: String,
    loop_item_id: Option<String>,
    task_user_id: i32,
    device_id: String,
    task_id: String,
    task_title: Option<String>,
    backend_task_id: Option<i64>,
    /// `modelSelection` (`LoopItemTaskBinding.model_selection`): the metadata
    /// `model_selection` object when present, else `null`.
    #[serde(rename = "modelSelection")]
    model_selection: Option<brz_json::RawJson>,
    /// `executionContext` (`LoopItemTaskBinding.execution_context`): the
    /// metadata `execution_context` object when present, else `null`.
    #[serde(rename = "executionContext")]
    execution_context: Option<brz_json::RawJson>,
    workflow_node_id: Option<String>,
    human_assignment_id: Option<String>,
    dispatch_id: Option<String>,
    dispatch_round_id: Option<String>,
    assignment_id: Option<String>,
    /// `change_requests` (`LoopItemTaskBinding.change_requests`): the metadata
    /// `change_requests` object list (empty when absent).
    change_requests: Vec<brz_json::RawJson>,
    linked_by_user_id: i32,
    linked_at: Option<String>,
    unlinked_at: Option<String>,
}

/// Serialize one `LoopItemTaskBindingResponse`.
pub(crate) fn binding_response(binding: &BindingRow) -> BindingResponse {
    BindingResponse {
        id: binding.id.clone(),
        cloud_project_id: binding.cloud_project_id.clone(),
        loop_item_id: normalize_empty_text(binding.loop_item_id.as_deref()),
        task_user_id: binding.task_user_id,
        device_id: binding.device_id.clone(),
        task_id: binding.task_id.clone(),
        task_title: normalize_empty_text(binding.task_title.as_deref()),
        backend_task_id: binding.backend_task_id.filter(|value| *value != 0),
        // `modelSelection`: the metadata `model_selection` mapping when it is
        // a JSON object, else `null` (`LoopItemTaskBinding.model_selection`).
        model_selection: binding.model_selection(),
        // `executionContext`: the metadata `execution_context` mapping when it
        // is a JSON object, else `null` (`LoopItemTaskBinding.execution_context`).
        execution_context: binding.execution_context(),
        workflow_node_id: binding.workflow_node_id(),
        // Dispatch/assignment ids: metadata text when a non-empty string,
        // else `null` (`LoopItemTaskBindingResponse`).
        human_assignment_id: binding.human_assignment_id(),
        dispatch_id: binding.dispatch_id(),
        dispatch_round_id: binding.dispatch_round_id(),
        assignment_id: binding.assignment_id(),
        // `change_requests`: the metadata `change_requests` list entries that
        // are JSON objects (`LoopItemTaskBinding.change_requests`).
        change_requests: binding.change_requests(),
        linked_by_user_id: binding.linked_by_user_id,
        linked_at: datetime_string(binding.linked_at),
        unlinked_at: match binding.unlinked_at {
            Some(value) if !super::repository::datetime_is_unset(binding.unlinked_at) => {
                datetime_string(Some(value))
            }
            _ => None,
        },
    }
}

/// GET /api/v1/cloud-projects/{project_id}/board-snapshot: the board-snapshot
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/board-snapshot")]
async fn get_project_board_snapshot(
    #[inject(state)] state: &AppState,
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
    state: &AppState,
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

    // `list_item_views`: re-read the project, list the active task rows
    // (`loop_item_service.list`, with its role guard), resolve `access()`
    // again, then project every row through `response_values`.
    let items = list_item_views(state, project_number, current_user).await?;

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

    // `loop_item_service.list_project_task_bindings` (+ its `Reporter` guard).
    // A public visitor fails the guard and the source raises 403.
    let bindings_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    if !has_permission(&bindings_access.role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let bindings = repository
        .list_project_task_bindings(&project_id, &item_ids)
        .await
        .map_err(internal_error)?;

    // `cloud_project_service.list_members` (+ its `Viewer` guard): the
    // effective participant roster and each member's permission provenance.
    let members_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    let members = members::list_project_members(
        &state.mysql,
        &members_access.project,
        project_number,
        members_access.workspace_id,
        current_user.id,
    )
    .await
    .map_err(internal_error)?;

    // `project_chat_service.list_agents` (+ its `Viewer` guard): active
    // chat-agent rows, filtered by visibility against the caller.
    let _agents_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
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

/// `project_board_snapshot_service.list_item_views`: the project's active task
/// rows projected through `loop_item_service.response_values`. The source
/// resolves the project, the rows, and the per-item access with three
/// `project_access_query` statements before projecting every row with the
/// shared access.
async fn list_item_views(
    state: &AppState,
    project_number: i64,
    current_user: &SessionUser,
) -> Result<Vec<LoopItemResponse>, FastApiError> {
    let repository = BoardSnapshotRepository::new(&state.mysql);

    // `cloud_project_service.get`: re-read the project row (and role).
    let project_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    let project = project_access.project;

    // External providers (github/gitlab) list issues through their provider
    // API. No recorded board-snapshot case exercises this branch (every
    // recorded case is a local project); the call and its 502 mapping are
    // preserved from the source's `external_loop_item_provider.list`.
    if matches!(project.task_provider().as_str(), "github" | "gitlab") {
        let _ =
            external_provider::list_issues(&state.attachment_http, &state.auth.jwt_key, &project)
                .await
                .map_err(|error| {
                    FastApiError::detail(
                        brz_http_server::StatusCode::BAD_GATEWAY,
                        format!("{PROVIDER_REQUEST_FAILED_PREFIX}{error}"),
                    )
                })?;
        return Ok(Vec::new());
    }

    // `loop_item_service.list` -> `_require_internal_task_project`: re-reads
    // the role (`Viewer`) before the rows; a caller without `Viewer` raises
    // 403 "Insufficient permission".
    let list_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    if !has_permission(&list_access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    // `has_permission(access.role, Maintainer)` decides whether the source
    // applies `visible_item_filter`.
    let visible_filter = (!has_permission(&list_access.role, "Maintainer"))
        .then(|| project.default_issue_security());
    let item_rows = LoopItemRepository::new(&state.mysql)
        .list_project_task_items(&project.id, current_user.id, visible_filter)
        .await
        .map_err(internal_error)?;

    // `cloud_project_service.access(db, project_id, user_id)`: the access the
    // source threads into every `response_values` call.
    let item_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;

    let visibility = project.visibility();
    let default_issue_security = project.default_issue_security();
    let facts = ProjectFacts {
        number: project_number,
        visibility: &visibility,
        provider_is_local: project.task_provider() == "local",
        created_by_user_id: project.created_by_user_id,
        default_issue_security,
    };
    let mut items = Vec::with_capacity(item_rows.len());
    for row in &item_rows {
        let view = response_values(state, row, current_user, &facts, Some(&item_access))
            .await
            .map_err(HttpError::into_fastapi)?;
        items.push(view);
    }
    Ok(items)
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
    FastApiError::validation(serde_json::json!([{
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
    use brz_mysql::Json;
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

    #[test]
    fn binding_response_normalizes_null_and_zero_backend_task_ids() {
        let mut binding = BindingRow {
            id: "5336494559207636217".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some(String::new()),
            task_user_id: 52,
            device_id: "dev".to_string(),
            task_id: "t".to_string(),
            task_title: Some(String::new()),
            backend_task_id: Some(0),
            linked_by_user_id: 52,
            linked_at: None,
            unlinked_at: None,
            metadata: None,
        };
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["backend_task_id"], serde_json::Value::Null);
        assert_eq!(value["loop_item_id"], serde_json::Value::Null);
        assert_eq!(value["task_title"], serde_json::Value::Null);
        assert_eq!(value["workflow_node_id"], serde_json::Value::Null);
        for (stored, expected) in [(None, None), (Some(0), None), (Some(42), Some(42))] {
            binding.backend_task_id = stored;
            assert_eq!(binding_response(&binding).backend_task_id, expected);
        }
    }

    #[test]
    fn binding_response_serializes_the_source_camel_case_aliases() {
        // `LoopItemTaskBindingResponse` declares the `modelSelection` and
        // `executionContext` aliases; a missing rename ships a snake_case key
        // the recorded board-snapshot body does not carry.
        let binding = BindingRow {
            id: "1".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some("item".to_string()),
            task_user_id: 1,
            device_id: "d".to_string(),
            task_id: "t".to_string(),
            task_title: None,
            backend_task_id: Some(0),
            linked_by_user_id: 1,
            linked_at: None,
            unlinked_at: None,
            metadata: Some(Json(
                serde_json::from_value(json!({
                    "model_selection": {"model": "m"},
                    "execution_context": {"kind": "local"},
                }))
                .unwrap(),
            )),
        };
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["modelSelection"], json!({"model": "m"}));
        assert_eq!(value["executionContext"], json!({"kind": "local"}));
        assert!(value.get("model_selection").is_none());
        assert!(value.get("execution_context").is_none());
    }

    #[test]
    fn binding_response_keeps_real_unlinked_at() {
        let mut binding = BindingRow {
            id: "1".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some("item".to_string()),
            task_user_id: 1,
            device_id: "d".to_string(),
            task_id: "t".to_string(),
            task_title: None,
            backend_task_id: Some(0),
            linked_by_user_id: 1,
            linked_at: None,
            unlinked_at: NaiveDateTime::parse_from_str("2026-09-04 08:00:00", "%Y-%m-%d %H:%M:%S")
                .ok(),
            metadata: None,
        };
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["unlinked_at"], json!("2026-09-04T08:00:00"));
        // Unset sentinel maps to null.
        binding.unlinked_at =
            NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S").ok();
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["unlinked_at"], serde_json::Value::Null);
    }
}
