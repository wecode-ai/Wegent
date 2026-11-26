use super::*;

impl LocalTaskStore {
    pub fn list_chat_agents(&self, project_id: &str) -> Result<Vec<ChatAgent>, TaskRuntimeError> {
        self.list_chat_agents_with_archived(project_id, false)
    }

    pub fn list_chat_agents_with_archived(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<ChatAgent>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, COALESCE((SELECT b.status FROM project_team_bindings b WHERE b.project_id=?1 AND b.team_ref=loop_items.id), status), priority, sort_order, current_delivery_id,
                    metadata, COALESCE((SELECT b.version FROM project_team_bindings b WHERE b.project_id=?1 AND b.team_ref=loop_items.id), version), created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id, assignee_user_id
             FROM loop_items
             WHERE resource_type = 'chat_agent' AND deleted_at IS NULL
               AND (cloud_project_id = ?1 OR id IN (SELECT team_ref FROM project_team_bindings WHERE project_id = ?1))
             ORDER BY created_at ASC",
        )?;
        let rows =
            statement.query_map(params![project_id], |row| map_loop_item(&connection, row))?;
        let agents = collect_items(rows)?;
        Ok(agents
            .into_iter()
            .filter(|agent| include_archived || agent.status.as_deref() != Some("archived"))
            .map(map_chat_agent)
            .map(|mut agent| {
                agent.project_id = project_id.to_owned();
                agent
            })
            .collect())
    }

    pub fn bind_chat_agent(
        &self,
        project_id: &str,
        team_ref: &str,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project =
            get_item_from(&tx, project_id, "project")?.ok_or(TaskRuntimeError::ProjectNotFound)?;
        let owned: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_items WHERE id=?1 AND created_by_user_id=?2)",
            params![team_ref, project.created_by_user_id], |row| row.get(0),
        )?;
        let source = get_item_from(&tx, team_ref, "chat_agent")?
            .filter(|agent| {
                agent.status.as_deref() == Some("active")
                    && agent.cloud_project_id.as_deref() == Some(DEFAULT_WORK_ITEM_PROJECT_ID)
                    && owned
            })
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("Local Team is unavailable for this project".into())
            })?;
        if project_id != DEFAULT_WORK_ITEM_PROJECT_ID {
            tx.execute(
                "INSERT OR IGNORE INTO project_team_bindings(project_id, team_ref) VALUES (?1, ?2)",
                params![project_id, team_ref],
            )?;
        }
        tx.commit()?;
        drop(connection);
        self.get_chat_agent(project_id, &source.id)
    }

    pub fn create_chat_agent(
        &self,
        project_id: &str,
        input: ChatAgentCreate,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        let connection = self.connection()?;
        let id = insert_chat_agent(&connection, project_id, input)?;
        drop(connection);
        self.get_chat_agent(project_id, &id)
    }

    pub fn ensure_default_chat_agent(
        &self,
        project_id: &str,
        input: ChatAgentCreate,
    ) -> Result<Option<ChatAgent>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT id, status FROM loop_items
                 WHERE resource_type = 'chat_agent' AND cloud_project_id = ?1
                   AND name = ?2 AND deleted_at IS NULL
                 ORDER BY CASE WHEN status = 'archived' THEN 1 ELSE 0 END, created_at
                 LIMIT 1",
                params![project_id, &input.name],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((id, status)) = existing {
            if status == "archived" {
                transaction.execute(
                    "UPDATE loop_items
                     SET status = 'active', version = version + 1, updated_at = ?1
                     WHERE id = ?2",
                    params![now(), id],
                )?;
                transaction.commit()?;
                drop(connection);
                return self.get_chat_agent(project_id, &id).map(Some);
            }
            transaction.commit()?;
            return Ok(None);
        }
        let id = insert_chat_agent(&transaction, project_id, input)?;
        transaction.commit()?;
        drop(connection);
        self.get_chat_agent(project_id, &id).map(Some)
    }

    pub fn update_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
        input: ChatAgentUpdate,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = get_item_from(&connection, agent_id, "chat_agent")?
            .ok_or_else(|| TaskRuntimeError::Invalid("Robot not found".to_owned()))?;
        if current.cloud_project_id.as_deref() != Some(project_id) {
            if let Some(status @ ("active" | "archived")) = input.status.as_deref() {
                if has_project_team_binding(&connection, project_id, agent_id)? {
                    if connection.execute("UPDATE project_team_bindings SET status=?1, version=version+1 WHERE project_id=?2 AND team_ref=?3 AND version=?4",
                        params![status, project_id, agent_id, input.version])? != 1 {
                        return Err(TaskRuntimeError::VersionConflict);
                    }
                    drop(connection);
                    return self.get_chat_agent(project_id, agent_id);
                }
            }
            return Err(TaskRuntimeError::Invalid(
                "Robot is not in this project".to_owned(),
            ));
        }
        if current.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let mut metadata = current.metadata;
        if let Some(policy) = input.execution_policy.as_ref() {
            metadata["execution_policy"] = policy.clone();
        }
        if let Some(policy) = input.model_policy.as_ref() {
            metadata["model_policy"] = policy.clone();
        }
        crate::task_runtime::runner_routing::validate_policies(
            metadata.get("execution_policy"),
            metadata.get("model_policy"),
        )?;
        crate::task_runtime::runner_routing::validate_model_runtime(
            metadata.get("model_policy"),
            input
                .runtime
                .as_deref()
                .or_else(|| metadata["runtime"].as_str())
                .unwrap_or("codex"),
        )?;
        if metadata
            .get("execution_policy")
            .is_some_and(|v| !v.is_null())
            && metadata.get("model_policy").is_some_and(|v| !v.is_null())
        {
            metadata
                .as_object_mut()
                .unwrap()
                .remove("routing_configuration_required");
        }
        if let Some(name) = input.name.as_ref() {
            validate_name(name, "robot name")?;
        }
        if let Some(display_name) = input.display_name.as_ref() {
            metadata["display_name"] = json!(display_name);
        }
        if let Some(namespace) = input.namespace.as_ref() {
            metadata["namespace"] = json!(namespace);
        }
        if let Some(runtime) = input.runtime.as_ref() {
            validate_chat_agent_runtime(runtime)?;
            metadata["runtime"] = json!(runtime);
        }
        if let Some(model) = input.model.as_ref() {
            metadata["model"] = json!(model);
        }
        if let Some(model_type) = input.model_type.as_ref() {
            metadata["model_type"] = json!(model_type);
        }
        if let Some(model_namespace) = input.model_namespace.as_ref() {
            metadata["model_namespace"] = json!(model_namespace);
        }
        if let Some(allowed_models) = input.allowed_models.as_ref() {
            metadata["allowed_models"] = json!(allowed_models);
        }
        if let Some(description) = input.capability_description.as_ref() {
            metadata["capability_description"] = json!(description);
        }
        if let Some(capability_mode) = input.capability_mode.as_ref() {
            metadata["capability_mode"] = json!(capability_mode);
        }
        if let Some(prompt) = input.system_prompt.as_ref() {
            metadata["system_prompt"] = json!(prompt);
        }
        if let Some(visibility) = input.visibility.as_ref() {
            metadata["visibility"] = json!(visibility);
        }
        if let Some(environment) = input.execution_environment.as_ref() {
            metadata["execution_environment"] = json!(environment);
        }
        if let Some(mode) = input.execution_mode.as_ref() {
            metadata["execution_mode"] = json!(mode);
        }
        if let Some(device) = input.execution_device_id.as_ref() {
            metadata["execution_device_id"] = json!(device);
        }
        if let Some(max_concurrent_executions) = input.max_concurrent_executions {
            if !(1..=20).contains(&max_concurrent_executions) {
                return Err(TaskRuntimeError::Invalid(
                    "Robot max concurrent executions must be between 1 and 20".to_owned(),
                ));
            }
            metadata["max_concurrent_executions"] = json!(max_concurrent_executions);
        }
        if let Some(workspace_policy) = input.workspace_policy {
            validate_workspace_policy(&workspace_policy)?;
            metadata["workspace_policy"] = json!(workspace_policy);
        }
        if let Some(local_project_id) = input.local_project_id {
            metadata["local_project_id"] = json!(local_project_id);
        }
        if let Some(plugins) = input.plugins {
            metadata["plugins"] = json!(plugins);
        }
        if let Some(additional_skills) = input.additional_skills {
            metadata["additional_skills"] = json!(additional_skills);
        }
        if let Some(mcp_servers) = input.mcp_servers {
            validate_mcp_servers(&mcp_servers)?;
            metadata["mcp_servers"] = mcp_servers;
        }
        let status = input
            .status
            .unwrap_or_else(|| current.status.unwrap_or_else(|| "active".to_owned()));
        let name = input.name.unwrap_or_else(|| {
            current
                .name
                .or(current.title)
                .unwrap_or_else(|| "AI".to_owned())
        });
        binding_rows::save_solo_bot(&mut metadata, agent_id, &name);
        let changed = connection.execute(
            "UPDATE loop_items
             SET name = ?1, title = ?1, status = ?2, metadata = ?3,
                 version = version + 1, updated_at = ?4
             WHERE id = ?5 AND version = ?6",
            params![
                name,
                status,
                metadata.to_string(),
                now(),
                agent_id,
                input.version,
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        drop(connection);
        self.get_chat_agent(project_id, agent_id)
    }

    pub fn archive_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
        version: i64,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        if has_project_team_binding(&connection, project_id, agent_id)? {
            if connection.execute("UPDATE project_team_bindings SET status='archived',version=version+1 WHERE project_id=?1 AND team_ref=?2 AND version=?3",params![project_id, agent_id, version])? != 1 {
                return Err(TaskRuntimeError::VersionConflict);
            }
            return Ok(());
        }
        let changed = connection.execute(
            "UPDATE loop_items
             SET status = 'archived', version = version + 1, updated_at = ?1
             WHERE id = ?2 AND version = ?3 AND cloud_project_id = ?4",
            params![now(), agent_id, version, project_id],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        Ok(())
    }

    pub fn delete_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
        version: i64,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let bound = has_project_team_binding(&transaction, project_id, agent_id)?;
        let agent = get_item_from(&transaction, agent_id, "chat_agent")?
            .filter(|agent| bound || agent.cloud_project_id.as_deref() == Some(project_id))
            .ok_or_else(|| TaskRuntimeError::Invalid("Robot is not in this project".into()))?;
        if !bound
            && transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_team_bindings WHERE team_ref=?1)",
                [agent_id],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Err(TaskRuntimeError::Invalid(
                "PROJECT_AGENT_IN_USE: remove this Team from its projects first".into(),
            ));
        }
        if !bound
            && wegent_protocol::collaboration::is_managed_project_agent(
                agent.name.as_deref().unwrap_or_default(),
            )
        {
            return Err(TaskRuntimeError::Invalid(
                "PROJECT_AGENT_MANAGED: the current-device Agent cannot be deleted".into(),
            ));
        }
        if !bound && agent.version != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if project.metadata["collaboration_groups"]
            .as_array()
            .is_some_and(|groups| {
                groups.iter().any(|group| {
                    wegent_protocol::collaboration::group_references_agent(
                        group,
                        agent_id,
                        agent.metadata["wegent_team_id"].as_i64(),
                    )
                })
            })
        {
            return Err(TaskRuntimeError::Invalid("PROJECT_AGENT_IN_USE: replace or remove the Agent from its collaboration groups first".into()));
        }
        if bound {
            if transaction.execute("DELETE FROM project_team_bindings WHERE project_id=?1 AND team_ref=?2 AND version=?3",params![project_id, agent_id, version])? != 1 { return Err(TaskRuntimeError::VersionConflict); }
            transaction.commit()?;
            return Ok(());
        }
        let changed = transaction.execute("UPDATE loop_items SET status='archived',deleted_at=?1,updated_at=?1,version=version+1 WHERE id=?2 AND cloud_project_id=?3 AND resource_type='chat_agent' AND version=?4 AND deleted_at IS NULL", params![now(), agent_id, project_id, version])?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        transaction.commit()?;
        Ok(())
    }

    fn get_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        let connection = self.connection()?;
        let row = get_item_from(&connection, agent_id, "chat_agent")?
            .ok_or_else(|| TaskRuntimeError::Invalid("Robot not found".to_owned()))?;
        let mut agent = map_chat_agent(row);
        if agent.project_id != project_id {
            let (status,version) = connection.query_row("SELECT status, version FROM project_team_bindings WHERE project_id=?1 AND team_ref=?2", params![project_id,agent_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?))).optional()?.ok_or_else(|| TaskRuntimeError::Invalid("Robot is not in this project".into()))?;
            agent.project_id = project_id.to_owned();
            agent.status = status;
            agent.version = version;
        }
        Ok(agent)
    }

    // ------------------------------------------------------------------
    // Local comment thread
    // ------------------------------------------------------------------
}
