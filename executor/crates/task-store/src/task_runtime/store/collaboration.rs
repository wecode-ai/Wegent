use super::*;

pub(super) fn dispatch_collaboration_group_assignment(
    connection: &Connection,
    input: CollaborationGroupExecutionInput<'_>,
) -> Result<Option<i64>, TaskRuntimeError> {
    let project = get_item_from(connection, input.project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    let leader = input.group.get("leader").ok_or_else(|| {
        TaskRuntimeError::Invalid("Collaboration team leader is missing".to_owned())
    })?;
    let leader_kind = leader.get("kind").and_then(Value::as_str).ok_or_else(|| {
        TaskRuntimeError::Invalid("Collaboration team leader kind is missing".to_owned())
    })?;
    let leader_id = leader
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            TaskRuntimeError::Invalid("Collaboration team leader is missing".to_owned())
        })?;
    if leader_kind == "human" {
        return Ok(None);
    }
    if leader_kind != "agent" {
        return Err(TaskRuntimeError::Invalid(
            "Collaboration team leader kind is invalid".to_owned(),
        ));
    }
    let leader_agent = collaboration_agent(connection, input.project_id, leader_id)?;
    let mut execution_payload = input.payload.as_object().cloned().unwrap_or_default();
    runner_dispatch::add_group_profiles(
        connection,
        input.project_id,
        input.group,
        &mut execution_payload,
    )?;
    let manager_context = collaboration_manager_message(
        input.group,
        project
            .metadata
            .get("workflow_definition")
            .unwrap_or(&Value::Null),
        input.issue_title,
        input.issue_description,
        input.issue_status,
        input.prompt,
    );
    execution_payload.insert("message".to_owned(), Value::String(manager_context.clone()));
    execution_payload.insert(
        "collaboration_manager_context".to_owned(),
        Value::String(manager_context),
    );
    execution_payload.insert(
        "projectInstructions".to_owned(),
        json!([
            leader_agent.metadata["system_prompt"]
                .as_str()
                .unwrap_or_default(),
            COLLABORATION_MANAGER_SYSTEM_INSTRUCTIONS,
        ]
        .into_iter()
        .filter(|instruction| !instruction.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")),
    );
    execution_payload.insert("dispatch_id".to_owned(), json!(input.item_id));
    execution_payload.insert("dispatch_role".to_owned(), json!("manager"));
    execution_payload.insert("collaboration_group".to_owned(), input.group.clone());
    if let Some(workspace_roots) = project
        .metadata
        .get("workspace_roots")
        .filter(|roots| roots.is_array())
    {
        execution_payload.insert(
            "project_workspace_roots".to_owned(),
            workspace_roots.clone(),
        );
    }
    create_local_execution(
        connection,
        input.item_id,
        input.project_id,
        &leader_agent.id,
        &leader_agent,
        input.priority,
        Value::Object(execution_payload),
    )
    .map(Some)
}

pub(super) fn collaboration_group(
    project: &LoopItem,
    group_id: &str,
) -> Result<Value, TaskRuntimeError> {
    project
        .metadata
        .get("collaboration_groups")
        .and_then(Value::as_array)
        .and_then(|groups| {
            groups
                .iter()
                .find(|group| group.get("id").and_then(Value::as_str) == Some(group_id))
        })
        .cloned()
        .ok_or_else(|| TaskRuntimeError::Invalid("Team is not in this project".to_owned()))
}

pub(super) fn record_assignment_change(
    metadata: &mut Value,
    by_user_id: i64,
    to_type: Option<&str>,
    to_id: Option<&str>,
    to_name: Option<&str>,
) {
    let history = metadata
        .as_object_mut()
        .expect("task metadata must be an object")
        .entry("assignment_history")
        .or_insert_with(|| json!([]));
    if !history.is_array() {
        *history = json!([]);
    }
    let entries = history
        .as_array_mut()
        .expect("assignment history must be an array");
    entries.push(json!({
        "by_user_id": by_user_id,
        "receipt_tracking": true,
        "to_type": to_type,
        "to_id": to_id,
        "to_name": to_name,
        "action": if to_id.is_none() {
            "unassign"
        } else if entries.is_empty() {
            "assign"
        } else {
            "reassign"
        },
        "at": now(),
    }));
}

pub(super) fn collaboration_agent(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
) -> Result<LoopItem, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                public_id, project_key, name, title, description, sequence_number,
                next_item_number, status, priority, sort_order, current_delivery_id,
                metadata, version, created_at, updated_at, completed_at,
                assignee_agent_id, created_by_user_id, assignee_user_id
         FROM loop_items
         WHERE resource_type = 'chat_agent'
           AND deleted_at IS NULL
           AND (cloud_project_id = ?1 OR cloud_project_id = ?2)
           AND (
               id = ?3
               OR CAST(json_extract(metadata, '$.wegent_team_id') AS TEXT) = ?3
           )
         ORDER BY CASE WHEN id = ?3 THEN 0 ELSE 1 END
         LIMIT 1",
    )?;
    let agent = statement
        .query_row(
            params![project_id, DEFAULT_WORK_ITEM_PROJECT_ID, agent_id],
            |row| map_loop_item(connection, row),
        )
        .optional()?
        .ok_or_else(|| {
            TaskRuntimeError::Invalid("Collaboration team robot is not active".to_owned())
        })?;
    let agent_project_id = agent.cloud_project_id.as_deref();
    if !matches!(
        agent_project_id,
        Some(candidate) if candidate == project_id || candidate == DEFAULT_WORK_ITEM_PROJECT_ID
    ) || agent.status.as_deref() == Some("archived")
    {
        return Err(TaskRuntimeError::Invalid(
            "Collaboration team robot is not active in this project".to_owned(),
        ));
    }
    Ok(agent)
}

pub(super) fn collaboration_manager_message(
    group: &Value,
    project_workflow: &Value,
    issue_title: &str,
    issue_description: &str,
    issue_status: Option<&str>,
    prompt: Option<&str>,
) -> String {
    let group_name = group
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("协作小组");
    let collaboration_context = json!({
        "group": {
            "id": group.get("id").cloned().unwrap_or(Value::Null),
            "name": group.get("name").cloned().unwrap_or(Value::Null),
            "description": group.get("description").cloned().unwrap_or(Value::Null),
            "coordination_mode": group
                .get("coordination_mode")
                .cloned()
                .unwrap_or_else(|| json!("manager")),
        },
        "group_instructions": group
            .get("instructions")
            .cloned()
            .unwrap_or(Value::Null),
        "leader": group.get("leader").cloned().unwrap_or(Value::Null),
        "members": group
            .get("members")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "group_stages": group
            .get("stages")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "project_workflow": project_workflow,
    });
    let context = format!(
        "Issue 标题：{issue_title}\nIssue 状态：{}\nIssue 描述：{}\n\n“{group_name}”的项目协作规则、成员与流程：{}",
        issue_status.unwrap_or("inbox"),
        if issue_description.trim().is_empty() {
            "无"
        } else {
            issue_description
        },
        serde_json::to_string_pretty(&collaboration_context)
            .unwrap_or_else(|_| "{}".to_owned()),
    );
    match prompt.filter(|prompt| !prompt.trim().is_empty()) {
        Some(prompt) => format!("{prompt}\n\n{context}"),
        None => context,
    }
}
