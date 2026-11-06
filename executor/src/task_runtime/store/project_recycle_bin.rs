// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{now, LocalTaskStore, TaskRuntimeError, DEFAULT_WORK_ITEM_PROJECT_ID};
use crate::task_runtime::model::DeletedProject;
use rusqlite::{params, TransactionBehavior};

impl LocalTaskStore {
    pub fn archive_project(&self, project_id: &str, version: i64) -> Result<(), TaskRuntimeError> {
        if project_id == DEFAULT_WORK_ITEM_PROJECT_ID {
            return Err(TaskRuntimeError::Invalid(
                "The built-in project cannot be deleted".to_owned(),
            ));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE cloud_project_id = ?1
             AND status NOT IN ('completed', 'failed', 'cancelled'))",
            [project_id],
            |row| row.get(0),
        )?;
        if active {
            return Err(TaskRuntimeError::Invalid(
                "Stop active executions before deleting this project".to_owned(),
            ));
        }
        let project = super::get_item_from(&tx, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let mut metadata = project.metadata;
        if let Some(rules) = metadata
            .get_mut("automatic_processing_rules")
            .and_then(|v| v.as_array_mut())
        {
            for rule in rules {
                rule["enabled"] = serde_json::json!(false);
            }
        }
        let updated = tx.execute(
            "UPDATE loop_items SET deleted_at = ?1, updated_at = ?1, version = version + 1, metadata = ?4
             WHERE id = ?2 AND resource_type = 'project' AND version = ?3 AND deleted_at IS NULL",
            params![now(), project_id, version, metadata.to_string()],
        )?;
        if updated != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        tx.commit()?;
        Ok(())
    }
    pub fn list_deleted_projects(&self) -> Result<Vec<DeletedProject>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, version, deleted_at FROM loop_items
             WHERE resource_type = 'project' AND deleted_at IS NOT NULL AND id != ?1
             ORDER BY deleted_at DESC, id",
        )?;
        let rows = statement.query_map([DEFAULT_WORK_ITEM_PROJECT_ID], |row| {
            Ok(DeletedProject {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                deleted_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn restore_project(&self, project_id: &str, version: i64) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let updated = connection.execute(
            "UPDATE loop_items SET deleted_at = NULL, updated_at = ?1, version = version + 1
             WHERE id = ?2 AND resource_type = 'project' AND version = ?3 AND deleted_at IS NOT NULL",
            params![now(), project_id, version],
        )?;
        if updated != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::{ProjectCreate, TaskProviderKind};
    use serde_json::json;

    #[test]
    fn project_deletion_rejects_builtin_and_unfinished_executions() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(dir.path().join("tasks.sqlite")).unwrap();
        assert!(matches!(
            store.archive_project(DEFAULT_WORK_ITEM_PROJECT_ID, 1),
            Err(TaskRuntimeError::Invalid(_))
        ));
        let project = store
            .create_project(ProjectCreate {
                name: "Running".to_owned(),
                project_key: Some("RUN".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        store.connection().unwrap().execute(
            "INSERT INTO loop_item_executions (loop_item_id, cloud_project_id, agent_id, created_at, updated_at)
             VALUES ('issue', ?1, 'agent', ?2, ?2)",
            params![project.id, now()],
        ).unwrap();
        for status in ["queued", "claimed", "running", "cancel_requested"] {
            store
                .connection()
                .unwrap()
                .execute("UPDATE loop_item_executions SET status = ?1", [status])
                .unwrap();
            assert!(matches!(
                store.archive_project(&project.id, project.version),
                Err(TaskRuntimeError::Invalid(_))
            ));
            assert!(store.list_deleted_projects().unwrap().is_empty());
        }
        store
            .connection()
            .unwrap()
            .execute("UPDATE loop_item_executions SET status = 'completed'", [])
            .unwrap();
        store.archive_project(&project.id, project.version).unwrap();
        assert_eq!(store.list_deleted_projects().unwrap()[0].id, project.id);
    }

    #[test]
    fn project_recycle_bin_persists_and_rejects_stale_restore() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Recoverable".to_owned(),
                project_key: Some("REC".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title": "Retained Issue"})).unwrap(),
            )
            .unwrap();
        store.connection().unwrap().execute(
            "UPDATE loop_items SET metadata = json_set(metadata, '$.automatic_processing_rules', json(?1)) WHERE id = ?2",
            params![json!([{"id": "rule", "enabled": true, "targetId": "agent"}]).to_string(), project.id],
        ).unwrap();
        store.archive_project(&project.id, project.version).unwrap();
        assert!(!store
            .list_projects()
            .unwrap()
            .iter()
            .any(|p| p.id == project.id));
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let deleted = store.list_deleted_projects().unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].id, project.id);
        assert_eq!(deleted[0].version, project.version + 1);
        assert!(matches!(
            store.restore_project(&project.id, project.version),
            Err(TaskRuntimeError::VersionConflict)
        ));
        store
            .restore_project(&project.id, deleted[0].version)
            .unwrap();
        assert!(store.list_deleted_projects().unwrap().is_empty());
        assert_eq!(
            store.get_project(&project.id).unwrap().version,
            project.version + 2
        );
        assert_eq!(
            store.get_project(&project.id).unwrap().metadata["automatic_processing_rules"][0]
                ["enabled"],
            json!(false)
        );
        assert_eq!(store.list_tasks(&project.id).unwrap()[0].id, task.id);
        assert!(store
            .restore_project(&project.id, deleted[0].version)
            .is_err());
    }
}
