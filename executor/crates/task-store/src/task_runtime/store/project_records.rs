use super::*;

impl LocalTaskStore {
    pub fn list_projects(&self) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id, assignee_user_id
             FROM loop_items
             WHERE resource_type = 'project' AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| map_loop_item(&connection, row))?;
        let mut projects = collect_items(rows)?;
        drop(statement);
        projects.extend(list_external_projects(&connection)?);
        projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(projects)
    }

    pub fn create_project(&self, input: ProjectCreate) -> Result<LoopItem, TaskRuntimeError> {
        validate_name(&input.name, "project name")?;
        validate_provider(ProjectStoreKind::Local, input.task_provider)?;
        let provider_config =
            encrypt_provider_config(self.path(), input.task_provider, input.provider_config)?;
        let public_id = Uuid::new_v4().to_string();
        let id = public_id.clone();
        let now = now();
        let metadata = local_project_metadata(input.task_provider, provider_config);
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_key =
            project_key_for_create(&transaction, input.project_key.as_deref(), &input.name)?;
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, public_id, project_key, name,
                description, storage_prefix, next_item_number, status, sort_order,
                metadata, version, created_at, updated_at
             ) VALUES (?1, 'project', 'default', ?2, ?3, ?4, ?5, ?6, 1, 'active',
                       0, ?7, 1, ?8, ?8)",
            params![
                id,
                public_id,
                project_key,
                input.name,
                input.description,
                format!("projects/{public_id}"),
                metadata.to_string(),
                now,
            ],
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_item(&id, "project")
    }

    pub fn configure_external_project(
        &self,
        project: ProjectDescriptor,
    ) -> Result<LoopItem, TaskRuntimeError> {
        validate_provider(project.project_store, project.task_provider)?;
        if !matches!(
            project.task_provider,
            TaskProviderKind::Github | TaskProviderKind::Gitlab | TaskProviderKind::DingtalkAitable
        ) {
            return Err(TaskRuntimeError::Invalid(
                "external project requires github, gitlab, or dingtalk_aitable".to_owned(),
            ));
        }
        let connection = self.connection()?;
        let current = provider_credential_config(
            &connection,
            project_store_key(project.project_store),
            &project.id,
        )?
        .unwrap_or_else(|| json!({}));
        let provider_config = update_provider_config(
            self.path(),
            project.task_provider,
            &current,
            project.provider_config.clone(),
        )?;
        connection.execute(
            "INSERT INTO project_provider_credentials (
                project_store, project_id, task_provider, provider_config, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_store, project_id) DO UPDATE SET
                task_provider = excluded.task_provider,
                provider_config = excluded.provider_config,
                updated_at = excluded.updated_at",
            params![
                project_store_key(project.project_store),
                project.id,
                task_provider_key(project.task_provider),
                provider_config.to_string(),
                now(),
            ],
        )?;
        if project.project_store == ProjectStoreKind::Backend {
            let mut descriptor = project.clone();
            descriptor.provider_config = json!({});
            connection.execute(
                "INSERT INTO external_project_catalog (
                    project_store, project_id, descriptor, updated_at
                 ) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(project_store, project_id) DO UPDATE SET
                    descriptor = excluded.descriptor,
                    updated_at = excluded.updated_at",
                params![
                    project_store_key(project.project_store),
                    project.id,
                    serde_json::to_string(&descriptor)
                        .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?,
                    now(),
                ],
            )?;
        }
        Ok(descriptor_loop_item(project, provider_config))
    }

    pub fn remove_external_project(&self, project_id: &str) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM project_provider_credentials
             WHERE project_store = 'backend' AND project_id = ?1",
            [project_id],
        )?;
        transaction.execute(
            "DELETE FROM external_project_catalog
             WHERE project_store = 'backend' AND project_id = ?1",
            [project_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn retain_external_projects(&self, project_ids: &[String]) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let retained = project_ids
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut statement = transaction.prepare(
            "SELECT project_id FROM external_project_catalog WHERE project_store = 'backend'",
        )?;
        let stored = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for project_id in stored {
            if retained.contains(&project_id) {
                continue;
            }
            transaction.execute(
                "DELETE FROM project_provider_credentials
                 WHERE project_store = 'backend' AND project_id = ?1",
                [&project_id],
            )?;
            transaction.execute(
                "DELETE FROM external_project_catalog
                 WHERE project_store = 'backend' AND project_id = ?1",
                [&project_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn external_project(
        &self,
        project: ProjectDescriptor,
    ) -> Result<LoopItem, TaskRuntimeError> {
        validate_provider(project.project_store, project.task_provider)?;
        let connection = self.connection()?;
        let provider_config = provider_credential_config(
            &connection,
            project_store_key(project.project_store),
            &project.id,
        )?
        .unwrap_or_else(|| project.provider_config.clone());
        Ok(descriptor_loop_item(project, provider_config))
    }

    pub fn update_project(
        &self,
        project_id: &str,
        input: ProjectUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        if let Some(change) = input.tag_change.as_ref() {
            let mut fields = serde_json::to_value(&input)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            fields
                .as_object_mut()
                .unwrap()
                .retain(|key, value| key != "version" && key != "tag_change" && !value.is_null());
            if !fields.as_object().unwrap().is_empty() {
                return Err(TaskRuntimeError::Invalid(
                    "Tag changes cannot be combined with other project updates".into(),
                ));
            }
            return self.change_project_tag(project_id, input.version, change);
        }
        let project = self.get_project(project_id)?;
        if project.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if let Some(name) = input.name.as_deref() {
            validate_name(name, "project name")?;
        }
        let provider = task_provider(&project)?;
        let mut metadata = project.metadata;
        if let Some(tags) = input.tags {
            crate::task_runtime::tagging::validate_tags(&tags)?;
            metadata["tags"] = json!(tags);
        }
        if let Some(provider_config) = input.provider_config {
            metadata["provider_config"] = update_provider_config(
                self.path(),
                provider,
                &metadata["provider_config"],
                provider_config,
            )?;
        }
        if let Some(board_config) = input.board_config {
            metadata["board_config"] = board_config;
        }
        if let Some(board_views) = input.board_views {
            crate::task_runtime::board_views::validate_update(
                &metadata["board_views"],
                &board_views,
            )?;
            metadata["board_views"] = board_views;
        }
        if let Some(card_display) = input.card_display {
            metadata["card_display"] = card_display;
        }
        if let Some(pull_request_automation) = input.pull_request_automation {
            metadata["pull_request_automation"] = pull_request_automation;
        }
        if let Some(workflow_definition) = input.workflow_definition {
            metadata["workflow_definition"] = workflow_definition;
        }
        if let Some(collaboration_groups) = input.collaboration_groups {
            metadata["collaboration_groups"] = collaboration_groups;
        }
        if let Some(automatic_processing_rules) = input.automatic_processing_rules {
            local_automation::validate_rules(
                &*self.connection()?,
                &project.id,
                &metadata,
                &automatic_processing_rules,
            )?;
            metadata["automatic_processing_rules"] = automatic_processing_rules;
        }
        if let Some(execution_environment) = input.execution_environment {
            metadata["execution_environment"] = code_projects::merge_execution_environment(
                &metadata["execution_environment"],
                execution_environment,
            );
        }
        let connection = self.connection()?;
        let updated = connection.execute(
            "UPDATE loop_items
             SET name = COALESCE(?1, name),
                 description = COALESCE(?2, description),
                 metadata = ?3,
                 version = version + 1,
                 updated_at = ?4
             WHERE id = ?5 AND resource_type = 'project' AND version = ?6
               AND deleted_at IS NULL",
            params![
                input.name.map(|value| value.trim().to_owned()),
                input.description,
                metadata.to_string(),
                now(),
                project_id,
                input.version,
            ],
        )?;
        if updated == 0 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        drop(connection);
        self.get_project(project_id)
    }

    pub fn archive_project(&self, project_id: &str, version: i64) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let archived_at = now();
        let updated = connection.execute(
            "UPDATE loop_items
             SET deleted_at = ?1, updated_at = ?1, version = version + 1
             WHERE id = ?2 AND resource_type = 'project' AND version = ?3
               AND deleted_at IS NULL",
            params![archived_at, project_id, version],
        )?;
        if updated != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        Ok(())
    }
}
