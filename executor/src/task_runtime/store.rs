// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

use super::credentials::{encrypt_provider_config, update_provider_config};
use super::model::{
    ChatAgent, ChatAgentCreate, ChatAgentUpdate, LocalComment, LocalCommentCreate, LocalExecution,
    LocalExecutionClaim, LoopItem, ProjectCreate, ProjectDescriptor, ProjectStoreKind,
    ProjectUpdate, RuntimeTaskAddress, TaskBinding, TaskCreate, TaskProviderKind, TaskReorder,
    TaskUpdate,
};

const LOCAL_SCHEMA_VERSION: i64 = 7;
const DEFAULT_WORK_ITEM_PROJECT_ID: &str = "default-work-items";
const DEFAULT_WORK_ITEM_PROJECT_KEY: &str = "WORK";

#[derive(Debug, Error)]
pub enum TaskRuntimeError {
    #[error("local task database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("invalid task data: {0}")]
    Invalid(String),
    #[error("project not found")]
    ProjectNotFound,
    #[error("task not found")]
    TaskNotFound,
    #[error("task changed")]
    VersionConflict,
    #[error("task provider '{0}' is not implemented yet")]
    UnsupportedProvider(String),
    #[error("task provider request failed: {0}")]
    ProviderRequest(String),
    #[error("local task database is unavailable")]
    LockPoisoned,
}

#[derive(Clone)]
pub struct LocalTaskStore {
    connection: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl LocalTaskStore {
    pub fn from_env() -> Result<Self, TaskRuntimeError> {
        Self::open(local_database_path())
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, TaskRuntimeError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        }
        let connection = Connection::open(&path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list_projects(&self) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id
             FROM loop_items
             WHERE resource_type = 'project' AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], map_loop_item)?;
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
        let project_key = normalize_project_key(input.project_key, &input.name);
        let now = now();
        let metadata = local_project_metadata(input.task_provider, provider_config);
        let connection = self.connection()?;
        connection.execute(
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
        if let Some(card_display) = input.card_display {
            metadata["card_display"] = card_display;
        }
        if let Some(pull_request_automation) = input.pull_request_automation {
            metadata["pull_request_automation"] = pull_request_automation;
        }
        if let Some(workflow_definition) = input.workflow_definition {
            metadata["workflow_definition"] = workflow_definition;
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
                    assignee_agent_id, created_by_user_id
             FROM loop_items
             WHERE resource_type = 'task' AND cloud_project_id = ?1
               AND deleted_at IS NULL
             ORDER BY sort_order, updated_at DESC",
        )?;
        let rows = statement.query_map([project_id], map_loop_item)?;
        let mut items = collect_items(rows)?;
        drop(statement);
        let executions = latest_executions_for_project(&connection, project_id)?;
        for item in &mut items {
            if let Some((id, status)) = executions.get(&item.id) {
                item.execution_id = Some(*id);
                item.execution_state = Some(status.clone());
            }
        }
        Ok(items)
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

    pub fn create_task(
        &self,
        project_id: &str,
        input: TaskCreate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        validate_name(&input.title, "task title")?;
        validate_status(&input.status)?;
        validate_priority(&input.priority)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if task_provider(&project)? != TaskProviderKind::Local {
            return Err(TaskRuntimeError::UnsupportedProvider("external".to_owned()));
        }
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
        let completed_at = (input.status == "completed").then(|| now.clone());
        let mut metadata = json!({"tags": input.tags});
        if let Some(workflow) = input.workflow {
            metadata["workflow"] = workflow;
        } else if let Some(definition) = project.metadata.get("workflow_definition") {
            metadata["workflow"] = instantiate_local_workflow(definition)?;
        }
        transaction.execute(
            "UPDATE loop_items SET next_item_number = ?1, version = version + 1,
                    updated_at = ?2 WHERE id = ?3",
            params![sequence + 1, now, project_id],
        )?;
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, parent_id,
                title, description, sequence_number, status, priority, sort_order,
                metadata, version, created_at, updated_at, completed_at,
                assignee_agent_id
             ) VALUES (?1, 'task', 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                       0, ?9, 1, ?10, ?10, ?11, ?12)",
            params![
                id,
                project_id,
                input.parent_id,
                input.title,
                input.description,
                sequence,
                input.status,
                input.priority,
                metadata.to_string(),
                now,
                completed_at,
                None::<String>,
            ],
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
            validate_status(status)?;
        }
        if let Some(priority) = input.priority.as_deref() {
            validate_priority(priority)?;
        }
        if let Some(Some(agent_id)) = input.assignee_agent_id.as_ref() {
            let agent = get_item_from(&transaction, agent_id, "chat_agent")?.ok_or_else(|| {
                TaskRuntimeError::Invalid("Robot is not active in this project".to_owned())
            })?;
            if agent.cloud_project_id.as_deref() != Some(project_id) {
                return Err(TaskRuntimeError::Invalid(
                    "Robot is not in this project".to_owned(),
                ));
            }
        }
        if let Some(Some(parent_id)) = input.parent_id.as_ref() {
            require_parent(&transaction, project_id, parent_id, Some(task_id))?;
        }
        let title = input.title.or(current.title);
        let description = input.description.unwrap_or(current.description);
        let status = input.status.or(current.status);
        let priority = input.priority.clone().or_else(|| current.priority.clone());
        let parent_id = input.parent_id.unwrap_or(current.parent_id);
        let mut metadata = current.metadata;
        if let Some(tags) = input.tags {
            metadata["tags"] = json!(tags);
        }
        if let Some(workflow) = input.workflow {
            metadata["workflow"] = workflow.unwrap_or(Value::Null);
        }
        let assignee_agent_id = match input.assignee_agent_id.as_ref() {
            Some(Some(agent_id)) => Some(agent_id.as_str()),
            Some(None) => None,
            None => current.assignee_agent_id.as_deref(),
        };
        let assignee_changed = input.assignee_agent_id.is_some()
            && assignee_agent_id != current.assignee_agent_id.as_deref();
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
                 assignee_agent_id = ?8, version = version + 1, updated_at = ?9
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
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if assignee_changed {
            cancel_active_executions(&transaction, task_id)?;
            if let Some(agent_id) = assignee_agent_id {
                let agent =
                    get_item_from(&transaction, agent_id, "chat_agent")?.ok_or_else(|| {
                        TaskRuntimeError::Invalid("Robot is not active in this project".to_owned())
                    })?;
                create_local_execution(
                    &transaction,
                    task_id,
                    project_id,
                    agent_id,
                    &agent,
                    current.priority.as_deref().unwrap_or("none"),
                    input.execution_payload.unwrap_or(Value::Null),
                )?;
                let execution_id = transaction.last_insert_rowid();
                // Mirror enqueue_execution: assignment-started runs need the
                // optimistic agent comment so the finished outcome has a row to
                // write back into the task thread.
                insert_comment(
                    &transaction,
                    &LocalCommentCreate {
                        project_id: project_id.to_owned(),
                        task_id: task_id.to_owned(),
                        client_message_id: None,
                        sender_type: "agent".to_owned(),
                        sender_id: agent_id.to_owned(),
                        sender_name: agent
                            .title
                            .or(agent.name)
                            .unwrap_or_else(|| "AI".to_owned()),
                        content: String::new(),
                        metadata: json!({ "execution_id": execution_id }),
                        reply_to_message_id: None,
                    },
                    "streaming",
                )?;
            }
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

    pub fn list_chat_agents(&self, project_id: &str) -> Result<Vec<ChatAgent>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id
             FROM loop_items
             WHERE resource_type = 'chat_agent' AND cloud_project_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at ASC",
        )?;
        let rows = statement.query_map(params![project_id], map_loop_item)?;
        let agents = collect_items(rows)?;
        Ok(agents
            .into_iter()
            .filter(|agent| agent.status.as_deref() != Some("archived"))
            .map(map_chat_agent)
            .collect())
    }

    pub fn create_chat_agent(
        &self,
        project_id: &str,
        input: ChatAgentCreate,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        validate_name(&input.name, "robot name")?;
        if !(1..=20).contains(&input.max_concurrent_executions) {
            return Err(TaskRuntimeError::Invalid(
                "Robot max concurrent executions must be between 1 and 20".to_owned(),
            ));
        }
        let connection = self.connection()?;
        let id = format!("LA-{}", Uuid::new_v4().simple());
        let now = now();
        let mut metadata = json!({
            "runtime": "codex",
            "model": input.model,
            "system_prompt": input.system_prompt.unwrap_or_default(),
            "visibility": input.visibility.unwrap_or_else(|| "creator_admin".to_owned()),
            "execution_environment": input.execution_environment.unwrap_or_else(|| "local".to_owned()),
            "execution_mode": input.execution_mode.unwrap_or_else(|| "auto".to_owned()),
            "max_concurrent_executions": input.max_concurrent_executions,
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
                now,
                input.created_by_user_id.unwrap_or(0),
            ],
        )?;
        drop(connection);
        self.get_chat_agent(project_id, &id)
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
            return Err(TaskRuntimeError::Invalid(
                "Robot is not in this project".to_owned(),
            ));
        }
        if current.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let mut metadata = current.metadata;
        if let Some(name) = input.name.as_ref() {
            validate_name(name, "robot name")?;
        }
        if let Some(model) = input.model.as_ref() {
            metadata["model"] = json!(model);
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
        if let Some(local_project_id) = input.local_project_id {
            metadata["local_project_id"] = json!(local_project_id);
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

    fn get_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        let connection = self.connection()?;
        let row = get_item_from(&connection, agent_id, "chat_agent")?
            .ok_or_else(|| TaskRuntimeError::Invalid("Robot not found".to_owned()))?;
        if row.cloud_project_id.as_deref() != Some(project_id) {
            return Err(TaskRuntimeError::Invalid(
                "Robot is not in this project".to_owned(),
            ));
        }
        Ok(map_chat_agent(row))
    }

    // ------------------------------------------------------------------
    // Local comment thread
    // ------------------------------------------------------------------

    pub fn list_comments(
        &self,
        project_id: &str,
        task_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<LocalComment>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, message_id, client_message_id, project_id, task_id,
                    sender_type, sender_id, sender_name, message_type, content,
                    metadata, trigger_message_id, reply_to_message_id,
                    thread_root_message_id, status, sequence_number, created_at, updated_at
             FROM loop_item_comments
             WHERE project_id = ?1 AND task_id = ?2 AND deleted_at IS NULL
               AND sequence_number > ?3
             ORDER BY sequence_number ASC",
        )?;
        let rows =
            statement.query_map(params![project_id, task_id, after_sequence], map_comment)?;
        let mut comments = Vec::new();
        for comment in rows {
            comments.push(comment?);
        }
        Ok(comments)
    }

    pub fn create_comment(
        &self,
        create: &LocalCommentCreate,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let connection = self.connection()?;
        insert_comment(&connection, create, "completed")
    }

    pub fn update_agent_comment_for_execution(
        &self,
        execution_id: i64,
        status: &str,
        content: &str,
    ) -> Result<Option<LocalComment>, TaskRuntimeError> {
        let connection = self.connection()?;
        let execution = execution_row(&connection, execution_id)?;
        let runtime_address = match (&execution.runtime_device_id, &execution.runtime_task_id) {
            (Some(device_id), Some(task_id)) => Some(json!({
                "deviceId": device_id,
                "taskId": task_id,
            })),
            _ => None,
        };
        let changed = connection.execute(
            "UPDATE loop_item_comments
             SET status = ?1, content = ?2, updated_at = ?3
             WHERE deleted_at IS NULL
               AND json_extract(metadata, '$.execution_id') = ?4",
            params![status, content, now(), execution_id],
        )?;
        if changed == 0 {
            // The optimistic comment row may be missing (for example runs
            // started by assignment before comment creation existed); create
            // it now so the finished outcome still appears in the task thread.
            let agent = get_item_from(&connection, &execution.agent_id, "chat_agent")
                .ok()
                .flatten();
            let sender_name = agent
                .and_then(|agent| agent.title.or(agent.name))
                .unwrap_or_else(|| "AI".to_owned());
            let mut metadata = json!({ "execution_id": execution_id });
            if let Some(address) = &runtime_address {
                metadata["runtime_address"] = address.clone();
            }
            insert_comment(
                &connection,
                &LocalCommentCreate {
                    project_id: execution.cloud_project_id.clone(),
                    task_id: execution.loop_item_id.clone(),
                    client_message_id: None,
                    sender_type: "agent".to_owned(),
                    sender_id: execution.agent_id.clone(),
                    sender_name,
                    content: content.to_owned(),
                    metadata,
                    reply_to_message_id: None,
                },
                status,
            )?;
        }
        if let Some(address) = &runtime_address {
            connection.execute(
                "UPDATE loop_item_comments
                 SET metadata = json_set(metadata, '$.runtime_address', json(?1))
                 WHERE deleted_at IS NULL
                   AND json_extract(metadata, '$.execution_id') = ?2",
                params![address.to_string(), execution_id],
            )?;
        }
        let message_id = connection.query_row(
            "SELECT message_id FROM loop_item_comments
             WHERE deleted_at IS NULL
               AND json_extract(metadata, '$.execution_id') = ?1
             ORDER BY id ASC LIMIT 1",
            params![execution_id],
            |row| row.get::<_, String>(0),
        )?;
        Ok(Some(comment_row(&connection, &message_id)?))
    }

    // ------------------------------------------------------------------
    // Local execution lifecycle
    // ------------------------------------------------------------------

    pub fn list_executions(
        &self,
        project_id: &str,
        agent_id: Option<&str>,
        status_filter: Option<&str>,
        include_terminal: bool,
    ) -> Result<Vec<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut sql = String::from(
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
                    t.title, t.status, t.priority,
                    a.name, a.title, a.metadata, e.runtime_instance_id
             FROM loop_item_executions e
             LEFT JOIN loop_items t ON t.id = e.loop_item_id
             LEFT JOIN loop_items a ON a.id = e.agent_id
             WHERE e.cloud_project_id = ?1",
        );
        if agent_id.is_some() {
            sql.push_str(" AND e.agent_id = ?2");
        }
        if status_filter.is_some() {
            sql.push_str(" AND e.status = ?3");
        } else if !include_terminal {
            sql.push_str(
                " AND e.status IN ('pending_approval', 'queued', 'claimed', 'running',
                                   'cancel_requested')",
            );
        }
        sql.push_str(" ORDER BY e.priority_weight DESC, e.queued_at ASC, e.id ASC");
        let mut statement = connection.prepare(&sql)?;
        let rows = match (agent_id, status_filter) {
            (Some(agent_id), Some(status)) => {
                statement.query_map(params![project_id, agent_id, status], map_execution)?
            }
            (Some(agent_id), None) => {
                statement.query_map(params![project_id, agent_id], map_execution)?
            }
            (None, Some(status)) => {
                // The SQL always references ?3 for the status filter; bind an
                // explicit NULL agent so the placeholder count stays aligned.
                statement.query_map(params![project_id, None::<String>, status], map_execution)?
            }
            (None, None) => statement.query_map(params![project_id], map_execution)?,
        };
        let mut executions = Vec::new();
        for execution in rows {
            executions.push(execution?);
        }
        Ok(executions)
    }

    /// Resolve a local execution by the runtime task id assigned to it. The
    /// App dispatcher records the id with `heartbeat_execution` after it
    /// starts the run, so terminal runtime events can write the outcome back.
    pub fn execution_by_runtime_task_id(
        &self,
        runtime_task_id: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let execution_id: Option<i64> = connection
            .query_row(
                "SELECT id FROM loop_item_executions
                 WHERE runtime_task_id = ?1
                   AND status IN ('claimed', 'running', 'cancel_requested')
                 ORDER BY id DESC LIMIT 1",
                params![runtime_task_id],
                |row| row.get(0),
            )
            .optional()?;
        match execution_id {
            Some(id) => execution_row(&connection, id).map(Some),
            None => Ok(None),
        }
    }

    pub fn approve_execution(&self, execution_id: i64) -> Result<LocalExecution, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "pending_approval" {
            return Err(TaskRuntimeError::Invalid(
                "Run is not waiting for robot approval".to_owned(),
            ));
        }
        let now = now();
        connection.execute(
            "UPDATE loop_item_executions
             SET status = 'queued', queued_at = ?1, approval_status = 'approved',
                 approved_at = ?1, version = version + 1, updated_at = ?1
             WHERE id = ?2",
            params![now, execution_id],
        )?;
        execution_row(&connection, execution_id)
    }

    pub fn reject_execution(
        &self,
        execution_id: i64,
        reason: Option<String>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "pending_approval" {
            return Err(TaskRuntimeError::Invalid(
                "Run is not waiting for robot approval".to_owned(),
            ));
        }
        let now = now();
        let reason = reason.unwrap_or_else(|| "Robot creator rejected the run".to_owned());
        connection.execute(
            "UPDATE loop_item_executions
             SET status = 'cancelled', approval_status = 'rejected',
                 rejected_reason = ?1, execution_note = ?1, completed_at = ?2,
                 observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?2,
                 termination_reason = 'approval_rejected',
                 version = version + 1, updated_at = ?2
             WHERE id = ?3",
            params![reason, now, execution_id],
        )?;
        update_agent_comment(&connection, execution_id, "cancelled", &reason, &now)?;
        execution_row(&connection, execution_id)
    }

    pub fn cancel_execution(
        &self,
        execution_id: i64,
        note: Option<&str>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        if matches!(
            current.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            transaction.rollback()?;
            return Ok(current);
        }

        let timestamp = now();
        let message = note.unwrap_or("AI execution was cancelled");
        let start_was_delivered = current.start_requested_at.is_some();
        if matches!(current.status.as_str(), "pending_approval" | "queued")
            || (current.status == "claimed" && !start_was_delivered)
        {
            let changed = transaction.execute(
                "UPDATE loop_item_executions
                 SET status = 'cancelled', completed_at = ?1, lease_expires_at = NULL,
                     observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?1,
                     cancel_requested_at = ?1, execution_note = ?2,
                     termination_reason = 'cancelled_before_start',
                     version = version + 1, updated_at = ?1
                 WHERE id = ?3 AND status = ?4 AND version = ?5",
                params![
                    timestamp,
                    message,
                    execution_id,
                    current.status,
                    current.version
                ],
            )?;
            if changed != 1 {
                transaction.rollback()?;
                return execution_row(&connection, execution_id);
            }
            update_agent_comment(&transaction, execution_id, "cancelled", message, &timestamp)?;
            transaction.commit()?;
            return execution_row(&connection, execution_id);
        }

        if !matches!(
            current.status.as_str(),
            "claimed" | "running" | "cancel_requested"
        ) {
            transaction.rollback()?;
            return Err(TaskRuntimeError::Invalid(format!(
                "Execution {} cannot be cancelled from status {}",
                execution_id, current.status
            )));
        }
        if current
            .runtime_device_id
            .as_deref()
            .unwrap_or("")
            .is_empty()
            || current.runtime_task_id.as_deref().unwrap_or("").is_empty()
        {
            transaction.rollback()?;
            return Err(TaskRuntimeError::Invalid(format!(
                "Delivered execution {execution_id} has no runtime identity"
            )));
        }
        if current.status != "cancel_requested" {
            let changed = transaction.execute(
                "UPDATE loop_item_executions
                 SET status = 'cancel_requested', cancel_requested_at = ?1,
                     sync_state = 'pending', execution_note = ?2,
                     version = version + 1, updated_at = ?1
                 WHERE id = ?3 AND status IN ('claimed', 'running') AND version = ?4",
                params![timestamp, message, execution_id, current.version],
            )?;
            if changed != 1 {
                transaction.rollback()?;
                return execution_row(&connection, execution_id);
            }
        }
        transaction.commit()?;
        execution_row(&connection, execution_id)
    }

    pub fn claim_next_local_execution(
        &self,
        claim: &LocalExecutionClaim,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let runtime_active_task_ids = claim
            .runtime_active_task_ids
            .iter()
            .map(|task_id| task_id.trim())
            .collect::<HashSet<_>>();
        if claim.runtime_instance_id.trim().is_empty()
            || !(1..=20).contains(&claim.device_capacity)
            || runtime_active_task_ids.len() != claim.runtime_active_task_ids.len()
            || runtime_active_task_ids.len() != claim.runtime_active as usize
            || runtime_active_task_ids.contains("")
        {
            return Err(TaskRuntimeError::Invalid(
                "Runtime capacity identity or limit is invalid".to_owned(),
            ));
        }
        let connection = self.connection()?;
        let ambiguous: i64 = connection.query_row(
            "SELECT COUNT(*) FROM loop_item_executions
             WHERE status IN ('claimed', 'running', 'cancel_requested')
               AND runtime_instance_id = ''",
            [],
            |row| row.get(0),
        )?;
        if ambiguous > 0 {
            return Ok(None);
        }
        let durable_task_ids = {
            let mut statement = connection.prepare(
                "SELECT runtime_task_id FROM loop_item_executions
             WHERE status IN ('claimed', 'running', 'cancel_requested')
               AND runtime_instance_id = ?1",
            )?;
            let rows = statement.query_map(params![&claim.runtime_instance_id], |row| {
                row.get::<_, Option<String>>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let pending_reservations = durable_task_ids
            .iter()
            .filter(|task_id| {
                task_id
                    .as_deref()
                    .map_or(true, |task_id| !runtime_active_task_ids.contains(task_id))
            })
            .count() as u64;
        let occupied = claim.runtime_active + pending_reservations;
        if occupied >= claim.device_capacity {
            return Ok(None);
        }
        let running_agents: HashMap<String, i64> = {
            let mut statement = connection.prepare(
                "SELECT agent_id, COUNT(*) FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND agent_id != ''
                 GROUP BY agent_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            rows.collect::<Result<HashMap<_, _>, _>>()?
        };
        let mut sql = String::from(
            "SELECT e.id, e.agent_id, e.execution_scope, e.priority_weight,
                    COALESCE(json_extract(a.metadata, '$.max_concurrent_executions'), 1)
             FROM loop_item_executions e
             LEFT JOIN loop_items a ON a.id = e.agent_id
             WHERE e.execution_environment = 'local' AND e.status = 'queued'",
        );
        if claim.execution_device_id.is_some() {
            // Robots created before device binding have no bound device; the
            // claiming device adopts those runs the same way the cloud
            // dispatcher binds unbound local runs.
            sql.push_str(
                " AND (e.execution_device_id = ?1
                     OR e.execution_device_id IS NULL
                     OR e.execution_device_id = '')",
            );
        }
        sql.push_str(" ORDER BY e.priority_weight DESC, e.queued_at ASC, e.id ASC");
        let mut statement = connection.prepare(&sql)?;
        let candidates = if let Some(device_id) = claim.execution_device_id.as_ref() {
            statement
                .query_map(params![device_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let occupied_scopes = {
            let mut statement = connection.prepare(
                "SELECT execution_scope FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND execution_scope != ''",
            )?;
            let scopes = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            scopes
        };
        let mut candidate = None;
        let mut priorities = candidates
            .iter()
            .map(|row| row.3)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        priorities.sort_unstable_by(|left, right| right.cmp(left));
        for priority in priorities {
            let mut seen_agents = HashSet::new();
            let mut fair_candidates = Vec::new();
            for (position, (id, agent_id, execution_scope, row_priority, configured_limit)) in
                candidates.iter().enumerate()
            {
                if *row_priority != priority {
                    continue;
                }
                let limit = if (1..=20).contains(configured_limit) {
                    *configured_limit
                } else {
                    1
                };
                let agent_available = agent_id.is_empty()
                    || running_agents.get(agent_id).copied().unwrap_or(0) < limit;
                let scope_available =
                    execution_scope.is_empty() || !occupied_scopes.contains(execution_scope);
                let fairness_key = if agent_id.is_empty() {
                    format!("automation:{id}")
                } else {
                    agent_id.clone()
                };
                if agent_available && scope_available && seen_agents.insert(fairness_key) {
                    fair_candidates.push((
                        running_agents.get(agent_id).copied().unwrap_or(0),
                        position,
                        *id,
                    ));
                }
            }
            if let Some((_, _, id)) = fair_candidates.into_iter().min() {
                candidate = Some(id);
                break;
            }
        }
        let Some(candidate_id) = candidate else {
            return Ok(None);
        };
        let now = now();
        let runtime_device_id = claim
            .execution_device_id
            .as_deref()
            .unwrap_or("local-device");
        let runtime_task_id = format!("codex-queue-{candidate_id}");
        let lease_seconds = claim.lease_seconds.max(60);
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET status = 'claimed', claimed_at = ?1, heartbeat_at = ?1,
                 execution_device_id = COALESCE(NULLIF(execution_device_id, ''), ?4),
                 runtime_instance_id = ?6,
                 runtime_device_id = ?4, runtime_task_id = ?5,
                 lease_expires_at = ?2, version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'queued'",
            params![
                now,
                lease_expiry(&now, lease_seconds),
                candidate_id,
                runtime_device_id,
                runtime_task_id,
                &claim.runtime_instance_id,
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        execution_row(&connection, candidate_id).map(Some)
    }

    pub fn heartbeat_execution(
        &self,
        execution_id: i64,
        runtime_device_id: Option<&str>,
        runtime_task_id: Option<&str>,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if !matches!(
            current.status.as_str(),
            "claimed" | "running" | "cancel_requested"
        ) {
            return Ok(None);
        }
        if runtime_device_id != current.runtime_device_id.as_deref()
            || runtime_task_id != current.runtime_task_id.as_deref()
        {
            return Ok(None);
        }
        let now = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET heartbeat_at = ?1, lease_expires_at = ?2,
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![now, lease_expiry(&now, lease_seconds.max(60)), execution_id,],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn request_runtime_start(
        &self,
        execution_id: i64,
        runtime_device_id: &str,
        runtime_task_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "claimed"
            || current.start_requested_at.is_some()
            || current.runtime_device_id.as_deref() != Some(runtime_device_id)
            || current.runtime_task_id.as_deref() != Some(runtime_task_id)
        {
            return Ok(None);
        }
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET start_requested_at = ?1, heartbeat_at = ?1, lease_expires_at = ?2,
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'claimed' AND start_requested_at IS NULL",
            params![
                timestamp,
                lease_expiry(&timestamp, lease_seconds.max(60)),
                execution_id,
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn confirm_runtime_accepted(
        &self,
        execution_id: i64,
        runtime_device_id: &str,
        runtime_task_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "claimed"
            || current.start_requested_at.is_none()
            || current.runtime_device_id.as_deref() != Some(runtime_device_id)
            || current.runtime_task_id.as_deref() != Some(runtime_task_id)
        {
            return Ok(None);
        }
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET observed_state = 'accepted', sync_state = 'in_sync', observed_at = ?1,
                 heartbeat_at = ?1, lease_expires_at = ?2, error_message = '',
                 termination_reason = '',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'claimed'",
            params![
                timestamp,
                lease_expiry(&timestamp, lease_seconds.max(60)),
                execution_id,
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let address = json!({"deviceId": runtime_device_id, "taskId": runtime_task_id}).to_string();
        connection.execute(
            "UPDATE loop_item_comments
             SET metadata = json_set(metadata, '$.runtime_address', json(?1)),
                 updated_at = ?2
             WHERE deleted_at IS NULL
               AND json_extract(metadata, '$.execution_id') = ?3",
            params![address, timestamp, execution_id],
        )?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn mark_runtime_dispatch_unknown(
        &self,
        execution_id: i64,
        runtime_device_id: &str,
        runtime_task_id: &str,
        error: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let current = execution_row(&connection, execution_id)?;
        if current.status != "claimed"
            || current.start_requested_at.is_none()
            || current.runtime_device_id.as_deref() != Some(runtime_device_id)
            || current.runtime_task_id.as_deref() != Some(runtime_task_id)
        {
            return Ok(Some(current));
        }
        let timestamp = now();
        connection.execute(
            "UPDATE loop_item_executions
             SET sync_state = 'stale', error_message = ?1,
                 termination_reason = 'runtime_dispatch_unknown',
                 version = version + 1, updated_at = ?2
             WHERE id = ?3 AND status = 'claimed'",
            params![truncate(error, 2000), timestamp, execution_id],
        )?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn mark_runtime_running(
        &self,
        runtime_task_id: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let timestamp = now();
        let changed = connection.execute(
            "UPDATE loop_item_executions
             SET status = CASE WHEN status = 'cancel_requested'
                               THEN status ELSE 'running' END,
                 observed_state = 'running', sync_state = 'in_sync',
                 observed_at = ?1, started_at = COALESCE(started_at, ?1),
                 heartbeat_at = ?1, lease_expires_at = ?2, error_message = '',
                 termination_reason = '',
                 version = version + 1, updated_at = ?1
             WHERE runtime_task_id = ?3
               AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, lease_expiry(&timestamp, 300), runtime_task_id],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let execution_id = connection.query_row(
            "SELECT id FROM loop_item_executions WHERE runtime_task_id = ?1",
            params![runtime_task_id],
            |row| row.get(0),
        )?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn reconcile_execution_snapshot(
        &self,
        execution_id: i64,
        runtime_status: &str,
        running: bool,
        turn_status: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let current = {
            let connection = self.connection()?;
            execution_row(&connection, execution_id)?
        };
        if matches!(
            current.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            return Ok(Some(current));
        }
        let status = runtime_status.trim().to_ascii_lowercase();
        let turn = turn_status.unwrap_or("").trim().to_ascii_lowercase();
        if running || matches!(status.as_str(), "running" | "in_progress" | "inprogress") {
            let Some(runtime_task_id) = current.runtime_task_id.as_deref() else {
                return Ok(Some(current));
            };
            return self.mark_runtime_running(runtime_task_id);
        }
        match turn.as_str() {
            "completed" | "succeeded" => {
                return self.complete_execution(execution_id, Some("Runtime reconciled"));
            }
            "failed" | "error" => {
                return self.fail_execution(
                    execution_id,
                    "Runtime reported a failed turn during reconciliation",
                    true,
                );
            }
            "interrupted" | "cancelled" | "canceled" | "aborted" => {
                return self.cancel_execution_observed(
                    execution_id,
                    Some("Runtime reconciled cancellation"),
                );
            }
            _ => {}
        }
        match status.as_str() {
            "completed" | "succeeded" => {
                return self.complete_execution(execution_id, Some("Runtime reconciled"));
            }
            "failed" | "error" => {
                return self.fail_execution(
                    execution_id,
                    "Runtime reported a failed task during reconciliation",
                    true,
                );
            }
            "cancelled" | "canceled" => {
                return self.cancel_execution_observed(
                    execution_id,
                    Some("Runtime reconciled cancellation"),
                );
            }
            _ => {}
        }

        let connection = self.connection()?;
        let timestamp = now();
        if matches!(
            status.as_str(),
            "accepted" | "active" | "pending" | "queued" | "starting"
        ) {
            connection.execute(
                "UPDATE loop_item_executions
                 SET observed_state = 'accepted', sync_state = 'in_sync',
                     observed_at = ?1, heartbeat_at = ?1, lease_expires_at = ?2,
                     error_message = '', termination_reason = '',
                     version = version + 1, updated_at = ?1
                 WHERE id = ?3
                   AND status IN ('claimed', 'running', 'cancel_requested')",
                params![timestamp, lease_expiry(&timestamp, 300), execution_id],
            )?;
        } else {
            connection.execute(
                "UPDATE loop_item_executions
                 SET sync_state = 'diverged', error_message = ?1,
                     version = version + 1, updated_at = ?2
                 WHERE id = ?3
                   AND status IN ('claimed', 'running', 'cancel_requested')",
                params![
                    format!(
                        "Runtime returned unrecognized status '{}'",
                        if status.is_empty() {
                            "missing"
                        } else {
                            &status
                        }
                    ),
                    timestamp,
                    execution_id,
                ],
            )?;
        }
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn complete_execution(
        &self,
        execution_id: i64,
        content: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = now();
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'completed', completed_at = ?1, lease_expires_at = NULL,
                 observed_state = 'succeeded', sync_state = 'in_sync', observed_at = ?1,
                 execution_note = ?2, termination_reason = 'runtime_succeeded',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, content.unwrap_or(""), execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        // Mirror the cloud project-chat write-back: when the assigned robot
        // finishes, move the task to human review so the queue no longer
        // shows it as an active run.
        transaction.execute(
            "UPDATE loop_items
             SET status = 'in_review', sort_order = 0, version = version + 1,
                 updated_at = ?1
             WHERE id = (SELECT loop_item_id FROM loop_item_executions WHERE id = ?2)
               AND assignee_agent_id =
                   (SELECT agent_id FROM loop_item_executions WHERE id = ?2)
               AND status NOT IN ('completed', 'in_review')",
            params![timestamp, execution_id],
        )?;
        update_agent_comment(
            &transaction,
            execution_id,
            "completed",
            content.unwrap_or(""),
            &timestamp,
        )?;
        transaction.commit()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn fail_execution(
        &self,
        execution_id: i64,
        error: &str,
        requeue: bool,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        if matches!(
            current.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            transaction.rollback()?;
            return Ok(Some(current));
        }
        let timestamp = now();
        let error = truncate(error, 2000);
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'failed', completed_at = ?1, lease_expires_at = NULL,
                 observed_state = 'failed', sync_state = 'in_sync', observed_at = ?1,
                 error_message = ?2, termination_reason = 'runtime_failed',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, error, execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(&transaction, execution_id, "failed", &error, &timestamp)?;
        if requeue && current.retry_attempt < current.max_retries {
            transaction.execute(
                "INSERT INTO loop_item_executions (
                    loop_item_id, cloud_project_id, agent_id, execution_environment,
                    execution_device_id, assigner_user_id, status, priority_weight,
                    queued_at, retry_attempt, max_retries, error_message, execution_note,
                    approval_status, approved_by_user_id, approved_at, execution_payload,
                    attempt_no, previous_execution_id, execution_scope,
                    observed_state, sync_state, version, created_at, updated_at
                 )
                 SELECT loop_item_id, cloud_project_id, agent_id, execution_environment,
                        execution_device_id, assigner_user_id, 'queued', priority_weight,
                        ?1, retry_attempt + 1, max_retries, ?2, execution_note,
                        approval_status, approved_by_user_id, approved_at, execution_payload,
                        attempt_no + 1, id, execution_scope,
                        'unconfirmed', 'pending', 1, ?1, ?1
                 FROM loop_item_executions WHERE id = ?3",
                params![timestamp, error, execution_id],
            )?;
            let retry_id = transaction.last_insert_rowid();
            insert_comment(
                &transaction,
                &LocalCommentCreate {
                    project_id: current.cloud_project_id.clone(),
                    task_id: current.loop_item_id.clone(),
                    client_message_id: None,
                    sender_type: "agent".to_owned(),
                    sender_id: current.agent_id.clone(),
                    sender_name: current.agent_name.clone(),
                    content: String::new(),
                    metadata: json!({
                        "execution_id": retry_id,
                        "previous_execution_id": execution_id,
                    }),
                    reply_to_message_id: None,
                },
                "pending",
            )?;
            transaction.commit()?;
            return execution_row(&connection, retry_id).map(Some);
        }
        transaction.commit()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn fail_runtime_preflight(
        &self,
        execution_id: i64,
        error: &str,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = execution_row(&transaction, execution_id)?;
        if current.status != "claimed" || current.start_requested_at.is_some() {
            transaction.rollback()?;
            return Ok(Some(current));
        }
        let timestamp = now();
        let error = truncate(error, 2000);
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'failed', completed_at = ?1, lease_expires_at = NULL,
                 sync_state = 'in_sync', error_message = ?2,
                 termination_reason = 'runtime_preflight_failed',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status = 'claimed' AND start_requested_at IS NULL",
            params![timestamp, error, execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(&transaction, execution_id, "failed", &error, &timestamp)?;
        transaction.commit()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn cancel_execution_observed(
        &self,
        execution_id: i64,
        note: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = now();
        let message = note.unwrap_or("Runtime task was cancelled");
        let changed = transaction.execute(
            "UPDATE loop_item_executions
             SET status = 'cancelled', completed_at = ?1, lease_expires_at = NULL,
                 observed_state = 'cancelled', sync_state = 'in_sync', observed_at = ?1,
                 execution_note = ?2, termination_reason = 'runtime_cancelled',
                 version = version + 1, updated_at = ?1
             WHERE id = ?3 AND status IN ('claimed', 'running', 'cancel_requested')",
            params![timestamp, message, execution_id],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return execution_row(&connection, execution_id).map(Some);
        }
        update_agent_comment(&transaction, execution_id, "cancelled", message, &timestamp)?;
        transaction.commit()?;
        execution_row(&connection, execution_id).map(Some)
    }

    pub fn recover_stale_local_executions(&self) -> Result<(u64, u64), TaskRuntimeError> {
        let connection = self.connection()?;
        let stale: Vec<i64> = {
            let mut statement = connection.prepare(
                "SELECT id FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at < ?1",
            )?;
            let rows = statement.query_map(params![now()], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut requeued = 0u64;
        let mut unknown = 0u64;
        for id in stale {
            let current = execution_row(&connection, id)?;
            let now = now();
            if current.status == "claimed" && current.start_requested_at.is_none() {
                connection.execute(
                    "UPDATE loop_item_executions
                     SET status = 'queued', queued_at = ?1, lease_expires_at = NULL,
                         claimed_at = NULL, observed_state = 'unconfirmed',
                         sync_state = 'pending', error_message = ?2,
                         version = version + 1, updated_at = ?1
                     WHERE id = ?3",
                    params![now, "Unstarted claim lease expired locally", id],
                )?;
                requeued += 1;
            } else {
                connection.execute(
                    "UPDATE loop_item_executions
                     SET sync_state = 'stale', error_message = ?2,
                         termination_reason = 'runtime_observation_stale',
                         version = version + 1, updated_at = ?1
                     WHERE id = ?3",
                    params![now, "Runtime state requires reconciliation", id],
                )?;
                unknown += 1;
            }
        }
        Ok((requeued, unknown))
    }

    pub fn stale_local_executions(&self) -> Result<Vec<LocalExecution>, TaskRuntimeError> {
        let connection = self.connection()?;
        let ids = {
            let mut statement = connection.prepare(
                "SELECT id FROM loop_item_executions
                 WHERE status IN ('claimed', 'running', 'cancel_requested')
                   AND sync_state = 'stale'
                   AND runtime_device_id IS NOT NULL
                   AND runtime_device_id != ''
                   AND runtime_task_id IS NOT NULL
                   AND runtime_task_id != ''
                 ORDER BY observed_at ASC, id ASC",
            )?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect::<Result<Vec<i64>, _>>()?
        };
        ids.into_iter()
            .map(|id| execution_row(&connection, id))
            .collect()
    }

    /// Enqueue a local robot run for a comment-triggered execution and create
    /// the optimistic agent comment that tracks its status in the task thread.
    pub fn enqueue_execution(
        &self,
        project_id: &str,
        task_id: &str,
        agent_id: &str,
        payload: Value,
        trigger_message_id: Option<&str>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        let connection = self.connection()?;
        let agent = get_item_from(&connection, agent_id, "chat_agent")?.ok_or_else(|| {
            TaskRuntimeError::Invalid("Robot is not active in this project".to_owned())
        })?;
        let task =
            get_item_from(&connection, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        create_local_execution(
            &connection,
            task_id,
            project_id,
            agent_id,
            &agent,
            task.priority.as_deref().unwrap_or("none"),
            payload.clone(),
        )?;
        let execution_id = connection.last_insert_rowid();
        insert_comment(
            &connection,
            &LocalCommentCreate {
                project_id: project_id.to_owned(),
                task_id: task_id.to_owned(),
                client_message_id: None,
                sender_type: "agent".to_owned(),
                sender_id: agent_id.to_owned(),
                sender_name: agent
                    .title
                    .or(agent.name)
                    .unwrap_or_else(|| "AI".to_owned()),
                content: String::new(),
                metadata: json!({
                    "execution_id": execution_id,
                    "trigger_message_id": trigger_message_id,
                }),
                reply_to_message_id: trigger_message_id.map(ToOwned::to_owned),
            },
            "streaming",
        )?;
        execution_row(&connection, execution_id)
    }

    pub fn local_execution_payload(
        &self,
        execution_id: i64,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let payload: Option<String> = connection.query_row(
            "SELECT execution_payload FROM loop_item_executions WHERE id = ?1",
            params![execution_id],
            |row| row.get(0),
        )?;
        Ok(payload
            .and_then(|value| serde_json::from_str(&value).ok())
            .filter(Value::is_object))
    }

    pub fn archive_task(&self, project_id: &str, task_id: &str) -> Result<(), TaskRuntimeError> {
        self.get_task(project_id, task_id)?;
        let connection = self.connection()?;
        let archived_at = now();
        let updated = connection.execute(
            "WITH RECURSIVE task_tree(id) AS (
                 SELECT id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'task'
                   AND cloud_project_id = ?2 AND deleted_at IS NULL
                 UNION ALL
                 SELECT child.id FROM loop_items child
                 JOIN task_tree parent ON child.parent_id = parent.id
                 WHERE child.resource_type = 'task'
                   AND child.cloud_project_id = ?2 AND child.deleted_at IS NULL
             )
             UPDATE loop_items
             SET deleted_at = ?3, updated_at = ?3, version = version + 1
             WHERE id IN (SELECT id FROM task_tree)",
            params![task_id, project_id, archived_at],
        )?;
        if updated == 0 {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        Ok(())
    }

    pub fn reorder_tasks(
        &self,
        project_id: &str,
        input: TaskReorder,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        validate_status(&input.status)?;
        if input.item_ids.is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "item_ids must contain at least one task".to_owned(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if task_provider(&project)? != TaskProviderKind::Local {
            return Err(TaskRuntimeError::UnsupportedProvider("external".to_owned()));
        }
        let mut statement = transaction.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id
             FROM loop_items
             WHERE resource_type = 'task' AND cloud_project_id = ?1 AND status = ?2
               AND ((?3 IS NULL AND (parent_id IS NULL OR parent_id = '')) OR parent_id = ?3)
               AND deleted_at IS NULL
             ORDER BY sort_order, updated_at DESC",
        )?;
        let lane = collect_items(statement.query_map(
            params![project_id, input.status, input.parent_id],
            map_loop_item,
        )?)?;
        drop(statement);
        let mut ordered_ids = input
            .item_ids
            .into_iter()
            .filter(|id| lane.iter().any(|item| item.id == *id))
            .collect::<Vec<_>>();
        if ordered_ids.is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "task not found in lane".to_owned(),
            ));
        }
        let remaining_ids = lane
            .iter()
            .filter(|item| !ordered_ids.contains(&item.id))
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        ordered_ids.extend(remaining_ids);
        let updated_at = now();
        for (position, item_id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE loop_items
                 SET sort_order = ?1, version = version + 1, updated_at = ?2
                 WHERE id = ?3 AND sort_order != ?1",
                params![position as i64, updated_at, item_id],
            )?;
        }
        transaction.commit()?;
        drop(connection);
        let by_id = self
            .list_tasks(project_id)?
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<std::collections::HashMap<_, _>>();
        Ok(ordered_ids
            .into_iter()
            .filter_map(|id| by_id.get(&id).cloned())
            .collect())
    }

    pub fn bind_task(
        &self,
        project_id: &str,
        item_id: Option<&str>,
        external_item_id: Option<&str>,
        input: RuntimeTaskAddress,
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
        let metadata = json!({
            "external_item_id": external_item_id,
            "project_id": project_id,
            "workflow_node_id": input.workflow_node_id,
            "workflow_stage_input": workflow_stage_input,
        });
        if let Some(active) = active {
            let target_item_id = item_id.or(external_item_id);
            let same_target = active.cloud_project_id == project_id
                && active.loop_item_id.as_deref() == target_item_id
                && active.workflow_node_id == input.workflow_node_id;
            if same_target {
                transaction.execute(
                    "UPDATE loop_items SET task_title = ?1, backend_task_id = ?2,
                            updated_at = ?3
                     WHERE id = ?4",
                    params![input.task_title, input.backend_task_id, now(), active.id],
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
        let id = numeric_id();
        let linked_at = now();
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                task_user_id, device_id, task_id, task_title, backend_task_id,
                linked_by_user_id, linked_at, metadata, version, created_at, updated_at
             ) VALUES (?1, 'execution', 'default', ?2, ?3, 0, ?4, ?5, ?6, ?7,
                       0, ?8, ?9, 1, ?8, ?8)",
            params![
                id,
                local_project_id,
                item_id,
                input.device_id,
                input.task_id,
                input.task_title,
                input.backend_task_id,
                linked_at,
                metadata.to_string(),
            ],
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_binding(&id)
    }

    pub fn list_task_bindings(&self, item_id: &str) -> Result<Vec<TaskBinding>, TaskRuntimeError> {
        self.list_task_bindings_batch(&[item_id.to_owned()])
    }

    pub fn list_task_bindings_batch(
        &self,
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
        let connection = self.connection()?;
        let mut statement = connection.prepare(&format!(
            "SELECT id, COALESCE(cloud_project_id, json_extract(metadata, '$.project_id')),
                    COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                    task_user_id, device_id,
                    task_id, task_title, backend_task_id,
                    json_extract(metadata, '$.workflow_node_id'),
                    json_extract(metadata, '$.workflow_stage_input'),
                    CASE
                        WHEN COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                             = 'default-work-items'
                        THEN 'system'
                        ELSE 'user'
                    END,
                    linked_at
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
                "SELECT id, COALESCE(cloud_project_id, json_extract(metadata, '$.project_id')),
                        COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        task_user_id, device_id,
                        task_id, task_title, backend_task_id,
                        json_extract(metadata, '$.workflow_node_id'),
                        json_extract(metadata, '$.workflow_stage_input'),
                        CASE
                            WHEN COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                                 = 'default-work-items'
                            THEN 'system'
                            ELSE 'user'
                        END,
                        linked_at
                 FROM loop_items WHERE id = ?1 AND resource_type = 'execution'",
                [id],
                map_task_binding,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub(crate) fn get_project(&self, project_id: &str) -> Result<LoopItem, TaskRuntimeError> {
        let connection = self.connection()?;
        if let Some(project) = get_item_from(&connection, project_id, "project")? {
            return Ok(project);
        }
        external_project_from_catalog(&connection, project_id)?
            .ok_or(TaskRuntimeError::ProjectNotFound)
    }

    pub(crate) fn get_item(
        &self,
        id: &str,
        resource_type: &str,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let connection = self.connection()?;
        get_item_from(&connection, id, resource_type)?.ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub(crate) fn connection(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, TaskRuntimeError> {
        self.connection
            .lock()
            .map_err(|_| TaskRuntimeError::LockPoisoned)
    }
}

fn get_effective_binding(
    connection: &Connection,
    device_id: &str,
    task_id: &str,
) -> Result<Option<TaskBinding>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, COALESCE(cloud_project_id, json_extract(metadata, '$.project_id')),
                    COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                    task_user_id, device_id,
                    task_id, task_title, backend_task_id,
                    json_extract(metadata, '$.workflow_node_id'),
                    json_extract(metadata, '$.workflow_stage_input'),
                    CASE
                        WHEN COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                             = 'default-work-items'
                        THEN 'system'
                        ELSE 'user'
                    END,
                    linked_at
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
            params![device_id, task_id],
            map_task_binding,
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

fn get_binding_by_kind(
    connection: &Connection,
    device_id: &str,
    task_id: &str,
    system: bool,
) -> Result<Option<TaskBinding>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, COALESCE(cloud_project_id, json_extract(metadata, '$.project_id')),
                    COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                    task_user_id, device_id,
                    task_id, task_title, backend_task_id,
                    json_extract(metadata, '$.workflow_node_id'),
                    json_extract(metadata, '$.workflow_stage_input'),
                    CASE
                        WHEN COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                             = 'default-work-items'
                        THEN 'system'
                        ELSE 'user'
                    END,
                    linked_at
             FROM loop_items
             WHERE resource_type = 'execution' AND device_id = ?1 AND task_id = ?2
               AND unlinked_at IS NULL
               AND (
                   COALESCE(cloud_project_id, json_extract(metadata, '$.project_id'))
                       = 'default-work-items'
               ) = ?3
             ORDER BY linked_at DESC
             LIMIT 1",
            params![device_id, task_id, system],
            map_task_binding,
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

fn validate_local_workflow_task_binding(
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

fn map_task_binding(row: &Row<'_>) -> rusqlite::Result<TaskBinding> {
    Ok(TaskBinding {
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
    })
}

fn local_workflow_stage_snapshot(
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

fn migrate(connection: &Connection) -> Result<(), TaskRuntimeError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS loop_items (
            id TEXT PRIMARY KEY,
            resource_type TEXT NOT NULL,
            project_space TEXT NOT NULL DEFAULT 'default',
            cloud_project_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            loop_item_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            delivery_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
            public_id TEXT UNIQUE,
            project_key TEXT UNIQUE,
            name TEXT,
            title TEXT,
            description TEXT NOT NULL DEFAULT '',
            storage_prefix TEXT UNIQUE,
            sequence_number INTEGER,
            next_item_number INTEGER,
            created_by_user_id INTEGER,
            updated_by_user_id INTEGER,
            assignee_user_id INTEGER,
            user_id INTEGER,
            added_by_user_id INTEGER,
            source TEXT,
            status TEXT,
            priority TEXT,
            due_at TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            current_delivery_id TEXT,
            local_project_id INTEGER,
            device_id TEXT,
            is_default INTEGER,
            task_user_id INTEGER,
            task_id TEXT,
            task_title TEXT,
            backend_task_id INTEGER,
            linked_by_user_id INTEGER,
            linked_at TEXT,
            unlinked_at TEXT,
            path TEXT,
            kind TEXT,
            display_name TEXT,
            relative_path TEXT,
            object_key TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            sha256 TEXT,
            source_task_binding_id TEXT,
            source_task_snapshot TEXT,
            markdown_object_key TEXT,
            chat_object_key TEXT,
            manifest_object_key TEXT,
            metadata TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            delivered_at TEXT,
            deleted_at TEXT,
            assignee_agent_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_loop_items_project_type
            ON loop_items(cloud_project_id, resource_type);
        CREATE INDEX IF NOT EXISTS idx_loop_items_parent_type
            ON loop_items(parent_id, resource_type, sort_order);
        CREATE INDEX IF NOT EXISTS idx_loop_items_project_path
            ON loop_items(cloud_project_id, path);
        CREATE INDEX IF NOT EXISTS ix_loop_items_resource_type
            ON loop_items(resource_type);
        CREATE INDEX IF NOT EXISTS ix_loop_items_project_space
            ON loop_items(project_space);
        CREATE INDEX IF NOT EXISTS ix_loop_items_deleted_at
            ON loop_items(deleted_at);
        CREATE TABLE IF NOT EXISTS loop_item_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            loop_item_id TEXT NOT NULL,
            cloud_project_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            execution_environment TEXT NOT NULL DEFAULT 'local',
            execution_device_id TEXT,
            runtime_instance_id TEXT NOT NULL DEFAULT '',
            assigner_user_id INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'queued',
            priority_weight INTEGER NOT NULL DEFAULT 0,
            queued_at TEXT,
            started_at TEXT,
            completed_at TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            retry_attempt INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 1,
            error_message TEXT NOT NULL DEFAULT '',
            execution_note TEXT NOT NULL DEFAULT '',
            approval_status TEXT,
            approved_by_user_id INTEGER,
            approved_at TEXT,
            rejected_reason TEXT,
            runtime_device_id TEXT,
            runtime_task_id TEXT,
            execution_payload TEXT,
            attempt_no INTEGER NOT NULL DEFAULT 1,
            previous_execution_id INTEGER,
            execution_scope TEXT NOT NULL DEFAULT '',
            observed_state TEXT NOT NULL DEFAULT 'unconfirmed',
            sync_state TEXT NOT NULL DEFAULT 'pending',
            claimed_at TEXT,
            start_requested_at TEXT,
            observed_at TEXT,
            cancel_requested_at TEXT,
            last_event_seq INTEGER NOT NULL DEFAULT 0,
            termination_reason TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_exec_device_status_order
            ON loop_item_executions(execution_device_id, status, priority_weight, queued_at);
        CREATE INDEX IF NOT EXISTS ix_exec_agent_status
            ON loop_item_executions(agent_id, status);
        CREATE INDEX IF NOT EXISTS ix_exec_item_status
            ON loop_item_executions(loop_item_id, status);
        CREATE TABLE IF NOT EXISTS loop_item_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE,
            client_message_id TEXT,
            project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            sender_type TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            message_type TEXT NOT NULL DEFAULT 'text',
            content TEXT NOT NULL DEFAULT '',
            metadata TEXT NOT NULL DEFAULT '{}',
            trigger_message_id TEXT,
            reply_to_message_id TEXT,
            thread_root_message_id TEXT,
            status TEXT NOT NULL DEFAULT 'completed',
            sequence_number INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_loop_item_comments_task
            ON loop_item_comments(task_id, sequence_number);
        CREATE TABLE IF NOT EXISTS project_provider_credentials (
            project_store TEXT NOT NULL,
            project_id TEXT NOT NULL,
            task_provider TEXT NOT NULL,
            provider_config TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_store, project_id)
        );
        CREATE TABLE IF NOT EXISTS external_project_catalog (
            project_store TEXT NOT NULL,
            project_id TEXT NOT NULL,
            descriptor TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_store, project_id)
        );",
    )?;
    // Existing databases created before assignee_agent_id existed.
    let has_assignee_agent = connection
        .prepare("PRAGMA table_info(loop_items)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "assignee_agent_id");
    if !has_assignee_agent {
        connection.execute(
            "ALTER TABLE loop_items ADD COLUMN assignee_agent_id TEXT",
            [],
        )?;
    }
    let execution_columns = connection
        .prepare("PRAGMA table_info(loop_item_executions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for (column, definition) in [
        ("attempt_no", "INTEGER NOT NULL DEFAULT 1"),
        ("previous_execution_id", "INTEGER"),
        ("execution_scope", "TEXT NOT NULL DEFAULT ''"),
        ("observed_state", "TEXT NOT NULL DEFAULT 'unconfirmed'"),
        ("sync_state", "TEXT NOT NULL DEFAULT 'pending'"),
        ("claimed_at", "TEXT"),
        ("start_requested_at", "TEXT"),
        ("observed_at", "TEXT"),
        ("cancel_requested_at", "TEXT"),
        ("last_event_seq", "INTEGER NOT NULL DEFAULT 0"),
        ("termination_reason", "TEXT NOT NULL DEFAULT ''"),
        ("runtime_instance_id", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !execution_columns.iter().any(|existing| existing == column) {
            connection.execute(
                &format!("ALTER TABLE loop_item_executions ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    connection.execute_batch(
        "UPDATE loop_item_executions
         SET attempt_no = CASE WHEN attempt_no < retry_attempt + 1
                               THEN retry_attempt + 1 ELSE attempt_no END,
             execution_scope = CASE WHEN execution_scope = ''
                                    THEN 'project_robot:' || loop_item_id
                                    ELSE execution_scope END;
         UPDATE loop_item_executions
         SET status = 'claimed',
             claimed_at = COALESCE(claimed_at, started_at, queued_at),
             start_requested_at = COALESCE(start_requested_at, started_at, updated_at),
             observed_state = 'unconfirmed', sync_state = 'stale',
             termination_reason = CASE WHEN termination_reason = ''
                                       THEN 'legacy_running_state'
                                       ELSE termination_reason END
         WHERE status = 'running' AND observed_state = 'unconfirmed';
         CREATE INDEX IF NOT EXISTS ix_exec_scope_status
             ON loop_item_executions(execution_scope, status);
         CREATE INDEX IF NOT EXISTS ix_exec_runtime_capacity
             ON loop_item_executions(runtime_instance_id, status);",
    )?;
    // The index must be created after the column exists (old databases need
    // the ALTER first; a missing column here would abort the whole migration
    // and take down the wework_space MCP server).
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_loop_items_assignee_agent_id
         ON loop_items(assignee_agent_id)",
        [],
    )?;
    let default_board_migration_applied = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM schema_migrations WHERE version = ?1
         )",
        [LOCAL_SCHEMA_VERSION],
        |row| row.get::<_, bool>(0),
    )?;
    if !default_board_migration_applied {
        let timestamp = now();
        let metadata = local_project_metadata(TaskProviderKind::Local, json!({}));
        let metadata = json!({
            "system_kind": "default_work_items",
            "project_store": metadata["project_store"],
            "task_provider": metadata["task_provider"],
            "provider_config": metadata["provider_config"],
            "board_config": metadata["board_config"],
            "tags": metadata["tags"],
        });
        let conflicting_project_ids = connection
            .prepare(
                "SELECT id FROM loop_items
                 WHERE resource_type = 'project' AND project_key = ?1 AND id != ?2",
            )?
            .query_map(
                params![DEFAULT_WORK_ITEM_PROJECT_KEY, DEFAULT_WORK_ITEM_PROJECT_ID],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        for project_id in conflicting_project_ids {
            let replacement_key = unused_project_key(connection)?;
            connection.execute(
                "UPDATE loop_items
                 SET project_key = ?1, updated_at = ?2
                 WHERE id = ?3 AND resource_type = 'project'",
                params![replacement_key, timestamp, project_id],
            )?;
        }
        connection.execute(
            "INSERT OR IGNORE INTO loop_items (
                id, resource_type, project_space, public_id, project_key, name,
                description, storage_prefix, next_item_number, status, sort_order,
                metadata, version, created_at, updated_at
             ) VALUES (?1, 'project', 'default', ?1, ?2, ?3, ?4, ?5, 1, 'active',
                       0, ?6, 1, ?7, ?7)",
            params![
                DEFAULT_WORK_ITEM_PROJECT_ID,
                DEFAULT_WORK_ITEM_PROJECT_KEY,
                "我的任务",
                "自动收纳任务，并同步每次执行的生命周期。",
                format!("projects/{DEFAULT_WORK_ITEM_PROJECT_ID}"),
                metadata.to_string(),
                timestamp,
            ],
        )?;
        connection.execute(
            "UPDATE loop_items
             SET project_key = ?1, name = ?2, description = ?3, metadata = ?4,
                 status = 'active', deleted_at = NULL, updated_at = ?5
             WHERE id = ?6 AND resource_type = 'project'",
            params![
                DEFAULT_WORK_ITEM_PROJECT_KEY,
                "我的任务",
                "自动收纳任务，并同步每次执行的生命周期。",
                metadata.to_string(),
                timestamp,
                DEFAULT_WORK_ITEM_PROJECT_ID,
            ],
        )?;
        let canonical_project_exists = connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM loop_items
                WHERE id = ?1 AND resource_type = 'project'
                  AND project_key = ?2
                  AND json_extract(metadata, '$.system_kind') = 'default_work_items'
             )",
            params![DEFAULT_WORK_ITEM_PROJECT_ID, DEFAULT_WORK_ITEM_PROJECT_KEY],
            |row| row.get::<_, bool>(0),
        )?;
        if !canonical_project_exists {
            return Err(TaskRuntimeError::Invalid(
                "failed to reserve the default work-item project".to_owned(),
            ));
        }
    }
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
        params![LOCAL_SCHEMA_VERSION, now()],
    )?;
    Ok(())
}

fn unused_project_key(connection: &Connection) -> Result<String, rusqlite::Error> {
    loop {
        let candidate =
            format!("PRJ{}", &Uuid::new_v4().simple().to_string()[..8]).to_ascii_uppercase();
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_items WHERE project_key = ?1)",
            [&candidate],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Ok(candidate);
        }
    }
}

fn get_item_from(
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
                    assignee_agent_id, created_by_user_id
             FROM loop_items
             WHERE id = ?1 AND resource_type = ?2 AND deleted_at IS NULL",
            params![id, resource_type],
            map_loop_item,
        )
        .optional()
}

fn map_loop_item(row: &Row<'_>) -> rusqlite::Result<LoopItem> {
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
        metadata: row
            .get::<_, Option<String>>(16)?
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| json!({})),
        version: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        completed_at: row.get(20)?,
        assignee_agent_id: row.get(21)?,
        execution_id: None,
        execution_state: None,
    })
}

fn collect_items(
    rows: rusqlite::MappedRows<'_, impl FnMut(&Row<'_>) -> rusqlite::Result<LoopItem>>,
) -> Result<Vec<LoopItem>, TaskRuntimeError> {
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(TaskRuntimeError::from)
}

/// Newest execution attempt for one task, projected to the UI vocabulary.
fn latest_execution(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<(i64, String)>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, status, observed_state, sync_state
             FROM loop_item_executions
             WHERE loop_item_id = ?1
             ORDER BY id DESC
             LIMIT 1",
            params![item_id],
            |row| {
                let status = row.get::<_, String>(1)?;
                let observed_state = row.get::<_, String>(2)?;
                let sync_state = row.get::<_, String>(3)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    local_execution_display_state(&status, &observed_state, &sync_state),
                ))
            },
        )
        .optional()
        .map_err(TaskRuntimeError::from)
}

/// Newest execution attempt for every task in a project.
fn latest_executions_for_project(
    connection: &Connection,
    project_id: &str,
) -> Result<HashMap<String, (i64, String)>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT e.loop_item_id, e.id, e.status, e.observed_state, e.sync_state
         FROM loop_item_executions e
         JOIN loop_items t ON t.id = e.loop_item_id
         WHERE t.cloud_project_id = ?1 AND t.resource_type = 'task'
         ORDER BY e.id DESC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        let status = row.get::<_, String>(2)?;
        let observed_state = row.get::<_, String>(3)?;
        let sync_state = row.get::<_, String>(4)?;
        Ok((
            row.get::<_, String>(0)?,
            (
                row.get::<_, i64>(1)?,
                local_execution_display_state(&status, &observed_state, &sync_state),
            ),
        ))
    })?;
    let mut executions = HashMap::new();
    for row in rows {
        let (item_id, pair) = row?;
        executions.entry(item_id).or_insert(pair);
    }
    Ok(executions)
}

fn attach_execution(mut item: LoopItem, execution: Option<(i64, String)>) -> LoopItem {
    if let Some((id, status)) = execution {
        item.execution_id = Some(id);
        item.execution_state = Some(status);
    }
    item
}

pub(crate) fn task_provider(project: &LoopItem) -> Result<TaskProviderKind, TaskRuntimeError> {
    serde_json::from_value(
        project
            .metadata
            .get("task_provider")
            .cloned()
            .unwrap_or_else(|| json!("local")),
    )
    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
}

pub(crate) fn validate_provider(
    store: ProjectStoreKind,
    provider: TaskProviderKind,
) -> Result<(), TaskRuntimeError> {
    let valid = matches!(
        (store, provider),
        (ProjectStoreKind::Local, TaskProviderKind::Local)
            | (ProjectStoreKind::Local, TaskProviderKind::Github)
            | (ProjectStoreKind::Local, TaskProviderKind::Gitlab)
            | (ProjectStoreKind::Local, TaskProviderKind::DingtalkAitable)
            | (ProjectStoreKind::Backend, TaskProviderKind::Backend)
            | (ProjectStoreKind::Backend, TaskProviderKind::Github)
            | (ProjectStoreKind::Backend, TaskProviderKind::Gitlab)
            | (ProjectStoreKind::Backend, TaskProviderKind::DingtalkAitable)
    );
    valid
        .then_some(())
        .ok_or_else(|| TaskRuntimeError::Invalid("invalid project/provider combination".to_owned()))
}

fn project_store_key(store: ProjectStoreKind) -> &'static str {
    match store {
        ProjectStoreKind::Local => "local",
        ProjectStoreKind::Backend => "backend",
    }
}

fn task_provider_key(provider: TaskProviderKind) -> &'static str {
    match provider {
        TaskProviderKind::Local => "local",
        TaskProviderKind::Backend => "backend",
        TaskProviderKind::Github => "github",
        TaskProviderKind::Gitlab => "gitlab",
        TaskProviderKind::DingtalkAitable => "dingtalk_aitable",
    }
}

fn provider_credential_config(
    connection: &Connection,
    project_store: &str,
    project_id: &str,
) -> Result<Option<serde_json::Value>, TaskRuntimeError> {
    let serialized = connection
        .query_row(
            "SELECT provider_config FROM project_provider_credentials
             WHERE project_store = ?1 AND project_id = ?2",
            params![project_store, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    serialized
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .transpose()
}

fn list_external_projects(connection: &Connection) -> Result<Vec<LoopItem>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT project_id, descriptor
         FROM external_project_catalog
         WHERE project_store = 'backend'
         ORDER BY updated_at DESC",
    )?;
    let descriptors = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    descriptors
        .into_iter()
        .filter_map(|(project_id, serialized)| {
            let descriptor = match serde_json::from_str::<ProjectDescriptor>(&serialized) {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    eprintln!(
                        "ignoring incompatible cached external project {project_id}: {error}"
                    );
                    return None;
                }
            };
            let provider_config = provider_credential_config(
                connection,
                project_store_key(descriptor.project_store),
                &descriptor.id,
            )
            .map(|config| config.unwrap_or_else(|| json!({})))
            .map(|config| descriptor_loop_item(descriptor, config));
            Some(provider_config)
        })
        .collect()
}

fn external_project_from_catalog(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<LoopItem>, TaskRuntimeError> {
    let serialized = connection
        .query_row(
            "SELECT descriptor
             FROM external_project_catalog
             WHERE project_store = 'backend' AND project_id = ?1",
            [project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    serialized
        .map(|serialized| {
            let descriptor = serde_json::from_str::<ProjectDescriptor>(&serialized)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            let provider_config = provider_credential_config(
                connection,
                project_store_key(descriptor.project_store),
                &descriptor.id,
            )?
            .unwrap_or_else(|| json!({}));
            Ok(descriptor_loop_item(descriptor, provider_config))
        })
        .transpose()
}

fn descriptor_loop_item(
    project: ProjectDescriptor,
    provider_config: serde_json::Value,
) -> LoopItem {
    LoopItem {
        id: project.id,
        resource_type: "project".to_owned(),
        project_space: "default".to_owned(),
        cloud_project_id: None,
        parent_id: None,
        public_id: project.public_id,
        project_key: Some(project.project_key),
        name: Some(project.name),
        title: None,
        description: project.description,
        created_by_user_id: 0,
        sequence_number: None,
        next_item_number: Some(1),
        status: Some("active".to_owned()),
        priority: None,
        sort_order: 0,
        current_delivery_id: None,
        metadata: json!({
            "project_store": project.project_store,
            "task_provider": project.task_provider,
            "provider_config": provider_config,
            "tags": [],
        }),
        version: project.version,
        created_at: String::new(),
        updated_at: String::new(),
        completed_at: None,
        assignee_agent_id: None,
        execution_id: None,
        execution_state: None,
    }
}

fn local_project_metadata(task_provider: TaskProviderKind, provider_config: Value) -> Value {
    json!({
        "project_store": ProjectStoreKind::Local,
        "task_provider": task_provider,
        "provider_config": provider_config,
        "board_config": {
            "group_by": "status",
            "statuses": [
                {"id": "inbox", "name": "收集箱", "color": "gray"},
                {"id": "pending", "name": "待开始", "color": "blue"},
                {"id": "in_progress", "name": "进行中", "color": "orange"},
                {"id": "in_review", "name": "待确认", "color": "purple"},
                {"id": "completed", "name": "已完成", "color": "green"}
            ]
        },
        "tags": [],
    })
}

fn require_parent(
    connection: &Connection,
    project_id: &str,
    parent_id: &str,
    moving_task_id: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    let parent = get_item_from(connection, parent_id, "task")?
        .filter(|item| item.cloud_project_id.as_deref() == Some(project_id))
        .ok_or_else(|| TaskRuntimeError::Invalid("parent task is not in the project".to_owned()))?;
    let mut cursor = Some(parent);
    while let Some(item) = cursor {
        if moving_task_id == Some(item.id.as_str()) {
            return Err(TaskRuntimeError::Invalid(
                "task hierarchy cannot contain a cycle".to_owned(),
            ));
        }
        cursor = match item.parent_id {
            Some(parent_id) => get_item_from(connection, &parent_id, "task")?,
            None => None,
        };
    }
    Ok(())
}

fn normalize_project_key(value: Option<String>, name: &str) -> String {
    let normalized = value.unwrap_or_else(|| {
        name.chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(8)
            .collect()
    });
    let normalized = normalized.trim().to_ascii_uppercase();
    if normalized.len() >= 2 {
        normalized.chars().take(16).collect()
    } else {
        format!("PRJ{}", &Uuid::new_v4().simple().to_string()[..6]).to_ascii_uppercase()
    }
}

fn validate_name(value: &str, label: &str) -> Result<(), TaskRuntimeError> {
    let length = value.trim().chars().count();
    if length == 0 || length > 255 {
        return Err(TaskRuntimeError::Invalid(format!(
            "{label} must contain 1 to 255 characters"
        )));
    }
    Ok(())
}

fn validate_status(value: &str) -> Result<(), TaskRuntimeError> {
    matches!(
        value,
        "inbox" | "pending" | "in_progress" | "in_review" | "completed"
    )
    .then_some(())
    .ok_or_else(|| TaskRuntimeError::Invalid("invalid task status".to_owned()))
}

fn validate_priority(value: &str) -> Result<(), TaskRuntimeError> {
    matches!(value, "none" | "low" | "medium" | "high" | "urgent")
        .then_some(())
        .ok_or_else(|| TaskRuntimeError::Invalid("invalid task priority".to_owned()))
}

fn instantiate_local_workflow(definition: &Value) -> Result<Value, TaskRuntimeError> {
    let version = definition
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let definitions = definition
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids = definitions
        .iter()
        .filter_map(|node| node.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<HashSet<_>>();
    if ids.len() != definitions.len() {
        return Err(TaskRuntimeError::Invalid(
            "workflow node ids must be unique and non-empty".to_owned(),
        ));
    }
    let dependency_map = definitions
        .iter()
        .map(|node| {
            let node_id = node
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let dependencies = node
                .get("depends_on")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            (node_id, dependencies)
        })
        .collect::<HashMap<_, _>>();
    fn visit_workflow_node(
        node_id: &str,
        dependencies: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> Result<(), TaskRuntimeError> {
        if visiting.contains(node_id) {
            return Err(TaskRuntimeError::Invalid(
                "workflow dependencies must be acyclic".to_owned(),
            ));
        }
        if visited.contains(node_id) {
            return Ok(());
        }
        visiting.insert(node_id.to_owned());
        for dependency in dependencies.get(node_id).into_iter().flatten() {
            visit_workflow_node(dependency, dependencies, visiting, visited)?;
        }
        visiting.remove(node_id);
        visited.insert(node_id.to_owned());
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for node_id in &ids {
        visit_workflow_node(node_id, &dependency_map, &mut visiting, &mut visited)?;
    }
    let mut nodes = Vec::with_capacity(definitions.len());
    for definition in definitions {
        let dependencies = definition
            .get("depends_on")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if dependencies
            .iter()
            .filter_map(Value::as_str)
            .any(|dependency| !ids.contains(dependency))
        {
            return Err(TaskRuntimeError::Invalid(
                "workflow dependency does not exist".to_owned(),
            ));
        }
        let mut node = definition;
        node["status"] = json!(if dependencies.is_empty() {
            "ready"
        } else {
            "blocked"
        });
        node["task_binding_id"] = Value::Null;
        node["execution_id"] = Value::Null;
        nodes.push(node);
    }
    Ok(json!({
        "version": 1,
        "definition_version": version,
        "nodes": nodes,
    }))
}

fn local_database_path() -> PathBuf {
    let home = env::var_os("WEGENT_EXECUTOR_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"));
    home.join("data").join("tasks.sqlite")
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn numeric_id() -> String {
    let prefix = &Uuid::new_v4().simple().to_string()[..13];
    u64::from_str_radix(prefix, 16)
        .expect("UUID prefix should be hexadecimal")
        .to_string()
}

fn map_chat_agent(row: LoopItem) -> ChatAgent {
    let metadata = row.metadata;
    let text = |key: &str, default: &str| {
        metadata
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_owned()
    };
    ChatAgent {
        id: row.id.clone(),
        project_id: row.cloud_project_id.clone().unwrap_or_default(),
        name: row.title.or(row.name).unwrap_or_else(|| "AI".to_owned()),
        runtime: "codex".to_owned(),
        model: metadata
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
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
        local_project_id: metadata.get("local_project_id").and_then(Value::as_i64),
        created_by_user_id: row.created_by_user_id,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn insert_comment(
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
    comment_row(connection, &message_id)
}

fn map_comment(row: &Row<'_>) -> rusqlite::Result<LocalComment> {
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

fn comment_row(
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

fn map_execution(row: &Row<'_>) -> rusqlite::Result<LocalExecution> {
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
        task_title: row.get(38)?,
        task_status: row.get(39)?,
        task_priority: row.get(40)?,
        agent_name: row
            .get::<_, Option<String>>(41)?
            .or(row.get::<_, Option<String>>(42)?)
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
        agent_max_concurrent_executions: agent_metadata
            .get("max_concurrent_executions")
            .and_then(Value::as_u64)
            .filter(|value| (1..=20).contains(value))
            .unwrap_or(1),
    })
}

fn local_execution_display_state(status: &str, observed_state: &str, sync_state: &str) -> String {
    match status {
        "completed" => "succeeded",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ if matches!(sync_state, "stale" | "diverged") => "unknown",
        "pending_approval" => "waiting_approval",
        "queued" => "queued",
        "cancel_requested" => "cancelling",
        "claimed" if observed_state == "unconfirmed" => "starting",
        "claimed" => "waiting_runtime",
        "running" if observed_state == "running" => "running",
        _ => "waiting_runtime",
    }
    .to_owned()
}

fn execution_row(
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
                t.title, t.status, t.priority,
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

fn cancel_active_executions(
    connection: &Connection,
    item_id: &str,
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
        return Err(TaskRuntimeError::Invalid(
            "Stop the active Runtime task before changing its robot assignee".to_owned(),
        ));
    }
    let active: Vec<i64> = {
        let mut statement = connection.prepare(
            "SELECT id FROM loop_item_executions
             WHERE loop_item_id = ?1
               AND (status IN ('pending_approval', 'queued')
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
             execution_note = 'Assignee changed before the run finished',
             termination_reason = 'cancelled_before_start',
             version = version + 1, updated_at = ?1
         WHERE id IN ({placeholders})"
    );
    connection.execute(
        &sql,
        rusqlite::params_from_iter(
            std::iter::once(now.clone()).chain(active.iter().map(|id| id.to_string())),
        ),
    )?;
    let note = "Assignee changed before the run finished";
    for execution_id in active {
        update_agent_comment(connection, execution_id, "cancelled", note, &now)?;
    }
    Ok(())
}

fn update_agent_comment(
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
    Ok(())
}

fn create_local_execution(
    connection: &Connection,
    item_id: &str,
    project_id: &str,
    agent_id: &str,
    agent: &LoopItem,
    priority: &str,
    payload: Value,
) -> Result<(), TaskRuntimeError> {
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
    Ok(())
}

fn priority_weight(priority: &str) -> i64 {
    match priority {
        "low" => 10,
        "medium" => 20,
        "high" => 30,
        "urgent" => 40,
        _ => 0,
    }
}

fn lease_expiry(now: &str, lease_seconds: u64) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(now)
        .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
        .naive_utc();
    (parsed + chrono::Duration::seconds(lease_seconds as i64))
        .and_utc()
        .to_rfc3339()
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_owned()
    } else {
        value.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::task_runtime::{BinaryInput, DeliveryCreate};

    fn chat_agent_store() -> (TempDir, LocalTaskStore, LoopItem) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Robot project".to_owned(),
                project_key: Some("RBOT".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        (directory, store, project)
    }

    fn make_local_agent(store: &LocalTaskStore, project_id: &str, mode: &str) -> ChatAgent {
        store
            .create_chat_agent(
                project_id,
                ChatAgentCreate {
                    name: "Local Bot".to_owned(),
                    model: None,
                    system_prompt: Some("Be careful.".to_owned()),
                    visibility: Some("creator_admin".to_owned()),
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some(mode.to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: Some(7),
                },
            )
            .unwrap()
    }

    fn accept_and_start(store: &LocalTaskStore, claimed: &LocalExecution) -> LocalExecution {
        let device_id = claimed.runtime_device_id.as_deref().unwrap();
        let task_id = claimed.runtime_task_id.as_deref().unwrap();
        store
            .request_runtime_start(claimed.id, device_id, task_id, 300)
            .unwrap()
            .expect("start intent must be fenced");
        store
            .confirm_runtime_accepted(claimed.id, device_id, task_id, 300)
            .unwrap()
            .expect("Runtime acceptance must be recorded");
        store
            .mark_runtime_running(task_id)
            .unwrap()
            .expect("first Runtime event must prove running")
    }

    #[test]
    fn chat_agent_crud_and_task_assignment_create_execution() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "auto");
        let listed = store.list_chat_agents(&project.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Local Bot");
        assert_eq!(
            listed[0].execution_device_id.as_deref(),
            Some("local-device")
        );

        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Do the thing".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "high".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let updated = store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "run it"})),
                    workflow: None,
                },
            )
            .unwrap();
        assert_eq!(
            updated.assignee_agent_id.as_deref(),
            Some(agent.id.as_str())
        );

        let executions = store
            .list_executions(&project.id, None, None, false)
            .unwrap();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].agent_id, agent.id);
        assert_eq!(executions[0].status, "queued");
        assert_eq!(executions[0].priority_weight, 30);
        assert!(executions[0].execution_payload.is_some());

        // Assignment-started runs carry an optimistic agent comment so the
        // finished outcome has a row to write back into the task thread.
        let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].sender_type, "agent");
        assert_eq!(comments[0].sender_id, agent.id);
        assert_eq!(comments[0].status, "streaming");
        assert_eq!(
            comments[0].metadata["execution_id"],
            json!(executions[0].id)
        );
    }

    #[test]
    fn local_comment_thread_and_enqueue_writeback() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Comment run".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "medium".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();

        let user_comment = store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: task.id.clone(),
                client_message_id: Some("cm-1".to_owned()),
                sender_type: "user".to_owned(),
                sender_id: "1".to_owned(),
                sender_name: "Ada".to_owned(),
                content: "@Local Bot 看一下".to_owned(),
                metadata: json!({
                    "mentions": [{"type": "agent", "id": agent.id, "label": "Local Bot"}]
                }),
                reply_to_message_id: None,
            })
            .unwrap();
        assert_eq!(user_comment.sequence_number, 1);
        assert_eq!(
            user_comment.thread_root_message_id.as_deref(),
            Some(user_comment.message_id.as_str())
        );

        let execution = store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"text": "@Local Bot 看一下"}),
                Some(&user_comment.message_id),
            )
            .unwrap();
        assert_eq!(execution.status, "queued");
        assert_eq!(execution.task_title, "Comment run");

        let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
        assert_eq!(comments.len(), 2);
        let agent_comment = comments
            .iter()
            .find(|comment| comment.sender_type == "agent")
            .unwrap();
        assert_eq!(agent_comment.status, "streaming");
        assert_eq!(
            agent_comment.reply_to_message_id.as_deref(),
            Some(user_comment.message_id.as_str())
        );
        assert_eq!(
            agent_comment.thread_root_message_id.as_deref(),
            Some(user_comment.message_id.as_str())
        );

        let updated = store
            .update_agent_comment_for_execution(execution.id, "completed", "搞定")
            .unwrap()
            .unwrap();
        assert_eq!(updated.status, "completed");
        assert_eq!(updated.content, "搞定");

        let after = store
            .list_comments(&project.id, &task.id, user_comment.sequence_number)
            .unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].sender_type, "agent");
    }

    #[test]
    fn local_assignment_execution_writeback_stamps_runtime_address() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Assigned run".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: None,
                    workflow: None,
                },
            )
            .unwrap();
        let execution = store
            .list_executions(&project.id, None, None, false)
            .unwrap()
            .remove(0);
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let claimed = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("run must be claimable");
        assert!(store
            .heartbeat_execution(
                claimed.id,
                Some("local-device"),
                Some("different-runtime-task"),
                300,
            )
            .unwrap()
            .is_none());
        let unchanged = execution_row(&store.connection().unwrap(), claimed.id).unwrap();
        assert_eq!(unchanged.runtime_task_id, claimed.runtime_task_id);
        let running = accept_and_start(&store, &claimed);
        // The runtime address is stamped at dispatch time so the task thread
        // can open live execution details while the run is still streaming.
        let streaming_comments = store.list_comments(&project.id, &task.id, 0).unwrap();
        assert_eq!(streaming_comments.len(), 1);
        assert_eq!(streaming_comments[0].status, "streaming");
        assert_eq!(
            streaming_comments[0].metadata["runtime_address"],
            json!({"deviceId": "local-device", "taskId": running.runtime_task_id.unwrap()})
        );
        store.complete_execution(execution.id, None).unwrap();

        let updated = store
            .update_agent_comment_for_execution(execution.id, "completed", "搞定")
            .unwrap()
            .expect("comment write-back must land");
        assert_eq!(updated.status, "completed");
        assert_eq!(updated.content, "搞定");
        assert_eq!(
            updated.metadata["runtime_address"],
            json!({"deviceId": "local-device", "taskId": claimed.runtime_task_id.unwrap()})
        );
        assert_eq!(
            store
                .get_task(&project.id, &task.id)
                .unwrap()
                .status
                .as_deref(),
            Some("in_review")
        );
    }

    #[test]
    fn local_execution_writeback_creates_missing_agent_comment() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Legacy run".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: None,
                    workflow: None,
                },
            )
            .unwrap();
        let execution = store
            .list_executions(&project.id, None, None, false)
            .unwrap()
            .remove(0);
        // Simulate a pre-fix run whose optimistic comment row is missing.
        store
            .connection()
            .unwrap()
            .execute(
                "DELETE FROM loop_item_comments WHERE task_id = ?1",
                params![task.id],
            )
            .unwrap();
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let claimed = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("run must be claimable");
        accept_and_start(&store, &claimed);
        store.complete_execution(execution.id, None).unwrap();

        let created = store
            .update_agent_comment_for_execution(execution.id, "completed", "修复完成")
            .unwrap()
            .expect("missing comment must be created");
        assert_eq!(created.sender_type, "agent");
        assert_eq!(created.sender_id, agent.id);
        assert_eq!(created.status, "completed");
        assert_eq!(created.content, "修复完成");
        assert_eq!(
            created.metadata["runtime_address"],
            json!({"deviceId": "local-device", "taskId": claimed.runtime_task_id.unwrap()})
        );
        let comments = store.list_comments(&project.id, &task.id, 0).unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].message_id, created.message_id);
    }

    #[test]
    fn local_complete_execution_advances_task_to_review() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Review me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "run"})),
                    workflow: None,
                },
            )
            .unwrap();
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let claimed = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("run must be claimable");
        store.complete_execution(claimed.id, Some("done")).unwrap();

        let updated = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(updated.status.as_deref(), Some("in_review"));
        assert_eq!(updated.execution_state.as_deref(), Some("succeeded"));
        // A task that is already in review is not advanced again.
        let second = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Already reviewed".to_owned(),
                    description: String::new(),
                    status: "in_review".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &second.id,
                TaskUpdate {
                    version: second.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "run"})),
                    workflow: None,
                },
            )
            .unwrap();
        let claimed_second = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("second run must be claimable");
        store.complete_execution(claimed_second.id, None).unwrap();
        let second_after = store.get_task(&project.id, &second.id).unwrap();
        assert_eq!(second_after.status.as_deref(), Some("in_review"));
    }

    #[test]
    fn manual_approval_flow_and_claim_runs_once() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "manual_approval");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Approve me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "run it"})),
                    workflow: None,
                },
            )
            .unwrap();
        let executions = store
            .list_executions(&project.id, None, None, false)
            .unwrap();
        assert_eq!(executions[0].status, "pending_approval");
        assert_eq!(executions[0].approval_status.as_deref(), Some("pending"));

        // Not approved -> not claimable.
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        assert!(store.claim_next_local_execution(&claim).unwrap().is_none());

        store.approve_execution(executions[0].id).unwrap();
        let claimed = store.claim_next_local_execution(&claim).unwrap().unwrap();
        assert_eq!(claimed.status, "claimed");
        assert!(claimed.lease_expires_at.is_some());
        // Only one run at a time.
        assert!(store.claim_next_local_execution(&claim).unwrap().is_none());

        accept_and_start(&store, &claimed);
        let done = store.complete_execution(claimed.id, None).unwrap().unwrap();
        assert_eq!(done.status, "completed");
    }

    #[test]
    fn local_task_responses_carry_execution_state() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "manual_approval");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Approve me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let updated = store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: None,
                    workflow: None,
                },
            )
            .unwrap();
        assert_eq!(updated.execution_state.as_deref(), Some("waiting_approval"));
        assert!(updated.execution_id.is_some());

        let fetched = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(fetched.execution_state.as_deref(), Some("waiting_approval"));

        let listed = store.list_tasks(&project.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].execution_state.as_deref(),
            Some("waiting_approval")
        );

        let executions = store
            .list_executions(&project.id, None, None, false)
            .unwrap();
        store.approve_execution(executions[0].id).unwrap();
        let after = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(after.execution_state.as_deref(), Some("queued"));
    }

    #[test]
    fn chat_agent_persists_creator_id() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Creator Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("manual_approval".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: Some(42),
                },
            )
            .unwrap();
        assert_eq!(agent.created_by_user_id, 42);
        let listed = store.list_chat_agents(&project.id).unwrap();
        assert_eq!(listed[0].created_by_user_id, 42);
    }

    #[test]
    fn chat_agent_persists_local_project_binding() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Bound Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("auto".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: Some(7),
                    created_by_user_id: Some(7),
                },
            )
            .unwrap();
        assert_eq!(agent.local_project_id, Some(7));
        let listed = store.list_chat_agents(&project.id).unwrap();
        assert_eq!(listed[0].local_project_id, Some(7));

        let updated = store
            .update_chat_agent(
                &project.id,
                &agent.id,
                ChatAgentUpdate {
                    version: agent.version,
                    name: None,
                    model: None,
                    system_prompt: None,
                    status: None,
                    visibility: None,
                    execution_environment: None,
                    execution_mode: None,
                    execution_device_id: None,
                    max_concurrent_executions: None,
                    local_project_id: Some(Some(9)),
                },
            )
            .unwrap();
        assert_eq!(updated.local_project_id, Some(9));

        let cleared = store
            .update_chat_agent(
                &project.id,
                &agent.id,
                ChatAgentUpdate {
                    version: updated.version,
                    name: None,
                    model: None,
                    system_prompt: None,
                    status: None,
                    visibility: None,
                    execution_environment: None,
                    execution_mode: None,
                    execution_device_id: None,
                    max_concurrent_executions: None,
                    local_project_id: Some(None),
                },
            )
            .unwrap();
        assert_eq!(cleared.local_project_id, None);
    }

    #[test]
    fn local_claim_respects_device_capacity() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent_a = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Bot A".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("auto".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 20,
                    local_project_id: None,
                    created_by_user_id: None,
                },
            )
            .unwrap();
        let agent_b = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Bot B".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("auto".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: None,
                },
            )
            .unwrap();
        for (agent, title) in [(agent_a.clone(), "A1"), (agent_a, "A2"), (agent_b, "B")] {
            let task = store
                .create_task(
                    &project.id,
                    TaskCreate {
                        title: title.to_owned(),
                        description: String::new(),
                        status: "inbox".to_owned(),
                        priority: "none".to_owned(),
                        parent_id: None,
                        tags: vec![],
                        workflow: None,
                    },
                )
                .unwrap();
            store
                .update_task(
                    &project.id,
                    &task.id,
                    TaskUpdate {
                        version: task.version,
                        title: None,
                        description: None,
                        status: None,
                        priority: None,
                        parent_id: None,
                        tags: None,
                        assignee_agent_id: Some(Some(agent.id.clone())),
                        execution_payload: Some(json!({"message": title})),
                        workflow: None,
                    },
                )
                .unwrap();
        }
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let first = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("first robot should claim");
        // Capacity 1 -> the second robot's run stays queued.
        assert!(store.claim_next_local_execution(&claim).unwrap().is_none());

        let manual_process = LocalExecutionClaim {
            device_capacity: 2,
            runtime_active: 1,
            runtime_active_task_ids: vec!["manual-task".to_owned()],
            ..claim.clone()
        };
        assert!(store
            .claim_next_local_execution(&manual_process)
            .unwrap()
            .is_none());

        let observed_first = LocalExecutionClaim {
            device_capacity: 2,
            runtime_active: 1,
            runtime_active_task_ids: vec![first.runtime_task_id.unwrap()],
            ..claim
        };
        assert!(store
            .claim_next_local_execution(&observed_first)
            .unwrap()
            .is_some_and(|execution| execution.agent_name == "Bot B"));
    }

    #[test]
    fn local_claim_allows_configured_robot_parallelism() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Parallel Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("auto".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 2,
                    local_project_id: None,
                    created_by_user_id: Some(7),
                },
            )
            .unwrap();
        for index in 0..3 {
            let task = store
                .create_task(
                    &project.id,
                    TaskCreate {
                        title: format!("Parallel {index}"),
                        description: String::new(),
                        status: "inbox".to_owned(),
                        priority: "none".to_owned(),
                        parent_id: None,
                        tags: vec![],
                        workflow: None,
                    },
                )
                .unwrap();
            store
                .update_task(
                    &project.id,
                    &task.id,
                    TaskUpdate {
                        version: task.version,
                        title: None,
                        description: None,
                        status: None,
                        priority: None,
                        parent_id: None,
                        tags: None,
                        assignee_agent_id: Some(Some(agent.id.clone())),
                        execution_payload: Some(json!({"message": "run"})),
                        workflow: None,
                    },
                )
                .unwrap();
        }
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 4,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };

        assert!(store.claim_next_local_execution(&claim).unwrap().is_some());
        assert!(store.claim_next_local_execution(&claim).unwrap().is_some());
        assert!(store.claim_next_local_execution(&claim).unwrap().is_none());
    }

    #[test]
    fn local_claim_binds_unbound_execution_to_claiming_device() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Unbound Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("auto".to_owned()),
                    // Robots created before device binding have no device.
                    execution_device_id: None,
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: Some(7),
                },
            )
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Run unbound".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "go"})),
                    workflow: None,
                },
            )
            .unwrap();
        let executions = store
            .list_executions(&project.id, None, None, false)
            .unwrap();
        assert_eq!(executions[0].execution_device_id, None);

        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 1,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let claimed = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("unbound local run must be claimable");
        assert_eq!(claimed.status, "claimed");
        assert_eq!(claimed.execution_device_id.as_deref(), Some("local-device"));
    }

    #[test]
    fn local_fail_and_reject_close_agent_comment() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;

        // Auto robot: enqueue -> queued -> claim -> terminal fail.
        let auto_agent = make_local_agent(&store, &project.id, "auto");
        let auto_task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Fail me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .enqueue_execution(
                &project.id,
                &auto_task.id,
                &auto_agent.id,
                json!({"text": "run"}),
                None,
            )
            .unwrap();
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let claimed = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("auto run must be claimable");
        accept_and_start(&store, &claimed);
        store
            .fail_execution(claimed.id, "model exploded", false)
            .unwrap();
        let comments = store.list_comments(&project.id, &auto_task.id, 0).unwrap();
        let agent_comment = comments
            .iter()
            .find(|comment| comment.sender_type == "agent")
            .unwrap();
        assert_eq!(agent_comment.status, "failed");
        assert_eq!(agent_comment.content, "model exploded");

        // Manual robot: enqueue -> pending_approval -> reject cancels the run
        // and must close the optimistic comment too.
        let manual_agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Manual Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("manual_approval".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: Some(7),
                },
            )
            .unwrap();
        let manual_task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Reject me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let manual_run = store
            .enqueue_execution(
                &project.id,
                &manual_task.id,
                &manual_agent.id,
                json!({"text": "run"}),
                None,
            )
            .unwrap();
        assert_eq!(manual_run.status, "pending_approval");
        store
            .reject_execution(manual_run.id, Some("not now".to_owned()))
            .unwrap();
        let comments = store
            .list_comments(&project.id, &manual_task.id, 0)
            .unwrap();
        let agent_comment = comments
            .iter()
            .find(|comment| comment.sender_type == "agent")
            .unwrap();
        assert_eq!(agent_comment.status, "cancelled");
        assert_eq!(agent_comment.content, "not now");
    }

    #[test]
    fn local_executions_list_filters_by_status_without_agent() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Status Filter Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("manual_approval".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: Some(7),
                },
            )
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Approval task".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "run"})),
                    workflow: None,
                },
            )
            .unwrap();
        // Regression: status-only listing must not fail the placeholder count.
        let pending = store
            .list_executions(&project.id, None, Some("pending_approval"), false)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].status, "pending_approval");
        let running = store
            .list_executions(&project.id, None, Some("running"), false)
            .unwrap();
        assert!(running.is_empty());
    }

    #[test]
    fn local_recovery_requeues_expired_runs() {
        let (directory, store, project) = chat_agent_store();
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Recover me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let execution = store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"text": "run"}),
                None,
            )
            .unwrap();
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let claimed = store
            .claim_next_local_execution(&claim)
            .unwrap()
            .expect("run must be claimable");
        assert_eq!(claimed.id, execution.id);

        // Expire the lease out-of-band, as if the app crashed mid-run.
        let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE loop_item_executions
                 SET lease_expires_at = '2000-01-01T00:00:00+00:00'
                 WHERE id = ?1",
                params![execution.id],
            )
            .unwrap();
        drop(connection);

        let (requeued, unknown) = store.recover_stale_local_executions().unwrap();
        assert_eq!(requeued, 1);
        assert_eq!(unknown, 0);
        let recovered = store
            .list_executions(&project.id, None, None, false)
            .unwrap();
        assert_eq!(recovered[0].status, "queued");
        assert_eq!(recovered[0].retry_attempt, 0);
    }

    #[test]
    fn local_reconciliation_uses_runtime_turn_truth() {
        let (directory, store, project) = chat_agent_store();
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Reconcile me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"message": "run"}),
                None,
            )
            .unwrap();
        let claimed = store
            .claim_next_local_execution(&LocalExecutionClaim {
                execution_device_id: Some("local-device".to_owned()),
                runtime_instance_id: "runtime-1".to_owned(),
                device_capacity: 5,
                runtime_active: 0,
                runtime_active_task_ids: vec![],
                lease_seconds: 300,
            })
            .unwrap()
            .expect("run must be claimed");
        let device_id = claimed.runtime_device_id.as_deref().unwrap();
        let task_id = claimed.runtime_task_id.as_deref().unwrap();
        store
            .request_runtime_start(claimed.id, device_id, task_id, 300)
            .unwrap();

        let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE loop_item_executions
                 SET sync_state = 'stale', error_message = 'lost event'
                 WHERE id = ?1",
                params![claimed.id],
            )
            .unwrap();
        drop(connection);
        assert_eq!(store.stale_local_executions().unwrap().len(), 1);

        let accepted = store
            .reconcile_execution_snapshot(claimed.id, "queued", false, None)
            .unwrap()
            .expect("queued Runtime task must reconcile");
        assert_eq!(accepted.status, "claimed");
        assert_eq!(accepted.observed_state, "accepted");
        assert_eq!(accepted.sync_state, "in_sync");
        assert_eq!(accepted.display_state, "waiting_runtime");
        assert!(accepted.started_at.is_none());
        assert!(accepted.error_message.is_empty());

        let completed = store
            .reconcile_execution_snapshot(claimed.id, "active", false, Some("completed"))
            .unwrap()
            .expect("completed Runtime turn must terminalize the run");
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.observed_state, "succeeded");
        assert_eq!(completed.display_state, "succeeded");
    }

    #[test]
    fn local_cancel_terminalizes_only_before_runtime_delivery() {
        let (directory, store, project) = chat_agent_store();
        let _ = directory;
        let agent = make_local_agent(&store, &project.id, "auto");
        let create_run = |title: &str| {
            let task = store
                .create_task(
                    &project.id,
                    TaskCreate {
                        title: title.to_owned(),
                        description: String::new(),
                        status: "inbox".to_owned(),
                        priority: "none".to_owned(),
                        parent_id: None,
                        tags: vec![],
                        workflow: None,
                    },
                )
                .unwrap();
            let execution = store
                .enqueue_execution(
                    &project.id,
                    &task.id,
                    &agent.id,
                    json!({"text": "run"}),
                    None,
                )
                .unwrap();
            (task, execution)
        };

        let (queued_task, queued) = create_run("Cancel before delivery");
        let cancelled = store
            .cancel_execution(queued.id, Some("stopped before start"))
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.observed_state, "cancelled");
        assert_eq!(cancelled.termination_reason, "cancelled_before_start");
        let queued_comment = store
            .list_comments(&project.id, &queued_task.id, 0)
            .unwrap()
            .into_iter()
            .find(|comment| comment.sender_type == "agent")
            .unwrap();
        assert_eq!(queued_comment.status, "cancelled");

        let (_delivered_task, delivered) = create_run("Cancel after delivery");
        let claimed = store
            .claim_next_local_execution(&LocalExecutionClaim {
                execution_device_id: Some("local-device".to_owned()),
                runtime_instance_id: "runtime-1".to_owned(),
                device_capacity: 5,
                runtime_active: 0,
                runtime_active_task_ids: vec![],
                lease_seconds: 300,
            })
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, delivered.id);
        store
            .request_runtime_start(
                claimed.id,
                claimed.runtime_device_id.as_deref().unwrap(),
                claimed.runtime_task_id.as_deref().unwrap(),
                300,
            )
            .unwrap()
            .unwrap();

        let cancelling = store
            .cancel_execution(claimed.id, Some("please stop"))
            .unwrap();
        assert_eq!(cancelling.status, "cancel_requested");
        assert_eq!(cancelling.display_state, "cancelling");
        assert_eq!(cancelling.sync_state, "pending");
        assert!(cancelling.completed_at.is_none());

        let observed = store
            .cancel_execution_observed(claimed.id, Some("Runtime stopped"))
            .unwrap()
            .unwrap();
        assert_eq!(observed.status, "cancelled");
        assert_eq!(observed.observed_state, "cancelled");
        assert_eq!(observed.termination_reason, "runtime_cancelled");
    }

    #[test]
    fn local_recovery_keeps_delivered_run_unknown_instead_of_redelivering() {
        let (directory, store, project) = chat_agent_store();
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Reconcile me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"text": "run"}),
                None,
            )
            .unwrap();
        let claimed = store
            .claim_next_local_execution(&LocalExecutionClaim {
                execution_device_id: Some("local-device".to_owned()),
                runtime_instance_id: "runtime-1".to_owned(),
                device_capacity: 5,
                runtime_active: 0,
                runtime_active_task_ids: vec![],
                lease_seconds: 300,
            })
            .unwrap()
            .unwrap();
        accept_and_start(&store, &claimed);
        let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE loop_item_executions
                 SET lease_expires_at = '2000-01-01T00:00:00+00:00'
                 WHERE id = ?1",
                params![claimed.id],
            )
            .unwrap();
        drop(connection);

        let (requeued, unknown) = store.recover_stale_local_executions().unwrap();
        assert_eq!((requeued, unknown), (0, 1));
        let execution = store
            .list_executions(&project.id, None, None, false)
            .unwrap()
            .remove(0);
        assert_eq!(execution.id, claimed.id);
        assert_eq!(execution.status, "running");
        assert_eq!(execution.display_state, "unknown");
        assert_eq!(execution.sync_state, "stale");
        assert!(store
            .claim_next_local_execution(&LocalExecutionClaim {
                execution_device_id: Some("local-device".to_owned()),
                runtime_instance_id: "runtime-1".to_owned(),
                device_capacity: 5,
                runtime_active: 0,
                runtime_active_task_ids: vec![],
                lease_seconds: 300,
            })
            .unwrap()
            .is_none());
    }

    #[test]
    fn local_runtime_failure_creates_a_new_attempt_with_a_new_identity() {
        let (_directory, store, project) = chat_agent_store();
        let agent = make_local_agent(&store, &project.id, "auto");
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Retry me".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .enqueue_execution(
                &project.id,
                &task.id,
                &agent.id,
                json!({"text": "run"}),
                None,
            )
            .unwrap();
        let claim = LocalExecutionClaim {
            execution_device_id: Some("local-device".to_owned()),
            runtime_instance_id: "runtime-1".to_owned(),
            device_capacity: 5,
            runtime_active: 0,
            runtime_active_task_ids: vec![],
            lease_seconds: 300,
        };
        let first = store.claim_next_local_execution(&claim).unwrap().unwrap();
        accept_and_start(&store, &first);

        let retry = store
            .fail_execution(first.id, "Runtime failed", true)
            .unwrap()
            .unwrap();
        assert_ne!(retry.id, first.id);
        assert_eq!(retry.status, "queued");
        assert_eq!(retry.attempt_no, 2);
        assert_eq!(retry.previous_execution_id, Some(first.id));
        let previous = execution_row(&store.connection().unwrap(), first.id).unwrap();
        assert_eq!(previous.status, "failed");
        assert_eq!(previous.runtime_task_id, first.runtime_task_id);

        let second = store.claim_next_local_execution(&claim).unwrap().unwrap();
        assert_ne!(second.runtime_task_id, first.runtime_task_id);
        assert_eq!(
            second.runtime_task_id,
            Some(format!("codex-queue-{}", second.id))
        );
    }

    #[test]
    fn migrates_legacy_schema_without_assignee_agent_id() {
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("tasks.sqlite");
        // A pre-robot database: loop_items exists without assignee_agent_id and
        // loop_item_executions does not exist yet. The migrate() step must add
        // the column before creating the index, otherwise TaskRuntime fails to
        // open and the wework_space MCP server dies during startup.
        let legacy = rusqlite::Connection::open(&db_path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );
                CREATE TABLE loop_items (
                    id TEXT PRIMARY KEY,
                    resource_type TEXT NOT NULL,
                    project_space TEXT NOT NULL DEFAULT 'default',
                    cloud_project_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
                    parent_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
                    loop_item_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
                    delivery_id TEXT REFERENCES loop_items(id) ON DELETE CASCADE,
                    public_id TEXT UNIQUE,
                    project_key TEXT UNIQUE,
                    name TEXT,
                    title TEXT,
                    description TEXT NOT NULL DEFAULT '',
                    storage_prefix TEXT UNIQUE,
                    sequence_number INTEGER,
                    next_item_number INTEGER,
                    created_by_user_id INTEGER,
                    updated_by_user_id INTEGER,
                    assignee_user_id INTEGER,
                    user_id INTEGER,
                    added_by_user_id INTEGER,
                    source TEXT,
                    status TEXT,
                    priority TEXT,
                    due_at TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    current_delivery_id TEXT,
                    local_project_id INTEGER,
                    device_id TEXT,
                    is_default INTEGER,
                    task_user_id INTEGER,
                    task_id TEXT,
                    task_title TEXT,
                    backend_task_id INTEGER,
                    linked_by_user_id INTEGER,
                    linked_at TEXT,
                    unlinked_at TEXT,
                    path TEXT,
                    kind TEXT,
                    display_name TEXT,
                    relative_path TEXT,
                    object_key TEXT,
                    content_type TEXT,
                    size_bytes INTEGER,
                    sha256 TEXT,
                    source_task_binding_id TEXT,
                    source_task_snapshot TEXT,
                    markdown_object_key TEXT,
                    chat_object_key TEXT,
                    manifest_object_key TEXT,
                    metadata TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    delivered_at TEXT,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_loop_items_project_type
                    ON loop_items(cloud_project_id, resource_type);
                CREATE INDEX IF NOT EXISTS ix_loop_items_resource_type
                    ON loop_items(resource_type);
                CREATE TABLE IF NOT EXISTS project_provider_credentials (
                    project_store TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    task_provider TEXT NOT NULL,
                    provider_config TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(project_store, project_id)
                );
                CREATE TABLE IF NOT EXISTS external_project_catalog (
                    project_store TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    descriptor TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(project_store, project_id)
                );
                INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-08-01T00:00:00+00:00');",
            )
            .unwrap();
        drop(legacy);

        let store = LocalTaskStore::open(&db_path).unwrap();
        let connection = store.connection().unwrap();
        let columns = connection
            .prepare("PRAGMA table_info(loop_items)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "assignee_agent_id"));
        let tables = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.iter().any(|table| table == "loop_item_executions"));
        let index_exists = connection
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_loop_items_assignee_agent_id'")
            .unwrap()
            .query_row([], |_| Ok(()))
            .optional()
            .unwrap()
            .is_some();
        assert!(index_exists);
        drop(connection);

        // The migrated store is fully usable: robots and executions work.
        let project = store
            .create_project(ProjectCreate {
                name: "Migrated project".to_owned(),
                project_key: Some("MIG".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let agent = store
            .create_chat_agent(
                &project.id,
                ChatAgentCreate {
                    name: "Migrated Bot".to_owned(),
                    model: None,
                    system_prompt: None,
                    visibility: None,
                    execution_environment: Some("local".to_owned()),
                    execution_mode: Some("auto".to_owned()),
                    execution_device_id: Some("local-device".to_owned()),
                    max_concurrent_executions: 1,
                    local_project_id: None,
                    created_by_user_id: None,
                },
            )
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "After migration".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    title: None,
                    description: None,
                    status: None,
                    priority: None,
                    parent_id: None,
                    tags: None,
                    assignee_agent_id: Some(Some(agent.id.clone())),
                    execution_payload: Some(json!({"message": "run"})),
                    workflow: None,
                },
            )
            .unwrap();
        let executions = store
            .list_executions(&project.id, None, None, false)
            .unwrap();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].status, "queued");
    }

    fn store() -> (TempDir, LocalTaskStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        (directory, store)
    }

    fn local_project(store: &LocalTaskStore) -> LoopItem {
        store
            .create_project(ProjectCreate {
                name: "Local board".to_owned(),
                project_key: Some("LOCAL".to_owned()),
                description: "Local project".to_owned(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap()
    }

    #[test]
    fn creates_the_backend_compatible_single_table_schema() {
        let (_directory, store) = store();
        let connection = store.connection().unwrap();
        let columns = connection
            .prepare("PRAGMA table_info(loop_items)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        for required in [
            "id",
            "resource_type",
            "cloud_project_id",
            "parent_id",
            "loop_item_id",
            "delivery_id",
            "metadata",
            "version",
            "deleted_at",
        ] {
            assert!(columns.iter().any(|column| column == required));
        }
    }

    #[test]
    fn creates_the_default_work_item_project_once() {
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("tasks.sqlite");

        let first_store = LocalTaskStore::open(&db_path).unwrap();
        let first_projects = first_store.list_projects().unwrap();
        let default_board = first_projects
            .iter()
            .find(|project| project.project_key.as_deref() == Some(DEFAULT_WORK_ITEM_PROJECT_KEY))
            .expect("the default work-item project must exist");
        assert_eq!(default_board.id, DEFAULT_WORK_ITEM_PROJECT_ID);
        assert_eq!(default_board.name.as_deref(), Some("我的任务"));
        assert_eq!(
            default_board.metadata["system_kind"],
            json!("default_work_items")
        );
        drop(first_store);

        let reopened_store = LocalTaskStore::open(&db_path).unwrap();
        let default_board_count = reopened_store
            .list_projects()
            .unwrap()
            .into_iter()
            .filter(|project| project.project_key.as_deref() == Some(DEFAULT_WORK_ITEM_PROJECT_KEY))
            .count();
        assert_eq!(default_board_count, 1);
    }

    #[test]
    fn migration_reserves_the_default_work_item_project_key() {
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&db_path).unwrap();
        let legacy_project = store
            .create_project(ProjectCreate {
                name: "Existing work board".to_owned(),
                project_key: Some("LEGACY".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        {
            let connection = store.connection().unwrap();
            connection
                .execute(
                    "DELETE FROM loop_items WHERE id = ?1",
                    [DEFAULT_WORK_ITEM_PROJECT_ID],
                )
                .unwrap();
            connection
                .execute(
                    "UPDATE loop_items SET project_key = ?1 WHERE id = ?2",
                    params![DEFAULT_WORK_ITEM_PROJECT_KEY, legacy_project.id],
                )
                .unwrap();
            connection
                .execute(
                    "DELETE FROM schema_migrations WHERE version = ?1",
                    [LOCAL_SCHEMA_VERSION],
                )
                .unwrap();
        }
        drop(store);

        let migrated = LocalTaskStore::open(&db_path).unwrap();
        let projects = migrated.list_projects().unwrap();
        let default_project = projects
            .iter()
            .find(|project| project.id == DEFAULT_WORK_ITEM_PROJECT_ID)
            .expect("the canonical default project should be created");
        assert_eq!(
            default_project.project_key.as_deref(),
            Some(DEFAULT_WORK_ITEM_PROJECT_KEY)
        );
        assert_eq!(
            default_project.metadata["system_kind"],
            json!("default_work_items")
        );
        let preserved_legacy_project = projects
            .iter()
            .find(|project| project.id == legacy_project.id)
            .expect("the existing project should be preserved");
        assert_ne!(
            preserved_legacy_project.project_key.as_deref(),
            Some(DEFAULT_WORK_ITEM_PROJECT_KEY)
        );
    }

    #[test]
    fn caches_backend_external_projects_without_exposing_credentials() {
        let (_directory, store) = store();
        let configured = store
            .configure_external_project(ProjectDescriptor {
                id: "cloud-1".to_owned(),
                public_id: Some("public-1".to_owned()),
                project_key: "CLOUD".to_owned(),
                name: "Cloud GitHub board".to_owned(),
                description: String::new(),
                project_store: ProjectStoreKind::Backend,
                task_provider: TaskProviderKind::Github,
                provider_config: json!({
                    "repository": "acme/repo",
                    "token": "local-secret",
                }),
                version: 1,
            })
            .unwrap();

        assert_eq!(configured.id, "cloud-1");
        let projects = store.list_projects().unwrap();
        let cached_project = projects
            .iter()
            .find(|project| project.id == "cloud-1")
            .expect("cached project must be listed");
        assert_eq!(
            cached_project.metadata["task_provider"],
            json!(TaskProviderKind::Github)
        );
        let serialized = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT provider_config FROM project_provider_credentials
                 WHERE project_store = 'backend' AND project_id = 'cloud-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(!serialized.contains("local-secret"));
        let descriptor = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT descriptor FROM external_project_catalog
                 WHERE project_store = 'backend' AND project_id = 'cloud-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(!descriptor.contains("local-secret"));
        assert_eq!(
            configured.metadata["project_store"],
            json!(ProjectStoreKind::Backend)
        );
        assert_eq!(
            store.get_project("cloud-1").unwrap().name.as_deref(),
            Some("Cloud GitHub board")
        );
    }

    #[test]
    fn incompatible_cached_external_project_does_not_hide_local_projects() {
        let (_directory, store) = store();
        let local = local_project(&store);
        store
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO external_project_catalog (
                    project_store, project_id, descriptor, updated_at
                 ) VALUES ('backend', 'future-1', ?1, ?2)",
                params![
                    json!({
                        "id": "future-1",
                        "project_key": "FUTURE",
                        "name": "Future provider",
                        "project_store": "backend",
                        "task_provider": "provider_from_newer_branch",
                    })
                    .to_string(),
                    now(),
                ],
            )
            .unwrap();

        let projects = store.list_projects().unwrap();

        assert!(projects.iter().any(|project| project.id == local.id));
        assert!(projects.iter().all(|project| project.id != "future-1"));
    }

    #[test]
    fn caches_backend_dingtalk_aitable_projects() {
        let (_directory, store) = store();
        let configured = store
            .configure_external_project(ProjectDescriptor {
                id: "aitable-cloud-1".to_owned(),
                public_id: Some("aitable-public-1".to_owned()),
                project_key: "AITABLE".to_owned(),
                name: "DingTalk AI Table".to_owned(),
                description: String::new(),
                project_store: ProjectStoreKind::Backend,
                task_provider: TaskProviderKind::DingtalkAitable,
                provider_config: json!({
                    "base_id": "base-1",
                    "table_id": "table-1",
                    "source_url": "https://alidocs.dingtalk.com/i/nodes/base-1",
                }),
                version: 1,
            })
            .unwrap();

        assert_eq!(
            configured.metadata["task_provider"],
            json!(TaskProviderKind::DingtalkAitable)
        );
        assert_eq!(
            configured.metadata["provider_config"]["base_id"],
            json!("base-1")
        );
        assert_eq!(
            store
                .get_project("aitable-cloud-1")
                .unwrap()
                .name
                .as_deref(),
            Some("DingTalk AI Table")
        );
    }

    #[test]
    fn removes_backend_external_project_credentials_and_catalog_entry() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = ProjectDescriptor {
            id: "cloud-public".to_owned(),
            public_id: Some("public-id".to_owned()),
            project_key: "PUBLIC".to_owned(),
            name: "Public GitHub".to_owned(),
            description: String::new(),
            project_store: ProjectStoreKind::Backend,
            task_provider: TaskProviderKind::Github,
            provider_config: json!({
                "repository": "acme/public",
                "token": "sensitive-token"
            }),
            version: 1,
        };
        store.configure_external_project(project).unwrap();

        store.remove_external_project("cloud-public").unwrap();

        assert!(store
            .list_projects()
            .unwrap()
            .iter()
            .all(|candidate| candidate.id != "cloud-public"));
        let connection = store.connection().unwrap();
        let credential_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM project_provider_credentials
                 WHERE project_store = 'backend' AND project_id = 'cloud-public'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(credential_count, 0);
    }

    #[test]
    fn retains_only_current_accounts_backend_external_projects() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        for id in ["account-a", "account-b"] {
            store
                .configure_external_project(ProjectDescriptor {
                    id: id.to_owned(),
                    public_id: None,
                    project_key: id.to_uppercase(),
                    name: id.to_owned(),
                    description: String::new(),
                    project_store: ProjectStoreKind::Backend,
                    task_provider: TaskProviderKind::Github,
                    provider_config: json!({
                        "repository": format!("acme/{id}"),
                        "token": format!("{id}-token")
                    }),
                    version: 1,
                })
                .unwrap();
        }

        store
            .retain_external_projects(&["account-b".to_owned()])
            .unwrap();

        let project_ids = store
            .list_projects()
            .unwrap()
            .into_iter()
            .filter(|project| project.project_key.as_deref() != Some(DEFAULT_WORK_ITEM_PROJECT_KEY))
            .map(|project| project.id)
            .collect::<Vec<_>>();
        assert_eq!(project_ids, vec!["account-b"]);
    }

    #[test]
    fn creates_nested_tasks_and_rejects_cycles() {
        let (_directory, store) = store();
        let project = local_project(&store);
        let parent = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Parent".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let child = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Child".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "high".to_owned(),
                    parent_id: Some(parent.id.clone()),
                    tags: vec!["nested".to_owned()],
                    workflow: None,
                },
            )
            .unwrap();

        assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
        let error = store
            .update_task(
                &project.id,
                &parent.id,
                TaskUpdate {
                    version: parent.version,
                    parent_id: Some(Some(child.id)),
                    ..TaskUpdate::default()
                },
            )
            .unwrap_err();
        assert!(matches!(error, TaskRuntimeError::Invalid(_)));
    }

    #[test]
    fn reorders_one_local_board_lane() {
        let (_directory, store) = store();
        let project = local_project(&store);
        let first = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "First".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let second = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Second".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();

        let reordered = store
            .reorder_tasks(
                &project.id,
                TaskReorder {
                    parent_id: None,
                    status: "inbox".to_owned(),
                    item_ids: vec![second.id.clone(), first.id.clone()],
                },
            )
            .unwrap();

        assert_eq!(
            reordered
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
        assert_eq!(reordered[0].sort_order, 0);
        assert_eq!(reordered[1].sort_order, 1);
    }

    #[test]
    fn binds_and_unbinds_a_runtime_task() {
        let (_directory, store) = store();
        let project = local_project(&store);
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Bound task".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();

        let binding = store
            .bind_task(
                &project.id,
                Some(&task.id),
                None,
                RuntimeTaskAddress {
                    device_id: "local-device".to_owned(),
                    task_id: "runtime-1".to_owned(),
                    task_title: Some("Runtime".to_owned()),
                    backend_task_id: None,
                    workflow_node_id: None,
                },
            )
            .unwrap();

        assert_eq!(binding.loop_item_id.as_deref(), Some(task.id.as_str()));
        assert_eq!(store.list_task_bindings(&task.id).unwrap().len(), 1);
        assert_eq!(
            store
                .get_task(&project.id, &task.id)
                .unwrap()
                .status
                .as_deref(),
            Some("inbox")
        );
        store
            .unbind_task("local-device", "runtime-1", Some(&task.id))
            .unwrap();
        assert!(matches!(
            store.find_task_binding("local-device", "runtime-1"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
    }

    #[test]
    fn lists_task_bindings_for_multiple_items_in_one_query() {
        let (_directory, store) = store();
        let project = local_project(&store);
        let first = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "First bound task".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let second = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Second bound task".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        for (item, runtime_task_id) in [(&first, "runtime-1"), (&second, "runtime-2")] {
            store
                .bind_task(
                    &project.id,
                    Some(&item.id),
                    None,
                    RuntimeTaskAddress {
                        device_id: "local-device".to_owned(),
                        task_id: runtime_task_id.to_owned(),
                        task_title: item.title.clone(),
                        backend_task_id: None,
                        workflow_node_id: None,
                    },
                )
                .unwrap();
        }

        let bindings = store
            .list_task_bindings_batch(&[
                first.id.clone(),
                second.id.clone(),
                first.id.clone(),
                String::new(),
            ])
            .unwrap();
        let task_ids = bindings
            .iter()
            .map(|binding| binding.task_id.as_str())
            .collect::<HashSet<_>>();

        assert_eq!(bindings.len(), 2);
        assert_eq!(task_ids, HashSet::from(["runtime-1", "runtime-2"]));
        assert!(store.list_task_bindings_batch(&[]).unwrap().is_empty());
    }

    #[test]
    fn keeps_one_system_binding_alongside_the_current_user_binding() {
        let (_directory, store) = store();
        let user_project = local_project(&store);
        let system_task = store
            .create_task(
                DEFAULT_WORK_ITEM_PROJECT_ID,
                TaskCreate {
                    title: "System task".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let user_task = store
            .create_task(
                &user_project.id,
                TaskCreate {
                    title: "User issue".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let address = RuntimeTaskAddress {
            device_id: "local-device".to_owned(),
            task_id: "runtime-1".to_owned(),
            task_title: Some("Runtime".to_owned()),
            backend_task_id: None,
            workflow_node_id: None,
        };

        let system_binding = store
            .bind_task(
                DEFAULT_WORK_ITEM_PROJECT_ID,
                Some(&system_task.id),
                None,
                address.clone(),
            )
            .unwrap();
        let user_binding = store
            .bind_task(&user_project.id, Some(&user_task.id), None, address)
            .unwrap();

        assert_eq!(system_binding.binding_type, "system");
        assert_eq!(user_binding.binding_type, "user");
        assert_eq!(
            store
                .find_task_binding("local-device", "runtime-1")
                .unwrap()
                .id,
            user_binding.id
        );
        assert_eq!(
            store
                .find_system_task_binding("local-device", "runtime-1")
                .unwrap()
                .id,
            system_binding.id
        );
        assert_eq!(
            store
                .find_user_task_binding("local-device", "runtime-1")
                .unwrap()
                .id,
            user_binding.id
        );

        store
            .unbind_task("local-device", "runtime-1", Some(&user_task.id))
            .unwrap();
        assert_eq!(
            store
                .find_task_binding("local-device", "runtime-1")
                .unwrap()
                .id,
            system_binding.id
        );
        store
            .unbind_task("local-device", "runtime-1", Some(&system_task.id))
            .unwrap();
        assert_eq!(
            store
                .find_system_task_binding("local-device", "runtime-1")
                .unwrap()
                .id,
            system_binding.id
        );
    }

    #[test]
    fn validates_local_workflow_task_bindings() {
        let (_directory, store) = store();
        let project = local_project(&store);
        let project = store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: project.version,
                    workflow_definition: Some(json!({
                        "version": 1,
                        "nodes": [
                            {
                                "id": "develop",
                                "name": "Develop",
                                "kind": "my_task",
                                "depends_on": [],
                                "required": true,
                                "workspace_policy": "composer"
                            },
                            {
                                "id": "test",
                                "name": "Test",
                                "kind": "my_task",
                                "depends_on": ["develop"],
                                "required": true,
                                "workspace_policy": "inherit"
                            }
                        ]
                    })),
                    ..ProjectUpdate::default()
                },
            )
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Workflow task".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();

        store
            .bind_task(
                &project.id,
                Some(&task.id),
                None,
                RuntimeTaskAddress {
                    device_id: "local-device".to_owned(),
                    task_id: "runtime-1".to_owned(),
                    task_title: Some("Develop".to_owned()),
                    backend_task_id: None,
                    workflow_node_id: Some("develop".to_owned()),
                },
            )
            .unwrap();

        let additional = store
            .bind_task(
                &project.id,
                Some(&task.id),
                None,
                RuntimeTaskAddress {
                    device_id: "local-device".to_owned(),
                    task_id: "runtime-2".to_owned(),
                    task_title: Some("Additional develop".to_owned()),
                    backend_task_id: None,
                    workflow_node_id: Some("develop".to_owned()),
                },
            )
            .unwrap();
        assert_eq!(additional.workflow_node_id.as_deref(), Some("develop"));

        let current = store.get_task(&project.id, &task.id).unwrap();
        let mut workflow = current.metadata["workflow"].clone();
        workflow["nodes"][0]["status"] = json!("awaiting_approval");
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: current.version,
                    workflow: Some(Some(workflow)),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
        let correction = store
            .bind_task(
                &project.id,
                Some(&task.id),
                None,
                RuntimeTaskAddress {
                    device_id: "local-device".to_owned(),
                    task_id: "runtime-correction".to_owned(),
                    task_title: Some("Correct develop".to_owned()),
                    backend_task_id: None,
                    workflow_node_id: Some("develop".to_owned()),
                },
            )
            .unwrap();
        assert_eq!(correction.workflow_node_id.as_deref(), Some("develop"));

        let blocked = store.bind_task(
            &project.id,
            Some(&task.id),
            None,
            RuntimeTaskAddress {
                device_id: "local-device".to_owned(),
                task_id: "runtime-3".to_owned(),
                task_title: Some("Test".to_owned()),
                backend_task_id: None,
                workflow_node_id: Some("test".to_owned()),
            },
        );
        assert!(matches!(blocked, Err(TaskRuntimeError::Invalid(_))));
    }

    #[test]
    fn stores_project_content_without_persisting_external_issues() {
        let (_directory, store) = store();
        let local_project = local_project(&store);
        let task = store
            .create_task(
                &local_project.id,
                TaskCreate {
                    title: "Persisted".to_owned(),
                    description: String::new(),
                    status: "inbox".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();

        let file = store
            .upload_project_file(
                &local_project.id,
                Some("docs/readme.txt"),
                BinaryInput {
                    display_name: "readme.txt".to_owned(),
                    content_type: Some("text/plain".to_owned()),
                    base64: "aGVsbG8=".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(store.project_file_path(&file.id).unwrap()).unwrap(),
            "hello"
        );
        let object_key: String = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT object_key FROM loop_items WHERE id = ?1",
                [&file.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(object_key, format!("files/{}/readme.txt", file.id));
        assert!(!std::path::Path::new(&object_key).is_absolute());
        let moved = store
            .move_project_file(&file.id, "docs/guides/readme.txt", file.version)
            .unwrap();
        assert_eq!(moved.path, "docs/guides/readme.txt");

        let attachment = store
            .add_task_attachment(
                &local_project.id,
                &task.id,
                true,
                BinaryInput {
                    display_name: "notes.txt".to_owned(),
                    content_type: None,
                    base64: "bm90ZXM=".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(store.task_attachment_path(&attachment.id).unwrap()).unwrap(),
            "notes"
        );

        let delivery = store
            .create_delivery(
                &local_project.id,
                &task.id,
                true,
                DeliveryCreate {
                    markdown: "# Done".to_owned(),
                    chat: None,
                    source_task: None,
                },
            )
            .unwrap();
        let asset = store
            .add_delivery_asset(
                &delivery.id,
                "assets/result.txt",
                BinaryInput {
                    display_name: "result.txt".to_owned(),
                    content_type: None,
                    base64: "ZG9uZQ==".to_owned(),
                },
            )
            .unwrap();
        let finalized = store
            .finalize_delivery(
                &task.id,
                &delivery.id,
                crate::task_runtime::DeliveryFinalize::default(),
            )
            .unwrap();
        assert_eq!(finalized.status, "delivered");
        assert_eq!(
            std::fs::read_to_string(store.delivery_asset_path(&asset.id).unwrap()).unwrap(),
            "done"
        );
        assert_eq!(store.list_deliveries(&task.id).unwrap().len(), 1);

        let external_project = store
            .create_project(ProjectCreate {
                name: "GitHub board".to_owned(),
                project_key: Some("GH".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Github,
                provider_config: json!({"repository": "owner/repo"}),
            })
            .unwrap();
        store
            .add_task_attachment(
                &external_project.id,
                "github-42",
                false,
                BinaryInput {
                    display_name: "issue.txt".to_owned(),
                    content_type: None,
                    base64: "aXNzdWU=".to_owned(),
                },
            )
            .unwrap();
        let external_delivery = store
            .create_delivery(
                &external_project.id,
                "42",
                false,
                DeliveryCreate {
                    markdown: "External result".to_owned(),
                    chat: None,
                    source_task: None,
                },
            )
            .unwrap();
        let external_asset = store
            .add_delivery_asset(
                &external_delivery.id,
                "result.txt",
                BinaryInput {
                    display_name: "result.txt".to_owned(),
                    content_type: None,
                    base64: "ZG9uZQ==".to_owned(),
                },
            )
            .unwrap();
        let connection = store.connection().unwrap();
        let task_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM loop_items WHERE resource_type = 'task'
                   AND cloud_project_id = ?1",
                [&external_project.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_count, 0);
        let (loop_item_id, external_item_id): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT loop_item_id, json_extract(metadata, '$.external_item_id')
                 FROM loop_items WHERE id = ?1",
                [&external_asset.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(loop_item_id, None);
        assert_eq!(external_item_id.as_deref(), Some("42"));
    }

    #[test]
    fn finalized_delivery_is_bound_to_the_source_workflow_node() {
        let (_directory, store) = store();
        let project = local_project(&store);
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Workflow delivery".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: Some(json!({
                        "version": 1,
                        "nodes": [{
                            "id": "develop",
                            "name": "Develop",
                            "kind": "my_task",
                            "status": "ready",
                            "depends_on": [],
                            "required": true,
                            "required_deliverables": ["result.txt"],
                            "delivery_ids": []
                        }]
                    })),
                },
            )
            .unwrap();
        let address = RuntimeTaskAddress {
            device_id: "device-1".to_owned(),
            task_id: "runtime-1".to_owned(),
            task_title: Some("Implement".to_owned()),
            backend_task_id: None,
            workflow_node_id: Some("develop".to_owned()),
        };
        store
            .bind_task(&project.id, Some(&task.id), None, address.clone())
            .unwrap();
        let delivery = store
            .create_delivery(
                &project.id,
                &task.id,
                true,
                DeliveryCreate {
                    markdown: "# Done".to_owned(),
                    chat: Some(json!({"messages": [{"role": "assistant", "content": "done"}]})),
                    source_task: Some(address),
                },
            )
            .unwrap();

        store
            .finalize_delivery(
                &task.id,
                &delivery.id,
                crate::task_runtime::DeliveryFinalize::default(),
            )
            .unwrap();

        let updated = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(
            updated.metadata["workflow"]["nodes"][0]["delivery_ids"],
            json!([delivery.id])
        );
        assert_eq!(
            store.delivery_detail(&delivery.id).unwrap().chat,
            Some(json!({"messages": [{"role": "assistant", "content": "done"}]}))
        );
    }

    #[test]
    fn external_provider_projects_do_not_create_local_task_rows() {
        let (_directory, store) = store();
        let project = store
            .create_project(ProjectCreate {
                name: "GitHub board".to_owned(),
                project_key: Some("GH".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Github,
                provider_config: json!({"repository": "owner/repo"}),
            })
            .unwrap();

        let error = store.list_tasks(&project.id).unwrap_err();
        assert!(matches!(error, TaskRuntimeError::UnsupportedProvider(_)));
        let connection = store.connection().unwrap();
        let task_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM loop_items WHERE resource_type = 'task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_count, 0);
    }
}
