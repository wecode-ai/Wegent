//! Local executions own a persisted activity card and a runtime task binding.
use super::*;

pub(super) fn create_local_execution(
    connection: &Connection,
    item_id: &str,
    project_id: &str,
    agent_id: &str,
    agent: &LoopItem,
    priority: &str,
    payload: Value,
) -> Result<i64, TaskRuntimeError> {
    let metadata = &agent.metadata;
    let mode = metadata
        .get("execution_mode")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let environment = metadata
        .get("execution_environment")
        .and_then(Value::as_str)
        .unwrap_or("local");
    let now = now();
    let status = if mode == "manual_approval" {
        "pending_approval"
    } else {
        "queued"
    };
    let approval = if status == "pending_approval" {
        Some("pending")
    } else {
        None
    };
    connection.execute(
        "INSERT INTO loop_item_executions (
            loop_item_id, cloud_project_id, agent_id, execution_environment,
            execution_device_id, assigner_user_id, status, priority_weight, queued_at,
            approval_status, execution_payload, execution_scope,
            version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?8, ?8)",
        params![
            item_id,
            project_id,
            agent_id,
            environment,
            agent
                .metadata
                .get("execution_device_id")
                .and_then(Value::as_str),
            status,
            priority_weight(priority),
            now,
            approval,
            if payload.is_null() {
                None::<String>
            } else {
                Some(payload.to_string())
            },
            format!("project_robot:{item_id}"),
        ],
    )?;
    let execution_id = connection.last_insert_rowid();
    create_execution_comment(connection, execution_id, "pending", "")?;
    Ok(execution_id)
}

pub(super) fn insert_task_binding(
    connection: &Connection,
    project_id: Option<&str>,
    item_id: Option<&str>,
    input: &RuntimeTaskAddress,
    metadata: &Value,
    linked_at: &str,
) -> Result<String, TaskRuntimeError> {
    let id = numeric_id();
    connection.execute(
        "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                task_user_id, device_id, task_id, task_title, backend_task_id,
                linked_by_user_id, linked_at, metadata, version, created_at, updated_at
             ) VALUES (?1, 'execution', 'default', ?2, ?3, 0, ?4, ?5, ?6, ?7,
                       0, ?8, ?9, 1, ?8, ?8)",
        params![
            id,
            project_id,
            item_id,
            input.device_id,
            input.task_id,
            input.task_title,
            input.backend_task_id,
            linked_at,
            metadata.to_string(),
        ],
    )?;
    Ok(id)
}

pub(super) fn create_execution_comment(
    connection: &Connection,
    execution_id: i64,
    status: &str,
    content: &str,
) -> Result<LocalComment, TaskRuntimeError> {
    let execution = execution_row(connection, execution_id)?;
    let payload = execution.execution_payload.as_ref().unwrap_or(&Value::Null);
    let trigger = payload.get("trigger_message_id").and_then(Value::as_str);
    let workflow_task_title = payload
        .get("workflow_task_title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&execution.task_title);
    let mut metadata = json!({
        "execution_id": execution_id,
        "previous_execution_id": execution.previous_execution_id,
        "trigger_message_id": trigger,
        "workflow_node_id": payload.get("workflow_node_id"),
        "workflow_task_title": workflow_task_title,
        "automation_role": payload.get("automation_role"),
        "automation_run_id": payload.get("automation_run_id"),
    });
    if let (Some(device), Some(task)) = (&execution.runtime_device_id, &execution.runtime_task_id) {
        metadata["runtime_address"] = json!({"deviceId": device, "taskId": task});
    }
    insert_comment(
        connection,
        &LocalCommentCreate {
            project_id: execution.cloud_project_id,
            task_id: execution.loop_item_id,
            client_message_id: None,
            sender_type: "agent".into(),
            sender_id: execution.agent_id,
            sender_name: execution.agent_name,
            content: content.into(),
            metadata,
            reply_to_message_id: trigger.map(ToOwned::to_owned),
        },
        status,
    )
}

pub(super) fn ensure_execution_binding(
    connection: &Connection,
    execution_id: i64,
) -> Result<(), TaskRuntimeError> {
    let execution = execution_row(connection, execution_id)?;
    let (Some(device), Some(task)) = (&execution.runtime_device_id, &execution.runtime_task_id)
    else {
        return Ok(());
    };
    let address = json!({"deviceId": device, "taskId": task});
    connection.execute(
        "UPDATE loop_item_comments SET metadata=json_set(metadata,'$.runtime_address',json(?1)), updated_at=?2
         WHERE deleted_at IS NULL AND json_extract(metadata,'$.execution_id')=?3",
        params![address.to_string(), now(), execution_id],
    )?;
    // An explicit unlink is durable; reopening the database must not undo it.
    let existing: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_items WHERE resource_type='execution'
         AND device_id=?1 AND task_id=?2 AND loop_item_id=?3)",
        params![device, task, execution.loop_item_id],
        |row| row.get(0),
    )?;
    if existing {
        return Ok(());
    }
    if get_binding_by_kind(connection, device, task, false)?.is_some() {
        return Err(TaskRuntimeError::Invalid(
            "runtime task is already bound to another Issue".into(),
        ));
    }
    let node = execution
        .execution_payload
        .as_ref()
        .and_then(|payload| payload.get("workflow_node_id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let task_title = execution
        .execution_payload
        .as_ref()
        .and_then(|payload| payload.get("workflow_task_title"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&execution.task_title)
        .to_owned();
    let metadata = json!({"project_id": execution.cloud_project_id,
        "execution_id": execution_id, "workflow_node_id": node});
    insert_task_binding(
        connection,
        Some(&execution.cloud_project_id),
        Some(&execution.loop_item_id),
        &RuntimeTaskAddress {
            device_id: device.clone(),
            task_id: task.clone(),
            task_title: Some(task_title),
            backend_task_id: None,
            model_selection: None,
            workflow_node_id: node,
        },
        &metadata,
        execution
            .start_requested_at
            .as_deref()
            .unwrap_or(&execution.created_at),
    )?;
    Ok(())
}

pub(super) fn repair_missing_execution_activity(
    connection: &Connection,
) -> Result<(), TaskRuntimeError> {
    let ids = connection
        .prepare(
            "SELECT e.id FROM loop_item_executions e
         JOIN loop_items t ON t.id=e.loop_item_id AND t.deleted_at IS NULL
         JOIN loop_items p ON p.id=e.cloud_project_id AND p.deleted_at IS NULL
         ORDER BY e.id",
        )?
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let transaction = connection.unchecked_transaction()?;
    for id in ids {
        let execution = execution_row(&transaction, id)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_item_comments WHERE json_extract(metadata,'$.execution_id')=?1)",
            [id], |row| row.get(0),
        )?;
        if !exists {
            let (status, content) = match execution.status.as_str() {
                "completed" => ("completed", execution.execution_note.as_str()),
                "failed" => ("failed", execution.error_message.as_str()),
                "cancelled" => ("cancelled", execution.execution_note.as_str()),
                "running" | "cancel_requested" => ("streaming", ""),
                _ => ("pending", ""),
            };
            let comment = create_execution_comment(&transaction, id, status, content)?;
            transaction.execute(
                "UPDATE loop_item_comments SET created_at=?1,updated_at=?2 WHERE message_id=?3",
                params![
                    execution.created_at,
                    execution.updated_at,
                    comment.message_id
                ],
            )?;
        }
        if execution.start_requested_at.is_some() || execution.started_at.is_some() {
            ensure_execution_binding(&transaction, id)?;
        }
    }
    transaction.commit()?;
    Ok(())
}

impl LocalTaskStore {
    /// Persist progress only while the execution is active; late output cannot replace a result.
    pub fn update_execution_progress(
        &self,
        runtime_task_id: &str,
        content: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_item_comments SET content=?1, status='streaming', updated_at=?2
             WHERE id=(SELECT id FROM loop_item_comments
                 WHERE deleted_at IS NULL AND status IN ('pending','streaming')
                   AND json_extract(metadata,'$.runtime_address.taskId')=?3
                 ORDER BY id DESC LIMIT 1) AND content != ?1",
            params![content, now(), runtime_task_id],
        )?;
        Ok(())
    }

    pub fn finish_runtime_comment(
        &self,
        runtime_task_id: &str,
        status: &str,
        content: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_item_comments SET content=?1,status=?2,updated_at=?3
             WHERE id=(SELECT id FROM loop_item_comments
                 WHERE deleted_at IS NULL AND status IN ('pending','streaming')
                   AND json_extract(metadata,'$.runtime_address.taskId')=?4
                 ORDER BY id DESC LIMIT 1)",
            params![content, status, now(), runtime_task_id],
        )?;
        Ok(())
    }
}
