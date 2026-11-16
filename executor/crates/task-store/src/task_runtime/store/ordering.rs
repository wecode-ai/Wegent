// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use rusqlite::{params, Connection};

use super::{now, TaskRuntimeError};
use crate::task_runtime::model::TaskPosition;

pub(super) fn siblings(
    connection: &Connection,
    project_id: &str,
    parent_id: Option<&str>,
) -> Result<Vec<(String, String)>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id, status FROM loop_items
         WHERE resource_type = 'task' AND cloud_project_id = ?1
           AND ((?2 IS NULL AND (parent_id IS NULL OR parent_id = '')) OR parent_id = ?2)
           AND deleted_at IS NULL
         ORDER BY sort_order, updated_at DESC, id",
    )?;
    let rows = statement.query_map(params![project_id, parent_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn persist(
    connection: &Connection,
    ids: &[String],
    updated_item_id: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    let timestamp = now();
    for (position, id) in ids.iter().enumerate() {
        connection.execute(
            "UPDATE loop_items SET sort_order = ?1, updated_at = ?2,
                 version = version + CASE WHEN id = ?4 THEN 0 ELSE 1 END
             WHERE id = ?3 AND sort_order != ?1",
            params![position as i64, timestamp, id, updated_item_id],
        )?;
    }
    Ok(())
}

pub(super) fn move_task(
    connection: &Connection,
    project_id: &str,
    task_id: &str,
    parent_id: Option<&str>,
    position: &TaskPosition,
) -> Result<(), TaskRuntimeError> {
    let mut ids = siblings(connection, project_id, parent_id)?
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| id != task_id)
        .collect::<Vec<_>>();
    let index = match &position.before_item_id {
        Some(anchor) => ids.iter().position(|id| id == anchor).ok_or_else(|| {
            TaskRuntimeError::Invalid("Position anchor is not an active sibling".to_owned())
        })?,
        None => ids.len(),
    };
    ids.insert(index, task_id.to_owned());
    persist(connection, &ids, Some(task_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::{
        LocalTaskStore, LoopItem, ProjectCreate, TaskCreate, TaskReorder, TaskUpdate,
    };
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, LocalTaskStore, LoopItem) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(
                serde_json::from_value::<ProjectCreate>(json!({
                    "name": "Order", "project_key": "ORDER", "task_provider": "local"
                }))
                .unwrap(),
            )
            .unwrap();
        (directory, store, project)
    }

    fn create(store: &LocalTaskStore, project: &LoopItem, status: &str) -> LoopItem {
        store
            .create_task(
                &project.id,
                serde_json::from_value::<TaskCreate>(json!({
                    "title": "Card", "status": status, "priority": "high", "tags": ["shared"]
                }))
                .unwrap(),
            )
            .unwrap()
    }

    fn ids(store: &LocalTaskStore, project: &LoopItem) -> Vec<String> {
        siblings(&store.connection().unwrap(), &project.id, None)
            .unwrap()
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    }

    #[test]
    fn status_order_and_position_share_global_ranks_after_reopening() {
        let (directory, store, project) = fixture();
        let a = create(&store, &project, "pending");
        let b = create(&store, &project, "completed");
        let c = create(&store, &project, "pending");
        store
            .reorder_tasks(
                &project.id,
                TaskReorder {
                    parent_id: None,
                    status: None,
                    item_ids: vec![a.id.clone(), b.id.clone(), c.id.clone()],
                },
            )
            .unwrap();
        store
            .reorder_tasks(
                &project.id,
                TaskReorder {
                    parent_id: None,
                    status: Some("pending".to_owned()),
                    item_ids: vec![c.id.clone(), a.id.clone()],
                },
            )
            .unwrap();
        assert_eq!(
            ids(&store, &project),
            vec![c.id.clone(), b.id.clone(), a.id.clone()]
        );
        let current = store.get_task(&project.id, &c.id).unwrap();
        let moved = store.update_task(&project.id, &c.id, serde_json::from_value::<TaskUpdate>(json!({
            "version": current.version, "status": "completed", "position": {"before_item_id": null}
        })).unwrap()).unwrap();
        assert_eq!(moved.version, current.version + 1);
        assert_eq!(moved.metadata["tags"], json!(["shared"]));
        let reopened = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        assert_eq!(
            ids(&reopened, &project),
            vec![b.id.clone(), a.id.clone(), c.id.clone()]
        );
        for (rank, id) in ids(&reopened, &project).iter().enumerate() {
            assert_eq!(
                reopened.get_task(&project.id, id).unwrap().sort_order,
                rank as i64
            );
        }
    }

    #[test]
    fn invalid_position_rolls_back_all_task_fields() {
        let (_directory, store, project) = fixture();
        let card = create(&store, &project, "pending");
        let result = store.update_task(&project.id, &card.id, serde_json::from_value::<TaskUpdate>(json!({
            "version": card.version, "status": "completed", "priority": "urgent", "position": {"before_item_id": "missing"}
        })).unwrap());
        assert!(matches!(result, Err(TaskRuntimeError::Invalid(_))));
        let unchanged = store.get_task(&project.id, &card.id).unwrap();
        assert_eq!(unchanged.version, card.version);
        assert_eq!(unchanged.status, card.status);
        assert_eq!(unchanged.priority, card.priority);
        assert_eq!(
            serde_json::to_value(unchanged).unwrap(),
            serde_json::to_value(card).unwrap()
        );
    }

    #[test]
    fn position_write_failure_rolls_back_the_complete_move() {
        let (_directory, store, project) = fixture();
        let first = create(&store, &project, "pending");
        let last = create(&store, &project, "completed");
        store
            .reorder_tasks(
                &project.id,
                TaskReorder {
                    parent_id: None,
                    status: None,
                    item_ids: vec![first.id.clone(), last.id.clone()],
                },
            )
            .unwrap();
        let before = [
            store.get_task(&project.id, &first.id).unwrap(),
            store.get_task(&project.id, &last.id).unwrap(),
        ];
        store.connection().unwrap().execute_batch("CREATE TRIGGER reject_order BEFORE UPDATE OF sort_order ON loop_items BEGIN SELECT RAISE(ABORT, 'Ordering write failed'); END;").unwrap();
        let result = store.update_task(&project.id, &last.id, serde_json::from_value::<TaskUpdate>(json!({
            "version": before[1].version, "priority": "urgent", "position": {"before_item_id": first.id}
        })).unwrap());
        assert!(result.is_err());
        let after = [
            store.get_task(&project.id, &before[0].id).unwrap(),
            store.get_task(&project.id, &last.id).unwrap(),
        ];
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }

    #[test]
    fn position_is_not_limited_by_the_bulk_reorder_size() {
        let (_directory, store, project) = fixture();
        let first = create(&store, &project, "pending");
        for _ in 0..999 {
            create(&store, &project, "pending");
        }
        let last = create(&store, &project, "completed");
        store
            .update_task(
                &project.id,
                &last.id,
                serde_json::from_value::<TaskUpdate>(json!({
                    "version": last.version, "position": {"before_item_id": first.id}
                }))
                .unwrap(),
            )
            .unwrap();
        let ids = ids(&store, &project);
        assert_eq!(ids.len(), 1001);
        let index = ids.iter().position(|id| id == &first.id).unwrap();
        assert_eq!(ids[index - 1], last.id);
        for (rank, id) in ids.iter().enumerate() {
            assert_eq!(
                store.get_task(&project.id, id).unwrap().sort_order,
                rank as i64
            );
        }
    }

    #[test]
    fn position_requires_an_explicit_anchor_or_null() {
        assert!(serde_json::from_value::<TaskPosition>(json!({})).is_err());
        assert!(serde_json::from_value::<TaskPosition>(json!({"beforeItemId": null})).is_ok());
    }
}
