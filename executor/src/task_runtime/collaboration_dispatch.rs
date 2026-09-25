//! Executor-owned collaboration group dispatch.
//!
//! A manager submits one batch through the project-space MCP. Every agent
//! assignment becomes an independent Runtime execution so each member keeps
//! its configured shell, model, device policy, and capabilities. Once the
//! batch reaches a terminal state, the Executor queues a fresh manager
//! execution to evaluate the results and decide the next batch.

use super::*;

const TERMINAL_EXECUTION_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

impl LocalTaskStore {
    pub fn submit_collaboration_round(
        &self,
        manager_runtime_task_id: &str,
        plan: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let manager_execution_id =
            active_manager_execution_id(&transaction, manager_runtime_task_id)?.ok_or_else(
                || {
                    TaskRuntimeError::Invalid(
                        "collaboration manager Runtime execution was not found".to_owned(),
                    )
                },
            )?;
        let manager = execution_row(&transaction, manager_execution_id)?;
        let manager_payload = manager
            .execution_payload
            .as_ref()
            .filter(|payload| {
                payload.get("dispatch_role").and_then(Value::as_str) == Some("manager")
            })
            .ok_or_else(|| {
                TaskRuntimeError::Invalid(
                    "submit_workflow_plan requires a collaboration manager execution".to_owned(),
                )
            })?;
        let round_id = required_string(plan, "round_id")?;
        let assignments = plan
            .get("items")
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("workflow plan items must not be empty".to_owned())
            })?;
        if collaboration_round_exists(&transaction, &manager.loop_item_id, round_id)? {
            transaction.rollback()?;
            return Ok(json!({
                "round_id": round_id,
                "state": "already_dispatched",
            }));
        }

        let group = manager_payload
            .get("collaboration_group")
            .filter(|group| group.is_object())
            .ok_or_else(|| {
                TaskRuntimeError::Invalid(
                    "collaboration manager group context is missing".to_owned(),
                )
            })?;
        let mut dispatched = Vec::with_capacity(assignments.len());
        for assignment in assignments {
            let assignee_type = assignment
                .get("assignee_type")
                .and_then(Value::as_str)
                .unwrap_or("agent");
            if assignee_type != "agent" {
                return Err(TaskRuntimeError::Invalid(
                    "submit_workflow_plan currently requires agent assignments".to_owned(),
                ));
            }
            let agent_id = required_string(assignment, "assignee_id")?;
            validate_group_agent(group, agent_id)?;
            let title = required_string(assignment, "title")?;
            let instructions = required_string(assignment, "instructions")?;
            let agent = collaboration_agent(&transaction, &manager.cloud_project_id, agent_id)?;
            let payload = json!({
                "message": instructions,
                "workflow_task_title": title,
                "workflow_node_id": assignment.get("workflow_stage_id"),
                "dispatch_id": manager_payload.get("dispatch_id"),
                "dispatch_role": "member",
                "coordination_round_id": round_id,
                "coordination_manager_execution_id": manager_execution_id,
                "collaboration_group": group,
                "project_workspace_roots": manager_payload.get("project_workspace_roots"),
            });
            let execution_id = create_local_execution(
                &transaction,
                &manager.loop_item_id,
                &manager.cloud_project_id,
                agent_id,
                &agent,
                manager.task_priority.as_deref().unwrap_or("none"),
                payload,
            )?;
            dispatched.push(json!({
                "execution_id": execution_id,
                "task_title": title,
                "agent_id": agent_id,
                "agent_name": agent_display_name(&agent),
                "assignee_id": agent_id,
                "assignee_name": agent_display_name(&agent),
                "workflow_stage_id": assignment.get("workflow_stage_id"),
            }));
        }

        let mut updated_payload = manager_payload.clone();
        updated_payload["coordination_submitted_round_id"] = json!(round_id);
        transaction.execute(
            "UPDATE loop_item_executions
             SET execution_payload = ?1, version = version + 1, updated_at = ?2
             WHERE id = ?3",
            params![updated_payload.to_string(), now(), manager_execution_id],
        )?;
        update_manager_assignment_activity(
            &transaction,
            manager_execution_id,
            round_id,
            &dispatched,
        )?;
        transaction.commit()?;
        Ok(json!({
            "round_id": round_id,
            "state": "dispatched",
            "assignments": dispatched,
        }))
    }

    pub(super) fn resume_manager_for_finished_round(
        &self,
        execution_id: i64,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let execution = execution_row(&transaction, execution_id)?;
        let Some(round_id) = coordination_round_id(&execution) else {
            transaction.rollback()?;
            return Ok(());
        };
        if !collaboration_round_is_ready(&transaction, &execution.loop_item_id, &round_id)? {
            transaction.rollback()?;
            return Ok(());
        }
        if manager_resume_exists(&transaction, &execution.loop_item_id, &round_id)? {
            transaction.rollback()?;
            return Ok(());
        }
        let source_manager =
            source_manager_execution(&transaction, &execution.loop_item_id, &round_id)?
                .ok_or_else(|| {
                    TaskRuntimeError::Invalid(
                        "collaboration round manager execution was not found".to_owned(),
                    )
                })?;
        if !TERMINAL_EXECUTION_STATUSES.contains(&source_manager.status.as_str()) {
            transaction.rollback()?;
            return Ok(());
        }
        let source_payload = source_manager
            .execution_payload
            .as_ref()
            .ok_or_else(|| TaskRuntimeError::Invalid("manager payload is missing".to_owned()))?;
        let group = source_payload
            .get("collaboration_group")
            .filter(|group| group.is_object())
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("manager collaboration group is missing".to_owned())
            })?;
        let leader_id = group
            .pointer("/leader/id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("collaboration group leader is missing".to_owned())
            })?;
        let leader = collaboration_agent(&transaction, &execution.cloud_project_id, leader_id)?;
        let results =
            collaboration_round_results(&transaction, &execution.loop_item_id, &round_id)?;
        let mut payload = source_payload.clone();
        payload["message"] = Value::String(format!(
            "上一轮任务已经全部结束。请读取以下执行结果，综合判断是否需要分配下一轮任务；如 Issue 已达到待确认或完成条件，请显式调用 update_issue_status。不要直接执行成员工作。\n\n{}",
            serde_json::to_string_pretty(&results).unwrap_or_else(|_| "[]".to_owned())
        ));
        payload["coordination_resume_round_id"] = json!(round_id);
        payload
            .as_object_mut()
            .expect("manager payload must be an object")
            .remove("coordination_submitted_round_id");
        create_local_execution(
            &transaction,
            &execution.loop_item_id,
            &execution.cloud_project_id,
            leader_id,
            &leader,
            execution.task_priority.as_deref().unwrap_or("none"),
            payload,
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn active_manager_execution_id(
    connection: &Connection,
    runtime_task_id: &str,
) -> Result<Option<i64>, TaskRuntimeError> {
    Ok(connection
        .query_row(
            "SELECT id FROM loop_item_executions
             WHERE runtime_task_id = ?1
               AND status IN ('claimed', 'running', 'cancel_requested')
               AND json_extract(execution_payload, '$.dispatch_role') = 'manager'
             ORDER BY id DESC LIMIT 1",
            params![runtime_task_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, TaskRuntimeError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| TaskRuntimeError::Invalid(format!("{key} is required")))
}

fn validate_group_agent(group: &Value, agent_id: &str) -> Result<(), TaskRuntimeError> {
    let leader_matches = group.pointer("/leader/id").and_then(Value::as_str) == Some(agent_id);
    let member_matches = group
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|member| {
            member.get("kind").and_then(Value::as_str) == Some("agent")
                && member.get("id").and_then(Value::as_str) == Some(agent_id)
        });
    if leader_matches || member_matches {
        Ok(())
    } else {
        Err(TaskRuntimeError::Invalid(
            "workflow plan assignee is not an agent in the collaboration group".to_owned(),
        ))
    }
}

fn collaboration_round_exists(
    connection: &Connection,
    item_id: &str,
    round_id: &str,
) -> Result<bool, TaskRuntimeError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM loop_item_executions
             WHERE loop_item_id = ?1
               AND json_extract(execution_payload, '$.coordination_round_id') = ?2
         )",
        params![item_id, round_id],
        |row| row.get(0),
    )?)
}

fn update_manager_assignment_activity(
    connection: &Connection,
    manager_execution_id: i64,
    round_id: &str,
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
                 ?3
             ),
             updated_at = ?4
         WHERE deleted_at IS NULL
           AND json_extract(metadata, '$.execution_id') = ?5",
        params![
            assignment_summary(assignments),
            Value::Array(assignments.to_vec()).to_string(),
            round_id,
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
            Some(format!(
                "{} → {}",
                assignment.get("task_title")?.as_str()?,
                assignment.get("agent_name")?.as_str()?
            ))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn coordination_round_id(execution: &LocalExecution) -> Option<String> {
    let payload = execution.execution_payload.as_ref()?;
    payload
        .get("coordination_round_id")
        .or_else(|| payload.get("coordination_submitted_round_id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn collaboration_round_is_ready(
    connection: &Connection,
    item_id: &str,
    round_id: &str,
) -> Result<bool, TaskRuntimeError> {
    let (total, terminal): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END), 0)
         FROM loop_item_executions
         WHERE loop_item_id = ?1
           AND json_extract(execution_payload, '$.dispatch_role') = 'member'
           AND json_extract(execution_payload, '$.coordination_round_id') = ?2",
        params![item_id, round_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(total > 0 && total == terminal)
}

fn manager_resume_exists(
    connection: &Connection,
    item_id: &str,
    round_id: &str,
) -> Result<bool, TaskRuntimeError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM loop_item_executions
             WHERE loop_item_id = ?1
               AND json_extract(execution_payload, '$.dispatch_role') = 'manager'
               AND json_extract(execution_payload, '$.coordination_resume_round_id') = ?2
         )",
        params![item_id, round_id],
        |row| row.get(0),
    )?)
}

fn source_manager_execution(
    connection: &Connection,
    item_id: &str,
    round_id: &str,
) -> Result<Option<LocalExecution>, TaskRuntimeError> {
    let id = connection
        .query_row(
            "SELECT id FROM loop_item_executions
             WHERE loop_item_id = ?1
               AND json_extract(execution_payload, '$.dispatch_role') = 'manager'
               AND json_extract(execution_payload, '$.coordination_submitted_round_id') = ?2
             ORDER BY id DESC LIMIT 1",
            params![item_id, round_id],
            |row| row.get(0),
        )
        .optional()?;
    id.map(|id| execution_row(connection, id)).transpose()
}

fn collaboration_round_results(
    connection: &Connection,
    item_id: &str,
    round_id: &str,
) -> Result<Value, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id FROM loop_item_executions
         WHERE loop_item_id = ?1
           AND json_extract(execution_payload, '$.dispatch_role') = 'member'
           AND json_extract(execution_payload, '$.coordination_round_id') = ?2
         ORDER BY id",
    )?;
    let ids = statement
        .query_map(params![item_id, round_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let results = ids
        .into_iter()
        .map(|id| execution_row(connection, id))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|execution| {
            let payload = execution.execution_payload.as_ref().unwrap_or(&Value::Null);
            json!({
                "execution_id": execution.id,
                "task_title": payload.get("workflow_task_title"),
                "assignee_id": execution.agent_id,
                "assignee_name": execution.agent_name,
                "status": execution.status,
                "result": if execution.status == "failed" {
                    execution.error_message
                } else {
                    execution.execution_note
                },
            })
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(results))
}

fn agent_display_name(agent: &LoopItem) -> String {
    agent
        .metadata
        .get("display_name")
        .and_then(Value::as_str)
        .or(agent.title.as_deref())
        .or(agent.name.as_deref())
        .unwrap_or("AI")
        .to_owned()
}
