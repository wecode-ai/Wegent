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
            let assignment_id = required_string(assignment, "assignment_id")?;
            let assignee_id = required_string(assignment, "assignee_id")?;
            let title = required_string(assignment, "title")?;
            let instructions = required_string(assignment, "instructions")?;
            match assignee_type {
                "agent" => {
                    validate_group_agent(group, assignee_id)?;
                    let agent =
                        collaboration_agent(&transaction, &manager.cloud_project_id, assignee_id)?;
                    let runtime_payload =
                        collaboration_member_runtime_payload(manager_payload, assignee_id)?;
                    let payload = json!({
                        "runtimePayload": runtime_payload,
                        "message": collaboration_assignment_prompt(title, instructions),
                        "workflow_task_title": title,
                        "workflow_node_id": assignment.get("workflow_stage_id"),
                        "assignment_id": assignment_id,
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
                        assignee_id,
                        &agent,
                        manager.task_priority.as_deref().unwrap_or("none"),
                        payload,
                    )?;
                    dispatched.push(json!({
                        "execution_id": execution_id,
                        "assignment_id": assignment_id,
                        "assignee_type": "agent",
                        "task_title": title,
                        "agent_id": assignee_id,
                        "agent_name": agent_display_name(&agent),
                        "assignee_id": assignee_id,
                        "assignee_name": agent_display_name(&agent),
                        "workflow_stage_id": assignment.get("workflow_stage_id"),
                    }));
                }
                "human" => {
                    let human_name = validate_group_human(group, assignee_id)?;
                    let human_task_id = create_human_assignment_task(
                        &transaction,
                        &manager,
                        round_id,
                        assignment_id,
                        assignee_id,
                        title,
                        instructions,
                        assignment.get("workflow_stage_id"),
                    )?;
                    dispatched.push(json!({
                        "human_assignment_id": human_task_id,
                        "assignment_id": assignment_id,
                        "assignee_type": "human",
                        "task_title": title,
                        "assignee_id": assignee_id,
                        "assignee_name": human_name,
                        "workflow_stage_id": assignment.get("workflow_stage_id"),
                    }));
                }
                value => {
                    return Err(TaskRuntimeError::Invalid(format!(
                        "unsupported collaboration assignee type '{value}'"
                    )));
                }
            }
        }

        let mut updated_payload = manager_payload.clone();
        updated_payload["coordination_submitted_round_id"] = json!(round_id);
        transaction.execute(
            "UPDATE loop_item_executions
             SET execution_payload = ?1,
                 status = 'completed',
                 completed_at = ?2,
                 lease_expires_at = NULL,
                 observed_state = 'succeeded',
                 sync_state = 'in_sync',
                 observed_at = ?2,
                 termination_reason = 'collaboration_round_dispatched',
                 version = version + 1,
                 updated_at = ?2
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
        let connection = self.connection()?;
        let execution = execution_row(&connection, execution_id)?;
        let Some(round_id) = coordination_round_id(&execution) else {
            return Ok(());
        };
        drop(connection);
        self.resume_manager_for_round(&execution.loop_item_id, &round_id)
    }

    pub(crate) fn resume_manager_for_human_delivery(
        &self,
        human_task_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let assignment = connection
            .query_row(
                "SELECT parent_id,
                        json_extract(metadata, '$.collaboration_assignment.round_id')
                 FROM loop_items
                 WHERE id = ?1
                   AND resource_type = 'task'
                   AND json_extract(metadata, '$.collaboration_assignment.assignee_type') = 'human'",
                [human_task_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .and_then(|(item_id, round_id)| item_id.zip(round_id));
        drop(connection);
        let Some((item_id, round_id)) = assignment else {
            return Ok(());
        };
        self.resume_manager_for_round(&item_id, &round_id)
    }

    fn resume_manager_for_round(
        &self,
        item_id: &str,
        round_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !collaboration_round_is_ready(&transaction, item_id, round_id)? {
            transaction.rollback()?;
            return Ok(());
        }
        if manager_resume_exists(&transaction, item_id, round_id)? {
            transaction.rollback()?;
            return Ok(());
        }
        let source_manager = source_manager_execution(&transaction, item_id, round_id)?
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
        let manager_context = source_payload
            .get("collaboration_manager_context")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("collaboration manager context is missing".to_owned())
            })?;
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
        let leader =
            collaboration_agent(&transaction, &source_manager.cloud_project_id, leader_id)?;
        let results = self.collaboration_round_results(&transaction, item_id, round_id)?;
        let mut payload = source_payload.clone();
        payload["message"] = Value::String(format!(
            "{manager_context}\n\n<collaboration_round_results>\n上一轮任务已经全部结束。请读取以下执行结果，综合判断是否需要分配下一轮任务；如 Issue 已达到待确认或完成条件，请显式调用 update_issue_status。不要直接执行成员工作。\n\n{}\n</collaboration_round_results>",
            serde_json::to_string_pretty(&results).unwrap_or_else(|_| "[]".to_owned())
        ));
        payload["coordination_resume_round_id"] = json!(round_id);
        payload
            .as_object_mut()
            .expect("manager payload must be an object")
            .remove("coordination_submitted_round_id");
        create_local_execution(
            &transaction,
            item_id,
            &source_manager.cloud_project_id,
            leader_id,
            &leader,
            source_manager.task_priority.as_deref().unwrap_or("none"),
            payload,
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn collaboration_round_results(
        &self,
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
        let execution_ids = statement
            .query_map(params![item_id, round_id], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut results = execution_ids
            .into_iter()
            .map(|id| execution_row(connection, id))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|execution| {
                let payload = execution.execution_payload.as_ref().unwrap_or(&Value::Null);
                json!({
                    "assignee_type": "agent",
                    "assignment_id": payload.get("assignment_id"),
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

        let mut human_statement = connection.prepare(
            "SELECT id, title, assignee_user_id, status, current_delivery_id, metadata
             FROM loop_items
             WHERE parent_id = ?1
               AND resource_type = 'task'
               AND deleted_at IS NULL
               AND json_extract(metadata, '$.collaboration_assignment.assignee_type') = 'human'
               AND json_extract(metadata, '$.collaboration_assignment.round_id') = ?2
             ORDER BY sequence_number, id",
        )?;
        let human_rows = human_statement
            .query_map(params![item_id, round_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (task_id, title, user_id, status, delivery_id, metadata) in human_rows {
            let metadata = serde_json::from_str::<Value>(&metadata).unwrap_or_else(|_| json!({}));
            let result = delivery_id
                .as_deref()
                .map(|delivery_id| human_delivery_markdown(self, connection, delivery_id))
                .transpose()?
                .unwrap_or_default();
            results.push(json!({
                "assignee_type": "human",
                "assignment_id": metadata.pointer("/collaboration_assignment/assignment_id"),
                "human_task_id": task_id,
                "task_title": title,
                "assignee_id": user_id.map(|value| value.to_string()),
                "status": if delivery_id.is_some() { "completed" } else {
                    status.as_deref().unwrap_or("inbox")
                },
                "delivery_id": delivery_id,
                "result": result,
            }));
        }
        Ok(Value::Array(results))
    }
}

fn collaboration_assignment_prompt(title: &str, instructions: &str) -> String {
    format!("任务标题：{title}\n\n执行要求：{instructions}")
}

fn collaboration_member_runtime_payload(
    manager_payload: &Value,
    assignee_id: &str,
) -> Result<Value, TaskRuntimeError> {
    let mut payload = manager_payload
        .get("memberRuntimeProfiles")
        .or_else(|| manager_payload.get("member_runtime_profiles"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|profile| {
            profile
                .get("memberIds")
                .or_else(|| profile.get("member_ids"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|member_id| member_id == assignee_id)
        })
        .and_then(|profile| {
            profile
                .get("runtimePayload")
                .or_else(|| profile.get("runtime_payload"))
        })
        .filter(|payload| payload.is_object())
        .cloned()
        .ok_or_else(|| {
            TaskRuntimeError::Invalid(format!(
                "Collaboration assignment target '{assignee_id}' has no materialized Runtime profile"
            ))
        })?;
    let system_prompt = crate::task_runtime::collaboration_member_profile_instructions(&payload);
    let execution_request = if payload.get("executionRequest").is_some() {
        payload.get_mut("executionRequest")
    } else {
        payload.get_mut("execution_request")
    }
    .and_then(Value::as_object_mut)
    .ok_or_else(|| {
        TaskRuntimeError::Invalid(
            "Collaboration member Runtime profile has no execution request".to_owned(),
        )
    })?;
    execution_request.insert(
        "system_prompt".to_owned(),
        Value::String(crate::task_runtime::collaboration_member_system_prompt(
            &system_prompt,
        )),
    );
    execution_request.remove("systemPrompt");
    Ok(payload)
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
    reject_group_leader(group, "agent", agent_id)?;
    let member_matches = group
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|member| {
            member.get("kind").and_then(Value::as_str) == Some("agent")
                && member.get("id").and_then(Value::as_str) == Some(agent_id)
        });
    if member_matches {
        Ok(())
    } else {
        Err(TaskRuntimeError::Invalid(
            "workflow plan assignee is not an agent in the collaboration group".to_owned(),
        ))
    }
}

fn validate_group_human(group: &Value, human_id: &str) -> Result<String, TaskRuntimeError> {
    reject_group_leader(group, "human", human_id)?;
    group
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|member| {
            member.get("kind").and_then(Value::as_str) == Some("human")
                && member.get("id").and_then(Value::as_str) == Some(human_id)
        })
        .map(|member| {
            member
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(human_id)
                .to_owned()
        })
        .ok_or_else(|| {
            TaskRuntimeError::Invalid(
                "workflow plan assignee is not a human in the collaboration group".to_owned(),
            )
        })
}

fn reject_group_leader(
    group: &Value,
    assignee_type: &str,
    assignee_id: &str,
) -> Result<(), TaskRuntimeError> {
    let leader = group.get("leader").filter(|leader| leader.is_object());
    let is_leader = leader.is_some_and(|leader| {
        leader.get("kind").and_then(Value::as_str) == Some(assignee_type)
            && leader.get("id").and_then(Value::as_str) == Some(assignee_id)
    });
    if is_leader {
        Err(TaskRuntimeError::Invalid(
            "collaboration group leader coordinates work and cannot be an assignment target"
                .to_owned(),
        ))
    } else {
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn create_human_assignment_task(
    connection: &Connection,
    manager: &LocalExecution,
    round_id: &str,
    assignment_id: &str,
    assignee_id: &str,
    title: &str,
    instructions: &str,
    workflow_stage_id: Option<&Value>,
) -> Result<String, TaskRuntimeError> {
    let assignee_user_id = assignee_id.parse::<i64>().map_err(|_| {
        TaskRuntimeError::Invalid(
            "local collaboration human assignee identity must be a numeric user id".to_owned(),
        )
    })?;
    let project = get_item_from(connection, &manager.cloud_project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    let sequence = project.next_item_number.unwrap_or(1);
    let project_key = project
        .project_key
        .as_deref()
        .ok_or_else(|| TaskRuntimeError::Invalid("project key is missing".to_owned()))?;
    let task_id = format!("{project_key}-{sequence}");
    let timestamp = now();
    let metadata = json!({
        "tags": [],
        "is_unread": true,
        "collaboration_assignment": {
            "assignment_id": assignment_id,
            "assignee_type": "human",
            "round_id": round_id,
            "manager_execution_id": manager.id,
            "root_item_id": manager.loop_item_id,
            "workflow_stage_id": workflow_stage_id,
        },
    });
    connection.execute(
        "UPDATE loop_items
         SET next_item_number = ?1, version = version + 1, updated_at = ?2
         WHERE id = ?3",
        params![sequence + 1, timestamp, manager.cloud_project_id],
    )?;
    connection.execute(
        "INSERT INTO loop_items (
            id, resource_type, project_space, cloud_project_id, parent_id,
            title, description, sequence_number, status, priority, sort_order,
            metadata, version, created_at, updated_at, assignee_user_id
         ) VALUES (?1, 'task', 'default', ?2, ?3, ?4, ?5, ?6, 'inbox', ?7,
                   0, ?8, 1, ?9, ?9, ?10)",
        params![
            task_id,
            manager.cloud_project_id,
            manager.loop_item_id,
            title,
            instructions,
            sequence,
            manager.task_priority.as_deref().unwrap_or("none"),
            metadata.to_string(),
            timestamp,
            assignee_user_id,
        ],
    )?;
    refresh_runtime_projection_additional_context(connection, &manager.loop_item_id)?;
    Ok(task_id)
}

fn human_delivery_markdown(
    store: &LocalTaskStore,
    connection: &Connection,
    delivery_id: &str,
) -> Result<String, TaskRuntimeError> {
    let object_key = connection
        .query_row(
            "SELECT markdown_object_key
             FROM loop_items
             WHERE id = ?1 AND resource_type = 'delivery' AND deleted_at IS NULL",
            [delivery_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    let object_key = Path::new(&object_key);
    if object_key.is_absolute()
        || object_key
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(TaskRuntimeError::Invalid(
            "stored delivery object key must be a safe relative path".to_owned(),
        ));
    }
    let object_root = store
        .path()
        .parent()
        .ok_or_else(|| TaskRuntimeError::Invalid("task database path is invalid".to_owned()))?
        .join("objects");
    std::fs::read_to_string(object_root.join(object_key))
        .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
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
             UNION ALL
             SELECT 1 FROM loop_items
             WHERE parent_id = ?1
               AND resource_type = 'task'
               AND json_extract(metadata, '$.collaboration_assignment.round_id') = ?2
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
                assignment.get("assignee_name")?.as_str()?
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
    let (agent_total, agent_terminal): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END), 0)
         FROM loop_item_executions
         WHERE loop_item_id = ?1
           AND json_extract(execution_payload, '$.dispatch_role') = 'member'
           AND json_extract(execution_payload, '$.coordination_round_id') = ?2",
        params![item_id, round_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (human_total, human_terminal): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN current_delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0)
         FROM loop_items
         WHERE parent_id = ?1
           AND resource_type = 'task'
           AND deleted_at IS NULL
           AND json_extract(metadata, '$.collaboration_assignment.assignee_type') = 'human'
           AND json_extract(metadata, '$.collaboration_assignment.round_id') = ?2",
        params![item_id, round_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let total = agent_total + human_total;
    Ok(total > 0 && agent_total == agent_terminal && human_total == human_terminal)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_member_payload_uses_canonical_member_instructions() {
        let manager_payload = json!({
            "memberRuntimeProfiles": [{
                "memberIds": ["member-1"],
                "runtimePayload": {
                    "projectInstructions": "member system instructions",
                    "executionRequest": {
                        "system_prompt": "manager system instructions"
                    }
                }
            }]
        });

        let payload = collaboration_member_runtime_payload(&manager_payload, "member-1").unwrap();
        let system_prompt = payload["executionRequest"]["system_prompt"]
            .as_str()
            .expect("member system prompt");

        assert!(system_prompt.starts_with("member system instructions"));
        assert!(!system_prompt.contains("manager system instructions"));
        assert!(system_prompt.contains("Executor 自动记录到当前 Issue 动态"));
    }
}
