use super::*;

impl LocalTaskStore {
    pub fn list_tasks(&self, project_id: &str) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let project = self.get_project(project_id)?;
        let provider = task_provider(&project)?;
        if provider != TaskProviderKind::Local {
            return Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            )));
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id, assignee_user_id
             FROM loop_items
             WHERE resource_type = 'task' AND cloud_project_id = ?1
               AND deleted_at IS NULL
             ORDER BY sort_order, updated_at DESC, id",
        )?;
        let rows = statement.query_map([project_id], projections::map_loop_item_fields)?;
        let mut items = collect_items(rows)?;
        drop(statement);
        crate::task_runtime::runner_history::enrich_project_tasks(
            &connection,
            project_id,
            &mut items,
        )?;
        let executions = latest_executions_for_project(&connection, project_id)?;
        Ok(items
            .into_iter()
            .map(|item| {
                let projection = executions.get(&item.id).cloned();
                attach_execution(item, projection)
            })
            .collect())
    }

    pub fn get_task(&self, project_id: &str, task_id: &str) -> Result<LoopItem, TaskRuntimeError> {
        let item = self.get_item(task_id, "task")?;
        if item.cloud_project_id.as_deref() != Some(project_id) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        let connection = self.connection()?;
        Ok(attach_execution(
            item,
            latest_execution(&connection, task_id)?,
        ))
    }

    pub fn mark_task_read(
        &self,
        project_id: &str,
        task_id: &str,
        activity_sequence: Option<i64>,
        content_revision: Option<i64>,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let connection = self.connection()?;
        let item = get_item_from(&connection, task_id, "task")?
            .filter(|item| item.cloud_project_id.as_deref() == Some(project_id))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if project_id == DEFAULT_WORK_ITEM_PROJECT_ID {
            drop(connection);
            return self.get_task(project_id, task_id);
        }
        if item.metadata["is_unread"] == json!(true) || activity_sequence.is_some() {
            connection.execute(
                "UPDATE loop_items
                 SET metadata = json_set(
                    metadata,
                    '$.is_unread',
                    json(CASE WHEN ?3 IS NULL OR version <= ?3 THEN 'false'
                         WHEN json_extract(metadata, '$.is_unread') THEN 'true'
                         ELSE 'false' END),
                    '$.activity_read_sequence',
                    MAX(
                        COALESCE(json_extract(metadata, '$.activity_read_sequence'), 0),
                        ?2
                    )
                 )
                 WHERE id = ?1",
                params![task_id, activity_sequence.unwrap_or(0), content_revision],
            )?;
        }
        drop(connection);
        self.get_task(project_id, task_id)
    }

    pub fn create_task(
        &self,
        project_id: &str,
        input: TaskCreate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.create_task_with_schedule(project_id, input, None, None, false)
    }

    pub fn create_task_with_schedule(
        &self,
        project_id: &str,
        input: TaskCreate,
        start_at: Option<String>,
        due_at: Option<String>,
        personal_task: bool,
    ) -> Result<LoopItem, TaskRuntimeError> {
        validate_name(&input.title, "task title")?;
        validate_priority(&input.priority)?;
        crate::task_runtime::tagging::validate_tags(&input.tags)?;
        validate_schedule_range(start_at.as_deref(), due_at.as_deref())?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        project_status::validate(&project.metadata, &input.status)?;
        if task_provider(&project)? != TaskProviderKind::Local {
            return Err(TaskRuntimeError::UnsupportedProvider("external".to_owned()));
        }
        let assignee_count = usize::from(input.assignee_user_id.is_some())
            + usize::from(input.assignee_agent_id.is_some())
            + usize::from(input.assignee_group_id.is_some());
        if assignee_count > 1 {
            return Err(TaskRuntimeError::Invalid(
                "Issue can only be assigned to one target".to_owned(),
            ));
        }
        let assigned_agent = input
            .assignee_agent_id
            .as_deref()
            .map(|agent_id| collaboration_agent(&transaction, project_id, agent_id))
            .transpose()?;
        let assigned_group = input
            .assignee_group_id
            .as_deref()
            .map(|group_id| collaboration_group(&project, group_id))
            .transpose()?;
        if let Some(parent_id) = input.parent_id.as_deref() {
            require_parent(&transaction, project_id, parent_id, None)?;
        }
        let sequence = project.next_item_number.unwrap_or(1);
        let project_key = project
            .project_key
            .as_deref()
            .ok_or_else(|| TaskRuntimeError::Invalid("project key is missing".to_owned()))?;
        let id = format!("{project_key}-{sequence}");
        let now = now();
        let parent_id = input.parent_id.clone();
        let status = if assigned_agent.is_some() || assigned_group.is_some() {
            project_status::robot_assignment_status(&project.metadata, &input.status).to_owned()
        } else {
            input.status
        };
        let completed_at = (status == "completed").then(|| now.clone());
        milestones::require_milestone(&transaction, project_id, input.milestone_id.as_deref())?;
        let mut metadata = json!({"tags": input.tags});
        if let Some(milestone_id) = input.milestone_id {
            metadata["milestone_id"] = json!(milestone_id);
        }
        issue_badges::update_source(
            &mut metadata,
            "issue",
            &format!("{}\n{}", input.title, input.description),
        );
        if let Some(start_at) = start_at {
            metadata["start_at"] = json!(start_at);
        }
        if let Some(due_at) = due_at {
            metadata["due_at"] = json!(due_at);
        }
        if let Some(workflow) = input.workflow {
            metadata["workflow"] = workflow;
        }
        if let Some(group) = assigned_group.as_ref() {
            metadata["collaboration_group"] = group.clone();
        }
        if let Some(group) = assigned_group.as_ref() {
            record_assignment_change(
                &mut metadata,
                project.created_by_user_id,
                Some("group"),
                input.assignee_group_id.as_deref(),
                group.get("name").and_then(Value::as_str),
            );
        } else if let Some(agent) = assigned_agent.as_ref() {
            record_assignment_change(
                &mut metadata,
                project.created_by_user_id,
                Some("agent"),
                Some(&agent.id),
                agent.title.as_deref().or(agent.name.as_deref()),
            );
        } else if let Some(user_id) = input.assignee_user_id {
            let user_id = user_id.to_string();
            record_assignment_change(
                &mut metadata,
                project.created_by_user_id,
                Some("user"),
                Some(&user_id),
                None,
            );
        }
        if personal_task {
            if input.assignee_user_id != Some(project.created_by_user_id) {
                return Err(TaskRuntimeError::Invalid(
                    "Personal work must belong to its creator".into(),
                ));
            }
            metadata["personal_task_assignment_at"] = metadata["assignment_history"]
                .as_array()
                .and_then(|rows| rows.last())
                .map(|row| row["at"].clone())
                .unwrap_or(Value::Null);
        }
        // Allocating an Issue number does not change editable project configuration.
        transaction.execute(
            "UPDATE loop_items SET next_item_number = ?1,
                    updated_at = ?2 WHERE id = ?3",
            params![sequence + 1, now, project_id],
        )?;
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, parent_id,
                title, description, sequence_number, status, priority, sort_order,
                metadata, version, created_at, updated_at, completed_at,
                assignee_agent_id, assignee_user_id
             ) VALUES (?1, 'task', 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                       0, ?9, 1, ?10, ?10, ?11, ?12, ?13)",
            params![
                id,
                project_id,
                input.parent_id,
                input.title,
                input.description,
                sequence,
                status,
                input.priority,
                metadata.to_string(),
                now,
                completed_at,
                assigned_agent.as_ref().map(|agent| agent.id.as_str()),
                input.assignee_user_id,
            ],
        )?;
        assignment_receipts::sync_assignment_receipt(&transaction, project_id, &id, &metadata)?;
        if let Some(group) = assigned_group.as_ref() {
            dispatch_collaboration_group_assignment(
                &transaction,
                CollaborationGroupExecutionInput {
                    item_id: &id,
                    project_id,
                    group,
                    issue_title: &input.title,
                    issue_description: &input.description,
                    issue_status: Some(&status),
                    prompt: None,
                    priority: &input.priority,
                    payload: Value::Null,
                },
            )?;
        } else if let Some(agent) = assigned_agent.as_ref() {
            create_local_execution(
                &transaction,
                &id,
                project_id,
                &agent.id,
                agent,
                &input.priority,
                Value::Null,
            )?;
        }
        if let Some(parent_id) = parent_id.as_deref() {
            refresh_runtime_projection_additional_context(&transaction, parent_id)?;
        }
        local_automation::on_event(
            &transaction,
            project_id,
            &id,
            local_automation::AutomationEvent::Created,
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_item(&id, "task")
    }

    pub fn update_task(
        &self,
        project_id: &str,
        task_id: &str,
        input: TaskUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.update_task_with_schedule(project_id, task_id, input, None, None)
    }

    pub fn update_task_with_schedule(
        &self,
        project_id: &str,
        task_id: &str,
        input: TaskUpdate,
        start_at: Option<Option<String>>,
        due_at: Option<Option<String>>,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            get_item_from(&transaction, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        if current.cloud_project_id.as_deref() != Some(project_id) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if current.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if let Some(title) = input.title.as_deref() {
            validate_name(title, "task title")?;
        }
        if let Some(status) = input.status.as_deref() {
            let project = get_item_from(&transaction, project_id, "project")?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
            project_status::validate(&project.metadata, status)?;
        }
        if let Some(priority) = input.priority.as_deref() {
            validate_priority(priority)?;
        }
        if let Some(tags) = input.tags.as_ref() {
            crate::task_runtime::tagging::validate_tags(tags)?;
        }
        let selected_agent = input
            .assignee_agent_id
            .as_ref()
            .and_then(|agent_id| agent_id.as_deref())
            .map(|agent_id| collaboration_agent(&transaction, project_id, agent_id))
            .transpose()?;
        if let Some(Some(parent_id)) = input.parent_id.as_ref() {
            require_parent(&transaction, project_id, parent_id, Some(task_id))?;
        }
        let added_tags = input
            .tags
            .as_ref()
            .map(|tags| {
                tags.iter()
                    .filter(|tag| {
                        !current.metadata["tags"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|existing| existing.as_str() == Some(tag.as_str()))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let previous_parent_id = current.parent_id.clone();
        let content_updated = input.title.is_some() || input.description.is_some();
        let title = input.title.or(current.title);
        let description = input.description.unwrap_or(current.description);
        let mut status = input.status.or_else(|| current.status.clone());
        let priority = input.priority.clone().or_else(|| current.priority.clone());
        let parent_id = input.parent_id.unwrap_or(current.parent_id);
        let previous_group_id = current.metadata["collaboration_group"]["id"]
            .as_str()
            .map(ToOwned::to_owned);
        let requested_group_id = input.assignee_group_id.as_ref().cloned().flatten();
        let collaboration_group_changed = input.assignee_group_id.is_some()
            && previous_group_id.as_deref() != requested_group_id.as_deref();
        let selected_collaboration_group =
            if let Some(Some(group_id)) = input.assignee_group_id.as_ref() {
                let project = get_item_from(&transaction, project_id, "project")?
                    .ok_or(TaskRuntimeError::ProjectNotFound)?;
                Some(collaboration_group(&project, group_id)?)
            } else {
                None
            };
        let mut metadata = current.metadata;
        if let Some(milestone_id) = input.milestone_id {
            milestones::require_milestone(&transaction, project_id, milestone_id.as_deref())?;
            if let Some(milestone_id) = milestone_id {
                metadata["milestone_id"] = json!(milestone_id);
            } else if let Some(metadata) = metadata.as_object_mut() {
                metadata.remove("milestone_id");
            }
        }
        if content_updated {
            issue_badges::update_source(
                &mut metadata,
                "issue",
                &format!("{}\n{}", title.as_deref().unwrap_or_default(), description),
            );
        }
        if let Some(group_id) = &input.assignee_group_id {
            metadata["collaboration_group"] = if group_id.is_some() {
                selected_collaboration_group
                    .clone()
                    .expect("selected collaboration group was validated")
            } else {
                Value::Null
            };
        } else if input.assignee_user_id.flatten().is_some()
            || input
                .assignee_agent_id
                .as_ref()
                .and_then(|id| id.as_ref())
                .is_some()
        {
            metadata["collaboration_group"] = Value::Null;
        }
        if let Some(tags) = input.tags {
            metadata["tags"] = json!(tags);
        }
        if let Some(workflow) = input.workflow {
            metadata["workflow"] = workflow.unwrap_or(Value::Null);
        }
        if let Some(start_at) = start_at {
            metadata["start_at"] = start_at.map_or(Value::Null, Value::String);
        }
        if let Some(due_at) = due_at {
            metadata["due_at"] = due_at.map_or(Value::Null, Value::String);
        }
        validate_schedule_range(metadata["start_at"].as_str(), metadata["due_at"].as_str())?;
        if collaboration_group_changed {
            if let (Some(group_id), Some(group)) = (
                requested_group_id.as_deref(),
                selected_collaboration_group.as_ref(),
            ) {
                record_assignment_change(
                    &mut metadata,
                    current.created_by_user_id,
                    Some("group"),
                    Some(group_id),
                    group.get("name").and_then(Value::as_str),
                );
            } else {
                record_assignment_change(
                    &mut metadata,
                    current.created_by_user_id,
                    None,
                    None,
                    None,
                );
            }
        } else if let Some(agent_id) = input.assignee_agent_id.as_ref() {
            if agent_id.is_some() {
                let agent = selected_agent
                    .as_ref()
                    .expect("selected agent was validated");
                record_assignment_change(
                    &mut metadata,
                    current.created_by_user_id,
                    Some("agent"),
                    Some(&agent.id),
                    agent.title.as_deref().or(agent.name.as_deref()),
                );
            } else {
                record_assignment_change(
                    &mut metadata,
                    current.created_by_user_id,
                    None,
                    None,
                    None,
                );
            }
        } else if let Some(user_id) = input.assignee_user_id {
            if let Some(user_id) = user_id {
                let user_id = user_id.to_string();
                record_assignment_change(
                    &mut metadata,
                    current.created_by_user_id,
                    Some("user"),
                    Some(&user_id),
                    None,
                );
            } else {
                record_assignment_change(
                    &mut metadata,
                    current.created_by_user_id,
                    None,
                    None,
                    None,
                );
            }
        }
        let assignee_agent_id = match input.assignee_agent_id.as_ref() {
            Some(Some(_)) => selected_agent.as_ref().map(|agent| agent.id.as_str()),
            Some(None) => None,
            None if input.assignee_user_id.flatten().is_some()
                || input
                    .assignee_group_id
                    .as_ref()
                    .and_then(|id| id.as_ref())
                    .is_some() =>
            {
                None
            }
            None => current.assignee_agent_id.as_deref(),
        };
        let assignee_user_id = if assignee_agent_id.is_some()
            || input
                .assignee_group_id
                .as_ref()
                .and_then(|id| id.as_ref())
                .is_some()
        {
            None
        } else {
            input.assignee_user_id.unwrap_or(current.assignee_user_id)
        };
        let assignee_changed = assignee_agent_id != current.assignee_agent_id.as_deref();
        if assignee_changed
            || collaboration_group_changed
            || assignee_user_id != current.assignee_user_id
        {
            metadata
                .as_object_mut()
                .unwrap()
                .remove("collaboration_group_assignment_key");
        }
        let starts_runtime_dispatch = (collaboration_group_changed
            && selected_collaboration_group.is_some())
            || (assignee_changed && assignee_agent_id.is_some());
        if starts_runtime_dispatch {
            let project = get_item_from(&transaction, project_id, "project")?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
            status = status.map(|status| {
                project_status::robot_assignment_status(&project.metadata, &status).to_owned()
            });
        }
        let status_changed = current.status.as_ref() != status.as_ref();
        let now = now();
        let completed_at = if status.as_deref() == Some("completed") {
            current.completed_at.or_else(|| Some(now.clone()))
        } else {
            None
        };
        let changed = transaction.execute(
            "UPDATE loop_items
             SET title = ?1, description = ?2, status = ?3, priority = ?4,
                 parent_id = ?5, metadata = ?6, completed_at = ?7,
                 assignee_agent_id = ?8, version = version + 1, updated_at = ?9,
                 assignee_user_id = ?12
             WHERE id = ?10 AND version = ?11",
            params![
                title,
                description,
                status,
                priority,
                parent_id,
                metadata.to_string(),
                completed_at,
                assignee_agent_id,
                now,
                task_id,
                input.version,
                assignee_user_id,
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        assignment_receipts::sync_assignment_receipt(&transaction, project_id, task_id, &metadata)?;
        if let Some(position) = input.position.as_ref() {
            ordering::move_task(
                &transaction,
                project_id,
                task_id,
                parent_id.as_deref(),
                position,
            )?;
        }
        refresh_runtime_projection_additional_context(&transaction, task_id)?;
        if previous_parent_id != parent_id {
            if let Some(previous_parent_id) = previous_parent_id.as_deref() {
                refresh_runtime_projection_additional_context(&transaction, previous_parent_id)?;
            }
            if let Some(parent_id) = parent_id.as_deref() {
                refresh_runtime_projection_additional_context(&transaction, parent_id)?;
            }
        }
        if assignee_changed || collaboration_group_changed {
            cancel_active_executions(
                &transaction,
                task_id,
                "Assignee changed before the run finished",
                "Stop the active Runtime task before changing its robot assignee",
            )?;
            if let Some(group) = selected_collaboration_group.as_ref() {
                dispatch_collaboration_group_assignment(
                    &transaction,
                    CollaborationGroupExecutionInput {
                        item_id: task_id,
                        project_id,
                        group,
                        issue_title: title.as_deref().unwrap_or(task_id),
                        issue_description: &description,
                        issue_status: status.as_deref(),
                        prompt: None,
                        priority: priority.as_deref().unwrap_or("none"),
                        payload: input.execution_payload.unwrap_or(Value::Null),
                    },
                )?;
            } else if requested_group_id.is_none() {
                if let Some(agent) = selected_agent.as_ref() {
                    create_local_execution(
                        &transaction,
                        task_id,
                        project_id,
                        &agent.id,
                        agent,
                        current.priority.as_deref().unwrap_or("none"),
                        input.execution_payload.unwrap_or(Value::Null),
                    )?;
                }
            }
        }
        if status_changed {
            local_automation::on_status_changed(
                &transaction,
                task_id,
                current.status.as_deref(),
                None,
            )?;
        }
        if !added_tags.is_empty() {
            local_automation::on_event(
                &transaction,
                project_id,
                task_id,
                local_automation::AutomationEvent::TagsAdded(&added_tags),
            )?;
        }
        transaction.commit()?;
        drop(connection);
        let item = self.get_item(task_id, "task")?;
        let connection = self.connection()?;
        Ok(attach_execution(
            item,
            latest_execution(&connection, task_id)?,
        ))
    }

    // ------------------------------------------------------------------
    // Local robot (chat_agent) CRUD
    // ------------------------------------------------------------------
}
