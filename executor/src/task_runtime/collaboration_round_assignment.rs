// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Point the Issue at the member this round waits for. A human assignment wins
/// over a robot assignment because the round only continues after the human
/// delivers; the group assignment is cleared so the board shows the real owner.
pub(super) fn apply_round_assignee(
    connection: &Connection,
    item_id: &str,
    dispatched: &[Value],
) -> Result<(), TaskRuntimeError> {
    let Some(target) = dispatched
        .iter()
        .find(|assignment| assignment.get("assignee_type").and_then(Value::as_str) == Some("human"))
        .or_else(|| dispatched.first())
    else {
        return Ok(());
    };
    let (to_type, to_id, to_name, assignee_agent_id, assignee_user_id) =
        match target.get("assignee_type").and_then(Value::as_str) {
            Some("human") => {
                let id = target
                    .get("human_user_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        TaskRuntimeError::Invalid("human assignment identity is missing".to_owned())
                    })?;
                let user_id = id.parse::<i64>().map_err(|_| {
                    TaskRuntimeError::Invalid(
                        "local collaboration human assignee identity must be a numeric user id"
                            .to_owned(),
                    )
                })?;
                (
                    "user",
                    id.to_owned(),
                    target
                        .get("human_user_name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    None,
                    Some(user_id),
                )
            }
            _ => {
                let id = target
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        TaskRuntimeError::Invalid("agent assignment identity is missing".to_owned())
                    })?;
                (
                    "agent",
                    id.to_owned(),
                    target
                        .get("agent_name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    Some(id.to_owned()),
                    None,
                )
            }
        };
    let current =
        get_item_from(connection, item_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let assignee_matches = match to_type {
        "user" => current.assignee_user_id == assignee_user_id,
        _ => current.assignee_agent_id.as_deref() == assignee_agent_id.as_deref(),
    };
    let group_cleared = current
        .metadata
        .get("collaboration_group")
        .map_or(true, Value::is_null);
    if assignee_matches && group_cleared {
        return Ok(());
    }
    let mut metadata = current.metadata;
    metadata["collaboration_group"] = Value::Null;
    if let Some(name) = to_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        metadata["assignee_label"] = json!(name);
    }
    record_assignment_change(
        &mut metadata,
        0,
        Some(to_type),
        Some(&to_id),
        to_name.as_deref(),
    );
    connection.execute(
        "UPDATE loop_items
         SET assignee_agent_id = ?1, assignee_user_id = ?2, metadata = ?3,
             version = version + 1, updated_at = ?4
         WHERE id = ?5 AND resource_type = 'task' AND deleted_at IS NULL",
        params![
            assignee_agent_id,
            assignee_user_id,
            metadata.to_string(),
            now(),
            item_id,
        ],
    )?;
    Ok(())
}

pub(super) fn update_manager_assignment_activity(
    connection: &Connection,
    manager_execution_id: i64,
    round_id: &str,
    dispatch_id: &str,
    assignments: &[Value],
) -> Result<(), TaskRuntimeError> {
    connection.execute(
        "UPDATE loop_item_comments
         SET content = ?1,
             metadata = json_set(
                 metadata,
                 '$.dispatch_assignments',
                 json(?2),
                 '$.coordination_round_id',
                 ?3,
                 '$.dispatch_id',
                 ?4,
                 '$.activity_type',
                 'manager_assignment'
             ),
             updated_at = ?5
         WHERE deleted_at IS NULL
           AND json_extract(metadata, '$.execution_id') = ?6",
        params![
            assignment_summary(assignments),
            Value::Array(assignments.to_vec()).to_string(),
            round_id,
            dispatch_id,
            now(),
            manager_execution_id,
        ],
    )?;
    Ok(())
}

fn assignment_summary(assignments: &[Value]) -> String {
    assignments
        .iter()
        .filter_map(|assignment| {
            let name = assignment
                .get("agent_name")
                .or_else(|| assignment.get("human_user_name"))
                .and_then(Value::as_str)?;
            Some(format!(
                "{} → {}",
                assignment.get("task_title")?.as_str()?,
                name
            ))
        })
        .collect::<Vec<_>>()
        .join("\n")
}
