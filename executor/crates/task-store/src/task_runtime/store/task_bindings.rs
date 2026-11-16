use super::*;

impl LocalTaskStore {
    pub fn bind_task(
        &self,
        project_id: &str,
        item_id: Option<&str>,
        external_item_id: Option<&str>,
        input: RuntimeTaskAddress,
        dispatch: Option<&Value>,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        validate_name(&input.device_id, "device id")?;
        validate_name(&input.task_id, "task id")?;
        self.get_project(project_id)?;
        if let Some(item_id) = item_id {
            self.get_task(project_id, item_id)?;
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let system_binding = project_id == DEFAULT_WORK_ITEM_PROJECT_ID;
        let active = get_binding_by_kind(
            &transaction,
            &input.device_id,
            &input.task_id,
            system_binding,
        )?;
        if let (Some(item_id), Some(workflow_node_id)) =
            (item_id, input.workflow_node_id.as_deref())
        {
            validate_local_workflow_task_binding(
                &transaction,
                item_id,
                workflow_node_id,
                &input.device_id,
                &input.task_id,
            )?;
        }
        let workflow_stage_input = match (item_id, input.workflow_node_id.as_deref()) {
            (Some(item_id), Some(workflow_node_id)) => Some(local_workflow_stage_snapshot(
                &transaction,
                item_id,
                workflow_node_id,
            )?),
            _ => None,
        };
        let local_project_id = transaction
            .query_row(
                "SELECT id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'project' AND deleted_at IS NULL",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let mut metadata = json!({
            "external_item_id": external_item_id,
            "project_id": project_id,
            "workflow_node_id": input.workflow_node_id,
            "workflow_stage_input": workflow_stage_input,
        });
        // A member's own task carries the collaboration dispatch it was started
        // from so a delivery can settle the exact round assignment. Absent
        // fields are omitted: the rebind below merges with a JSON patch where
        // null values would delete the stored identity.
        if let Some(dispatch) = dispatch {
            if let Some(pending) = dispatch
                .get("standInPending")
                .or_else(|| dispatch.get("stand_in_pending"))
                .and_then(Value::as_bool)
            {
                metadata["stand_in_pending"] = json!(pending);
            }
            for (metadata_key, value) in [
                (
                    "human_assignment_id",
                    dispatch
                        .get("humanAssignmentId")
                        .or_else(|| dispatch.get("human_assignment_id")),
                ),
                (
                    "dispatch_id",
                    dispatch
                        .get("dispatchId")
                        .or_else(|| dispatch.get("dispatch_id")),
                ),
                (
                    "dispatch_round_id",
                    dispatch
                        .get("dispatchRoundId")
                        .or_else(|| dispatch.get("dispatch_round_id")),
                ),
                (
                    "assignment_id",
                    dispatch
                        .get("assignmentId")
                        .or_else(|| dispatch.get("assignment_id")),
                ),
            ] {
                if let Some(value) = value
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    metadata[metadata_key] = json!(value);
                }
            }
        }
        if let Some(model_selection) = input.model_selection.as_ref() {
            metadata["model_selection"] = model_selection.clone();
        }
        if let Some(execution_context) = input.execution_context.as_ref() {
            metadata["execution_context"] = execution_context.clone();
        }
        if let Some(active) = active {
            let target_item_id = item_id.or(external_item_id);
            let same_target = active.cloud_project_id == project_id
                && active.loop_item_id.as_deref() == target_item_id
                && active.workflow_node_id == input.workflow_node_id;
            if same_target {
                transaction.execute(
                    "UPDATE loop_items SET task_title = ?1, backend_task_id = ?2,
                            metadata = json_patch(COALESCE(metadata, '{}'), ?3),
                            updated_at = ?4
                     WHERE id = ?5",
                    params![
                        input.task_title,
                        input.backend_task_id,
                        metadata.to_string(),
                        now(),
                        active.id
                    ],
                )?;
                transaction.commit()?;
                drop(connection);
                return self.get_binding(&active.id);
            }
            transaction.execute(
                "UPDATE loop_items SET unlinked_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now(), active.id],
            )?;
        }
        let id = insert_task_binding(
            &transaction,
            local_project_id.as_deref(),
            item_id,
            &input,
            &metadata,
            &now(),
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_binding(&id)
    }

    pub fn ensure_default_work_item_binding(
        &self,
        device_id: &str,
        task_id: &str,
        task_title: &str,
        description: &str,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        validate_name(device_id, "device id")?;
        validate_name(task_id, "task id")?;
        validate_name(task_title, "task title")?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(active) = get_binding_by_kind(&transaction, device_id, task_id, true)? {
            transaction.execute(
                "UPDATE loop_items SET task_title = ?1, updated_at = ?2 WHERE id = ?3",
                params![task_title, now(), active.id],
            )?;
            transaction.commit()?;
            drop(connection);
            return self.get_binding(&active.id);
        }

        let project = get_item_from(&transaction, DEFAULT_WORK_ITEM_PROJECT_ID, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let sequence = project.next_item_number.unwrap_or(1);
        let item_id = format!("{DEFAULT_WORK_ITEM_PROJECT_KEY}-{sequence}");
        let timestamp = now();
        let mut task_metadata = json!({
            "tags": [],
            "has_additional_context": false,
        });
        task_metadata[RUNTIME_PROJECTION_METADATA_KEY] = json!({
            "source_title": task_title,
            "source_description": description,
        });
        transaction.execute(
            "UPDATE loop_items SET next_item_number = ?1,
                    updated_at = ?2 WHERE id = ?3",
            params![sequence + 1, timestamp, DEFAULT_WORK_ITEM_PROJECT_ID],
        )?;
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, title, description,
                sequence_number, status, priority, sort_order, metadata, version,
                created_at, updated_at
             ) VALUES (?1, 'task', 'default', ?2, ?3, ?4, ?5, 'inbox', 'none',
                       0, ?6, 1, ?7, ?7)",
            params![
                item_id,
                DEFAULT_WORK_ITEM_PROJECT_ID,
                task_title,
                description,
                sequence,
                task_metadata.to_string(),
                timestamp,
            ],
        )?;
        let binding_id = numeric_id();
        let metadata = json!({
            "external_item_id": Value::Null,
            "project_id": DEFAULT_WORK_ITEM_PROJECT_ID,
            "workflow_node_id": Value::Null,
            "workflow_stage_input": Value::Null,
        });
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                task_user_id, device_id, task_id, task_title, linked_by_user_id,
                linked_at, metadata, version, created_at, updated_at
             ) VALUES (?1, 'execution', 'default', ?2, ?3, 0, ?4, ?5, ?6, 0,
                       ?7, ?8, 1, ?7, ?7)",
            params![
                binding_id,
                DEFAULT_WORK_ITEM_PROJECT_ID,
                item_id,
                device_id,
                task_id,
                task_title,
                timestamp,
                metadata.to_string(),
            ],
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_binding(&binding_id)
    }

    pub fn project_bound_task_status(
        &self,
        device_id: &str,
        task_id: &str,
        execution_status: &str,
        observed_at_ms: i64,
    ) -> Result<usize, TaskRuntimeError> {
        if observed_at_ms <= 0 {
            return Err(TaskRuntimeError::Invalid(
                "runtime task status observation requires a positive timestamp".to_owned(),
            ));
        }
        let next_status = match execution_status {
            "queued" | "pending" => "pending",
            "running" => "in_progress",
            "done" | "completed" | "succeeded" | "failed" | "cancelled" | "canceled"
            | "interrupted" | "error" => "in_review",
            "archived" => "completed",
            _ => {
                return Err(TaskRuntimeError::Invalid(format!(
                    "unsupported runtime task status '{execution_status}'"
                )));
            }
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = now();
        let preserve_reviewed = matches!(
            execution_status,
            "done"
                | "completed"
                | "succeeded"
                | "failed"
                | "cancelled"
                | "canceled"
                | "interrupted"
                | "error"
        );
        let candidate_tasks = {
            let mut statement = transaction.prepare(
                "SELECT id FROM loop_items
             WHERE resource_type = 'task'
               AND id IN (
                   SELECT loop_item_id
                   FROM loop_items
                   WHERE resource_type = 'execution'
                     AND device_id = ?2 AND task_id = ?3
                     AND unlinked_at IS NULL AND loop_item_id IS NOT NULL
                     AND json_extract(metadata, '$.workflow_node_id') IS NULL
                     AND NOT EXISTS (
                         SELECT 1
                         FROM loop_item_executions dispatch_execution
                         WHERE dispatch_execution.id = CAST(
                             json_extract(loop_items.metadata, '$.execution_id') AS INTEGER
                         )
                     )
                     AND CAST(COALESCE(
                         json_extract(metadata, '$.runtime_status_observed_at_ms'),
                         0
                     ) AS INTEGER) < ?5
               )
               AND status != ?1
               AND (NOT ?4 OR status NOT IN ('completed', 'in_review'))",
            )?;
            let rows = statement.query_map(
                params![
                    next_status,
                    device_id,
                    task_id,
                    preserve_reviewed,
                    observed_at_ms,
                ],
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut changed_tasks = Vec::new();
        for item_id in candidate_tasks {
            let task = get_item_from(&transaction, &item_id, "task")?
                .ok_or(TaskRuntimeError::TaskNotFound)?;
            let project = get_item_from(
                &transaction,
                task.cloud_project_id
                    .as_deref()
                    .ok_or(TaskRuntimeError::ProjectNotFound)?,
                "project",
            )?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
            let status = task.status.as_deref().map(|current| {
                project_status::runtime_transition_status(&project.metadata, current, next_status)
            });
            if status == task.status.as_deref() {
                continue;
            }
            transaction.execute(
                "UPDATE loop_items
                 SET status = ?1,
                     completed_at = CASE WHEN ?1 = 'completed' THEN ?2 ELSE NULL END,
                     metadata = CASE
                         WHEN ?4 AND cloud_project_id != ?5
                             THEN json_set(metadata, '$.is_unread', json('true'))
                         ELSE metadata
                     END,
                     sort_order = 0, version = version + 1, updated_at = ?2
                 WHERE id = ?3",
                params![
                    status,
                    timestamp,
                    item_id,
                    preserve_reviewed,
                    DEFAULT_WORK_ITEM_PROJECT_ID
                ],
            )?;
            changed_tasks.push((item_id, task.status));
        }
        transaction.execute(
            "UPDATE loop_items
             SET metadata = json_set(
                     COALESCE(metadata, '{}'),
                     '$.runtime_status_observed_at_ms',
                     ?1
                 ),
                 version = version + 1,
                 updated_at = ?2
             WHERE resource_type = 'execution'
               AND device_id = ?3 AND task_id = ?4
               AND unlinked_at IS NULL AND loop_item_id IS NOT NULL
               AND json_extract(metadata, '$.workflow_node_id') IS NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM loop_item_executions dispatch_execution
                   WHERE dispatch_execution.id = CAST(
                       json_extract(loop_items.metadata, '$.execution_id') AS INTEGER
                   )
               )
               AND CAST(COALESCE(
                   json_extract(metadata, '$.runtime_status_observed_at_ms'),
                   0
               ) AS INTEGER) < ?1",
            params![observed_at_ms, timestamp, device_id, task_id],
        )?;
        for (item_id, previous) in &changed_tasks {
            local_automation::on_status_changed(&transaction, item_id, previous.as_deref(), None)?;
        }
        transaction.commit()?;
        Ok(changed_tasks.len())
    }

    pub fn list_task_bindings(&self, item_id: &str) -> Result<Vec<TaskBinding>, TaskRuntimeError> {
        self.list_task_bindings_batch(&[item_id.to_owned()])
    }

    pub fn list_task_bindings_batch(
        &self,
        item_ids: &[String],
    ) -> Result<Vec<TaskBinding>, TaskRuntimeError> {
        let connection = self.connection()?;
        Self::list_task_bindings_from(&connection, item_ids)
    }

    pub(super) fn list_task_bindings_from(
        connection: &Connection,
        item_ids: &[String],
    ) -> Result<Vec<TaskBinding>, TaskRuntimeError> {
        let item_ids = item_ids
            .iter()
            .map(|item_id| item_id.trim())
            .filter(|item_id| !item_id.is_empty())
            .collect::<HashSet<_>>();
        if item_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = std::iter::repeat("?")
            .take(item_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection.prepare(&format!(
            "SELECT {TASK_BINDING_COLUMNS}
             FROM loop_items
             WHERE resource_type = 'execution' AND unlinked_at IS NULL
               AND (
                    loop_item_id IN ({placeholders})
                    OR json_extract(metadata, '$.external_item_id') IN ({placeholders})
               )
             ORDER BY linked_at DESC"
        ))?;
        let parameters = item_ids.iter().copied().chain(item_ids.iter().copied());
        let rows = statement.query_map(params_from_iter(parameters), map_task_binding)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TaskRuntimeError::from)
    }

    pub fn find_task_binding(
        &self,
        device_id: &str,
        task_id: &str,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        let connection = self.connection()?;
        get_effective_binding(&connection, device_id, task_id)?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn find_system_task_binding(
        &self,
        device_id: &str,
        task_id: &str,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        let connection = self.connection()?;
        get_binding_by_kind(&connection, device_id, task_id, true)?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn find_user_task_binding(
        &self,
        device_id: &str,
        task_id: &str,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        let connection = self.connection()?;
        get_binding_by_kind(&connection, device_id, task_id, false)?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn unbind_task(
        &self,
        device_id: &str,
        task_id: &str,
        item_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let timestamp = now();
        if let Some(item_id) = item_id {
            connection.execute(
                "UPDATE loop_items SET unlinked_at = ?1, updated_at = ?1
                 WHERE resource_type = 'execution' AND device_id = ?2 AND task_id = ?3
                   AND unlinked_at IS NULL
                   AND (
                       loop_item_id = ?4
                       OR json_extract(metadata, '$.external_item_id') = ?4
                   )
                   AND COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                       != 'default-work-items'",
                params![timestamp, device_id, task_id, item_id],
            )?;
        } else {
            connection.execute(
                "UPDATE loop_items SET unlinked_at = ?1, updated_at = ?1
                 WHERE resource_type = 'execution' AND device_id = ?2 AND task_id = ?3
                   AND unlinked_at IS NULL
                   AND COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                       != 'default-work-items'",
                params![timestamp, device_id, task_id],
            )?;
        }
        Ok(())
    }

    fn get_binding(&self, id: &str) -> Result<TaskBinding, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                &format!(
                    "SELECT {TASK_BINDING_COLUMNS}
                 FROM loop_items WHERE id = ?1 AND resource_type = 'execution'",
                ),
                [id],
                map_task_binding,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }
}
