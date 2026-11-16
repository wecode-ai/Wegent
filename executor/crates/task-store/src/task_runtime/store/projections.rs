use super::*;

pub(super) fn load_runtime_projection_task(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<RuntimeProjectionTask>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT title, description, priority, parent_id, current_delivery_id,
                    assignee_agent_id, metadata
             FROM loop_items
             WHERE id = ?1 AND resource_type = 'task' AND deleted_at IS NULL",
            [task_id],
            |row| {
                let metadata = row.get::<_, String>(6)?;
                Ok(RuntimeProjectionTask {
                    title: row.get(0)?,
                    description: row.get(1)?,
                    priority: row.get(2)?,
                    parent_id: row.get(3)?,
                    current_delivery_id: row.get(4)?,
                    assignee_agent_id: row.get(5)?,
                    metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| json!({})),
                })
            },
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

pub(super) fn projection_has_metadata_context(metadata: &Value) -> bool {
    let tags_present = metadata
        .get("tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| !tags.is_empty());
    let workflow_present = metadata
        .get("workflow")
        .is_some_and(|workflow| !workflow.is_null());
    let due_date_present = metadata
        .get("due_at")
        .and_then(Value::as_str)
        .is_some_and(|due_at| !due_at.trim().is_empty());
    tags_present || workflow_present || due_date_present
}

pub(super) fn projection_has_related_context(
    connection: &Connection,
    task_id: &str,
) -> Result<bool, TaskRuntimeError> {
    let related_content_exists = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM loop_items
            WHERE deleted_at IS NULL AND (
                (resource_type IN ('attachment', 'delivery') AND loop_item_id = ?1)
                OR (resource_type = 'task' AND parent_id = ?1)
            )
         )",
        [task_id],
        |row| row.get::<_, bool>(0),
    )?;
    if related_content_exists {
        return Ok(true);
    }
    connection
        .query_row(
            "SELECT EXISTS(
            SELECT 1 FROM loop_item_comments
            WHERE task_id = ?1 AND sender_type = 'user'
              AND trim(content) != '' AND deleted_at IS NULL
         )",
            [task_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(TaskRuntimeError::from)
}

pub(super) fn projection_has_intrinsic_context(
    task: &RuntimeProjectionTask,
    source_title: &str,
    source_description: &str,
) -> bool {
    task.title.as_deref().unwrap_or_default() != source_title
        || task.description != source_description
        || task
            .priority
            .as_deref()
            .is_some_and(|value| value != "none")
        || task.parent_id.is_some()
        || task.current_delivery_id.is_some()
        || task.assignee_agent_id.is_some()
        || projection_has_metadata_context(&task.metadata)
}

pub(crate) fn refresh_runtime_projection_additional_context(
    connection: &Connection,
    task_id: &str,
) -> Result<(), TaskRuntimeError> {
    let Some(mut task) = load_runtime_projection_task(connection, task_id)? else {
        return Ok(());
    };
    let Some(projection) = task
        .metadata
        .get(RUNTIME_PROJECTION_METADATA_KEY)
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    let source_title = projection
        .get("source_title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source_description = projection
        .get("source_description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let has_additional_context =
        projection_has_intrinsic_context(&task, source_title, source_description)
            || projection_has_related_context(connection, task_id)?;
    if task
        .metadata
        .get("has_additional_context")
        .and_then(Value::as_bool)
        == Some(has_additional_context)
    {
        return Ok(());
    }
    task.metadata["has_additional_context"] = json!(has_additional_context);
    connection.execute(
        "UPDATE loop_items SET metadata = ?1 WHERE id = ?2 AND resource_type = 'task'",
        params![task.metadata.to_string(), task_id],
    )?;
    Ok(())
}

pub(crate) fn get_item_from(
    connection: &Connection,
    id: &str,
    resource_type: &str,
) -> Result<Option<LoopItem>, rusqlite::Error> {
    connection
        .query_row(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id, assignee_user_id
             FROM loop_items
             WHERE id = ?1 AND resource_type = ?2 AND deleted_at IS NULL",
            params![id, resource_type],
            |row| map_loop_item(connection, row),
        )
        .optional()
}

pub(super) fn map_loop_item(connection: &Connection, row: &Row<'_>) -> rusqlite::Result<LoopItem> {
    let mut item = map_loop_item_fields(row)?;
    item.metadata = crate::task_runtime::runner_history::metadata(
        connection,
        &item.id,
        &item.resource_type,
        item.metadata,
    )?;
    Ok(item)
}

pub(super) fn map_loop_item_fields(row: &Row<'_>) -> rusqlite::Result<LoopItem> {
    let metadata = row
        .get::<_, Option<String>>(16)?
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or_else(|| json!({}));
    Ok(LoopItem {
        id: row.get(0)?,
        resource_type: row.get(1)?,
        project_space: row.get(2)?,
        cloud_project_id: row.get(3)?,
        parent_id: row.get(4)?,
        public_id: row.get(5)?,
        project_key: row.get(6)?,
        name: row.get(7)?,
        title: row.get(8)?,
        description: row.get(9)?,
        created_by_user_id: row.get::<_, Option<i64>>(22)?.unwrap_or(0),
        sequence_number: row.get(10)?,
        next_item_number: row.get(11)?,
        status: row.get(12)?,
        priority: row.get(13)?,
        sort_order: row.get(14)?,
        current_delivery_id: row.get(15)?,
        metadata,
        version: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        completed_at: row.get(20)?,
        assignee_agent_id: row.get(21)?,
        assignee_user_id: row.get(23)?,
        execution_id: None,
        execution_state: None,
    })
}

pub(super) fn collect_items(
    rows: rusqlite::MappedRows<'_, impl FnMut(&Row<'_>) -> rusqlite::Result<LoopItem>>,
) -> Result<Vec<LoopItem>, TaskRuntimeError> {
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(TaskRuntimeError::from)
}

#[derive(Clone)]
pub(super) struct ExecutionProjection {
    id: i64,
    state: String,
    agent_name: Option<String>,
    completed_at: Option<String>,
}

fn execution_projection(row: &Row<'_>) -> rusqlite::Result<ExecutionProjection> {
    let metadata: Value = row
        .get::<_, Option<String>>(6)?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(Value::Null);
    Ok(ExecutionProjection {
        id: row.get(0)?,
        state: local_execution_display_state(
            &row.get::<_, String>(1)?,
            &row.get::<_, String>(2)?,
            &row.get::<_, String>(3)?,
        ),
        agent_name: super::record_rows::execution_agent_name(&metadata, row.get(4)?, row.get(5)?),
        completed_at: row.get(7)?,
    })
}

/// Newest execution attempt for one task, projected to the UI vocabulary.
pub(super) fn latest_execution(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<ExecutionProjection>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT e.id, e.status, e.observed_state, e.sync_state, a.name, a.title, a.metadata, e.completed_at
             FROM loop_item_executions e
             LEFT JOIN loop_items a ON a.id=e.agent_id AND a.resource_type='chat_agent' AND a.cloud_project_id=e.cloud_project_id
             WHERE e.loop_item_id = ?1
             ORDER BY e.id DESC
             LIMIT 1",
            params![item_id],
            execution_projection,
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

/// Newest execution attempt for every task in a project.
pub(super) fn latest_executions_for_items(
    connection: &Connection,
    item_ids: &[String],
) -> Result<HashMap<String, ExecutionProjection>, TaskRuntimeError> {
    if item_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(item_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = connection.prepare(&format!(
        "SELECT e.id,e.status,e.observed_state,e.sync_state,a.name,a.title,a.metadata,e.completed_at,e.loop_item_id
         FROM loop_item_executions e
         LEFT JOIN loop_items a ON a.id=e.agent_id AND a.resource_type='chat_agent' AND a.cloud_project_id=e.cloud_project_id
         WHERE e.loop_item_id IN ({placeholders}) ORDER BY e.id DESC"
    ))?;
    let rows = statement.query_map(params_from_iter(item_ids), |row| {
        Ok((row.get::<_, String>(8)?, execution_projection(row)?))
    })?;
    let mut executions = HashMap::new();
    for row in rows {
        let (item_id, projection) = row?;
        executions.entry(item_id).or_insert(projection);
    }
    Ok(executions)
}

pub(super) fn latest_executions_for_project(
    connection: &Connection,
    project_id: &str,
) -> Result<HashMap<String, ExecutionProjection>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT e.id, e.status, e.observed_state, e.sync_state, a.name, a.title, a.metadata, e.completed_at, e.loop_item_id
         FROM loop_item_executions e
         JOIN loop_items t ON t.id = e.loop_item_id
         LEFT JOIN loop_items a ON a.id=e.agent_id AND a.resource_type='chat_agent' AND a.cloud_project_id=e.cloud_project_id
         WHERE t.cloud_project_id = ?1 AND t.resource_type = 'task'
         ORDER BY e.id DESC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(8)?, execution_projection(row)?))
    })?;
    let mut executions = HashMap::new();
    for row in rows {
        let (item_id, pair) = row?;
        executions.entry(item_id).or_insert(pair);
    }
    Ok(executions)
}

pub(super) fn attach_execution(
    mut item: LoopItem,
    execution: Option<ExecutionProjection>,
) -> LoopItem {
    if let Some(metadata) = item.metadata.as_object_mut() {
        metadata.remove("processing_actor");
        metadata.remove("human_waiting_since");
    }
    if let Some(execution) = execution {
        if execution.state == "running" {
            if let Some(name) = execution.agent_name {
                item.metadata["processing_actor"] = json!({"kind":"agent","name":name});
            }
        } else if matches!(
            execution.state.as_str(),
            "succeeded" | "failed" | "cancelled"
        ) {
            if let Some(at) = execution.completed_at.filter(|value| !value.is_empty()) {
                item.metadata["human_waiting_since"] = json!(at);
            }
        }
        item.execution_id = Some(execution.id);
        item.execution_state = Some(execution.state);
    }
    item
}

pub fn task_provider(project: &LoopItem) -> Result<TaskProviderKind, TaskRuntimeError> {
    serde_json::from_value(
        project
            .metadata
            .get("task_provider")
            .cloned()
            .unwrap_or_else(|| json!("local")),
    )
    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
}

#[cfg(test)]
mod execution_actor_tests {
    use super::*;

    #[test]
    fn unassigned_comment_execution_projects_the_real_actor_and_current_handoff() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("actor.sqlite")).unwrap();
        let project = store
            .create_project(
                serde_json::from_value(json!({"name":"Actors","project_key":"ACT"})).unwrap(),
            )
            .unwrap();
        let agent = store.create_chat_agent(&project.id,serde_json::from_value(json!({"name":"Mention bot","display_name":"Actual mention actor","execution_mode":"auto"})).unwrap()).unwrap();
        let task = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Unassigned Issue"})).unwrap(),
            )
            .unwrap();
        assert!(task.assignee_agent_id.is_none());
        let execution = store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"message":"Mentioned work"}),
                None,
            )
            .unwrap();
        store.connection().unwrap().execute("UPDATE loop_items SET metadata=?1 WHERE id=?2",params![json!({"processing_actor":{"kind":"stand_in","name":"stale"},"human_waiting_since":"2000-01-01T00:00:00Z","keep":true}).to_string(),task.id]).unwrap();
        store.connection().unwrap().execute("UPDATE loop_item_executions SET status='running',observed_state='running',sync_state='in_sync' WHERE id=?1",[execution.id]).unwrap();
        let running = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(
            running.metadata["processing_actor"],
            json!({"kind":"agent","name":"Actual mention actor"})
        );
        assert!(running.metadata.get("human_waiting_since").is_none());
        assert_eq!(
            store.list_tasks(&project.id).unwrap()[0].metadata,
            running.metadata
        );
        let completed_at = "2026-11-08T05:00:00Z";
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_item_executions SET status='completed',completed_at=?1 WHERE id=?2",
                params![completed_at, execution.id],
            )
            .unwrap();
        let completed = store.get_task(&project.id, &task.id).unwrap();
        assert!(completed.metadata.get("processing_actor").is_none());
        assert_eq!(completed.metadata["human_waiting_since"], completed_at);
        assert_eq!(completed.metadata["keep"], true);
        let persisted: String = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT metadata FROM loop_items WHERE id=?1",
                [&task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&persisted).unwrap()["processing_actor"]["name"],
            "stale"
        );
        let next = store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"message":"Next turn"}),
                None,
            )
            .unwrap();
        let queued = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(queued.execution_id, Some(next.id));
        assert_eq!(queued.execution_state.as_deref(), Some("queued"));
        assert!(queued.metadata.get("processing_actor").is_none());
        assert!(queued.metadata.get("human_waiting_since").is_none());
        assert_eq!(
            store.list_tasks(&project.id).unwrap()[0].metadata,
            queued.metadata
        );
    }
}
