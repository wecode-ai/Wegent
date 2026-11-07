use super::*;

pub(super) fn cancel_active_executions(
    connection: &Connection,
    item_id: &str,
    note: &str,
    active_error: &str,
) -> Result<(), TaskRuntimeError> {
    let delivered: i64 = connection.query_row(
        "SELECT COUNT(*) FROM loop_item_executions
         WHERE loop_item_id = ?1
           AND status IN ('claimed', 'running', 'cancel_requested')
           AND start_requested_at IS NOT NULL",
        params![item_id],
        |row| row.get(0),
    )?;
    if delivered > 0 {
        return Err(TaskRuntimeError::Invalid(active_error.to_owned()));
    }
    let active: Vec<i64> = {
        let mut statement = connection.prepare(
            "SELECT id FROM loop_item_executions
             WHERE loop_item_id = ?1
               AND (status IN ('pending_approval', 'queued', 'waiting_runtime')
                    OR (status = 'claimed' AND start_requested_at IS NULL))",
        )?;
        let rows = statement.query_map(params![item_id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if active.is_empty() {
        return Ok(());
    }
    let now = now();
    let placeholders = vec!["?"; active.len()].join(",");
    let sql = format!(
        "UPDATE loop_item_executions
         SET status = 'cancelled', completed_at = ?1,
             observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?1,
             execution_note = ?2,
             termination_reason = 'cancelled_before_start',
             version = version + 1, updated_at = ?1
         WHERE id IN ({placeholders})"
    );
    connection.execute(
        &sql,
        rusqlite::params_from_iter(
            [now.clone(), note.to_owned()]
                .into_iter()
                .chain(active.iter().map(|id| id.to_string())),
        ),
    )?;
    for execution_id in active {
        update_agent_comment(connection, execution_id, "cancelled", note, &now)?;
    }
    Ok(())
}

pub(super) fn update_agent_comment(
    connection: &Connection,
    execution_id: i64,
    status: &str,
    content: &str,
    updated_at: &str,
) -> Result<(), TaskRuntimeError> {
    connection.execute(
        "UPDATE loop_item_comments
         SET status = ?1, content = ?2, updated_at = ?3
         WHERE deleted_at IS NULL
           AND json_extract(metadata, '$.execution_id') = ?4",
        params![status, content, updated_at, execution_id],
    )?;
    let mut statement = connection.prepare("SELECT task_id, message_id FROM loop_item_comments WHERE deleted_at IS NULL AND json_extract(metadata, '$.execution_id') = ?1")?;
    let comments = statement.query_map([execution_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for comment in comments {
        let (task_id, message_id) = comment?;
        issue_badges::update_stored_source(
            connection,
            &task_id,
            &format!("comment:{message_id}"),
            content,
        )?;
    }
    Ok(())
}

pub(super) fn local_execution_runtime_payload(execution: &LocalExecution) -> Value {
    let stored = execution
        .execution_payload
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut payload = stored
        .get("runtimePayload")
        .or_else(|| stored.get("runtime_payload"))
        .or_else(|| stored.get("managerRuntimeRequest"))
        .or_else(|| stored.get("manager_runtime_request"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(stored.clone()));
    let runtime_task_id = execution.runtime_task_id.clone().unwrap_or_default();
    let message = stored
        .get("message")
        .or_else(|| stored.get("text"))
        .or_else(|| payload.get("message"))
        .or_else(|| payload.get("content"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&execution.task_title)
        .to_owned();
    let title = stored
        .get("workflow_task_title")
        .or_else(|| payload.get("title"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&execution.task_title)
        .to_owned();
    let dispatch_id = stored.get("dispatch_id").cloned();
    let dispatch_role = stored.get("dispatch_role").cloned();
    let mut origin = json!({
        "type": if dispatch_id.is_some() { "issue_dispatch" } else { "project_automation" },
        "projectStore": "local",
        "cloudProjectId": execution.cloud_project_id,
        "loopItemId": execution.loop_item_id,
        "workflowNodeId": stored.get("workflow_node_id"),
        "dispatchId": dispatch_id,
        "dispatchRole": dispatch_role,
        "managerAgentId": if stored.get("dispatch_role").and_then(Value::as_str) == Some("manager") {
            Some(execution.agent_id.as_str())
        } else {
            None
        },
        "run_id": stored.get("automation_run_id"),
    });
    if let Some(context) = stored.get("project_coordination") {
        origin["project_coordination"] = context.clone();
        origin["userId"] = json!(execution.assigner_user_id);
    }

    let payload_object = payload
        .as_object_mut()
        .expect("materialized Runtime payload must be an object");
    for (key, value) in &stored {
        if ![
            "runtimePayload",
            "runtime_payload",
            "managerRuntimeRequest",
            "manager_runtime_request",
        ]
        .contains(&key.as_str())
        {
            payload_object
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    apply_execution_agent_profile(payload_object, execution);
    for key in ["runnerPolicy", "runnerSelection"] {
        if let Some(value) = stored.get(key) {
            payload_object.insert(key.into(), value.clone());
        }
    }
    if let Some(project_instructions) = stored.get("projectInstructions").cloned() {
        payload_object.insert("projectInstructions".to_owned(), project_instructions);
    }
    payload_object.insert("taskId".to_owned(), json!(runtime_task_id));
    payload_object.insert("title".to_owned(), json!(title));
    payload_object.insert("message".to_owned(), json!(message));
    payload_object.insert(
        "cloudProjectId".to_owned(),
        json!(execution.cloud_project_id),
    );
    if let Some(project_id) = execution.agent_local_project_id {
        payload_object.insert("projectId".to_owned(), json!(project_id));
        payload_object.insert("standaloneChatWorkspace".to_owned(), json!(false));
    } else {
        payload_object.insert("standaloneChatWorkspace".to_owned(), json!(true));
    }
    payload_object.insert("origin".to_owned(), origin.clone());
    if dispatch_id.is_some() {
        payload_object.insert("collaboration_model".to_owned(), json!("single"));
    }

    if let Some(member_profiles) = stored
        .get("memberRuntimeProfiles")
        .or_else(|| stored.get("member_runtime_profiles"))
        .filter(|value| value.is_array())
        .cloned()
    {
        let runtime_handle = payload_object
            .entry("runtimeHandle")
            .or_insert_with(|| json!({}));
        if !runtime_handle.is_object() {
            *runtime_handle = json!({});
        }
        let runtime_handle = runtime_handle
            .as_object_mut()
            .expect("Runtime handle was normalized");
        runtime_handle.insert(
            "collaborationMemberRuntimeProfiles".to_owned(),
            member_profiles,
        );
        if let Some(manager_context) = stored.get("collaboration_manager_context").cloned() {
            runtime_handle.insert("collaborationManagerContext".to_owned(), manager_context);
        }
        if let Some(dispatch_id) = stored.get("dispatch_id").cloned() {
            runtime_handle.insert("collaborationDispatchTaskId".to_owned(), dispatch_id);
        }
    }

    let execution_request_key = if payload_object.contains_key("executionRequest") {
        "executionRequest"
    } else {
        "execution_request"
    };
    if let Some(request) = payload_object
        .get_mut(execution_request_key)
        .and_then(Value::as_object_mut)
    {
        request.insert("task_id".to_owned(), json!(runtime_task_id));
        request.insert(
            "subtask_id".to_owned(),
            json!(uuid::Uuid::new_v4().to_string()),
        );
        request.insert("task_title".to_owned(), json!(title));
        request.insert(
            "subtask_title".to_owned(),
            json!(format!("{title} - Assistant")),
        );
        request.insert("prompt".to_owned(), json!(message));
        if let Some(instructions) = stored
            .get("projectInstructions")
            .filter(|_| stored.get("dispatch_role").and_then(Value::as_str) == Some("manager"))
        {
            request.insert("system_prompt".to_owned(), instructions.clone());
        }
        if stored.contains_key("project_coordination") {
            request.insert("user_id".to_owned(), json!(execution.assigner_user_id));
        }
        request.insert(
            "new_session".to_owned(),
            json!(stored.get("continueTaskId").is_none()),
        );
        request.insert(
            "device_id".to_owned(),
            json!(execution
                .runtime_device_id
                .as_deref()
                .unwrap_or("local-device")),
        );
        let extra = request.entry("extra").or_insert_with(|| json!({}));
        if !extra.is_object() {
            *extra = json!({});
        }
        let extra = extra
            .as_object_mut()
            .expect("Execution extra was normalized");
        extra.insert("origin".to_owned(), origin);
        if stored.contains_key("project_coordination") {
            extra.insert("user_id".to_owned(), json!(execution.assigner_user_id));
        }
        extra.insert(
            "cloudProjectId".to_owned(),
            json!(execution.cloud_project_id),
        );
        extra.insert("execution_target_type".to_owned(), json!("local"));
    }
    payload
}

pub(super) fn apply_execution_agent_profile(
    payload: &mut serde_json::Map<String, Value>,
    execution: &LocalExecution,
) {
    payload
        .entry("runtime")
        .or_insert_with(|| json!(execution.agent_runtime));
    payload
        .entry("projectInstructions")
        .or_insert_with(|| json!(execution.agent_system_prompt));
    if let Some(model) = execution.agent_model.as_deref() {
        payload.entry("modelId").or_insert_with(|| json!(model));
    }
    payload
        .entry("additionalSkills")
        .or_insert_with(|| json!(execution.agent_additional_skills));
    payload
        .entry("projectPlugins")
        .or_insert_with(|| json!(execution.agent_plugins));
    payload.entry("bot").or_insert_with(|| {
        json!([{
            "id": execution.agent_id,
            "name": execution.agent_name,
            "shell_type": if execution.agent_runtime == "claude_code" {
                "ClaudeCode"
            } else {
                "Codex"
            },
            "mcp_servers": execution.agent_mcp_servers,
        }])
    });
}
