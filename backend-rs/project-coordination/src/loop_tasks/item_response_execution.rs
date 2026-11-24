// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The loop-item execution overlay: the newest run's fields, the approval view and the AI-state projection.

use super::*;

/// `execution_processing_actor(execution, ai_state)`: only a running run with
/// a non-empty projected agent name identifies the current AI actor.
pub(super) fn execution_processing_actor(
    execution: &ExecutionFullRow,
    ai_state: Option<&Value>,
) -> Option<Value> {
    if display_state(execution) != "running" {
        return None;
    }
    let name = ai_state
        .and_then(Value::as_object)
        .and_then(|state| state.get("agent_name"))
        .and_then(Value::as_str)?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(json!({"kind": "agent", "name": name}))
}

/// `execution_human_waiting_since(execution)`: a finished attempt returns work
/// to people; execution timestamps are UTC.
pub(super) fn execution_human_waiting_since(execution: &ExecutionFullRow) -> Option<String> {
    if !matches!(
        display_state(execution).as_str(),
        "succeeded" | "failed" | "cancelled"
    ) {
        return None;
    }
    let completed_at = execution
        .completed_at
        .filter(|_| !datetime_model_is_unset(execution.completed_at))?;
    Some(format!(
        "{}+00:00",
        isoformat(Some(completed_at)).unwrap_or_default()
    ))
}

/// `item_security(item, project)`: the item's own `security_level` when it is
/// one of the known levels, else the project default.
pub fn metadata_security_level(metadata: &ItemMetadata) -> Option<&'static str> {
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
pub(super) async fn execution_overlay(
    state: &LoopItemReads<'_>,
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
pub(super) fn display_state(execution: &ExecutionFullRow) -> String {
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

/// `_approval_view`: the per-status approval projection. Only the fields of
/// the active status are present, matching the source's `view[key] = value`
/// writes.
pub(super) fn approval_view(execution: &ExecutionFullRow) -> Option<Value> {
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
pub(super) async fn present_cached_ai_state(
    _state: &LoopItemReads<'_>,
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    item: &TaskItemFullRow,
    ai_state: Option<&Value>,
    context: &SharedContext,
    single_item: bool,
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
        Some(message_id) => match context.message(&item.id, message_id) {
            Some(row) => Some(row.clone()),
            None if !single_item => None,
            None => repository
                .project_chat_message(message_id, &item.id)
                .await
                .map_err(HttpError::internal)?,
        },
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
        || parsed_expiry.is_some_and(|expiry| expiry < chrono::Utc::now().naive_utc())
    {
        state.insert("status".to_string(), json!("unknown"));
        state.insert("sync_state".to_string(), json!("stale"));
    }
    Ok(Some(Value::Object(state)))
}

/// `_parse_ai_state_datetime`: parse an ISO timestamp, normalizing an aware
/// value to naive UTC.
pub(super) fn parse_ai_state_datetime(value: &str) -> Option<NaiveDateTime> {
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(parsed);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.naive_utc())
}

/// `execution_ai_state`: project the authoritative execution attempt onto the
/// task AI metadata. Returns `None` for a run awaiting approval.
pub(super) async fn execution_ai_state(
    _state: &LoopItemReads<'_>,
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
    // `execution.executor_type`: a `wegent_team` run names its team; every
    // other run names the agent (`agent.title or agent.name`).
    let agent_name = if execution.executor_type() == "wegent_team" && team_name.is_some() {
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
