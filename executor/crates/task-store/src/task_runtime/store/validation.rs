use super::*;

pub(super) fn validate_name(value: &str, label: &str) -> Result<(), TaskRuntimeError> {
    let length = value.trim().chars().count();
    if length == 0 || length > 255 {
        return Err(TaskRuntimeError::Invalid(format!(
            "{label} must contain 1 to 255 characters"
        )));
    }
    Ok(())
}

pub(super) fn validate_workspace_policy(value: &str) -> Result<(), TaskRuntimeError> {
    if matches!(value, "project" | "git_worktree") {
        return Ok(());
    }
    Err(TaskRuntimeError::Invalid(
        "Robot workspace policy must be project or git_worktree".to_owned(),
    ))
}

pub(super) fn validate_chat_agent_runtime(value: &str) -> Result<(), TaskRuntimeError> {
    matches!(value, "codex" | "claude_code")
        .then_some(())
        .ok_or_else(|| {
            TaskRuntimeError::Invalid("Robot runtime must be codex or claude_code".to_owned())
        })
}

pub(super) fn validate_mcp_servers(value: &Value) -> Result<(), TaskRuntimeError> {
    value.is_object().then_some(()).ok_or_else(|| {
        TaskRuntimeError::Invalid("Robot MCP servers must be a JSON object".to_owned())
    })
}

pub(super) fn validate_priority(value: &str) -> Result<(), TaskRuntimeError> {
    matches!(value, "none" | "low" | "medium" | "high" | "urgent")
        .then_some(())
        .ok_or_else(|| TaskRuntimeError::Invalid("invalid task priority".to_owned()))
}

pub(super) fn validate_schedule_range(
    start_at: Option<&str>,
    due_at: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    let start = start_at.map(schedule_datetime).transpose()?;
    let due = due_at.map(schedule_datetime).transpose()?;
    if start.zip(due).is_some_and(|(start, due)| start > due) {
        return Err(TaskRuntimeError::Invalid(
            "start_at cannot be after due_at".to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn schedule_datetime(value: &str) -> Result<DateTime<Utc>, TaskRuntimeError> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Ok(value.with_timezone(&Utc));
    }
    if let Ok(value) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Ok(value
            .and_hms_opt(0, 0, 0)
            .expect("midnight is a valid time")
            .and_utc());
    }
    Err(TaskRuntimeError::Invalid(
        "schedule dates must be ISO 8601 values".to_owned(),
    ))
}
