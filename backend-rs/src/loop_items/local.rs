// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local-provider `LoopItemResponse` projection.
//!
//! Mirrors `app.services.loop_items.service.LoopItemService.response_values`
//! merged with the pydantic `LoopItemResponse` normalization
//! (`app.schemas.delivery`): the item row fields, the project-role permissions
//! (`issue_permissions` / `can_view_item`), the `item_security` level and the
//! metadata-derived history, AI and execution overlay fields.

use serde_json::{Map, Value, json};

use super::response::{
    LoopItemPermissions, LoopItemResponse, isoformat, isoformat_required, json_array, json_object,
    normalize_empty_id, normalize_tags, normalize_unset_datetime, normalize_zero_id,
    parse_ai_state_datetime,
};
use crate::board_snapshot::repository::ProjectRow;
use crate::loop_tasks::http_error::HttpError;
use crate::loop_tasks::loop_repository::{
    ExecutionFullRow, ItemMetadata, LoopItemRepository, TaskItemFullRow, has_permission,
};
use crate::state::AppState;

/// `issue_permissions(access, issue_creator_user_id, user_id)`
/// (`app.services.cloud_projects.access`). The source derives every action
/// from the caller's project role alone.
fn issue_permissions(role: &str) -> LoopItemPermissions {
    LoopItemPermissions {
        edit_content: has_permission(role, "Developer"),
        comment: has_permission(role, "Developer"),
        assign: has_permission(role, "Maintainer"),
        execute: has_permission(role, "Developer"),
    }
}

/// `item_security(item, project)` (`app.services.loop_items.access`): the
/// item's own `security_level` when set, else the project default.
fn item_security(metadata: &ItemMetadata, project: &ProjectRow) -> &'static str {
    if let Some(Value::String(level)) = metadata.security_level.as_ref() {
        match level.as_str() {
            "open" => return "open",
            "related" => return "related",
            _ => {}
        }
    }
    project.default_issue_security()
}

/// `can_view_item(db, access, item, user_id)`: maintainers and up always see
/// the item; otherwise open items and items related to the caller.
async fn can_view_item<M: brz_mysql::Mysql>(
    repository: &LoopItemRepository<'_, M>,
    item: &TaskItemFullRow,
    metadata: &ItemMetadata,
    project: &ProjectRow,
    role: &str,
    user_id: i32,
) -> Result<bool, HttpError> {
    if has_permission(role, "Maintainer") {
        return Ok(true);
    }
    if item_security(metadata, project) == "open" {
        return Ok(true);
    }
    repository
        .is_related_item(&item.id, user_id)
        .await
        .map_err(HttpError::internal)
}

/// `content_revision(metadata)` (`app.services.loop_item_unread`).
fn content_revision(metadata: &ItemMetadata) -> i64 {
    match metadata.content_revision.as_ref().and_then(Value::as_i64) {
        Some(value) if value >= 1 => value,
        _ => 1,
    }
}

/// `is_unread(metadata, user_id)`.
fn is_unread(metadata: &ItemMetadata, user_id: i32) -> bool {
    let revision = content_revision(metadata);
    let Some(Value::Object(read_revisions)) = metadata.read_revisions.as_ref() else {
        return true;
    };
    !matches!(
        read_revisions
            .get(&user_id.to_string())
            .and_then(Value::as_i64),
        Some(read) if read >= revision
    )
}

/// `activity_read_sequence(metadata, user_id)`.
fn activity_read_sequence(metadata: &ItemMetadata, user_id: i32) -> i64 {
    let Some(Value::Object(sequences)) = metadata.activity_read_sequences.as_ref() else {
        return 0;
    };
    match sequences.get(&user_id.to_string()).and_then(Value::as_i64) {
        Some(value) if value >= 0 => value,
        _ => 0,
    }
}

/// `execution_display_state(execution)`: the single user-facing state derived
/// from execution truth.
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
        return "starting".to_string();
    }
    if status == "running" && execution.observed_state.as_deref() == Some("running") {
        return "running".to_string();
    }
    "waiting_runtime".to_string()
}

/// `_approval_view(execution)`: the per-status approval projection.
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
                json!(isoformat(execution.queued_at)),
            );
        }
        "approved" => {
            view.insert(
                "approved_by_user_id".to_string(),
                json!(execution.approved_by_user_id),
            );
            view.insert(
                "approved_at".to_string(),
                json!(isoformat(execution.approved_at)),
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

/// `_can_approve_run`: whether the caller created the assigned robot and the
/// run is waiting for their manual approval.
async fn can_approve_run<M: brz_mysql::Mysql>(
    repository: &LoopItemRepository<'_, M>,
    item: &TaskItemFullRow,
    execution: &ExecutionFullRow,
    user_id: i32,
) -> Result<bool, HttpError> {
    if execution.status.as_deref() != Some("pending_approval") {
        return Ok(false);
    }
    let Some(agent_id) = nonempty(item.assignee_agent_id.as_deref()) else {
        return Ok(false);
    };
    let created_by = repository
        .chat_agent(&agent_id)
        .await
        .map_err(HttpError::internal)?
        .and_then(|agent| agent.created_by_user_id);
    Ok(created_by == Some(user_id))
}

/// `execution_ai_state(db, execution, existing=...)`: project the
/// authoritative execution attempt onto the task AI metadata. Returns `None`
/// for a run awaiting approval.
async fn execution_ai_state<M: brz_mysql::Mysql>(
    repository: &LoopItemRepository<'_, M>,
    execution: &ExecutionFullRow,
    existing: Option<Value>,
) -> Result<Option<Value>, HttpError> {
    if execution.status.as_deref() == Some("pending_approval") {
        return Ok(None);
    }
    let mut state = match json_object(existing.as_ref()) {
        Some(map) => map,
        None => Map::new(),
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
    // `execution.executor_type` is not selected by the execution row, so the
    // team branch is chosen when no agent id is set: the agent's title/name
    // otherwise.
    let agent_name = if let Some(agent) = agent {
        agent.display_name()
    } else {
        team_name
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
        json!(isoformat(execution.started_at)),
    );
    state.insert(
        "heartbeat_at".to_string(),
        json!(isoformat(execution.heartbeat_at)),
    );
    state.insert(
        "lease_expires_at".to_string(),
        json!(isoformat(execution.lease_expires_at)),
    );
    state.insert(
        "completed_at".to_string(),
        json!(isoformat(execution.completed_at)),
    );
    state.insert(
        "updated_at".to_string(),
        json!(isoformat(execution.updated_at)),
    );
    state.insert(
        "last_error".to_string(),
        nonempty(execution.error_message.as_deref()).map_or(Value::Null, Value::String),
    );
    Ok(Some(Value::Object(state)))
}

/// `_present_cached_ai_state`: read-only presentation of legacy task AI
/// metadata, including the `ProjectChatMessage` terminal-state check.
async fn present_cached_ai_state<M: brz_mysql::Mysql>(
    repository: &LoopItemRepository<'_, M>,
    item: &TaskItemFullRow,
    ai_state: Option<&Value>,
) -> Result<Option<Value>, HttpError> {
    let Some(mut state) = json_object(ai_state) else {
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
        let updated_at = isoformat(message.updated_at);
        state.insert("completed_at".to_string(), json!(updated_at.clone()));
        state.insert("updated_at".to_string(), json!(updated_at));
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
        || parsed_expiry.is_some_and(|expiry| expiry < chrono::Local::now().naive_local())
    {
        state.insert("status".to_string(), json!("unknown"));
        state.insert("sync_state".to_string(), json!("stale"));
    }
    Ok(Some(Value::Object(state)))
}

/// `"".filter -> None` for a possibly-empty string (`value or None`).
fn nonempty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// A mapped `500` for a user-lookup failure.
fn internal_anyhow(error: anyhow::Error) -> HttpError {
    tracing::error!(%error, "loop-items user lookup failure");
    HttpError::new(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

/// `response_values` for one local (`resource_type='task'`) item.
pub(crate) async fn local_item(
    state: &AppState,
    item: &TaskItemFullRow,
    user_id: i32,
    user_name: &str,
    project: &ProjectRow,
    role: &str,
) -> Result<LoopItemResponse, HttpError> {
    let repository = LoopItemRepository::new(&state.mysql);
    let default_metadata = ItemMetadata::default();
    let metadata = item.metadata().unwrap_or(&default_metadata);

    let permissions = issue_permissions(role);
    let can_view_detail =
        can_view_item(&repository, item, metadata, project, role, user_id).await?;
    let security_level = item_security(metadata, project);

    // `db.get(User, item.assignee_user_id)`: the source identity map already
    // holds the session user, so a self-assignment uses the session name
    // without another query.
    let assignee_user_id = normalize_zero_id(item.assignee_user_id);
    let assignee_name = match assignee_user_id {
        Some(id) if id == user_id => Some(user_name.to_string()),
        Some(id) => state
            .user_reader
            .get_by_id(i64::from(id))
            .await
            .map_err(internal_anyhow)?
            .map(|record| record.user_name),
        None => None,
    };

    let assignee_agent_id = normalize_empty_id(item.assignee_agent_id.as_deref());
    let assignee_agent_name = match assignee_agent_id.as_deref() {
        Some(agent_id) => repository
            .chat_agent(agent_id)
            .await
            .map_err(HttpError::internal)?
            .and_then(|agent| agent.name),
        None => None,
    };

    let assignee_team_id = normalize_zero_id(item.assignee_team_id);
    let assignee_team_name = match assignee_team_id {
        Some(team_id) => repository
            .kind_name(i64::from(team_id))
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };

    let collaboration_group = json_object(metadata.collaboration_group.as_ref());
    let assignee_group_id = collaboration_group
        .as_ref()
        .and_then(|group| super::response::json_string(group.get("id")));
    let assignee_group_name = collaboration_group
        .as_ref()
        .and_then(|group| super::response::json_string(group.get("name")));

    let cached_ai_state =
        present_cached_ai_state(&repository, item, metadata.ai_state.as_ref()).await?;
    let execution = repository
        .latest_execution_for_item(&item.id)
        .await
        .map_err(HttpError::internal)?;

    // `values["ai_state"]` then `execution_ai_state` when a run exists, then
    // the pydantic fallback to `metadata.ai_state`.
    let values_ai_state = match execution.as_ref() {
        Some(execution) => execution_ai_state(&repository, execution, cached_ai_state).await?,
        None => cached_ai_state,
    };
    let ai_state =
        values_ai_state.or_else(|| json_object(metadata.ai_state.as_ref()).map(Value::Object));

    let execution_id = execution.as_ref().map(|execution| execution.id);
    let execution_state = execution
        .as_ref()
        .map(display_state)
        .or_else(|| super::response::metadata_string(metadata.execution_state.as_ref()));
    let execution_control_state = execution.as_ref().and_then(|e| e.status.clone());
    let execution_observed_state = execution.as_ref().and_then(|e| e.observed_state.clone());
    let execution_sync_state = execution.as_ref().and_then(|e| e.sync_state.clone());
    let execution_attempt_no = execution.as_ref().and_then(|e| e.attempt_no);
    let execution_last_event_seq = execution.as_ref().and_then(|e| e.last_event_seq);
    let can_approve = match execution.as_ref() {
        Some(execution) => can_approve_run(&repository, item, execution, user_id).await?,
        None => false,
    };
    let approval = match execution.as_ref() {
        Some(execution) => approval_view(execution),
        None => None,
    }
    .or_else(|| json_object(metadata.approval.as_ref()).map(Value::Object));
    let queued_at = match execution.as_ref() {
        Some(execution) => isoformat(execution.queued_at),
        None => None,
    }
    .or_else(|| super::response::metadata_string(metadata.queued_at.as_ref()));
    let execution_note = execution
        .as_ref()
        .and_then(|execution| nonempty(execution.execution_note.as_deref()))
        .or_else(|| super::response::metadata_string(metadata.execution_note.as_ref()));
    let execution_error = execution
        .as_ref()
        .and_then(|execution| nonempty(execution.error_message.as_deref()))
        .or_else(|| super::response::metadata_string(metadata.execution_error.as_ref()));

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
        assignee_user_id,
        assignee_group_id,
        assignee_group_name,
        assignee_name,
        assignee_agent_id,
        assignee_agent_name,
        assignee_team_id,
        assignee_team_name,
        ai_state,
        execution_id,
        execution_state,
        execution_control_state,
        execution_observed_state,
        execution_sync_state,
        execution_attempt_no,
        execution_last_event_seq,
        can_approve,
        assignment_history: json_array(metadata.assignment_history.as_ref()),
        status_history: json_array(metadata.status_history.as_ref()),
        approval,
        queued_at,
        execution_note,
        execution_error,
        automation: json_object(metadata.automation.as_ref()).map(Value::Object),
        workflow: json_object(metadata.workflow.as_ref()).map(Value::Object),
        execution_config: json_object(metadata.execution_config.as_ref()).map(Value::Object),
        priority: item.priority.clone().unwrap_or_default(),
        due_at: isoformat(normalize_unset_datetime(item.due_at)),
        sort_order: item.sort_order,
        tags: normalize_tags(metadata.tags.as_ref()),
        created_by_user_id: i64::from(item.created_by_user_id.unwrap_or(0)),
        created_by_user_name: None,
        can_view_detail,
        security_level,
        can_edit: permissions.edit_content,
        permissions,
        detail_loaded: true,
        content_revision: content_revision(metadata),
        activity_read_sequence: activity_read_sequence(metadata, user_id),
        is_unread: is_unread(metadata, user_id),
        current_delivery_id: normalize_empty_id(item.current_delivery_id.as_deref()),
        version: item.version,
        created_at: isoformat_required(item.created_at),
        updated_at: isoformat_required(item.updated_at),
        completed_at: isoformat(normalize_unset_datetime(item.completed_at)),
    })
}
