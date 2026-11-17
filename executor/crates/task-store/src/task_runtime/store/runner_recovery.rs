use super::*;

pub(super) fn clear_request(payload: &mut Value) {
    fn clear(value: &mut Value) {
        for field in ["runnerRouting", "runnerSelection"] {
            if let Some(route) = value.get_mut(field).and_then(Value::as_object_mut) {
                route.remove("recovery_from_environment_id");
            }
        }
    }
    clear(payload);
    for field in [
        "runtimePayload",
        "runtime_payload",
        "managerRuntimeRequest",
        "manager_runtime_request",
    ] {
        if let Some(runtime) = payload.get_mut(field) {
            clear(runtime);
        }
    }
}

fn runtime_payload(payload: &Value) -> &Value {
    payload
        .get("runtimePayload")
        .or_else(|| payload.get("runtime_payload"))
        .or_else(|| payload.get("managerRuntimeRequest"))
        .or_else(|| payload.get("manager_runtime_request"))
        .filter(|value| value.is_object())
        .unwrap_or(payload)
}

pub(super) fn expected_binding(payload: &Value) -> Option<&str> {
    let runtime = runtime_payload(payload);
    runtime["runnerRouting"]["recovery_from_environment_id"]
        .as_str()
        .or_else(|| payload["runnerSelection"]["recovery_from_environment_id"].as_str())
}

pub(super) fn available_on(
    connection: &Connection,
    issue: &str,
    exclude: i64,
) -> Result<bool, TaskRuntimeError> {
    Ok(!connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE loop_item_id=?1 AND id<>?2 AND status IN ('queued','pending_approval','claimed','running','cancel_requested'))",
        params![issue, exclude], |row| row.get::<_, bool>(0),
    )?)
}

pub(super) fn validate_on(
    connection: &Connection,
    issue: &str,
    payload: &Value,
) -> Result<(), TaskRuntimeError> {
    let Some(expected) = expected_binding(payload) else {
        return Ok(());
    };
    let task = get_item_from(connection, issue, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let current = task
        .metadata
        .pointer("/runner_binding/environment_id")
        .and_then(Value::as_str);
    // Group profiles retain their routing snapshot across later rounds.
    if current.is_some()
        && runtime_payload(payload)["runnerRouting"]["environment_id"].as_str() == current
    {
        return Ok(());
    }
    if current != Some(expected)
        || payload["automation_run_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        || !available_on(connection, issue, 0)?
    {
        return Err(TaskRuntimeError::Invalid("ISSUE_RUNNER_CONFLICT: failure recovery requires the original binding and no active execution".into()));
    }
    Ok(())
}
