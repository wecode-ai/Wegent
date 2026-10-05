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
//! metadata-derived history and AI projections, the newest execution overlay
//! (`loop_item_execution_service.latest_for_item`), and the human-work view
//! (`human_issue_work_service.view`).
use chrono::{Local, NaiveDateTime};
use serde::Serialize;
use serde_json::{Map, Value, json};

use brz_http_server::StatusCode;

use super::http_error::HttpError;
use super::loop_repository::{
    CommentRow, ExecutionFullRow, ItemMetadata, LoopItemRepository, TaskItemFullRow,
    datetime_is_unset, has_permission,
};
use crate::auth::SessionUser;
use crate::board_snapshot::repository::BoardSnapshotRepository;
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
    human_work: Option<Value>,
    queued_at: Option<String>,
    execution_note: Option<String>,
    execution_error: Option<String>,
    automation: Option<Value>,
    workflow: Option<Value>,
    execution_config: Option<Value>,
    priority: String,
    due_at: Option<String>,
    sort_order: i64,
    tags: Vec<String>,
    created_by_user_id: i64,
    created_by_user_name: Option<String>,
    can_view_detail: bool,
    can_edit: bool,
    permissions: Permissions,
    detail_loaded: bool,
    content_revision: i64,
    is_unread: bool,
    current_delivery_id: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
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

/// The owning project facts `response_values` needs: the numeric id, the
/// resolved visibility, whether the task provider is local, and the creator.
pub struct ProjectFacts<'a> {
    pub number: i64,
    pub visibility: &'a str,
    pub provider_is_local: bool,
    pub created_by_user_id: i32,
}

/// `LoopItemService.response_values`: project one task row to the
/// `LoopItemResponse` body.
pub async fn response_values(
    state: &AppState,
    item: &TaskItemFullRow,
    current_user: &SessionUser,
    project: &ProjectFacts<'_>,
) -> Result<LoopItemResponse, HttpError> {
    let repository = LoopItemRepository::new(&state.mysql);
    let project_number = project.number;

    // `access = access or require_cloud_project_role(db, item.cloud_project_id,
    // user_id, RestrictedAnalyst)`.
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_number, current_user.id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    let role = access.role.as_str();
    let is_public_visitor = role == "RestrictedAnalyst";

    // `_item_permissions` -> `can_view_item`.
    let restricts_unrelated =
        project.visibility == "public_restricted" && !has_permission(role, "Maintainer");
    let can_view_detail = if restricts_unrelated {
        repository
            .is_related_item(&item.id, current_user.id)
            .await
            .map_err(HttpError::internal)?
    } else {
        !is_public_visitor || item.created_by_user_id == Some(current_user.id)
    };

    // `issue_permissions(access, issue_creator_user_id=item.created_by_user_id,
    // user_id=user_id)`.
    let permissions = issue_permissions(
        role,
        item.created_by_user_id,
        current_user.id,
        is_public_visitor,
    );

    let default_metadata = ItemMetadata::default();
    let metadata = item.metadata().unwrap_or(&default_metadata);

    // `db.get(User, item.assignee_user_id)`: the source identity map already
    // holds the session user, so the session name is used without a query.
    let assignee_name = match item.assignee_user_id.filter(|id| *id != 0) {
        Some(user_id) if user_id == current_user.id => Some(current_user.user_name.clone()),
        Some(user_id) => state
            .user_reader
            .get_by_id(i64::from(user_id))
            .await
            .map_err(|error| {
                tracing::error!(%error, "cloud-context assignee lookup failed");
                HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            })?
            .map(|record| record.user_name),
        None => None,
    };

    // `db.get(ProjectChatAgent, item.assignee_agent_id)` when set.
    let assignee_agent_name = match nonempty(item.assignee_agent_id.as_deref()) {
        Some(agent_id) => repository
            .chat_agent(&agent_id)
            .await
            .map_err(HttpError::internal)?
            .and_then(|agent| agent.display_name()),
        None => None,
    };

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
        execution.as_ref(),
        cached_ai_state,
    )
    .await?;

    let human_work =
        human_work_view(state, &repository, item, metadata, current_user.id, project).await?;

    let content_revision = content_revision(metadata);
    let is_unread = is_unread(metadata, current_user.id);
    let description = if can_view_detail {
        item.description.clone().unwrap_or_default()
    } else {
        String::new()
    };

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
        human_work,
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
        workflow: json_object(metadata.workflow.as_ref()),
        execution_config: json_object(metadata.execution_config.as_ref()),
        priority: item.priority.clone().unwrap_or_default(),
        due_at: isoformat_unset(item.due_at),
        sort_order: item.sort_order,
        tags: normalize_tags(metadata.tags.as_ref()),
        created_by_user_id: i64::from(item.created_by_user_id.unwrap_or(0)),
        created_by_user_name: None,
        can_view_detail,
        can_edit: permissions.edit_content,
        permissions,
        detail_loaded: true,
        content_revision,
        is_unread,
        current_delivery_id: normalize_empty_id(item.current_delivery_id.as_deref()),
        version: item.version,
        created_at: isoformat_required(item.created_at),
        updated_at: isoformat_required(item.updated_at),
        completed_at: isoformat_unset(item.completed_at),
    })
}

/// `issue_permissions`: action-specific permissions for the caller.
fn issue_permissions(
    role: &str,
    issue_creator_user_id: Option<i32>,
    user_id: i32,
    is_public_visitor: bool,
) -> Permissions {
    if is_public_visitor {
        let owns_issue = issue_creator_user_id == Some(user_id);
        return Permissions {
            edit_content: owns_issue,
            comment: owns_issue,
            assign: false,
            execute: owns_issue,
        };
    }
    Permissions {
        edit_content: has_permission(role, "Developer"),
        comment: has_permission(role, "Reporter"),
        assign: has_permission(role, "Maintainer"),
        execute: has_permission(role, "Reporter"),
    }
}

/// The execution overlay: the newest run's fields plus the approval view and
/// the AI-state projection when a run exists.
async fn execution_overlay(
    state: &AppState,
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    item: &TaskItemFullRow,
    user_id: i32,
    execution: Option<&ExecutionFullRow>,
    cached_ai_state: Option<Value>,
) -> Result<ExecutionOverlay, HttpError> {
    let Some(execution) = execution else {
        return Ok(ExecutionOverlay::default());
    };
    let can_approve = execution.status.as_deref() == Some("pending_approval")
        && nonempty(item.assignee_agent_id.as_deref()).is_some()
        && match nonempty(item.assignee_agent_id.as_deref()) {
            Some(agent_id) => {
                repository
                    .chat_agent(&agent_id)
                    .await
                    .map_err(HttpError::internal)?
                    .and_then(|agent| agent.created_by_user_id)
                    == Some(user_id)
            }
            None => false,
        };
    let ai_state = execution_ai_state(state, repository, execution, cached_ai_state).await?;
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
    let agent = match nonempty(execution.agent_id.as_deref()) {
        Some(agent_id) => repository
            .chat_agent(&agent_id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };
    let team_name = match execution.team_id {
        Some(team_id) => repository
            .kind_name(team_id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };
    let agent_name = if execution.agent_id.is_none() && execution.team_id.is_none() {
        Some("AI 托管".to_string())
    } else if execution.agent_id.is_none() {
        team_name
    } else {
        agent.and_then(|agent| agent.display_name())
    };
    let run_id = state
        .get("run_id")
        .cloned()
        .unwrap_or_else(|| json!(format!("exec-{}", execution.id)));
    state.insert("run_id".to_string(), run_id);
    state.insert("status".to_string(), json!(display_state(execution)));
    state.insert("agent_id".to_string(), json!(execution.agent_id));
    state.insert("team_id".to_string(), json!(execution.team_id));
    state.insert("agent_name".to_string(), json!(agent_name));
    state.insert(
        "runtime_device_id".to_string(),
        json!(execution.runtime_device_id),
    );
    state.insert(
        "runtime_task_id".to_string(),
        json!(execution.runtime_task_id),
    );
    state.insert(
        "started_at".to_string(),
        optional_string(isoformat(execution.started_at)),
    );
    state.insert(
        "heartbeat_at".to_string(),
        optional_string(isoformat(execution.heartbeat_at)),
    );
    state.insert(
        "lease_expires_at".to_string(),
        optional_string(isoformat(execution.lease_expires_at)),
    );
    state.insert(
        "completed_at".to_string(),
        optional_string(isoformat(execution.completed_at)),
    );
    state.insert(
        "updated_at".to_string(),
        optional_string(isoformat(execution.updated_at)),
    );
    state.insert(
        "last_error".to_string(),
        nonempty(execution.error_message.as_deref()).map_or(Value::Null, Value::String),
    );
    Ok(Some(Value::Object(state)))
}

/// `human_issue_work_service.view`: the human-work projection for a directly
/// human-assigned local issue, or `None` when the item has no single active
/// human assignment.
async fn human_work_view(
    _state: &AppState,
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    item: &TaskItemFullRow,
    metadata: &ItemMetadata,
    user_id: i32,
    project: &ProjectFacts<'_>,
) -> Result<Option<Value>, HttpError> {
    // `_assignment`: a local provider and no workflow/external projection.
    if !project.provider_is_local
        || metadata.workflow.as_ref().is_some_and(truthy)
        || metadata.external_index.as_ref().is_some_and(truthy)
        || metadata.external_shadow.as_ref().is_some_and(truthy)
    {
        return Ok(None);
    }
    let comments = repository
        .list_item_comments(&item.id)
        .await
        .map_err(HttpError::internal)?;
    let active = active_assignments(&comments);
    if active.len() != 1 {
        return Ok(None);
    }
    let assignment = &active[0];
    // Human, manually triggered, not a workflow step, matching the assignee.
    let assignee_text = item
        .assignee_user_id
        .filter(|id| *id != 0)
        .map(|id| id.to_string())
        .unwrap_or_default();
    if assignment.member_type != "human"
        || assignment.trigger.as_deref() == Some("default")
        || !assignment.workflow_step.is_empty()
        || assignee_text != assignment.member_id
    {
        return Ok(None);
    }
    let stored = json_object(metadata.human_work.as_ref());
    let work = match stored.as_ref() {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let assignment_id = assignment.comment_id.clone();
    let reviewer_id = reviewer_id(
        repository,
        item.assignee_user_id,
        assignment.assigned_by_user_id,
        project.number,
    )
    .await?;
    let is_assignee = item.assignee_user_id == Some(user_id);
    let status = item.status.as_deref().unwrap_or("");
    let can_review = status == "in_review"
        && work.get("state").and_then(Value::as_str) == Some("submitted")
        && work.get("assignment_id").and_then(Value::as_str) == Some(assignment_id.as_str())
        && match reviewer_id {
            Some(reviewer) => reviewer == user_id,
            None => {
                let mut fallback: Vec<i64> = vec![i64::from(project.created_by_user_id)];
                fallback.extend(
                    repository
                        .project_reviewer_ids(&item.cloud_project_id)
                        .await
                        .map_err(HttpError::internal)?,
                );
                fallback.contains(&i64::from(user_id))
            }
        };
    let state_value =
        if work.get("assignment_id").and_then(Value::as_str) == Some(assignment_id.as_str()) {
            work.get("state").cloned().unwrap_or_else(|| json!("none"))
        } else {
            json!("none")
        };
    let mut view = Map::new();
    view.insert("assignment_id".to_string(), json!(assignment_id));
    view.insert("assignee_user_id".to_string(), json!(item.assignee_user_id));
    view.insert("reviewer_user_id".to_string(), json!(reviewer_id));
    view.insert(
        "submission_message_id".to_string(),
        work.get("submission_message_id")
            .cloned()
            .unwrap_or(Value::Null),
    );
    view.insert(
        "submitted_by_user_id".to_string(),
        work.get("submitted_by_user_id")
            .cloned()
            .unwrap_or(Value::Null),
    );
    view.insert("state".to_string(), state_value);
    view.insert(
        "can_start".to_string(),
        json!(is_assignee && matches!(status, "inbox" | "pending")),
    );
    view.insert(
        "can_submit".to_string(),
        json!(is_assignee && status == "in_progress"),
    );
    view.insert("can_review".to_string(), json!(can_review));
    Ok(Some(Value::Object(view)))
}

/// `human_issue_work_service._reviewer_id`.
async fn reviewer_id(
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    assignee_user_id: Option<i32>,
    assigner_id: i64,
    project_number: i64,
) -> Result<Option<i32>, HttpError> {
    if assignee_user_id.map(i64::from) == Some(assigner_id) {
        return Ok(None);
    }
    let access = BoardSnapshotRepository::new(repository.mysql())
        .require_cloud_project_role(project_number, assigner_id as i32)
        .await
        .map_err(HttpError::internal)?;
    Ok(match access {
        Some(access) if access.role != "RestrictedAnalyst" => Some(assigner_id as i32),
        _ => None,
    })
}

/// One active assignment event (`issue_assignments.AssignmentEvent`).
struct ActiveAssignment {
    comment_id: String,
    member_type: String,
    member_id: String,
    workflow_step: String,
    trigger: Option<String>,
    assigned_by_user_id: i64,
}

/// `issue_assignment_service._active_events`: the active `assign` events after
/// applying the `unassign` cancellations, in activity order.
fn active_assignments(comments: &[CommentRow]) -> Vec<ActiveAssignment> {
    let cancelled: Vec<&str> = comments
        .iter()
        .filter_map(|comment| {
            let metadata = comment.assignment()?;
            (metadata.event_type.as_deref() == Some("assignment")
                && metadata.action.as_deref() == Some("unassign"))
            .then(|| metadata.assignment_event_id.as_deref().unwrap_or(""))
        })
        .collect();
    let mut active: Vec<ActiveAssignment> = Vec::new();
    for comment in comments {
        let Some(metadata) = comment.assignment() else {
            continue;
        };
        if metadata.event_type.as_deref() != Some("assignment")
            || metadata.action.as_deref() != Some("assign")
        {
            continue;
        }
        if cancelled.contains(&comment.id.as_str()) {
            continue;
        }
        let member_type = match metadata.target_type.as_deref() {
            Some("user") | Some("human") => "human",
            Some(_) => "agent",
            None => "agent",
        };
        let key = (
            member_type.to_string(),
            metadata.target_id.clone().unwrap_or_default(),
            metadata
                .workflow_step
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_string(),
        );
        let entry = ActiveAssignment {
            comment_id: comment.id.clone(),
            member_type: key.0.clone(),
            member_id: key.1.clone(),
            workflow_step: key.2.clone(),
            trigger: metadata.trigger.clone(),
            assigned_by_user_id: i64::from(comment.created_by_user_id.unwrap_or(0)),
        };
        match active.iter_mut().find(|existing| {
            existing.member_type == key.0
                && existing.member_id == key.1
                && existing.workflow_step == key.2
        }) {
            Some(existing) => *existing = entry,
            None => active.push(entry),
        }
    }
    active
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

/// Python truthiness for a JSON value (`None`/`false`/`0`/`""`/`[]`/`{}` are
/// falsy).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// A JSON value for an optional string: `Some` renders the string, `None`
/// renders JSON null.
fn optional_string(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// pydantic naive-datetime serialization (`isoformat()`): `YYYY-MM-DDTHH:MM:SS`
/// plus six fractional digits when the value has sub-second precision.
fn isoformat(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

/// A required pydantic datetime field: an absent value renders as `""`.
fn isoformat_required(value: Option<NaiveDateTime>) -> String {
    isoformat(value).unwrap_or_default()
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

#[cfg(test)]
#[path = "item_response_tests.rs"]
mod tests;
