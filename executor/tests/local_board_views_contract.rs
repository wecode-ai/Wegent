// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;
use wegent_executor::task_runtime::{LocalTaskStore, ProjectUpdate, TaskRuntimeError};

#[test]
fn tag_count_boundary_rejects_writes_without_changing_persisted_data() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Tag counts"})).unwrap())
        .unwrap();
    let mut tags: Vec<String> = (0..19).map(|index| format!("tag-{index}")).collect();
    let project = store
        .update_project(
            &project.id,
            serde_json::from_value(json!({
                "version":project.version,"tags":tags
            }))
            .unwrap(),
        )
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title":"Count boundary","status":"inbox","tags":tags
            }))
            .unwrap(),
        )
        .unwrap();
    tags.push("twentieth".into());
    let project = store
        .update_project(
            &project.id,
            serde_json::from_value(json!({
                "version":project.version,"tags":tags
            }))
            .unwrap(),
        )
        .unwrap();
    let issue = store
        .update_task(
            &project.id,
            &issue.id,
            serde_json::from_value(json!({
                "version":issue.version,"tags":tags
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(project.metadata["tags"], json!(tags));
    assert_eq!(issue.metadata["tags"], json!(tags));
    assert_eq!(issue.status.as_deref(), Some("inbox"));
    tags.push("twenty-first".into());
    assert!(matches!(
        store.update_project(
            &project.id,
            serde_json::from_value(json!({
                "version":project.version,"tags":tags
            }))
            .unwrap()
        ),
        Err(TaskRuntimeError::Invalid(_))
    ));
    assert!(matches!(
        store.create_task(
            &project.id,
            serde_json::from_value(json!({
                "title":"Rejected","tags":tags
            }))
            .unwrap()
        ),
        Err(TaskRuntimeError::Invalid(_))
    ));
    assert!(matches!(
        store.update_task(
            &project.id,
            &issue.id,
            serde_json::from_value(json!({
                "version":issue.version,"tags":tags
            }))
            .unwrap()
        ),
        Err(TaskRuntimeError::Invalid(_))
    ));
    drop(store);
    let reopened = LocalTaskStore::open(&path).unwrap();
    let persisted = reopened.get_task(&project.id, &issue.id).unwrap();
    let saved = reopened
        .list_projects()
        .unwrap()
        .into_iter()
        .find(|item| item.id == project.id)
        .unwrap();
    assert_eq!(persisted.metadata, issue.metadata);
    assert_eq!(persisted.version, issue.version);
    assert_eq!(saved.metadata, project.metadata);
    assert_eq!(saved.version, project.version);
}

#[test]
fn tag_boundaries_preserve_saved_lane_and_filter_matches() {
    for character in ["a", "标", "😀"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Tags"})).unwrap())
            .unwrap();
        let tag = character.repeat(32);
        let oversized = character.repeat(33);
        let config = json!({"schema_version":1,"views":[{
            "id":"boundary","name":"Boundary",
            "columns":[{"id":"tag","type":"tag","value":tag}],
            "filter":{"tags":[tag],"match":"all"}
        }]});
        let project = store
            .update_project(
                &project.id,
                serde_json::from_value(json!({
                    "version":project.version,"tags":[tag],"board_views":config
                }))
                .unwrap(),
            )
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({
                    "title":"Boundary","tags":[tag]
                }))
                .unwrap(),
            )
            .unwrap();
        let issue = store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(json!({
                    "version":issue.version,"tags":[tag]
                }))
                .unwrap(),
            )
            .unwrap();
        for fields in [
            json!({"tags":[oversized]}),
            json!({"tags":[" tag "]}),
            json!({"board_views":{"schema_version":1,"views":[{
                "id":"bad","name":"Untrimmed lane","columns":[{"id":"tag","type":"tag","value":" tag "}]
            }]}}),
            json!({"board_views":{"schema_version":1,"views":[{
                "id":"bad","name":"Untrimmed filter","columns":[{"id":"tag","type":"tag","value":tag}],
                "filter":{"tags":[" tag "],"match":"all"}
            }]}}),
            json!({"board_views":{"schema_version":1,"views":[{
                "id":"bad","name":"Bad lane","columns":[{"id":"tag","type":"tag","value":oversized}]
            }]}}),
            json!({"board_views":{"schema_version":1,"views":[{
                "id":"bad","name":"Bad filter","columns":[{"id":"tag","type":"tag","value":tag}],
                "filter":{"tags":[oversized],"match":"all"}
            }]}}),
        ] {
            let mut input = fields;
            input["version"] = json!(project.version);
            assert!(matches!(
                store.update_project(&project.id, serde_json::from_value(input).unwrap()),
                Err(TaskRuntimeError::Invalid(_))
            ));
        }
        assert!(matches!(
            store.create_task(
                &project.id,
                serde_json::from_value(json!({
                    "title":"Rejected","tags":[oversized]
                }))
                .unwrap()
            ),
            Err(TaskRuntimeError::Invalid(_))
        ));
        assert!(matches!(
            store.update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(json!({
                    "version":issue.version,"tags":[oversized]
                }))
                .unwrap()
            ),
            Err(TaskRuntimeError::Invalid(_))
        ));
        drop(store);
        let reopened = LocalTaskStore::open(&path).unwrap();
        let persisted = reopened.get_task(&project.id, &issue.id).unwrap();
        let saved = reopened
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|item| item.id == project.id)
            .unwrap();
        assert_eq!(persisted.version, issue.version);
        assert_eq!(saved.version, project.version);
        assert_eq!(saved.metadata["board_views"], config);
        assert_eq!(
            persisted.metadata["tags"],
            config["views"][0]["filter"]["tags"]
        );
        assert_eq!(
            persisted.metadata["tags"][0],
            config["views"][0]["columns"][0]["value"]
        );
    }
}

#[test]
fn saved_views_survive_old_writes_restart_and_conflicts_without_touching_issues() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Board"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title":"Historical", "status":"completed", "tags":["a","b"]
            }))
            .unwrap(),
        )
        .unwrap();
    let views = json!({"schema_version":1,"default_view_id":"mixed","futureField":{"keepCase":true},"views":[{
        "id":"mixed","name":"Mixed","columns":[{"id":"done","type":"status","value":"completed"},{"id":"tag-a","type":"tag","value":"a","future":42}],
        "filter":{"tags":["b"],"match":"all"},"sorts":{"tag-a":["created-asc"]}
    }]});
    let saved = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_views: Some(views.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(matches!(
        store.update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_views: Some(json!({"schema_version":1,"views":[]})),
                ..Default::default()
            }
        ),
        Err(TaskRuntimeError::VersionConflict)
    ));
    let updated = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: saved.version,
                board_config: Some(json!({"group_by":"status"})),
                tags: Some(vec!["renamed".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.metadata["board_views"], views);
    drop(store);
    let reopened = LocalTaskStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .list_projects()
            .unwrap()
            .iter()
            .find(|candidate| candidate.id == project.id)
            .unwrap()
            .metadata["board_views"],
        views
    );
    let historical = reopened.get_task(&project.id, &issue.id).unwrap();
    assert_eq!(historical.status.as_deref(), Some("completed"));
    assert_eq!(historical.metadata["tags"], json!(["a", "b"]));
    assert_eq!(historical.version, issue.version);
    let future = json!({"schema_version":2,"futureField":{"keepCase":true}});
    rusqlite::Connection::open(&path).unwrap().execute(
        "UPDATE loop_items SET metadata = json_set(metadata, '$.board_views', json(?1)) WHERE id = ?2",
        rusqlite::params![future.to_string(), project.id],
    ).unwrap();
    assert!(reopened
        .update_project(
            &project.id,
            ProjectUpdate {
                version: updated.version,
                board_views: Some(views),
                ..Default::default()
            }
        )
        .is_err());
    let old_client = reopened
        .update_project(
            &project.id,
            ProjectUpdate {
                version: updated.version,
                name: Some("Renamed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(old_client.metadata["board_views"], future);
}

#[test]
fn invalid_views_are_rejected_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Board"})).unwrap())
        .unwrap();
    for views in [
        json!({"schema_version":2,"views":[]}),
        json!({"schema_version":1,"default_view_id":"missing","views":[]}),
        json!({"schema_version":1,"default_view_id":null,"views":[]}),
        json!({"schema_version":1,"views":[{"id":"default","name":"Reserved","columns":[]}]}),
        json!({"schema_version":1,"views":[{"id":"a","name":"Duplicate","columns":[{"id":"1","type":"tag","value":"a"},{"id":"2","type":"tag","value":"a"}]}]}),
    ] {
        assert!(store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: project.version,
                    board_views: Some(views),
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(
            store
                .list_projects()
                .unwrap()
                .iter()
                .find(|candidate| candidate.id == project.id)
                .unwrap()
                .version,
            project.version
        );
    }
}

#[test]
fn omitted_filters_match_all_items_and_preserve_extensions() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Board"})).unwrap())
        .unwrap();
    let views = json!({"schema_version":1,"views":[{
        "id":"minimal","name":"Minimal","extension":{"keepCase":true},
        "columns":[{"id":"done","type":"status","value":"completed"}]
    }]});
    let saved = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_views: Some(views.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(saved.metadata["board_views"], views);
}
