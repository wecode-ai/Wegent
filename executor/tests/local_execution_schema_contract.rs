// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;
use wegent_executor::task_runtime::LocalTaskStore;

fn version_seven_store(missing_payload: bool) -> (TempDir, String, String, String, i64) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name": "Existing project"})).unwrap())
        .unwrap();
    let task = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title": "Existing issue"})).unwrap(),
        )
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            serde_json::from_value(json!({"name": "Local agent", "execution_mode": "auto"}))
                .unwrap(),
        )
        .unwrap();
    let execution = store
        .enqueue_execution(
            &project.id,
            &task.id,
            &agent.id,
            json!({"message": "original"}),
            None,
        )
        .unwrap();
    drop(store);
    let connection = Connection::open(path).unwrap();
    if missing_payload {
        // Upgrades to v7 omitted this column when the execution table already existed.
        connection
            .execute_batch("ALTER TABLE loop_item_executions DROP COLUMN execution_payload;")
            .unwrap();
    }
    connection
        .execute_batch(
            "DELETE FROM schema_migrations WHERE version >= 7;
             INSERT INTO schema_migrations VALUES (7, '2026-09-18T00:00:00Z');",
        )
        .unwrap();
    (directory, project.id, task.id, agent.id, execution.id)
}

#[test]
fn upgrades_v7_execution_table_missing_payload_without_losing_issues_or_runs() {
    let (directory, project_id, task_id, agent_id, execution_id) = version_seven_store(true);
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .get_task(&project_id, &task_id)
            .unwrap()
            .title
            .as_deref(),
        Some("Existing issue")
    );
    let executions = store
        .list_executions(&project_id, None, None, true)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].id, execution_id);
    assert_eq!(executions[0].status, "queued");
    assert!(executions[0].execution_payload.is_none());
    assert!(store
        .local_execution_payload(execution_id)
        .unwrap()
        .is_none());

    let payload = json!({"message": "after upgrade"});
    let created = store
        .enqueue_execution(&project_id, &task_id, &agent_id, payload.clone(), None)
        .unwrap();
    assert_eq!(
        store.local_execution_payload(created.id).unwrap(),
        Some(payload)
    );
    drop(store);

    // Reopening must not duplicate, reset, or lose execution records.
    let reopened = LocalTaskStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .list_executions(&project_id, None, None, true)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        reopened
            .get_task(&project_id, &task_id)
            .unwrap()
            .title
            .as_deref(),
        Some("Existing issue")
    );
    let connection = Connection::open(path).unwrap();
    let upgrades: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 10",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(upgrades, 1);
}

#[test]
fn upgrades_v7_with_existing_payload_without_overwriting_it() {
    let (directory, project_id, _, _, execution_id) = version_seven_store(false);
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    assert_eq!(
        store.local_execution_payload(execution_id).unwrap(),
        Some(json!({"message": "original"}))
    );
    let executions = store
        .list_executions(&project_id, None, None, true)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].id, execution_id);
    assert_eq!(executions[0].status, "queued");
}

#[test]
fn lists_legacy_execution_when_joined_task_title_is_null() {
    let (directory, project_id, task_id, _, execution_id) = version_seven_store(false);
    let path = directory.path().join("tasks.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET title = NULL WHERE id = ?1",
            [&task_id],
        )
        .unwrap();
    drop(connection);

    let store = LocalTaskStore::open(path).unwrap();
    let executions = store
        .list_executions(&project_id, None, None, true)
        .unwrap();

    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].id, execution_id);
    assert_eq!(executions[0].task_title, "");
}
