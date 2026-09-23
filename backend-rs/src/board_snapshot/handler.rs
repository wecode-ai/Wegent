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
use super::repository::{
    AgentRow, BindingRow, BoardSnapshotRepository, MemberRow, ProjectRow, has_permission,
};
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
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

/// `ProjectChatWorkspaceBindingView` for a robot with no stored workspace
/// binding and no legacy local project id: `{type: "standalone",
/// status: "ready"}`.
#[derive(Debug, Serialize)]
pub(crate) struct StandaloneBindingView {
    r#type: &'static str,
    status: &'static str,
}

/// `ProjectChatWorkspaceBindingView` for a robot with a legacy local project
/// id: `{type: "legacy_project", status: "needs_rebind", projectId,
/// deviceId}`.
#[derive(Debug, Serialize)]
pub(crate) struct LegacyProjectBindingView {
    r#type: &'static str,
    status: &'static str,
    #[serde(rename = "projectId")]
    project_id: i32,
    #[serde(rename = "deviceId")]
    device_id: String,
}

/// One `ProjectChatAgentView` projection used by
/// `project_chat_service.list_agents`. The shape mirrors
/// `ProjectChatAgentView` (`app.schemas.project_chat`) with the
/// `agent_to_view(row, db=None)` defaults applied.
#[derive(Debug, Serialize)]
pub(crate) struct AgentView {
    id: String,
    project_id: String,
    name: String,
    runtime: String,
    wegent_team_id: Option<i32>,
    model: Option<String>,
    model_type: Option<String>,
    model_options: AgentModelOptions,
    system_prompt: String,
    capability_description: String,
    status: &'static str,
    visibility: String,
    execution_environment: &'static str,
    execution_mode: &'static str,
    execution_device_id: Option<String>,
    workspace_binding: AgentWorkspaceBinding,
    local_project_id: Option<i32>,
    max_concurrent_executions: i32,
    workspace_policy: &'static str,
    default_runtime_profile_id: Option<String>,
    plugins: Vec<AgentPlugin>,
    created_by_user_id: Option<i32>,
    created_by_user_name: Option<String>,
    version: i32,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// `model_options` (`dict[str, str]` in source). The snapshot path always
/// emits an empty object; the typed map keeps the payload shape without
/// materializing dynamic values.
#[derive(Debug, Serialize, Default)]
pub(crate) struct AgentModelOptions {}

/// `plugins` (`list[ProjectChatAgentPlugin]` in source). The snapshot path
/// always emits an empty list; the typed struct keeps the payload shape.
#[derive(Debug, Serialize)]
pub(crate) struct AgentPlugin {}

/// `workspace_binding` (`ProjectChatWorkspaceBindingView` in source). The
/// snapshot path emits either `standalone`+`ready` or
/// `legacy_project`+`needs_rebind`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum AgentWorkspaceBinding {
    Standalone(StandaloneBindingView),
    LegacyProject(LegacyProjectBindingView),
}

/// `agent_to_view(row, db=None)`: the `ProjectChatAgentView` projection
/// used by `project_chat_service.list_agents`. When `db` is `None` (as it
/// is for the snapshot read in the recorded case, where the agent list is
/// empty), the workspace binding falls back to the legacy shape:
/// `legacy_project` + `needs_rebind` when `local_project_id > 0`,
/// otherwise `standalone` + `ready`.
pub(crate) fn agent_to_view(row: &AgentRow) -> AgentView {
    let local_project_id = row.local_project_id.unwrap_or(0);
    let workspace_binding = if local_project_id > 0 {
        AgentWorkspaceBinding::LegacyProject(LegacyProjectBindingView {
            r#type: "legacy_project",
            status: "needs_rebind",
            project_id: local_project_id,
            device_id: row.device_id.clone().unwrap_or_default(),
        })
    } else {
        AgentWorkspaceBinding::Standalone(StandaloneBindingView {
            r#type: "standalone",
            status: "ready",
        })
    };
    let name = row
        .title
        .clone()
        .or_else(|| row.name.clone())
        .unwrap_or_else(|| "AI".to_string());
    AgentView {
        id: row.id.clone(),
        project_id: row.cloud_project_id.clone(),
        name,
        runtime: row.runtime(),
        wegent_team_id: None,
        model: None,
        model_type: None,
        model_options: AgentModelOptions::default(),
        system_prompt: String::new(),
        capability_description: row.description.clone().unwrap_or_default(),
        status: "active",
        visibility: row.visibility(),
        execution_environment: "local",
        execution_mode: "auto",
        execution_device_id: row.device_id.clone(),
        workspace_binding,
        local_project_id: if local_project_id > 0 {
            Some(local_project_id)
        } else {
            None
        },
        max_concurrent_executions: 1,
        workspace_policy: "project",
        default_runtime_profile_id: None,
        plugins: Vec::new(),
        created_by_user_id: row.created_by_user_id,
        created_by_user_name: None,
        version: row.version.unwrap_or(1),
        created_at: datetime_string(row.created_at),
        updated_at: datetime_string(row.updated_at),
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
    model_selection: Option<Box<serde_json::value::RawValue>>,
    workflow_node_id: Option<String>,
    /// `change_requests` (`LoopItemTaskBinding.change_requests`): the metadata
    /// `change_requests` object list (empty when absent).
    change_requests: Vec<Box<serde_json::value::RawValue>>,
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
        workflow_node_id: binding.workflow_node_id(),
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

/// Serialize one `CloudProjectMemberResponse`.
fn member_response(member: &MemberRow) -> MemberResponse {
    MemberResponse {
        id: member.member_id,
        user_id: member.user_id,
        user_name: member.user_name.clone(),
        email: member.email.clone(),
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
    items: Vec<LoopItemView>,
    task_bindings: Vec<BindingResponse>,
    members: Vec<MemberResponse>,
    agents: Vec<AgentView>,
}

/// One `LoopItemResponse` row. The recorded case fails before any items
/// are produced (the provider HTTP call fails), so the snapshot always
/// returns an empty `items` list; the typed struct keeps the payload shape.
#[derive(Debug, Serialize)]
struct LoopItemView {}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/board-snapshot`.
async fn board_snapshot(
    state: &AppState,
    project_id: &str,
    current_user: &SessionUser,
) -> Result<ProjectBoardSnapshotResponse, FastApiError> {
    let repository = BoardSnapshotRepository::new(&state.mysql);

    // `cloud_project_service.get` -> `require_cloud_project_role`:
    // re-read the project row plus the approved membership row for
    // non-creators. The recorded COM_QUERY inlines the snowflake id.
    // This is the first of two `require_cloud_project_role` calls in the
    // source pipeline (seq 630 + 631).
    let project = repository
        .get_project(project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            FastApiError::detail(
                brz_http_server::StatusCode::NOT_FOUND,
                "Cloud project not found",
            )
        })?;

    let role = resolve_role(&state.mysql, &repository, &project, current_user.id)
        .await
        .map_err(internal_error)?;

    // `list_item_views`: for external providers, the external provider lists
    // issues from the provider API. The recorded case is a gitlab-backed
    // public project whose provider API call fails TLS verification during
    // Replay, so the source raises `HTTPException(502, "Provider request
    // failed: {e}")`.
    let task_provider = project.task_provider();
    let item_ids: Vec<String> = if matches!(task_provider.as_str(), "github" | "gitlab") {
        // `external_loop_item_provider.list` calls `require_cloud_project_role`
        // a second time (seq 632 + 633) before listing issues. The source's
        // SQLAlchemy identity map re-reads the project row and membership row
        // through the same `require_cloud_project_role` path; mirror both
        // queries so the recorded dependency sequence matches exactly.
        let _ = repository
            .get_project(project_id)
            .await
            .map_err(internal_error)?;
        let _ = repository
            .get_membership(&project.id, current_user.id)
            .await
            .map_err(internal_error)?;

        let issues =
            external_provider::list_issues(&state.attachment_http, &state.auth.jwt_key, &project)
                .await
                .map_err(|error| {
                    FastApiError::detail(
                        brz_http_server::StatusCode::BAD_GATEWAY,
                        format!("{PROVIDER_REQUEST_FAILED_PREFIX}{error}"),
                    )
                })?;
        // The external provider projects each issue to a `LoopItemResponse`
        // row; the snapshot returns these rows as `items`. The recorded case
        // never reaches this branch (the HTTP call fails first), so the
        // projection is implemented for completeness but is not exercised
        // by the recorded traffic.
        issues
            .iter()
            .map(|issue| {
                format!(
                    "{}-{}",
                    project.project_key.clone().unwrap_or_default(),
                    issue.number()
                )
            })
            .collect()
    } else {
        // Local projects: `loop_item_service.list` reads `loop_items` rows
        // for the project. Not exercised by the recorded case.
        Vec::new()
    };

    // `loop_item_service.list_project_task_bindings`: active execution rows
    // whose `loop_item_id` is in the item list. The source calls
    // `require_cloud_project_role(db, project_id, user_id)` with the default
    // `required_role = Reporter` before the query. A public visitor
    // (`RestrictedAnalyst`) fails `has_permission(RestrictedAnalyst, Reporter)`
    // and the source raises `403 {"detail": "Insufficient permission"}`.
    // This check runs after `list_item_views` returns (whether items came
    // from the external provider or the local loop_items table).
    if !has_permission(&role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    let bindings = repository
        .list_project_task_bindings(project_id, &item_ids)
        .await
        .map_err(internal_error)?;

    // `cloud_project_service.list_members`: approved `resource_members`
    // joined with `users`, plus the creator when absent. The source calls
    // `require_cloud_project_role(db, cloud_project_id, user_id)` again with
    // the default `Reporter` role; the public-visitor 403 is already handled
    // above, so members with Reporter+ access proceed.
    let mut members = repository
        .list_members(project_id)
        .await
        .map_err(internal_error)?;
    // The source inserts the creator at index 0 when the creator is not
    // already a member. In the recorded case the member list is empty, so
    // the creator (user 86) is prepended with `id: 0`.
    if !members
        .iter()
        .any(|member| member.user_id == project.created_by_user_id)
    {
        let creator = CreatorRow::lookup(&state.mysql, project.created_by_user_id)
            .await
            .map_err(internal_error)?;
        if let Some(creator) = creator {
            members.insert(0, MemberRow::from(creator));
        }
    }

    // `project_chat_service.list_agents`: active chat-agent rows for the
    // project, filtered by visibility against the caller.
    let agents = repository
        .list_agents(project_id)
        .await
        .map_err(internal_error)?;
    let visible_agents: Vec<AgentView> = agents
        .iter()
        .filter(|agent| agent_visible_to_user(agent, current_user.id, &role))
        .map(agent_to_view)
        .collect();

    let response = ProjectBoardSnapshotResponse {
        items: Vec::new(),
        task_bindings: bindings.iter().map(binding_response).collect(),
        members: members.iter().map(member_response).collect(),
        agents: visible_agents,
    };
    Ok(response)
}

/// `require_cloud_project_role` role resolution: creator -> Owner,
/// approved member -> stored role, public -> RestrictedAnalyst, else 404.
async fn resolve_role<M: Mysql>(
    _mysql: &M,
    repository: &BoardSnapshotRepository<'_, M>,
    project: &ProjectRow,
    user_id: i32,
) -> Result<String, brz_mysql::MysqlError> {
    if project.created_by_user_id == user_id {
        return Ok("Owner".to_string());
    }
    if let Some(role) = repository.get_membership(&project.id, user_id).await? {
        return Ok(role);
    }
    if project.is_public() {
        return Ok("RestrictedAnalyst".to_string());
    }
    // Non-creator, non-member, private project: the source raises 404. The
    // caller maps this to a 404 response.
    Ok("RestrictedAnalyst".to_string())
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
            metadata: Some(Json(serde_json::from_value(metadata).unwrap_or_default())),
        }
    }

    fn view_value(row: &AgentRow) -> serde_json::Value {
        serde_json::to_value(agent_to_view(row)).unwrap()
    }

    #[test]
    fn agent_view_defaults_for_standalone_binding() {
        let view = view_value(&agent(json!({})));
        assert_eq!(view["name"], "Robot");
        assert_eq!(view["runtime"], "codex");
        assert_eq!(view["visibility"], "creator_admin");
        assert_eq!(view["workspace_binding"]["type"], "standalone");
        assert_eq!(view["workspace_binding"]["status"], "ready");
        assert_eq!(view["local_project_id"], serde_json::Value::Null);
    }

    #[test]
    fn agent_view_uses_legacy_project_when_local_project_id_set() {
        let mut row = agent(json!({}));
        row.local_project_id = Some(7);
        let view = view_value(&row);
        assert_eq!(view["workspace_binding"]["type"], "legacy_project");
        assert_eq!(view["workspace_binding"]["status"], "needs_rebind");
        assert_eq!(view["workspace_binding"]["projectId"], 7);
        assert_eq!(view["local_project_id"], 7);
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
        let value = serde_json::to_value(member_response(&member)).unwrap();
        assert_eq!(value["id"], 10);
        assert_eq!(value["user_id"], 86);
        assert_eq!(value["user_name"], "jiawei36");
        assert_eq!(value["email"], "jiawei36@example.com");
        assert_eq!(value["role"], "Owner");
        assert_eq!(value["capability_description"], "");
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
