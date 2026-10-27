// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use wegent_executor::task_runtime::{LocalTaskStore, LoopItem, TaskRuntimeError};

fn seed(store: &LocalTaskStore) -> (LoopItem, Vec<LoopItem>) {
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Tags"})).unwrap())
        .unwrap();
    let project = store
        .update_project(
            &project.id,
            serde_json::from_value(json!({
                "version":project.version, "tags":["old","keep"],
                "board_views":{"schema_version":1,"future":{"keepCase":true},"views":[{
                    "id":"mixed","name":"Mixed","columns":[
                        {"id":"status","type":"status","value":"completed"},
                        {"id":"tag","type":"tag","value":"old","extension":true}
                    ],"filter":{"tags":["old","keep"]},"sorts":{"tag":["created-desc"]}
                }]}
            }))
            .unwrap(),
        )
        .unwrap();
    let items = [
        json!(["old", "keep"]),
        json!(["old"]),
        json!(["keep"]),
        json!([]),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, tags)| {
        store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":format!("Issue {index}"),"tags":tags}))
                    .unwrap(),
            )
            .unwrap()
    })
    .collect();
    (project, items)
}

fn change(
    store: &LocalTaskStore,
    project: &LoopItem,
    target: Value,
) -> Result<LoopItem, TaskRuntimeError> {
    store.update_project(
        &project.id,
        serde_json::from_value(json!({
            "version":project.version,"tag_change":{"source":"old","target":target}
        }))
        .unwrap(),
    )
}

#[test]
fn rename_and_delete_update_catalog_items_and_views_together() {
    for target in [json!("new"), Value::Null] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let (project, mut items) = seed(&store);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE loop_items SET metadata = json_remove(metadata, '$.tags') WHERE id = ?1",
                [&items[3].id],
            )
            .unwrap();
        items[3] = store.get_task(&project.id, &items[3].id).unwrap();
        let updated = change(&store, &project, target.clone()).unwrap();
        let expected = if target.is_null() {
            json!(["keep"])
        } else {
            json!(["new", "keep"])
        };
        assert_eq!(updated.metadata["tags"], expected);
        let view = &updated.metadata["board_views"]["views"][0];
        assert_eq!(view["filter"]["tags"], expected);
        assert_eq!(
            updated.metadata["board_views"]["future"],
            json!({"keepCase":true})
        );
        assert_eq!(
            view["columns"].as_array().unwrap().len(),
            if target.is_null() { 1 } else { 2 }
        );
        assert_eq!(
            view["sorts"],
            if target.is_null() {
                json!({})
            } else {
                json!({"tag":["created-desc"]})
            }
        );
        let first = store.get_task(&project.id, &items[0].id).unwrap();
        assert_eq!(first.metadata["tags"], expected);
        assert_eq!(first.version, items[0].version + 1);
        for item in &items[2..] {
            let unchanged = store.get_task(&project.id, &item.id).unwrap();
            assert_eq!(unchanged.version, item.version);
            assert_eq!(unchanged.metadata, item.metadata);
        }
        drop(store);
        let reopened = LocalTaskStore::open(path).unwrap();
        assert_eq!(
            reopened
                .list_projects()
                .unwrap()
                .into_iter()
                .find(|row| row.id == project.id)
                .unwrap()
                .metadata,
            updated.metadata
        );
        assert_eq!(
            reopened
                .get_task(&project.id, &items[0].id)
                .unwrap()
                .metadata,
            first.metadata
        );
    }
}

#[test]
fn conflict_and_mid_write_failure_leave_every_reference_unchanged() {
    for target in [json!("new"), Value::Null] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let (project, items) = seed(&store);
        let mut stale = project.clone();
        stale.version -= 1;
        assert!(matches!(
            change(&store, &stale, target.clone()),
            Err(TaskRuntimeError::VersionConflict)
        ));
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE tag_write_count (count INTEGER);
            INSERT INTO tag_write_count VALUES (0);
            CREATE TRIGGER reject_second_tag_write BEFORE UPDATE ON loop_items
            WHEN NEW.resource_type = 'task'
            BEGIN
              UPDATE tag_write_count SET count = count + 1;
              SELECT CASE WHEN (SELECT count FROM tag_write_count) = 2
              THEN RAISE(ABORT, 'second Issue write failed') END;
            END;",
            )
            .unwrap();
        assert!(change(&store, &project, target.clone()).is_err());
        assert_eq!(
            store
                .list_projects()
                .unwrap()
                .into_iter()
                .find(|row| row.id == project.id)
                .unwrap()
                .metadata,
            project.metadata
        );
        assert_eq!(
            store
                .list_projects()
                .unwrap()
                .into_iter()
                .find(|row| row.id == project.id)
                .unwrap()
                .version,
            project.version
        );
        for item in &items {
            let current = store.get_task(&project.id, &item.id).unwrap();
            assert_eq!(current.metadata, item.metadata);
            assert_eq!(current.version, item.version);
        }
        connection
            .execute_batch("DROP TRIGGER reject_second_tag_write")
            .unwrap();
        assert!(change(&store, &project, target).is_ok());
    }
}

#[test]
fn unsupported_tag_changes_reject_without_writing() {
    for case in ["future", "duplicate", "only_lane", "long_tag"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let (mut project, items) = seed(&store);
        let target = if case == "only_lane" {
            project.metadata["board_views"]["views"][0]["columns"]
                .as_array_mut()
                .unwrap()
                .remove(0);
            Value::Null
        } else if case == "long_tag" {
            json!("x".repeat(33))
        } else {
            if case == "future" {
                project.metadata["board_views"]["schema_version"] = json!(2);
            } else {
                project.metadata["board_views"]["views"][0]["columns"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":"new-tag","type":"tag","value":"new"}));
            }
            json!("new")
        };
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE loop_items SET metadata = ?1 WHERE id = ?2",
                rusqlite::params![project.metadata.to_string(), project.id],
            )
            .unwrap();
        assert!(change(&store, &project, target).is_err(), "{case}");
        let current = store
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|row| row.id == project.id)
            .unwrap();
        assert_eq!(current.metadata, project.metadata);
        assert_eq!(current.version, project.version);
        for item in items {
            let current = store.get_task(&project.id, &item.id).unwrap();
            assert_eq!(current.metadata, item.metadata);
            assert_eq!(current.version, item.version);
        }
    }
    assert!(
        serde_json::from_value::<wegent_executor::task_runtime::ProjectTagChange>(
            json!({"source":"old"})
        )
        .is_err()
    );
}
