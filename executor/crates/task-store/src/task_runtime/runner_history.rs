//! Interpret historical routing from existing metadata and execution records.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;

use super::model::LoopItem;

/// Resolve routing history once per project instead of scanning executions for each task.
pub(super) fn enrich_project_tasks(
    connection: &Connection,
    project_id: &str,
    tasks: &mut [LoopItem],
) -> rusqlite::Result<()> {
    if tasks
        .iter()
        .all(|task| task.metadata.get("runner_binding").is_some())
    {
        return Ok(());
    }
    let mut statement = connection.prepare(
        "SELECT e.loop_item_id, e.runtime_device_id FROM loop_item_executions e
         JOIN loop_items t ON t.id=e.loop_item_id
         WHERE t.cloud_project_id=?1 AND t.resource_type='task' AND t.deleted_at IS NULL
           AND e.runtime_device_id IS NOT NULL AND e.runtime_device_id!=''
         UNION SELECT e.loop_item_id, e.device_id FROM loop_items e
         JOIN loop_items t ON t.id=e.loop_item_id
         WHERE t.cloud_project_id=?1 AND t.resource_type='task' AND t.deleted_at IS NULL
           AND e.resource_type='execution' AND e.device_id IS NOT NULL AND e.device_id!=''",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut devices_by_task: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (task_id, device) = row?;
        devices_by_task.entry(task_id).or_default().push(device);
    }
    for task in tasks {
        if task.metadata.get("runner_binding").is_none() {
            apply_devices(
                &mut task.metadata,
                devices_by_task.remove(&task.id).unwrap_or_default(),
            );
        }
    }
    Ok(())
}

fn apply_devices(metadata: &mut Value, devices: Vec<String>) {
    if devices.len() == 1 {
        metadata["runner_binding"] = json!({"environment_id": devices[0]});
    } else if devices.len() > 1 {
        metadata["runner_binding_conflict"] = json!(devices);
    }
}

pub(super) fn metadata(
    connection: &Connection,
    id: &str,
    resource_type: &str,
    mut metadata: Value,
) -> rusqlite::Result<Value> {
    if resource_type == "task" && metadata.get("runner_binding").is_none() {
        let mut statement = connection.prepare(
            "SELECT DISTINCT runtime_device_id FROM loop_item_executions
             WHERE loop_item_id=?1 AND runtime_device_id IS NOT NULL AND runtime_device_id!=''
             UNION SELECT device_id FROM loop_items
             WHERE resource_type='execution' AND loop_item_id=?1 AND device_id IS NOT NULL AND device_id!=''",
        )?;
        let devices = statement
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        apply_devices(&mut metadata, devices);
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::store::LocalTaskStore;

    #[test]
    fn project_list_matches_point_routing_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("routing.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"History"})).unwrap())
            .unwrap();
        let db = Connection::open(store.path()).unwrap();
        // Match a long-lived desktop profile, including tasks with no historical runner.
        db.execute(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1600)
             INSERT INTO loop_items(id,resource_type,cloud_project_id,title,metadata,created_at,updated_at)
             SELECT 'task-'||i,'task',?1,'Task '||i,'{\"tags\":[\"keep\"]}','now','now' FROM n",
            [&project.id],
        ).unwrap();
        db.execute_batch(
            "INSERT INTO loop_items(id,resource_type,loop_item_id,device_id,created_at,updated_at)
             VALUES ('a','execution','task-1','runner-a','now','now'),
                    ('b','execution','task-2','runner-b','now','now'),
                    ('c','execution','task-2','runner-a','now','now'),
                    ('d','execution','task-3','','now','now'),
                    ('e','execution','task-4','ignored','now','now');
             UPDATE loop_items SET metadata='{\"runner_binding\":{\"environment_id\":\"fixed\"}}' WHERE id='task-4';",
        ).unwrap();
        db.execute(
            "INSERT INTO loop_item_executions(loop_item_id,cloud_project_id,agent_id,runtime_device_id,created_at,updated_at)
             VALUES ('task-1',?1,'agent','runner-a','now','now'),
                    ('task-2',?1,'agent','runner-c','now','now')",
            [&project.id],
        ).unwrap();
        db.execute_batch(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1600)
             INSERT INTO loop_items(id,resource_type,loop_item_id,device_id,created_at,updated_at)
             SELECT 'history-'||i,'execution','task-1600','runner-z','now','now' FROM n",
        )
        .unwrap();
        let changes = store.connection().unwrap().total_changes();
        let started = std::time::Instant::now();
        let tasks = store.list_tasks(&project.id).unwrap();
        eprintln!("1600-task routing projection: {:?}", started.elapsed());
        assert_eq!(tasks.len(), 1600);
        for task in tasks.iter().filter(|task| {
            ["task-1", "task-2", "task-3", "task-4", "task-1600"].contains(&task.id.as_str())
        }) {
            assert_eq!(
                task.metadata,
                metadata(
                    &db,
                    &task.id,
                    "task",
                    serde_json::from_str::<Value>(
                        &db.query_row(
                            "SELECT metadata FROM loop_items WHERE id=?1",
                            [&task.id],
                            |row| row.get::<_, String>(0)
                        )
                        .unwrap()
                    )
                    .unwrap()
                )
                .unwrap()
            );
        }
        let metadata_for = |id: &str| &tasks.iter().find(|task| task.id == id).unwrap().metadata;
        assert_eq!(
            metadata_for("task-1")["runner_binding"]["environment_id"],
            "runner-a"
        );
        assert_eq!(
            metadata_for("task-2")["runner_binding_conflict"],
            json!(["runner-a", "runner-b", "runner-c"])
        );
        assert!(metadata_for("task-3").get("runner_binding").is_none());
        assert_eq!(
            metadata_for("task-4")["runner_binding"]["environment_id"],
            "fixed"
        );
        assert_eq!(store.connection().unwrap().total_changes(), changes);
    }

    #[test]
    fn history_is_interpreted_without_writes_or_schema_changes() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE loop_items(id TEXT, resource_type TEXT, loop_item_id TEXT, device_id TEXT);
             CREATE TABLE loop_item_executions(loop_item_id TEXT, runtime_device_id TEXT);
             INSERT INTO loop_items VALUES ('binding', 'execution', 'issue', 'runner-a');
             INSERT INTO loop_item_executions VALUES ('issue', 'runner-a');",
        ).unwrap();
        let read = metadata(&db, "issue", "task", json!({"tags":["keep"]})).unwrap();
        assert_eq!(read["tags"], json!(["keep"]));
        assert_eq!(read["runner_binding"]["environment_id"], "runner-a");
        assert_eq!(db.total_changes(), 2);
        let columns = db
            .prepare("PRAGMA table_info(loop_items)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|name| name == "runner_environment_id"));

        db.execute(
            "INSERT INTO loop_item_executions VALUES ('issue', 'runner-b')",
            [],
        )
        .unwrap();
        let conflict = metadata(&db, "issue", "task", json!({})).unwrap();
        assert_eq!(
            conflict["runner_binding_conflict"],
            json!(["runner-a", "runner-b"])
        );
        let fixed = metadata(
            &db,
            "issue",
            "task",
            json!({"runner_binding":{"environment_id":"runner-a"}}),
        )
        .unwrap();
        assert_eq!(fixed["runner_binding"]["environment_id"], "runner-a");
    }
}
