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
use brz_mysql::Mysql;
use chrono::NaiveDateTime;
use serde::Serialize;

use super::external_provider::{self, PROVIDER_REQUEST_FAILED_PREFIX};
use super::repository::{AgentRow, BindingRow, BoardSnapshotRepository, MemberRow, has_permission};
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

/// `ProjectChatWorkspaceBindingView` (`app.schemas.project_chat`). Every field
/// is always emitted, so absent values serialize as `null`.
#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceBindingView {
    r#type: String,
    status: &'static str,
    #[serde(rename = "projectId")]
    project_id: Option<i32>,
    #[serde(rename = "deviceWorkspaceId")]
    device_workspace_id: Option<i64>,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "runtimeProjectKey")]
    runtime_project_key: Option<String>,
}

impl WorkspaceBindingView {
    /// `standalone` + `ready` with every other field null.
    fn standalone() -> Self {
        Self {
            r#type: "standalone".to_string(),
            status: "ready",
            project_id: None,
            device_workspace_id: None,
            device_id: None,
            runtime_project_key: None,
        }
    }
}

/// One `ProjectChatAgentView` projection used by
/// `project_chat_service.list_agents` and
/// `project_chat_service.agent_to_view`. The source schema derives every
/// wire key from the field name through the `_to_camel` alias generator
/// (`app.schemas.project_chat.ProjectChatSchema`), so the struct serializes
/// with `rename_all = "camelCase"`; the two `id`-shaped fields stay as-is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentView {
    id: String,
    project_id: String,
    name: String,
    runtime: String,
    wegent_team_id: Option<i64>,
    model: Option<String>,
    model_type: Option<String>,
    model_options: serde_json::Map<String, serde_json::Value>,
    system_prompt: String,
    capability_description: String,
    capability_mode: String,
    /// `executionPolicy` (`ProjectChatAgentView.execution_policy`):
    /// `bot_config(row)["execution_policy"]` when it is an object, else `null`.
    execution_policy: Option<brz_json::RawJson>,
    /// `modelPolicy` (`ProjectChatAgentView.model_policy`):
    /// `bot_config(row)["model_policy"]` when it is an object, else `null`.
    model_policy: Option<brz_json::RawJson>,
    status: &'static str,
    visibility: String,
    execution_environment: String,
    execution_mode: String,
    execution_device_id: Option<String>,
    workspace_binding: WorkspaceBindingView,
    local_project_id: Option<i32>,
    max_concurrent_executions: i32,
    workspace_policy: String,
    default_runtime_profile_id: Option<String>,
    plugins: Vec<serde_json::Value>,
    additional_skills: Vec<serde_json::Value>,
    mcp_servers: serde_json::Map<String, serde_json::Value>,
    created_by_user_id: Option<i32>,
    created_by_user_name: Option<String>,
    version: i32,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// `project_chat_service.agent_to_view(row, db=db, viewer_user_id=viewer)`:
/// resolve the creator's display name (a no-op read for the caller), then
/// project the row.
pub(crate) async fn agent_to_view(
    state: &AppState,
    row: &AgentRow,
    viewer_id: i32,
    viewer_name: &str,
) -> Result<AgentView, FastApiError> {
    // `db.get(User, row.created_by_user_id)`: the source identity map already
    // holds the caller, so only another creator needs a read.
    let created_by_user_name = match row.created_by_user_id {
        Some(id) if id == viewer_id => Some(viewer_name.to_string()),
        Some(id) => state
            .user_reader
            .get_entity_by_id(i64::from(id))
            .await
            .map_err(|error| {
                tracing::error!(%error, "project agent creator lookup failed");
                FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                )
            })?
            .map(|record| record.user_name),
        None => None,
    };
    Ok(agent_view_from_row(row, viewer_id, created_by_user_name))
}

/// The `ProjectChatAgentView` projection for one agent row and a resolved
/// creator name.
fn agent_view_from_row(
    row: &AgentRow,
    viewer_id: i32,
    created_by_user_name: Option<String>,
) -> AgentView {
    let config = row.bot_config();
    let workspace_binding = workspace_binding_view(row, config.workspace_binding());
    // `local_project_id=workspace_binding.project_id` in the source.
    let local_project_id = workspace_binding.project_id;
    // `_visible_mcp_servers(config, expose_configuration=viewer == creator)`:
    // an unexposed server keeps its key with an empty configuration.
    let mcp_servers = if viewer_id == row.created_by_user_id.unwrap_or(0) {
        config.mcp_servers()
    } else {
        config
            .mcp_servers()
            .into_iter()
            .map(|(name, _)| (name, serde_json::json!({})))
            .collect()
    };
    let name = row
        .title
        .clone()
        .or_else(|| row.name.clone())
        .unwrap_or_else(|| "AI".to_string());
    let status = if row.status.as_deref() == Some("archived") {
        "archived"
    } else {
        "active"
    };
    AgentView {
        id: row.id.clone(),
        project_id: row.cloud_project_id.clone(),
        name,
        runtime: config.runtime(),
        wegent_team_id: config.wegent_team_id(),
        model: config.model(),
        model_type: config.model_type(),
        model_options: config.model_options(),
        system_prompt: config.system_prompt(),
        capability_description: row.description.clone().unwrap_or_default(),
        capability_mode: config.capability_mode(),
        execution_policy: config.execution_policy(),
        model_policy: config.model_policy(),
        status,
        visibility: config.visibility(),
        execution_environment: config.execution_environment(),
        execution_mode: config.execution_mode(),
        // `execution_device_id=row.device_id or None`: an unset device id
        // renders as null, never an empty string.
        execution_device_id: normalize_empty_text(row.device_id.as_deref()),
        workspace_binding,
        local_project_id,
        max_concurrent_executions: config.max_concurrent_executions(),
        workspace_policy: config.workspace_policy(),
        default_runtime_profile_id: config.default_runtime_profile_id(),
        plugins: config.plugins(),
        additional_skills: config.additional_skills(),
        mcp_servers,
        created_by_user_id: row.created_by_user_id,
        created_by_user_name,
        version: row.version.unwrap_or(1),
        created_at: datetime_string(row.created_at),
        updated_at: datetime_string(row.updated_at),
    }
}

/// `read_agent_workspace_binding`: the stored V2 binding when present, else
/// `adapt_legacy_workspace_binding`. Recorded agent rows carry no stored
/// binding and no legacy local project id, so they resolve to
/// `standalone` + `ready`.
fn workspace_binding_view(
    row: &AgentRow,
    stored: Option<&serde_json::Map<String, serde_json::Value>>,
) -> WorkspaceBindingView {
    if let Some(binding) = stored {
        match binding.get("type").and_then(serde_json::Value::as_str) {
            Some("standalone") => return WorkspaceBindingView::standalone(),
            Some("device_project") => {
                return WorkspaceBindingView {
                    r#type: "device_project".to_string(),
                    status: "ready",
                    project_id: None,
                    device_workspace_id: None,
                    device_id: row.device_id.clone(),
                    runtime_project_key: binding
                        .get("runtime_project_key")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                };
            }
            _ => {}
        }
    }
    let local_project_id = row.local_project_id.unwrap_or(0);
    if local_project_id <= 0 {
        return WorkspaceBindingView::standalone();
    }
    WorkspaceBindingView {
        r#type: "backend_project".to_string(),
        status: "ready",
        project_id: Some(local_project_id),
        device_workspace_id: None,
        device_id: row.device_id.clone(),
        runtime_project_key: None,
    }
}

/// `_agent_visible_to_user(row, user_id, role)`: the source's visibility
/// filter. Private is the creator only, `creator_admin` is the creator
/// plus project admins, public is every project member.
pub(crate) fn agent_visible_to_user(row: &AgentRow, user_id: i32, role: &str) -> bool {
    if row.created_by_user_id == Some(user_id) {
        return true;
    }
    match row.visibility().as_str() {
        "public" => true,
        "creator_admin" => role == "Owner" || role == "Maintainer",
        _ => false,
    }
}

/// `normalize_empty_text`: `""` becomes `None`.
fn normalize_empty_text(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
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
        backend_task_id: if binding.backend_task_id == 0 {
            None
        } else {
            Some(binding.backend_task_id)
        },
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

/// One `CloudProjectMemberResponse` row.
#[derive(Debug, Serialize)]
struct MemberResponse {
    id: i32,
    user_id: i32,
    user_name: String,
    email: Option<String>,
    role: String,
    capability_description: String,
}

/// Serialize one `CloudProjectMemberResponse`. The source nulls `email` when
/// the caller is not an explicit project member (`can_view_emails`).
fn member_response(member: &MemberRow, can_view_emails: bool) -> MemberResponse {
    MemberResponse {
        id: member.member_id,
        user_id: member.user_id,
        user_name: member.user_name.clone(),
        email: if can_view_emails {
            member.email.clone()
        } else {
            None
        },
        role: member.role.clone(),
        capability_description: String::new(),
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
    members: Vec<MemberResponse>,
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

    // `cloud_project_service.list_members` (+ its `Viewer` guard): the member
    // emails are gated on the caller being an explicit project member.
    let _members_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    let can_view_emails = repository
        .explicit_member_ids(&project_id)
        .await
        .map_err(internal_error)?
        .iter()
        .any(|entity_id| entity_id.parse::<i32>().ok() == Some(current_user.id));
    let mut members = repository
        .list_members(&project_id)
        .await
        .map_err(internal_error)?;
    // The source inserts the creator at index 0 when the creator is not
    // already an approved member.
    if !members
        .iter()
        .any(|member| member.user_id == access.project.created_by_user_id)
    {
        let creator = CreatorRow::lookup(&state.mysql, access.project.created_by_user_id)
            .await
            .map_err(internal_error)?;
        if let Some(creator) = creator {
            members.insert(0, MemberRow::from(creator));
        }
    }

    // `project_chat_service.list_agents` (+ its `Viewer` guard): active
    // chat-agent rows, filtered by visibility against the caller.
    let _agents_access = repository
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    let agents = repository
        .list_agents(&project_id)
        .await
        .map_err(internal_error)?;
    let mut visible_agents: Vec<AgentView> = Vec::new();
    for agent in agents
        .iter()
        .filter(|agent| agent_visible_to_user(agent, current_user.id, &access.role))
    {
        visible_agents
            .push(agent_to_view(state, agent, current_user.id, &current_user.user_name).await?);
    }

    Ok(ProjectBoardSnapshotResponse {
        items,
        task_bindings: bindings.iter().map(binding_response).collect(),
        members: members
            .iter()
            .map(|member| member_response(member, can_view_emails))
            .collect(),
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

/// Lookup row for the project creator when they are not already a member.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct CreatorRow {
    #[mysql(rename = "users_id")]
    user_id: i32,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
}

impl CreatorRow {
    async fn lookup<M: Mysql>(
        mysql: &M,
        user_id: i32,
    ) -> Result<Option<Self>, brz_mysql::MysqlError> {
        mysql
            .fetch_optional(
                "SELECT users.id AS users_id, users.user_name AS users_user_name, \
                 users.email AS users_email \
                 FROM users WHERE users.id = ? LIMIT 1",
                (user_id,),
            )
            .await
    }
}

impl From<CreatorRow> for MemberRow {
    fn from(row: CreatorRow) -> Self {
        MemberRow {
            member_id: 0,
            user_id: row.user_id,
            user_name: row.user_name,
            email: row.email,
            role: "Owner".to_string(),
        }
    }
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
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

    fn agent(metadata: serde_json::Value) -> AgentRow {
        AgentRow {
            id: "1".to_string(),
            cloud_project_id: "p".to_string(),
            title: Some("Robot".to_string()),
            name: None,
            description: Some("desc".to_string()),
            status: Some("active".to_string()),
            created_by_user_id: Some(5),
            device_id: Some("dev".to_string()),
            local_project_id: None,
            created_at: None,
            updated_at: None,
            deleted_at: None,
            version: Some(1),
            metadata: Some(Json(metadata)),
        }
    }

    /// Project one row as its own creator, matching the recorded identity-map
    /// hit for `db.get(User, row.created_by_user_id)`.
    fn view_value(row: &AgentRow) -> serde_json::Value {
        let creator = row.created_by_user_id;
        serde_json::to_value(agent_view_from_row(
            row,
            creator.unwrap_or(0),
            creator.map(|_| "creator".to_string()),
        ))
        .unwrap()
    }

    #[test]
    fn agent_view_defaults_for_standalone_binding() {
        let view = view_value(&agent(json!({})));
        assert_eq!(view["name"], "Robot");
        assert_eq!(view["runtime"], "codex");
        assert_eq!(view["visibility"], "creator_admin");
        assert_eq!(view["capabilityMode"], "follow_device");
        assert_eq!(view["workspacePolicy"], "project");
        assert_eq!(view["workspaceBinding"]["type"], "standalone");
        assert_eq!(view["workspaceBinding"]["status"], "ready");
        assert_eq!(
            view["workspaceBinding"]["projectId"],
            serde_json::Value::Null
        );
        assert_eq!(view["localProjectId"], serde_json::Value::Null);
        assert_eq!(view["createdByUserName"], "creator");
    }

    #[test]
    fn agent_view_reads_the_bot_config_metadata() {
        let row = agent(json!({
            "capability_mode": "follow_device",
            "model": "gpt-5.6-sol",
            "model_type": "runtime",
            "system_prompt": "hi",
            "workspace_policy": "git_worktree",
            "max_concurrent_executions": 3,
            "mcp_servers": {"srv": {"cmd": "x"}},
            "additional_skills": ["a"],
        }));
        let view = view_value(&row);
        assert_eq!(view["model"], "gpt-5.6-sol");
        assert_eq!(view["modelType"], "runtime");
        assert_eq!(view["systemPrompt"], "hi");
        assert_eq!(view["workspacePolicy"], "git_worktree");
        assert_eq!(view["maxConcurrentExecutions"], 3);
        assert_eq!(view["capabilityMode"], "follow_device");
        // The creator (viewer) sees the stored server configuration.
        assert_eq!(view["mcpServers"]["srv"]["cmd"], "x");
        assert_eq!(view["additionalSkills"][0], "a");
    }

    #[test]
    fn agent_view_hides_mcp_servers_from_a_non_creator() {
        let row = agent(json!({"mcp_servers": {"srv": {"cmd": "x"}}}));
        let view = serde_json::to_value(agent_view_from_row(&row, 6, None)).unwrap();
        assert_eq!(view["mcpServers"]["srv"], json!({}));
    }

    #[test]
    fn agent_view_uses_backend_project_for_a_legacy_local_project() {
        let mut row = agent(json!({}));
        row.local_project_id = Some(7);
        let view = view_value(&row);
        assert_eq!(view["workspaceBinding"]["type"], "backend_project");
        assert_eq!(view["workspaceBinding"]["status"], "ready");
        assert_eq!(view["workspaceBinding"]["projectId"], 7);
        assert_eq!(view["localProjectId"], 7);
    }

    #[test]
    fn agent_visibility_creator_admin_blocks_non_admin() {
        let row = agent(json!({"visibility": "creator_admin"}));
        assert!(agent_visible_to_user(&row, 5, "Owner"));
        assert!(!agent_visible_to_user(&row, 6, "Developer"));
        assert!(agent_visible_to_user(&row, 6, "Maintainer"));
    }

    #[test]
    fn agent_visibility_public_allows_every_member() {
        let row = agent(json!({"visibility": "public"}));
        assert!(agent_visible_to_user(&row, 6, "Reporter"));
    }

    #[test]
    fn agent_visibility_private_is_creator_only() {
        let row = agent(json!({"visibility": "private"}));
        assert!(agent_visible_to_user(&row, 5, "Owner"));
        assert!(!agent_visible_to_user(&row, 6, "Owner"));
    }

    #[test]
    fn member_response_serializes_the_recorded_shape() {
        let member = MemberRow {
            member_id: 10,
            user_id: 86,
            user_name: "jiawei36".to_string(),
            email: Some("jiawei36@example.com".to_string()),
            role: "Owner".to_string(),
        };
        let value = serde_json::to_value(member_response(&member, true)).unwrap();
        assert_eq!(value["id"], 10);
        assert_eq!(value["user_id"], 86);
        assert_eq!(value["user_name"], "jiawei36");
        assert_eq!(value["email"], "jiawei36@example.com");
        assert_eq!(value["role"], "Owner");
        assert_eq!(value["capability_description"], "");
    }

    #[test]
    fn member_response_hides_email_without_member_access() {
        let member = MemberRow {
            member_id: 10,
            user_id: 86,
            user_name: "jiawei36".to_string(),
            email: Some("jiawei36@example.com".to_string()),
            role: "Owner".to_string(),
        };
        let value = serde_json::to_value(member_response(&member, false)).unwrap();
        assert_eq!(value["email"], serde_json::Value::Null);
    }

    #[test]
    fn binding_response_normalizes_zero_backend_task_id() {
        let binding = BindingRow {
            id: "5336494559207636217".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some(String::new()),
            task_user_id: 52,
            device_id: "dev".to_string(),
            task_id: "t".to_string(),
            task_title: Some(String::new()),
            backend_task_id: 0,
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
            backend_task_id: 0,
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
            backend_task_id: 0,
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
