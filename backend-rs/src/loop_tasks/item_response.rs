// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `loop_item_service.response_values` projection for the cloud-context
//! loop-item branch.
//!
//! Mirrors `app.services.loop_items.service.LoopItemService.response_values`
//! merged with the pydantic `LoopItemResponse` normalization
//! (`app.schemas.delivery.LoopItemResponse`): the item row fields, the
//! project-role permissions (`issue_permissions` / `can_view_item`), the
//! metadata-derived history and AI projections, and the newest execution
//! overlay (`loop_item_execution_service.latest_for_item`).
use chrono::{Local, NaiveDateTime};
use serde::Serialize;
use serde_json::{Map, Value, json};

use brz_http_server::StatusCode;

use super::http_error::HttpError;
use super::loop_repository::{
    ChatAgentRow, ExecutionFullRow, ItemMetadata, LoopItemRepository, TaskItemFullRow,
    datetime_is_unset, has_permission,
};
use crate::auth::SessionUser;
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectAccess};
use crate::state::AppState;

/// The `LoopItemResponse` body (`app.schemas.delivery.LoopItemResponse`):
/// every field is always emitted (FastAPI has no `response_model_exclude_*`),
/// so `None` serializes as `null` rather than being skipped.
#[derive(Debug, Serialize)]
pub struct LoopItemResponse {
    id: String,
    cloud_project_id: String,
    sequence_number: i64,
    parent_id: Option<String>,
    title: String,
    description: String,
    status: String,
    assignee_user_id: Option<i32>,
    assignee_group_id: Option<String>,
    assignee_group_name: Option<String>,
    assignee_name: Option<String>,
    assignee_agent_id: Option<String>,
    assignee_agent_name: Option<String>,
    assignee_team_id: Option<i32>,
    assignee_team_name: Option<String>,
    ai_state: Option<Value>,
    execution_id: Option<i64>,
    execution_state: Option<String>,
    execution_control_state: Option<String>,
    execution_observed_state: Option<String>,
    execution_sync_state: Option<String>,
    execution_attempt_no: Option<i64>,
    execution_last_event_seq: Option<i64>,
    can_approve: bool,
    assignment_history: Vec<Value>,
    status_history: Vec<Value>,
    approval: Option<Value>,
    human_task_binding: Option<Value>,
    queued_at: Option<String>,
    execution_note: Option<String>,
    execution_error: Option<String>,
    automation: Option<Value>,
    workflow: Option<Value>,
    execution_config: Option<Value>,
    priority: String,
    start_at: Option<String>,
    due_at: Option<String>,
    sort_order: i64,
    tags: Vec<String>,
    created_by_user_id: i64,
    created_by_user_name: Option<String>,
    can_view_detail: bool,
    security_level: &'static str,
    can_edit: bool,
    permissions: Permissions,
    detail_loaded: bool,
    content_revision: i64,
    activity_read_sequence: i64,
    is_unread: bool,
    current_delivery_id: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

impl LoopItemResponse {
    /// The item's primary key, consumed by callers that need the ids of a
    /// projected list (for example the board-snapshot task-binding read).
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// `LoopItemPermissions` (`app.schemas.delivery`).
#[derive(Debug, Serialize)]
struct Permissions {
    edit_content: bool,
    comment: bool,
    assign: bool,
    execute: bool,
}

/// The execution-derived overlay fields. All fields are `None` when the item
/// has no execution row.
#[derive(Debug, Default)]
struct ExecutionOverlay {
    id: Option<i64>,
    display_state: Option<String>,
    control_state: Option<String>,
    observed_state: Option<String>,
    sync_state: Option<String>,
    attempt_no: Option<i64>,
    last_event_seq: Option<i64>,
    queued_at: Option<String>,
    note: Option<String>,
    error: Option<String>,
    can_approve: bool,
    approval: Option<Value>,
    ai_state: Option<Value>,
}

/// The owning project facts `response_values` needs: the numeric id (for the
/// fallback access re-read), the resolved visibility, whether the task
/// provider is local, the creator, and the project's default issue security.
/// Only `number` and `default_issue_security` are consumed by this projection;
/// the remaining fields are carried for sibling projections.
pub struct ProjectFacts<'a> {
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub number: i64,
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub visibility: &'a str,
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub provider_is_local: bool,
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub created_by_user_id: i32,
    pub default_issue_security: &'a str,
}

/// `LoopItemService.response_values`: project one task row to the
/// `LoopItemResponse` body. `access` is the source's optional pre-resolved
/// `CloudProjectAccess`; when `None` the guard re-reads it (the source's
/// `access = access or require_cloud_project_role(...)`).
pub async fn response_values(
    state: &AppState,
    item: &TaskItemFullRow,
    current_user: &SessionUser,
    project: &ProjectFacts<'_>,
    access: Option<&ProjectAccess>,
) -> Result<LoopItemResponse, HttpError> {
    let repository = LoopItemRepository::new(&state.mysql);
    let project_number = project.number;

    // `access = access or require_cloud_project_role(db, item.cloud_project_id,
    // user_id, RestrictedAnalyst)`.
    let resolved_access;
    let access = match access {
        Some(access) => access,
        None => {
            resolved_access = BoardSnapshotRepository::new(&state.mysql)
                .require_cloud_project_role(project_number, current_user.id)
                .await
                .map_err(HttpError::internal)?
                .ok_or_else(HttpError::cloud_project_not_found)?;
            &resolved_access
        }
    };
    let role = access.role.as_str();
    let default_metadata = ItemMetadata::default();
    let metadata = item.metadata().unwrap_or(&default_metadata);

    // `item_security(item, access.project)` (`app.services.loop_items.access`):
    // the item's own `security_level` when set, else the project default.
    let security_level = match metadata_security_level(metadata) {
        Some(level) => level,
        None => {
            if project.default_issue_security == "related" {
                "related"
            } else {
                "open"
            }
        }
    };

    // `_item_permissions` -> `can_view_item`: maintainers and up always see
    // the item; otherwise an `open` item or an item related to the caller.
    let can_view_detail = if has_permission(role, "Maintainer") || security_level == "open" {
        true
    } else {
        repository
            .is_related_item(&item.id, current_user.id)
            .await
            .map_err(HttpError::internal)?
    };

    // `issue_permissions(access, issue_creator_user_id=item.created_by_user_id,
    // user_id=user_id)`.
    let is_creator = item.created_by_user_id == Some(current_user.id);
    let permissions = issue_permissions(role, is_creator);

    // `db.get(User, item.assignee_user_id)`: the source identity map already
    // holds the session user, so the session name is used without a query.
    let assignee_name = match item.assignee_user_id.filter(|id| *id != 0) {
        Some(user_id) if user_id == current_user.id => Some(current_user.user_name.clone()),
        Some(user_id) => state
            .user_reader
            .get_entity_by_id(i64::from(user_id))
            .await
            .map_err(|error| {
                tracing::error!(%error, "cloud-context assignee lookup failed");
                HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            })?
            .map(|record| record.user_name),
        None => None,
    };

    // `db.get(ProjectChatAgent, ...)`: the source identity map serves every
    // lookup of one agent id with a single SQL read, so the row is resolved
    // once here and reused by the approval and AI-state projections.
    let assignee_agent_id = nonempty(item.assignee_agent_id.as_deref());
    let assignee_agent = match assignee_agent_id.as_deref() {
        Some(agent_id) => repository
            .chat_agent(agent_id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };
    let assignee_agent_name = assignee_agent
        .as_ref()
        .and_then(|agent| agent.display_name());

    // `db.get(Kind, item.assignee_team_id)` when set.
    let assignee_team_name = match item.assignee_team_id.filter(|id| *id != 0) {
        Some(team_id) => repository
            .kind_name(i64::from(team_id))
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };

    // `metadata.get("collaboration_group")`.
    let collaboration_group = json_object(metadata.collaboration_group.as_ref());
    let assignee_group_id = collaboration_group
        .as_ref()
        .and_then(|group| json_string(group.get("id")));
    let assignee_group_name = collaboration_group
        .as_ref()
        .and_then(|group| json_string(group.get("name")));

    // `_present_cached_ai_state` then `execution_ai_state` (when a run exists).
    let cached_ai_state =
        present_cached_ai_state(state, &repository, item, metadata.ai_state.as_ref()).await?;
    let execution = repository
        .latest_execution_for_item(&item.id)
        .await
        .map_err(HttpError::internal)?;
    let overlay = execution_overlay(
        state,
        &repository,
        item,
        current_user.id,
        assignee_agent.as_ref(),
        execution.as_ref(),
        cached_ai_state,
    )
    .await?;

    let content_revision = content_revision(metadata);
    let is_unread = is_unread(metadata, current_user.id);
    let activity_read_sequence = activity_read_sequence(metadata, current_user.id);
    let description = if can_view_detail {
        item.description.clone().unwrap_or_default()
    } else {
        String::new()
    };

    let human_task_binding =
        super::human_task_binding::human_task_binding(state, item, current_user.id, project)
            .await?;

    Ok(LoopItemResponse {
        id: item.id.clone(),
        cloud_project_id: item.cloud_project_id.clone(),
        sequence_number: item.sequence_number.unwrap_or(0),
        parent_id: normalize_empty_id(item.parent_id.as_deref()),
        title: item.title.clone().unwrap_or_default(),
        description,
        status: item.status.clone().unwrap_or_default(),
        assignee_user_id: item.assignee_user_id.filter(|id| *id != 0),
        assignee_group_id,
        assignee_group_name,
        assignee_name,
        assignee_agent_id: normalize_empty_id(item.assignee_agent_id.as_deref()),
        assignee_agent_name,
        assignee_team_id: item.assignee_team_id.filter(|id| *id != 0),
        assignee_team_name,
        ai_state: overlay.ai_state,
        execution_id: overlay.id,
        execution_state: overlay
            .display_state
            .or_else(|| json_string(metadata.execution_state.as_ref())),
        execution_control_state: overlay.control_state,
        execution_observed_state: overlay.observed_state,
        execution_sync_state: overlay.sync_state,
        execution_attempt_no: overlay.attempt_no,
        execution_last_event_seq: overlay.last_event_seq,
        can_approve: overlay.can_approve,
        assignment_history: json_array(metadata.assignment_history.as_ref()),
        status_history: json_array(metadata.status_history.as_ref()),
        approval: overlay
            .approval
            .or_else(|| json_object(metadata.approval.as_ref())),
        human_task_binding,
        queued_at: overlay
            .queued_at
            .or_else(|| json_string(metadata.queued_at.as_ref())),
        execution_note: overlay
            .note
            .or_else(|| json_string(metadata.execution_note.as_ref())),
        execution_error: overlay
            .error
            .or_else(|| json_string(metadata.execution_error.as_ref())),
        automation: json_object(metadata.automation.as_ref()),
        workflow: json_object(metadata.workflow.as_ref()).map(|workflow| workflow_view(&workflow)),
        execution_config: execution_config_view(metadata.execution_config.as_ref()),
        priority: item.priority.clone().unwrap_or_default(),
        start_at: isoformat_unset(item.start_at),
        due_at: isoformat_unset(item.due_at),
        sort_order: item.sort_order,
        tags: normalize_tags(metadata.tags.as_ref()),
        created_by_user_id: i64::from(item.created_by_user_id.unwrap_or(0)),
        created_by_user_name: None,
        can_view_detail,
        security_level,
        can_edit: permissions.edit_content,
        permissions,
        detail_loaded: true,
        content_revision,
        activity_read_sequence,
        is_unread,
        current_delivery_id: normalize_empty_id(item.current_delivery_id.as_deref()),
        version: item.version,
        created_at: utc_datetime_string(item.created_at).unwrap_or_default(),
        updated_at: utc_datetime_string(item.updated_at).unwrap_or_default(),
        completed_at: isoformat_unset(item.completed_at),
    })
}

/// `issue_permissions(access, issue_creator_user_id, user_id)`
/// (`app.services.cloud_projects.access`): the role gates every action, but
/// the issue creator always keeps control of their own assignee.
fn issue_permissions(role: &str, is_creator: bool) -> Permissions {
    let developer = has_permission(role, "Developer");
    Permissions {
        edit_content: developer,
        comment: developer,
        assign: developer || is_creator,
        execute: developer,
    }
}

/// `item_security(item, project)`: the item's own `security_level` when it is
/// one of the known levels, else the project default.
pub(crate) fn metadata_security_level(metadata: &ItemMetadata) -> Option<&'static str> {
    match metadata.security_level.as_ref() {
        Some(Value::String(level)) => match level.as_str() {
            "open" => Some("open"),
            "related" => Some("related"),
            _ => None,
        },
        _ => None,
    }
}

/// The execution overlay: the newest run's fields plus the approval view and
/// the AI-state projection when a run exists.
async fn execution_overlay(
    state: &AppState,
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    item: &TaskItemFullRow,
    user_id: i32,
    assignee_agent: Option<&ChatAgentRow>,
    execution: Option<&ExecutionFullRow>,
    cached_ai_state: Option<Value>,
) -> Result<ExecutionOverlay, HttpError> {
    let Some(execution) = execution else {
        return Ok(ExecutionOverlay::default());
    };
    // `_can_approve_run`: `db.get(ProjectChatAgent, item.assignee_agent_id)`
    // is an identity-map hit for the already-loaded assignee agent row.
    let can_approve = execution.status.as_deref() == Some("pending_approval")
        && nonempty(item.assignee_agent_id.as_deref()).is_some()
        && assignee_agent.and_then(|agent| agent.created_by_user_id) == Some(user_id);
    let ai_state = execution_ai_state(
        state,
        repository,
        assignee_agent,
        execution,
        cached_ai_state,
    )
    .await?;
    Ok(ExecutionOverlay {
        id: Some(execution.id),
        display_state: Some(display_state(execution)),
        control_state: execution.status.clone(),
        observed_state: execution.observed_state.clone(),
        sync_state: execution.sync_state.clone(),
        attempt_no: execution.attempt_no,
        last_event_seq: execution.last_event_seq,
        queued_at: isoformat(execution.queued_at),
        note: nonempty(execution.execution_note.as_deref()),
        error: nonempty(execution.error_message.as_deref()),
        can_approve,
        approval: approval_view(execution),
        ai_state,
    })
}

/// `execution_display_state`: the single user-facing state derived from the
/// execution truth.
fn display_state(execution: &ExecutionFullRow) -> String {
    let status = execution.status.as_deref().unwrap_or("");
    if status == "completed" {
        return "succeeded".to_string();
    }
    if matches!(status, "failed" | "cancelled") {
        return status.to_string();
    }
    if matches!(
        execution.sync_state.as_deref(),
        Some("stale") | Some("diverged")
    ) {
        return "unknown".to_string();
    }
    if status == "pending_approval" {
        return "waiting_approval".to_string();
    }
    if status == "waiting_runtime" {
        return "waiting_runtime".to_string();
    }
    if status == "queued" {
        return "queued".to_string();
    }
    if status == "cancel_requested" {
        return "cancelling".to_string();
    }
    if status == "claimed" {
        return if execution.observed_state.as_deref() == Some("unconfirmed") {
            "starting".to_string()
        } else {
            "waiting_runtime".to_string()
        };
    }
    if status == "running" && execution.observed_state.as_deref() == Some("running") {
        return "running".to_string();
    }
    "waiting_runtime".to_string()
}

/// `_approval_view`: the per-status approval projection. Only the fields of
/// the active status are present, matching the source's `view[key] = value`
/// writes.
fn approval_view(execution: &ExecutionFullRow) -> Option<Value> {
    let status = execution.approval_status.as_deref()?;
    if status.is_empty() {
        return None;
    }
    let mut view = Map::new();
    view.insert("status".to_string(), json!(status));
    match status {
        "pending" => {
            view.insert(
                "requested_at".to_string(),
                optional_string(isoformat(execution.queued_at)),
            );
        }
        "approved" => {
            view.insert(
                "approved_by_user_id".to_string(),
                json!(execution.approved_by_user_id),
            );
            view.insert(
                "approved_at".to_string(),
                optional_string(isoformat(execution.approved_at)),
            );
        }
        "rejected" => {
            view.insert(
                "rejected_reason".to_string(),
                json!(execution.rejected_reason),
            );
        }
        _ => {}
    }
    Some(Value::Object(view))
}

/// `_present_cached_ai_state`: read-only presentation of legacy task AI
/// metadata, including the `ProjectChatMessage` terminal-state and lease
/// checks.
async fn present_cached_ai_state(
    _state: &AppState,
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    item: &TaskItemFullRow,
    ai_state: Option<&Value>,
) -> Result<Option<Value>, HttpError> {
    let Some(Value::Object(mut state)) = json_object(ai_state) else {
        return Ok(None);
    };
    let normalized = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let terminal = match normalized.as_str() {
        "completed" | "success" | "succeeded" => Some("succeeded"),
        "error" | "failed" | "failure" | "interrupted" => Some("failed"),
        "canceled" | "cancelled" => Some("cancelled"),
        _ => None,
    };
    if let Some(status) = terminal {
        state.insert("status".to_string(), json!(status));
        return Ok(Some(Value::Object(state)));
    }

    let message = match state
        .get("project_chat_message_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        Some(message_id) => repository
            .project_chat_message(message_id, &item.id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };
    if let Some(message) = message.as_ref()
        && matches!(message.status.as_str(), "completed" | "failed")
    {
        state.insert(
            "status".to_string(),
            json!(if message.status == "completed" {
                "succeeded"
            } else {
                "failed"
            }),
        );
        state.insert("lease_expires_at".to_string(), Value::Null);
        let updated_at = optional_string(isoformat(message.updated_at));
        state.insert("completed_at".to_string(), updated_at.clone());
        state.insert("updated_at".to_string(), updated_at);
        if message.status == "failed"
            && let Some(content) = message.content.as_deref().filter(|value| !value.is_empty())
        {
            let truncated: String = content.chars().take(10_000).collect();
            state.insert("last_error".to_string(), json!(truncated));
        }
        return Ok(Some(Value::Object(state)));
    }

    let parsed_expiry = state
        .get("lease_expires_at")
        .and_then(Value::as_str)
        .and_then(parse_ai_state_datetime);
    if message.is_none()
        || parsed_expiry.is_none()
        || parsed_expiry.is_some_and(|expiry| expiry < Local::now().naive_local())
    {
        state.insert("status".to_string(), json!("unknown"));
        state.insert("sync_state".to_string(), json!("stale"));
    }
    Ok(Some(Value::Object(state)))
}

/// `_parse_ai_state_datetime`: parse an ISO timestamp, normalizing an aware
/// value to naive UTC.
fn parse_ai_state_datetime(value: &str) -> Option<NaiveDateTime> {
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(parsed);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.naive_utc())
}

/// `execution_ai_state`: project the authoritative execution attempt onto the
/// task AI metadata. Returns `None` for a run awaiting approval.
async fn execution_ai_state(
    _state: &AppState,
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    assignee_agent: Option<&ChatAgentRow>,
    execution: &ExecutionFullRow,
    existing: Option<Value>,
) -> Result<Option<Value>, HttpError> {
    if execution.status.as_deref() == Some("pending_approval") {
        return Ok(None);
    }
    let mut state = match json_object(existing.as_ref()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    // `db.get(ProjectChatAgent, execution.agent_id)`: an identity-map hit for
    // the assignee agent when the ids agree, else one extra SQL read.
    let agent: Option<ChatAgentRow> = match nonempty(execution.agent_id.as_deref()) {
        Some(agent_id) if assignee_agent.is_some_and(|agent| agent.matches_id(&agent_id)) => {
            assignee_agent.cloned()
        }
        Some(agent_id) => repository
            .chat_agent(&agent_id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };
    // `db.get(Kind, execution.team_id) if execution.team_id else None`: an
    // unset team id is stored as 0, which is falsy, so no lookup runs.
    let team_name = match execution.team_id.filter(|team_id| *team_id != 0) {
        Some(team_id) => repository
            .kind_name(team_id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };
    // `execution.executor_type` is not selected by the recorded execution
    // statement, so the agent's title/name wins whenever an agent is set and
    // the team name is the fallback (`team.name if executor_type ==
    // "wegent_team" and team is not None else (agent.title or agent.name)`).
    let agent_name = agent.and_then(|agent| agent.display_name()).or(team_name);
    let run_id = state
        .get("run_id")
        .cloned()
        .unwrap_or_else(|| json!(format!("exec-{}", execution.id)));
    state.insert("run_id".to_string(), run_id);
    state.insert("status".to_string(), json!(display_state(execution)));
    state.insert(
        "agent_id".to_string(),
        json!(nonempty(execution.agent_id.as_deref())),
    );
    // `execution.team_id or None`: an unset 0 renders as null.
    state.insert(
        "team_id".to_string(),
        json!(execution.team_id.filter(|team_id| *team_id != 0)),
    );
    state.insert("agent_name".to_string(), json!(agent_name));
    state.insert(
        "runtime_device_id".to_string(),
        json!(execution.runtime_device_id),
    );
    state.insert(
        "runtime_task_id".to_string(),
        json!(execution.runtime_task_id),
    );
    // `iso(value)` wraps every datetime in `_optional_datetime`, whose
    // `loop_datetime_value_is_unset` treats NULL and both MySQL unset
    // sentinels (1970-01-01 00:00:00 and 00:00:01) as absent.
    state.insert(
        "started_at".to_string(),
        optional_string(isoformat_model_unset(execution.started_at)),
    );
    state.insert(
        "heartbeat_at".to_string(),
        optional_string(isoformat_model_unset(execution.heartbeat_at)),
    );
    state.insert(
        "lease_expires_at".to_string(),
        optional_string(isoformat_model_unset(execution.lease_expires_at)),
    );
    state.insert(
        "completed_at".to_string(),
        optional_string(isoformat_model_unset(execution.completed_at)),
    );
    state.insert(
        "updated_at".to_string(),
        optional_string(isoformat_model_unset(execution.updated_at)),
    );
    state.insert(
        "last_error".to_string(),
        nonempty(execution.error_message.as_deref()).map_or(Value::Null, Value::String),
    );
    Ok(Some(Value::Object(state)))
}

/// `content_revision`: the metadata revision when it is an integer >= 1.
fn content_revision(metadata: &ItemMetadata) -> i64 {
    metadata
        .content_revision
        .as_ref()
        .and_then(Value::as_i64)
        .filter(|value| *value >= 1)
        .unwrap_or(1)
}

/// `is_unread`: whether the caller's read revision trails the content
/// revision.
fn is_unread(metadata: &ItemMetadata, user_id: i32) -> bool {
    let revision = content_revision(metadata);
    let Some(Value::Object(read_revisions)) = metadata.read_revisions.as_ref() else {
        return true;
    };
    match read_revisions.get(&user_id.to_string()) {
        Some(Value::Number(value)) => value.as_i64().is_none_or(|read| read < revision),
        _ => true,
    }
}

/// `activity_read_sequence(metadata, user_id)`: the caller's stored activity
/// read sequence, or `0` when absent (`app.services.loop_item_unread`).
fn activity_read_sequence(metadata: &ItemMetadata, user_id: i32) -> i64 {
    let Some(Value::Object(sequences)) = metadata.activity_read_sequences.as_ref() else {
        return 0;
    };
    match sequences.get(&user_id.to_string()).and_then(Value::as_i64) {
        Some(value) if value >= 0 => value,
        _ => 0,
    }
}

/// `normalize_tags`: trim, dedupe, and cap a metadata tag list.
fn normalize_tags(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut tags: Vec<String> = Vec::new();
    for item in items {
        let tag = match item {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => continue,
        };
        let trimmed: String = tag.chars().take(32).collect();
        let trimmed = trimmed.trim().to_string();
        if !trimmed.is_empty() && !tags.contains(&trimmed) {
            tags.push(trimmed);
        }
        if tags.len() >= 20 {
            break;
        }
    }
    tags
}

/// A metadata value that is a JSON array, cloned; otherwise empty.
fn json_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// A metadata value that is a JSON object, cloned; otherwise `None`.
fn json_object(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(object @ Value::Object(_)) => Some(object.clone()),
        _ => None,
    }
}

/// `WorkflowExecutionConfig.workspace_binding`: the stored metadata object
/// re-serialized through `ProjectChatWorkspaceBinding`, whose `_to_camel`
/// alias generator renames the multi-word keys (`projectId`,
/// `deviceWorkspaceId`, `deviceId`, `runtimeProjectKey`) and whose field set
/// drops any extra stored keys (for example a stored `status`).
fn workspace_binding_alias_view(binding: &Value) -> Value {
    let Some(map) = binding.as_object() else {
        return binding.clone();
    };
    let key = |name: &str, alias: &str| {
        map.get(name)
            .or_else(|| map.get(alias))
            .cloned()
            .unwrap_or(Value::Null)
    };
    serde_json::json!({
        "type": key("type", "type"),
        "projectId": key("project_id", "projectId"),
        "deviceWorkspaceId": key("device_workspace_id", "deviceWorkspaceId"),
        "deviceId": key("device_id", "deviceId"),
        "runtimeProjectKey": key("runtime_project_key", "runtimeProjectKey"),
    })
}

/// `execution_config`: the stored metadata object with the nested
/// `workspace_binding` re-serialized through its alias-generating schema.
fn execution_config_view(value: Option<&Value>) -> Option<Value> {
    let config = json_object(value)?;
    let Some(map) = config.as_object() else {
        return Some(config);
    };
    let mut map = map.clone();
    if let Some(binding) = map.get("workspace_binding") {
        map.insert(
            "workspace_binding".to_string(),
            workspace_binding_alias_view(binding),
        );
    }
    Some(Value::Object(map))
}

/// `IssueWorkflowInstance`: the stored `metadata_json["workflow"]` object
/// re-serialized through its pydantic schema. Only the observable differences
/// from the stored shape are applied here: the nested `execution_config` uses
/// the camel-case `ProjectChatWorkspaceBinding` aliases, and each node carries
/// its defaulted `execution_error`. The stored object already holds every other
/// schema field, so the remaining keys pass through unchanged.
fn workflow_view(workflow: &Value) -> Value {
    let Some(map) = workflow.as_object() else {
        return workflow.clone();
    };
    let mut map = map.clone();
    if let Some(config) = map.get("execution_config") {
        map.insert(
            "execution_config".to_string(),
            execution_config_view(Some(config)).unwrap_or_else(|| config.clone()),
        );
    }
    if let Some(Value::Array(nodes)) = map.get("nodes") {
        let nodes: Vec<Value> = nodes.iter().map(workflow_node_view).collect();
        map.insert("nodes".to_string(), Value::Array(nodes));
    }
    Value::Object(map)
}

/// `WorkflowNodeInstance`: the stored node re-serialized through its schema.
/// Applies the nested `execution_config` alias view and materializes the
/// defaulted `execution_error` when the stored node omits it.
fn workflow_node_view(node: &Value) -> Value {
    let Some(map) = node.as_object() else {
        return node.clone();
    };
    let mut map = map.clone();
    if let Some(config) = map.get("execution_config") {
        map.insert(
            "execution_config".to_string(),
            execution_config_view(Some(config)).unwrap_or_else(|| config.clone()),
        );
    }
    map.entry("execution_error").or_insert(Value::Null);
    Value::Object(map)
}

/// A metadata value that is a JSON string, cloned; otherwise `None`.
fn json_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `_normalize_empty_id` / `normalize_empty_text`: `""` becomes `None`.
fn normalize_empty_id(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// `x or None`: an empty string becomes `None`.
fn nonempty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// A JSON value for an optional string: `Some` renders the string, `None`
/// renders JSON null.
fn optional_string(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// `database_datetime_as_utc(db, value).isoformat()` (`app.db.timezone`,
/// used for `created_at`/`updated_at` in `response_values`): the stored naive
/// database datetime is session-local UTC+8, so it is reinterpreted in that
/// offset, converted to UTC, and rendered as pydantic's aware datetime
/// (`...Z`, with six fractional digits only when nonzero).
pub(crate) fn utc_datetime_string(value: Option<NaiveDateTime>) -> Option<String> {
    /// `MYSQL_SESSION_TIMEZONE` offset (`settings.DATABASE_TIMEZONE`).
    const DB_SESSION_OFFSET_SECONDS: i32 = 8 * 3600;
    value.map(|value| {
        use chrono::TimeZone as _;
        let utc = chrono::FixedOffset::east_opt(DB_SESSION_OFFSET_SECONDS)
            .expect("valid fixed offset")
            .from_local_datetime(&value)
            .single()
            .expect("database datetime is representable")
            .with_timezone(&chrono::Utc)
            .naive_utc();
        let base = utc.format("%Y-%m-%dT%H:%M:%S").to_string();
        if utc.and_utc().timestamp_subsec_nanos() == 0 {
            format!("{base}Z")
        } else {
            format!("{base}.{:06}Z", utc.and_utc().timestamp_subsec_micros())
        }
    })
}

/// pydantic naive-datetime serialization (`isoformat()`): `YYYY-MM-DDTHH:MM:SS`
/// plus six fractional digits when the value has sub-second precision.
pub(crate) fn isoformat(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

/// `normalize_unset_datetime`: the `1970-01-01 00:00:01` sentinel and NULL
/// become `None`.
fn isoformat_unset(value: Option<NaiveDateTime>) -> Option<String> {
    if datetime_is_unset(value) {
        None
    } else {
        isoformat(value)
    }
}

/// `loop_datetime_value_is_unset` (`app.models.delivery`): the model-level
/// unset check that also treats the `1970-01-01 00:00:00` epoch constant as
/// absent, used by `_optional_datetime` for the execution AI-state fields.
fn datetime_model_is_unset(value: Option<NaiveDateTime>) -> bool {
    match value {
        None => true,
        Some(value) => matches!(
            value.format("%Y-%m-%d %H:%M:%S").to_string().as_str(),
            "1970-01-01 00:00:00" | "1970-01-01 00:00:01"
        ),
    }
}

/// `iso(value)`: `_optional_datetime(value).isoformat()` — the model-variant
/// unset datetimes render as `None`.
pub(crate) fn isoformat_model_unset(value: Option<NaiveDateTime>) -> Option<String> {
    if datetime_model_is_unset(value) {
        None
    } else {
        isoformat(value)
    }
}

#[cfg(test)]
#[path = "item_response_tests.rs"]
mod tests;
