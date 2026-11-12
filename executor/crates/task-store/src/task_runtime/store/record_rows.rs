use super::*;

pub(super) fn map_chat_agent(row: LoopItem) -> ChatAgent {
    let metadata = row.metadata;
    let name = row.title.or(row.name).unwrap_or_else(|| "AI".to_owned());
    let text = |key: &str, default: &str| {
        metadata
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_owned()
    };
    ChatAgent {
        execution_policy: metadata
            .get("execution_policy")
            .filter(|value| !value.is_null())
            .cloned(),
        model_policy: metadata
            .get("model_policy")
            .filter(|value| !value.is_null())
            .cloned(),
        id: row.id.clone(),
        project_id: row.cloud_project_id.clone().unwrap_or_default(),
        display_name: text("display_name", &name),
        namespace: text("namespace", "default"),
        name,
        runtime: text("runtime", "codex"),
        model: metadata
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model_type: metadata
            .get("model_type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model_namespace: text("model_namespace", "default"),
        allowed_models: metadata
            .get("allowed_models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                metadata
                    .get("model")
                    .and_then(Value::as_str)
                    .map(|model| {
                        vec![json!({
                            "name": model,
                            "type": metadata.get("model_type"),
                            "namespace": metadata
                                .get("model_namespace")
                                .and_then(Value::as_str)
                                .unwrap_or("default"),
                        })]
                    })
                    .unwrap_or_default()
            }),
        capability_description: text("capability_description", ""),
        capability_mode: metadata
            .get("capability_mode")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                let has_manual_capabilities = metadata
                    .get("plugins")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
                    || metadata
                        .get("additional_skills")
                        .and_then(Value::as_array)
                        .is_some_and(|items| !items.is_empty())
                    || metadata
                        .get("mcp_servers")
                        .and_then(Value::as_object)
                        .is_some_and(|items| !items.is_empty());
                if has_manual_capabilities {
                    "manual".to_owned()
                } else {
                    "follow_device".to_owned()
                }
            }),
        system_prompt: text("system_prompt", ""),
        status: row.status.unwrap_or_else(|| "active".to_owned()),
        visibility: text("visibility", "creator_admin"),
        execution_environment: text("execution_environment", "local"),
        execution_mode: text("execution_mode", "auto"),
        execution_device_id: metadata
            .get("execution_device_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        max_concurrent_executions: metadata
            .get("max_concurrent_executions")
            .and_then(Value::as_u64)
            .filter(|value| (1..=20).contains(value))
            .unwrap_or(1),
        workspace_policy: text("workspace_policy", "project"),
        local_project_id: metadata.get("local_project_id").and_then(Value::as_i64),
        plugins: metadata
            .get("plugins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        additional_skills: metadata
            .get("additional_skills")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        mcp_servers: metadata
            .get("mcp_servers")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
        created_by_user_id: row.created_by_user_id,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(super) fn insert_comment(
    connection: &Connection,
    create: &LocalCommentCreate,
    status: &str,
) -> Result<LocalComment, TaskRuntimeError> {
    let message_id = Uuid::new_v4().to_string();
    let now = now();
    let (reply_to_message_id, thread_root_message_id) =
        if let Some(reply_to) = &create.reply_to_message_id {
            let root = connection
                .query_row(
                    "SELECT COALESCE(thread_root_message_id, message_id)
                     FROM loop_item_comments
                     WHERE message_id = ?1 AND deleted_at IS NULL",
                    params![reply_to],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or_else(|| reply_to.clone());
            (Some(reply_to.clone()), Some(root))
        } else {
            (None, Some(message_id.clone()))
        };
    let sequence_number = connection.query_row(
        "SELECT COALESCE(MAX(sequence_number), 0) + 1
         FROM loop_item_comments WHERE task_id = ?1",
        params![create.task_id],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "INSERT INTO loop_item_comments (
            message_id, client_message_id, project_id, task_id,
            sender_type, sender_id, sender_name, message_type, content,
            metadata, trigger_message_id, reply_to_message_id,
            thread_root_message_id, status, sequence_number, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)",
        params![
            message_id,
            create.client_message_id,
            create.project_id,
            create.task_id,
            create.sender_type,
            create.sender_id,
            create.sender_name,
            "text",
            create.content,
            create.metadata.to_string(),
            None::<String>,
            reply_to_message_id,
            thread_root_message_id,
            status,
            sequence_number,
            now,
        ],
    )?;
    refresh_runtime_projection_additional_context(connection, &create.task_id)?;
    issue_badges::update_stored_source(
        connection,
        &create.task_id,
        &format!("comment:{message_id}"),
        &create.content,
    )?;
    comment_row(connection, &message_id)
}

pub(super) fn move_runtime_comment_task_to_in_progress(
    connection: &Connection,
    task_id: &str,
    origin_run_id: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    let task = get_item_from(connection, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let project = chat_groups::work_container_from(
        connection,
        task.cloud_project_id
            .as_deref()
            .ok_or(TaskRuntimeError::ProjectNotFound)?,
    )?
    .ok_or(TaskRuntimeError::ProjectNotFound)?;
    let next_status = task
        .status
        .as_deref()
        .map(|status| project_status::robot_assignment_status(&project.metadata, status));
    connection.execute(
        "UPDATE loop_items
         SET status=?3, completed_at=NULL,
             version=version+1, updated_at=?1
         WHERE id=?2 AND resource_type='task'
           AND status != ?3",
        params![now(), task_id, next_status],
    )?;
    local_automation::on_status_changed(
        connection,
        task_id,
        task.status.as_deref(),
        origin_run_id,
    )?;
    Ok(())
}

pub(super) fn map_comment(row: &Row<'_>) -> rusqlite::Result<LocalComment> {
    Ok(LocalComment {
        id: row.get(0)?,
        message_id: row.get(1)?,
        client_message_id: row.get(2)?,
        project_id: row.get(3)?,
        task_id: row.get(4)?,
        sender_type: row.get(5)?,
        sender_id: row.get(6)?,
        sender_name: row.get(7)?,
        message_type: row.get(8)?,
        content: row.get(9)?,
        metadata: serde_json::from_str(&row.get::<_, String>(10)?).unwrap_or(Value::Null),
        trigger_message_id: row.get(11)?,
        reply_to_message_id: row.get(12)?,
        thread_root_message_id: row.get(13)?,
        status: row.get(14)?,
        sequence_number: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

pub(super) fn comment_row(
    connection: &Connection,
    message_id: &str,
) -> Result<LocalComment, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, message_id, client_message_id, project_id, task_id,
                    sender_type, sender_id, sender_name, message_type, content,
                    metadata, trigger_message_id, reply_to_message_id,
                    thread_root_message_id, status, sequence_number, created_at, updated_at
             FROM loop_item_comments
             WHERE message_id = ?1 AND deleted_at IS NULL",
            params![message_id],
            map_comment,
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn map_execution(row: &Row<'_>) -> rusqlite::Result<LocalExecution> {
    let payload: Option<String> = row.get(22)?;
    let status: String = row.get(7)?;
    let observed_state: String = row.get(30)?;
    let sync_state: String = row.get(31)?;
    let agent_metadata = row
        .get::<_, Option<String>>(43)?
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or(Value::Null);
    Ok(LocalExecution {
        id: row.get(0)?,
        loop_item_id: row.get(1)?,
        cloud_project_id: row.get(2)?,
        agent_id: row.get(3)?,
        assigner_user_id: row.get(4)?,
        execution_environment: row.get(5)?,
        execution_device_id: row.get(6)?,
        runtime_instance_id: row.get(44)?,
        display_state: local_execution_display_state(&status, &observed_state, &sync_state),
        status,
        observed_state,
        sync_state,
        priority_weight: row.get(8)?,
        queued_at: row.get(9)?,
        started_at: row.get(10)?,
        completed_at: row.get(11)?,
        lease_expires_at: row.get(12)?,
        heartbeat_at: row.get(13)?,
        claimed_at: row.get(32)?,
        start_requested_at: row.get(33)?,
        observed_at: row.get(34)?,
        cancel_requested_at: row.get(35)?,
        attempt_no: row.get(27)?,
        previous_execution_id: row.get(28)?,
        execution_scope: row.get(29)?,
        last_event_seq: row.get(36)?,
        termination_reason: row.get(37)?,
        retry_attempt: row.get(14)?,
        error_message: row.get(15)?,
        execution_note: row.get(16)?,
        approval_status: row.get(17)?,
        approved_by_user_id: row.get(18)?,
        rejected_reason: row.get(19)?,
        runtime_device_id: row.get(20)?,
        runtime_task_id: row.get(21)?,
        execution_payload: payload
            .and_then(|value| serde_json::from_str(&value).ok())
            .filter(Value::is_object),
        max_retries: row.get(23)?,
        version: row.get(24)?,
        created_at: row.get(25)?,
        updated_at: row.get(26)?,
        task_title: row.get::<_, Option<String>>(38)?.unwrap_or_default(),
        task_status: row.get(39)?,
        task_priority: row.get(40)?,
        agent_name: execution_agent_name(&agent_metadata, row.get(41)?, row.get(42)?)
            .unwrap_or_else(|| "AI".to_owned()),
        agent_system_prompt: row
            .get::<_, Option<String>>(43)?
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .and_then(|metadata| {
                metadata
                    .get("system_prompt")?
                    .as_str()
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_default(),
        agent_model: agent_metadata
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        agent_local_project_id: agent_metadata
            .get("local_project_id")
            .and_then(Value::as_i64),
        agent_max_concurrent_executions: agent_metadata
            .get("max_concurrent_executions")
            .and_then(Value::as_u64)
            .filter(|value| (1..=20).contains(value))
            .unwrap_or(1),
        agent_plugins: agent_metadata
            .get("plugins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        agent_runtime: agent_metadata
            .get("runtime")
            .and_then(Value::as_str)
            .unwrap_or("codex")
            .to_owned(),
        agent_additional_skills: agent_metadata
            .get("additional_skills")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        agent_mcp_servers: agent_metadata
            .get("mcp_servers")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
    })
}

pub(super) fn execution_agent_name(
    metadata: &Value,
    name: Option<String>,
    title: Option<String>,
) -> Option<String> {
    metadata
        .get("display_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| name.filter(|value| !value.trim().is_empty()))
        .or_else(|| title.filter(|value| !value.trim().is_empty()))
}

pub(super) fn local_execution_display_state(
    status: &str,
    observed_state: &str,
    sync_state: &str,
) -> String {
    match status {
        "completed" => "succeeded",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ if matches!(sync_state, "stale" | "diverged") => "unknown",
        "pending_approval" => "waiting_approval",
        "queued" => "queued",
        "cancel_requested" => "cancelling",
        "claimed" => "starting",
        "running" if observed_state == "running" => "running",
        _ => "waiting_runtime",
    }
    .to_owned()
}

pub(super) fn execution_row(
    connection: &Connection,
    execution_id: i64,
) -> Result<LocalExecution, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT e.id, e.loop_item_id, e.cloud_project_id, e.agent_id,
                e.assigner_user_id, e.execution_environment, e.execution_device_id,
                e.status, e.priority_weight, e.queued_at, e.started_at, e.completed_at,
                e.lease_expires_at, e.heartbeat_at, e.retry_attempt, e.error_message,
                e.execution_note, e.approval_status, e.approved_by_user_id,
                e.rejected_reason, e.runtime_device_id, e.runtime_task_id,
                e.execution_payload, e.max_retries, e.version, e.created_at,
                e.updated_at, e.attempt_no, e.previous_execution_id,
                e.execution_scope, e.observed_state, e.sync_state,
                e.claimed_at, e.start_requested_at, e.observed_at,
                e.cancel_requested_at, e.last_event_seq, e.termination_reason,
                COALESCE(t.title, t.name, ''), t.status, t.priority,
                a.name, a.title, a.metadata, e.runtime_instance_id
         FROM loop_item_executions e
         LEFT JOIN loop_items t ON t.id = e.loop_item_id
         LEFT JOIN loop_items a ON a.id = e.agent_id
         WHERE e.id = ?1",
    )?;
    statement
        .query_row(params![execution_id], map_execution)
        .map_err(TaskRuntimeError::from)
}
