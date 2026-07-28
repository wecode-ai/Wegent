// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use super::credentials::{encrypt_provider_config, update_provider_config};
use super::model::{
    LoopItem, ProjectCreate, ProjectDescriptor, ProjectStoreKind, ProjectUpdate,
    RuntimeTaskAddress, TaskBinding, TaskCreate, TaskProviderKind, TaskReorder, TaskUpdate,
};

const LOCAL_SCHEMA_VERSION: i64 = 3;

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
                    metadata, version, created_at, updated_at, completed_at
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
        let metadata = json!({
            "project_store": ProjectStoreKind::Local,
            "task_provider": input.task_provider,
            "provider_config": provider_config,
            "tags": [],
        });
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
            TaskProviderKind::Github | TaskProviderKind::Gitlab
        ) {
            return Err(TaskRuntimeError::Invalid(
                "external project requires github or gitlab".to_owned(),
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
                    metadata, version, created_at, updated_at, completed_at
             FROM loop_items
             WHERE resource_type = 'task' AND cloud_project_id = ?1
               AND deleted_at IS NULL
             ORDER BY sort_order, updated_at DESC",
        )?;
        let rows = statement.query_map([project_id], map_loop_item)?;
        collect_items(rows)
    }

    pub fn get_task(&self, project_id: &str, task_id: &str) -> Result<LoopItem, TaskRuntimeError> {
        let item = self.get_item(task_id, "task")?;
        if item.cloud_project_id.as_deref() != Some(project_id) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        Ok(item)
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
        let metadata = json!({"tags": input.tags});
        transaction.execute(
            "UPDATE loop_items SET next_item_number = ?1, version = version + 1,
                    updated_at = ?2 WHERE id = ?3",
            params![sequence + 1, now, project_id],
        )?;
        transaction.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, parent_id,
                title, description, sequence_number, status, priority, sort_order,
                metadata, version, created_at, updated_at, completed_at
             ) VALUES (?1, 'task', 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                       0, ?9, 1, ?10, ?10, ?11)",
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
        if let Some(Some(parent_id)) = input.parent_id.as_ref() {
            require_parent(&transaction, project_id, parent_id, Some(task_id))?;
        }
        let title = input.title.or(current.title);
        let description = input.description.unwrap_or(current.description);
        let status = input.status.or(current.status);
        let priority = input.priority.or(current.priority);
        let parent_id = input.parent_id.unwrap_or(current.parent_id);
        let mut metadata = current.metadata;
        if let Some(tags) = input.tags {
            metadata["tags"] = json!(tags);
        }
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
                 version = version + 1, updated_at = ?8
             WHERE id = ?9 AND version = ?10",
            params![
                title,
                description,
                status,
                priority,
                parent_id,
                metadata.to_string(),
                completed_at,
                now,
                task_id,
                input.version,
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        transaction.commit()?;
        drop(connection);
        self.get_item(task_id, "task")
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
                    metadata, version, created_at, updated_at, completed_at
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
        let active = get_active_binding(&transaction, &input.device_id, &input.task_id)?;
        let metadata = json!({"external_item_id": external_item_id});
        if let Some(active) = active {
            let target_item_id = item_id.or(external_item_id);
            let same_target = active.cloud_project_id == project_id
                && active.loop_item_id.as_deref() == target_item_id;
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
                project_id,
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
        if let Some(item_id) = item_id {
            self.advance_started_task(project_id, item_id)?;
        }
        self.get_binding(&id)
    }

    pub fn list_task_bindings(&self, item_id: &str) -> Result<Vec<TaskBinding>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, cloud_project_id,
                    COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                    task_user_id, device_id,
                    task_id, task_title, backend_task_id, linked_at
             FROM loop_items
             WHERE resource_type = 'execution' AND unlinked_at IS NULL
               AND (loop_item_id = ?1 OR json_extract(metadata, '$.external_item_id') = ?1)
             ORDER BY linked_at DESC",
        )?;
        let rows = statement.query_map([item_id], map_task_binding)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TaskRuntimeError::from)
    }

    pub fn find_task_binding(
        &self,
        device_id: &str,
        task_id: &str,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        let connection = self.connection()?;
        get_active_binding(&connection, device_id, task_id)?.ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn unbind_task(&self, device_id: &str, task_id: &str) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let timestamp = now();
        connection.execute(
            "UPDATE loop_items SET unlinked_at = ?1, updated_at = ?1
             WHERE resource_type = 'execution' AND device_id = ?2 AND task_id = ?3
               AND unlinked_at IS NULL",
            params![timestamp, device_id, task_id],
        )?;
        Ok(())
    }

    fn get_binding(&self, id: &str) -> Result<TaskBinding, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, cloud_project_id,
                        COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        task_user_id, device_id,
                        task_id, task_title, backend_task_id, linked_at
                 FROM loop_items WHERE id = ?1 AND resource_type = 'execution'",
                [id],
                map_task_binding,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    fn advance_started_task(
        &self,
        project_id: &str,
        item_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_items
             SET status = 'in_progress', completed_at = NULL, version = version + 1,
                 updated_at = ?1
             WHERE id = ?2 AND cloud_project_id = ?3 AND status IN ('inbox', 'pending')",
            params![now(), item_id, project_id],
        )?;
        Ok(())
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

fn get_active_binding(
    connection: &Connection,
    device_id: &str,
    task_id: &str,
) -> Result<Option<TaskBinding>, TaskRuntimeError> {
    connection
        .query_row(
            "SELECT id, cloud_project_id,
                    COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                    task_user_id, device_id,
                    task_id, task_title, backend_task_id, linked_at
             FROM loop_items
             WHERE resource_type = 'execution' AND device_id = ?1 AND task_id = ?2
               AND unlinked_at IS NULL
             LIMIT 1",
            params![device_id, task_id],
            map_task_binding,
        )
        .optional()
        .map_err(TaskRuntimeError::from)
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
        linked_at: row.get(8)?,
    })
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
            deleted_at TEXT
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
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
        params![LOCAL_SCHEMA_VERSION, now()],
    )?;
    Ok(())
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
                    metadata, version, created_at, updated_at, completed_at
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
        created_by_user_id: 0,
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
    })
}

fn collect_items(
    rows: rusqlite::MappedRows<'_, impl FnMut(&Row<'_>) -> rusqlite::Result<LoopItem>>,
) -> Result<Vec<LoopItem>, TaskRuntimeError> {
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(TaskRuntimeError::from)
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

fn validate_provider(
    store: ProjectStoreKind,
    provider: TaskProviderKind,
) -> Result<(), TaskRuntimeError> {
    let valid = matches!(
        (store, provider),
        (ProjectStoreKind::Local, TaskProviderKind::Local)
            | (ProjectStoreKind::Local, TaskProviderKind::Github)
            | (ProjectStoreKind::Local, TaskProviderKind::Gitlab)
            | (ProjectStoreKind::Backend, TaskProviderKind::Backend)
            | (ProjectStoreKind::Backend, TaskProviderKind::Github)
            | (ProjectStoreKind::Backend, TaskProviderKind::Gitlab)
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
        "SELECT descriptor
         FROM external_project_catalog
         WHERE project_store = 'backend'
         ORDER BY updated_at DESC",
    )?;
    let descriptors = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    descriptors
        .into_iter()
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
    }
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::task_runtime::{BinaryInput, DeliveryCreate};

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
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "cloud-1");
        assert_eq!(
            projects[0].metadata["task_provider"],
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
            Some("in_progress")
        );
        store.unbind_task("local-device", "runtime-1").unwrap();
        assert!(matches!(
            store.find_task_binding("local-device", "runtime-1"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
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
        let finalized = store.finalize_delivery(&task.id, &delivery.id).unwrap();
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
