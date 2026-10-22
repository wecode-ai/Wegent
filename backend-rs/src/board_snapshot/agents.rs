// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `project_chat_service.agent_to_view` (`app/services/project_chat/service.py`)
//! and its permission fields: visibility, `can_edit`, `can_use`, and
//! `unavailable_reason`.
//!
//! `list_agents` filters with `project_agent_visible` (only a raw `private`
//! definition is creator-only). `agent_to_view` resolves the creator name,
//! the team-backed edit policy, the `execute` project decision, and
//! `require_project_agent`'s stored resource authorization.
use serde::Serialize;

use super::handler::{datetime_string, internal_error};
use super::repository::{
    AgentRow, BoardSnapshotRepository, BotConfig, ProjectAccess, datetime_is_unset, has_permission,
    project_agent_grant, team_binding_exists, team_bound_agents, team_grant, workspace_kind,
};
use crate::http_compat::FastApiError;
use crate::state::AppState;

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
    /// `can_edit`: the creator, or a `Team` definition the caller may edit.
    can_edit: bool,
    /// `can_use`: the caller may execute in the project and the agent's
    /// resource authorization is intact.
    can_use: bool,
    /// `unavailable_reason`: the stored migration reason, or the revoked
    /// authorization marker.
    unavailable_reason: Option<String>,
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
    let config = row.bot_config();
    // `db.get(Kind, int(config["wegent_team_id"]))` for a team-backed
    // definition; the source retains the loaded row for `require_project_team`.
    let team = match config.wegent_team_id() {
        Some(team_id) => workspace_kind(&state.mysql, Some(team_id))
            .await
            .map_err(internal_error)?,
        None => None,
    };
    let can_edit = match config.wegent_team_id() {
        Some(_) => can_edit_team(state, team.as_ref(), viewer_id).await?,
        None => row.created_by_user_id == Some(viewer_id),
    };
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
    let (can_use, unavailable_reason) =
        agent_can_use(state, row, viewer_id, &config, team.as_ref()).await?;
    Ok(agent_view_from_row(
        row,
        viewer_id,
        created_by_user_name,
        can_edit,
        can_use,
        unavailable_reason,
    ))
}

/// `team_access_policy.can_edit_team`: an active `Team` definition owned by
/// the viewer in the default namespace, or a group namespace where the viewer
/// holds at least `Developer`.
async fn can_edit_team(
    state: &AppState,
    team: Option<&super::repository::WorkspaceKindRow>,
    viewer_id: i32,
) -> Result<bool, FastApiError> {
    let Some(team) = team else {
        return Ok(false);
    };
    if !team.is_active || team.kind != "Team" {
        return Ok(false);
    }
    if team.namespace == "default" {
        return Ok(team.user_id == viewer_id);
    }
    let role = crate::knowledge_bases_all_grouped::membership::effective_role_in_group(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        i64::from(viewer_id),
        &team.namespace,
    )
    .await
    .map_err(internal_error)?;
    Ok(role.is_some_and(|role| has_permission(&role, "Developer")))
}

/// `agent_to_view`'s permission evaluation:
/// `collaboration_permission_service.check(db, viewer, "execute",
/// project_id).allowed`, then `require_project_agent` for an active agent. A
/// rejected agent authorization disables use and records the revoked marker.
async fn agent_can_use(
    state: &AppState,
    row: &AgentRow,
    viewer_id: i32,
    config: &BotConfig<'_>,
    team: Option<&super::repository::WorkspaceKindRow>,
) -> Result<(bool, Option<String>), FastApiError> {
    let mut unavailable_reason = config.permission_migration_reason();
    let Ok(project_id) = row.cloud_project_id.parse::<i64>() else {
        return Ok((false, unavailable_reason));
    };
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_id, viewer_id)
        .await
        .map_err(internal_error)?;
    let mut can_use = access
        .as_ref()
        .is_some_and(|access| has_permission(&access.role, "Developer"));
    if row.status.as_deref() == Some("active")
        && let Some(access) = access.as_ref()
        && !project_agent_authorized(state, row, access, config, team).await?
    {
        can_use = false;
        unavailable_reason = Some("resource_authorization_revoked".to_string());
    }
    Ok((
        can_use && row.status.as_deref() == Some("active"),
        unavailable_reason,
    ))
}

/// `collaboration_permission_service.require_project_agent`: the agent's
/// stored resource authorization must still be intact. Returns `false` for
/// every source `HTTPException` branch (the caller only cares that it failed).
async fn project_agent_authorized(
    state: &AppState,
    row: &AgentRow,
    access: &ProjectAccess,
    config: &BotConfig<'_>,
    team: Option<&super::repository::WorkspaceKindRow>,
) -> Result<bool, FastApiError> {
    if row.status.as_deref() != Some("active") || !datetime_is_unset(row.deleted_at) {
        return Ok(false);
    }
    let Some(workspace_id) = access.workspace_id else {
        return Ok(false);
    };
    let Some(parent) = workspace_kind(&state.mysql, Some(workspace_id))
        .await
        .map_err(internal_error)?
    else {
        return Ok(false);
    };
    if parent.kind != "CollaborationWorkspace" || !parent.is_active {
        return Ok(false);
    }
    match config.wegent_team_id() {
        Some(team_id) => {
            let grant = team_grant(&state.mysql, team_id, workspace_id)
                .await
                .map_err(internal_error)?;
            let Some(team) = team else {
                return Ok(false);
            };
            if team.kind != "Team" || !team.is_active {
                return Ok(false);
            }
            match grant {
                None => {
                    let bindings = team_bound_agents(&state.mysql, &row.cloud_project_id, team_id)
                        .await
                        .map_err(internal_error)?;
                    let legacy = bindings.iter().any(|binding| {
                        !binding.bot_config().has_authorization_version()
                            && (team.user_id == 0
                                || binding.created_by_user_id == Some(team.user_id))
                    });
                    if !legacy {
                        return Ok(false);
                    }
                }
                Some(grant) => {
                    if grant.status != "approved" || !resource_use_role(&grant.role) {
                        return Ok(false);
                    }
                }
            }
            team_binding_exists(&state.mysql, &row.cloud_project_id, team_id)
                .await
                .map_err(internal_error)
        }
        None => {
            let grant = project_agent_grant(&state.mysql, workspace_id, &row.id)
                .await
                .map_err(internal_error)?;
            if grant.is_none() && !config.has_authorization_version() {
                return Ok(true);
            }
            Ok(grant
                .is_some_and(|grant| grant.status == "approved" && resource_use_role(&grant.role)))
        }
    }
}

/// `RESOURCE_USE_ROLES`: the roles that authorize a project/team resource.
fn resource_use_role(role: &str) -> bool {
    matches!(role, "Owner" | "Maintainer" | "Developer")
}

/// The `ProjectChatAgentView` projection for one agent row and a resolved
/// creator name.
fn agent_view_from_row(
    row: &AgentRow,
    viewer_id: i32,
    created_by_user_name: Option<String>,
    can_edit: bool,
    can_use: bool,
    unavailable_reason: Option<String>,
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
        can_edit,
        can_use,
        unavailable_reason,
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

/// `collaboration_permissions.project_agent_visible(agent, user_id)`: only a
/// raw `private` visibility restricts the agent to its creator. Every other
/// value (including an absent one) is visible to the project member.
pub(crate) fn agent_visible_to_user(row: &AgentRow, user_id: i32) -> bool {
    row.created_by_user_id == Some(user_id) || row.bot_config().not_private()
}

/// `normalize_empty_text`: `""` becomes `None`.
pub(crate) fn normalize_empty_text(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
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
            false,
            false,
            None,
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
        assert_eq!(view["canEdit"], false);
        assert_eq!(view["canUse"], false);
        assert_eq!(view["unavailableReason"], serde_json::Value::Null);
    }

    #[test]
    fn agent_view_serializes_the_permission_fields() {
        let view = serde_json::to_value(agent_view_from_row(
            &agent(json!({})),
            6,
            None,
            true,
            true,
            Some("resource_authorization_revoked".to_string()),
        ))
        .unwrap();
        assert_eq!(view["canEdit"], true);
        assert_eq!(view["canUse"], true);
        assert_eq!(view["unavailableReason"], "resource_authorization_revoked");
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
        let view =
            serde_json::to_value(agent_view_from_row(&row, 6, None, false, false, None)).unwrap();
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
    fn agent_visibility_creator_admin_is_visible_to_members() {
        let row = agent(json!({"visibility": "creator_admin"}));
        assert!(agent_visible_to_user(&row, 5));
        assert!(agent_visible_to_user(&row, 6));
    }

    #[test]
    fn agent_visibility_public_allows_every_member() {
        let row = agent(json!({"visibility": "public"}));
        assert!(agent_visible_to_user(&row, 6));
    }

    #[test]
    fn agent_visibility_private_is_creator_only() {
        let row = agent(json!({"visibility": "private"}));
        assert!(agent_visible_to_user(&row, 5));
        assert!(!agent_visible_to_user(&row, 6));
    }

    #[test]
    fn agent_visibility_defaults_to_visible() {
        let row = agent(json!({}));
        assert!(agent_visible_to_user(&row, 6));
    }
}
