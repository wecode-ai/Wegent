use super::*;

pub(super) fn insert_chat_agent(
    connection: &Connection,
    project_id: &str,
    input: ChatAgentCreate,
) -> Result<String, TaskRuntimeError> {
    crate::task_runtime::runner_routing::validate_policies(
        input.execution_policy.as_ref(),
        input.model_policy.as_ref(),
    )?;
    crate::task_runtime::runner_routing::validate_model_runtime(
        input.model_policy.as_ref(),
        &input.runtime,
    )?;
    validate_name(&input.name, "robot name")?;
    validate_chat_agent_runtime(&input.runtime)?;
    if !(1..=20).contains(&input.max_concurrent_executions) {
        return Err(TaskRuntimeError::Invalid(
            "Robot max concurrent executions must be between 1 and 20".to_owned(),
        ));
    }
    validate_workspace_policy(&input.workspace_policy)?;
    validate_mcp_servers(&input.mcp_servers)?;
    let capability_mode = input.capability_mode.unwrap_or_else(|| {
        if !input.plugins.is_empty()
            || !input.additional_skills.is_empty()
            || input
                .mcp_servers
                .as_object()
                .is_some_and(|servers| !servers.is_empty())
        {
            "manual".to_owned()
        } else {
            "follow_device".to_owned()
        }
    });
    let id = format!("LA-{}", Uuid::new_v4().simple());
    let timestamp = now();
    let allowed_models = input.allowed_models.clone().unwrap_or_else(|| {
        input
            .model
            .as_ref()
            .map(|model| {
                vec![json!({
                    "name": model,
                    "type": input.model_type,
                    "namespace": input.model_namespace.as_deref().unwrap_or("default"),
                })]
            })
            .unwrap_or_default()
    });
    let mut metadata = json!({
        "execution_policy": input.execution_policy,
        "model_policy": input.model_policy,
        "display_name": input.display_name.unwrap_or_else(|| input.name.clone()),
        "namespace": input.namespace.unwrap_or_else(|| "default".to_owned()),
        "runtime": input.runtime,
        "model": input.model,
        "model_type": input.model_type,
        "model_namespace": input.model_namespace.unwrap_or_else(|| "default".to_owned()),
        "allowed_models": allowed_models,
        "capability_description": input.capability_description.unwrap_or_default(),
        "capability_mode": capability_mode,
        "system_prompt": input.system_prompt.unwrap_or_default(),
        "visibility": input.visibility.unwrap_or_else(|| "creator_admin".to_owned()),
        "execution_environment": input.execution_environment.unwrap_or_else(|| "local".to_owned()),
        "execution_mode": input.execution_mode.unwrap_or_else(|| "auto".to_owned()),
        "max_concurrent_executions": input.max_concurrent_executions,
        "workspace_policy": input.workspace_policy,
        "plugins": input.plugins,
        "additional_skills": input.additional_skills,
        "mcp_servers": input.mcp_servers,
    });
    metadata["execution_device_id"] = json!(input.execution_device_id);
    metadata["local_project_id"] = json!(input.local_project_id);
    connection.execute(
        "INSERT INTO loop_items (
            id, resource_type, project_space, cloud_project_id, name, title,
            description, status, metadata, version, created_at, updated_at,
            created_by_user_id
         ) VALUES (?1, 'chat_agent', 'default', ?2, ?3, ?3, '', 'active', ?4, 1,
                   ?5, ?5, ?6)",
        params![
            id,
            project_id,
            input.name,
            metadata.to_string(),
            timestamp,
            input.created_by_user_id,
        ],
    )?;
    Ok(id)
}

pub(super) fn get_effective_binding(
    connection: &Connection,
    device_id: &str,
    task_id: &str,
) -> Result<Option<TaskBinding>, TaskRuntimeError> {
    connection
        .query_row(
            &format!(
                "SELECT {TASK_BINDING_COLUMNS}
             FROM loop_items
             WHERE resource_type = 'execution' AND device_id = ?1 AND task_id = ?2
               AND unlinked_at IS NULL
             ORDER BY
                 CASE
                     WHEN COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                          = 'default-work-items'
                     THEN 1
                     ELSE 0
                 END,
                 linked_at DESC
             LIMIT 1",
            ),
            params![device_id, task_id],
            map_task_binding,
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

pub(super) fn get_binding_by_kind(
    connection: &Connection,
    device_id: &str,
    task_id: &str,
    system: bool,
) -> Result<Option<TaskBinding>, TaskRuntimeError> {
    connection
        .query_row(
            &format!(
                "SELECT {TASK_BINDING_COLUMNS}
             FROM loop_items
             WHERE resource_type = 'execution' AND device_id = ?1 AND task_id = ?2
               AND unlinked_at IS NULL
               AND (
                   COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                       = 'default-work-items'
               ) = ?3
             ORDER BY linked_at DESC
             LIMIT 1",
            ),
            params![device_id, task_id, system],
            map_task_binding,
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

pub(super) fn validate_local_workflow_task_binding(
    connection: &Connection,
    item_id: &str,
    workflow_node_id: &str,
    device_id: &str,
    task_id: &str,
) -> Result<(), TaskRuntimeError> {
    let item = get_item_from(connection, item_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let nodes = item
        .metadata
        .get("workflow")
        .and_then(|workflow| workflow.get("nodes"))
        .and_then(Value::as_array)
        .ok_or_else(|| TaskRuntimeError::Invalid("task has no workflow".to_owned()))?;
    let node = nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(workflow_node_id))
        .ok_or_else(|| TaskRuntimeError::Invalid("workflow node not found".to_owned()))?;
    if node.get("kind").and_then(Value::as_str) != Some("my_task") {
        return Err(TaskRuntimeError::Invalid(
            "workflow node does not accept a runtime task".to_owned(),
        ));
    }

    let current_binding = get_binding_by_kind(connection, device_id, task_id, false)?;
    let is_idempotent = current_binding.as_ref().is_some_and(|binding| {
        binding.loop_item_id.as_deref() == Some(item_id)
            && binding.workflow_node_id.as_deref() == Some(workflow_node_id)
    });
    let status = node
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_idempotent
        && !matches!(
            status,
            "ready" | "queued" | "running" | "awaiting_approval" | "changes_requested" | "failed"
        )
    {
        return Err(TaskRuntimeError::Invalid(
            "workflow node is not ready".to_owned(),
        ));
    }

    Ok(())
}

pub(super) fn map_task_binding(row: &Row<'_>) -> rusqlite::Result<TaskBinding> {
    Ok(TaskBinding {
        stand_in_pending: row.get(18)?,
        id: row.get(0)?,
        cloud_project_id: row.get(1)?,
        loop_item_id: row.get(2)?,
        task_user_id: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
        device_id: row.get(4)?,
        task_id: row.get(5)?,
        task_title: row.get(6)?,
        backend_task_id: row.get(7)?,
        workflow_node_id: row.get(8)?,
        workflow_stage_input: row
            .get::<_, Option<String>>(9)?
            .and_then(|value| serde_json::from_str(&value).ok()),
        binding_type: row.get(10)?,
        linked_at: row.get(11)?,
        model_selection: row
            .get::<_, Option<String>>(12)?
            .and_then(|value| serde_json::from_str(&value).ok()),
        execution_context: row
            .get::<_, Option<String>>(13)?
            .and_then(|value| serde_json::from_str(&value).ok()),
        human_assignment_id: row.get(14)?,
        dispatch_id: row.get(15)?,
        dispatch_round_id: row.get(16)?,
        assignment_id: row.get(17)?,
    })
}

pub(super) fn local_workflow_stage_snapshot(
    connection: &Connection,
    item_id: &str,
    workflow_node_id: &str,
) -> Result<Value, TaskRuntimeError> {
    let item = get_item_from(connection, item_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let nodes = item
        .metadata
        .get("workflow")
        .and_then(|workflow| workflow.get("nodes"))
        .and_then(Value::as_array)
        .ok_or_else(|| TaskRuntimeError::Invalid("task has no workflow".to_owned()))?;
    let target = nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(workflow_node_id))
        .ok_or_else(|| TaskRuntimeError::Invalid("workflow node not found".to_owned()))?;
    let dependencies = target
        .get("depends_on")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|dependency_id| {
            nodes
                .iter()
                .find(|node| node.get("id").and_then(Value::as_str) == Some(dependency_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({
        "version": 1,
        "issue": {
            "id": item.id,
            "title": item.title,
            "description": item.description,
            "status": item.status,
        },
        "target_stage": target,
        "dependencies": dependencies,
    }))
}
