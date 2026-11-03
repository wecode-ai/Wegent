// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Exercise the actual DWS process boundary and SQLite store without a tenant.

use super::*;
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::Path};

fn write(path: &Path, name: &str, value: Value) {
    std::fs::write(path.join(name), value.to_string()).unwrap();
}

fn runtime(store: LocalTaskStore, directory: &Path) -> TaskRuntime {
    let mut runtime = TaskRuntime::new(store).unwrap();
    runtime.aitable_provider.set_binary(directory.join("dws"));
    runtime
}

fn due(store: &LocalTaskStore) {
    rusqlite::Connection::open(store.path()).unwrap().execute(
        "UPDATE loop_items SET metadata=json_set(metadata,'$.follow_poll.next_at',0) WHERE resource_type='external_issue_identity'", [],
    ).unwrap();
}

fn history(version: i64) -> Value {
    json!({"type":"field_change","version":version,"operateTime":chrono::Utc::now().timestamp_millis(),"oldValue":json!({"cells":{"status":"pending","owner":"Ada"}}).to_string(),"newValue":json!({"cells":{"status":"done","owner":"Grace"}}).to_string()})
}

fn comments(directory: &Path, count: usize) {
    write(
        directory,
        "comments.json",
        json!({"data":{"comments":(0..count).map(|id|json!({"topicId":"topic","commentKey":id.to_string(),"content":"External comment"})).collect::<Vec<_>>()},"meta":{"pagination":{"endpoint_exhausted":true}}}),
    );
}

#[tokio::test]
async fn aitable_external_follow_protocol_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let binary = root.join("dws");
    std::fs::write(&binary,r#"#!/bin/sh
cd "$(dirname "$0")" || exit 1
printf '%s\n' "$*" >> requests.log
case "$*" in
  *"field get"*) printf '%s\n' '{"success":true,"result":[]}' ;;
  *"record query"*)
    if [ -f denied ]; then printf '%s\n' '{"success":false,"error":"Record access revoked"}'; exit 1; fi
    printf '%s\n' '{"success":true,"result":[{"recordId":"record-1","cells":{"title":"External Issue","status":"pending","owner":"Ada"}}]}' ;;
  *"history-list"*"--offset 0"*) cat history-first.json ;;
  *"history-list"*"--offset 50"*) cat history-last.json ;;
  *"comment list"*"--cursor next"*) cat comments.json ;;
  *"comment list"*) printf '%s\n' '{"data":{"comments":[]},"meta":{"pagination":{"endpoint_exhausted":false,"next_token":"next"}}}' ;;
  *) printf '%s\n' '{"success":false,"error":"No document"}'; exit 1 ;;
esac
"#).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    write(
        root,
        "history-first.json",
        json!({"data":{"histories":(1..=50).map(history).collect::<Vec<_>>()}}),
    );
    let last_history = history(51);
    write(
        root,
        "history-last.json",
        json!({"data":{"histories":[last_history.clone()]}}),
    );
    comments(root, 1);
    let path = root.join("tasks.sqlite");
    let store = LocalTaskStore::open(path.clone()).unwrap();
    let project=store.create_project(ProjectCreate {
        name:"AI Table".into(), project_key:Some("AIT".into()), description:String::new(), task_provider:TaskProviderKind::DingtalkAitable,
        provider_config:json!({"base_id":"base","table_id":"table","board_mapping":{"title_field_id":"title","status_field_id":"status","assignee_field_id":"owner"}}),
    }).unwrap();
    let task = "aitable:AIT:record-1";
    let first = runtime(store.clone(), root);
    first
        .set_task_following(&project.id, task, 42, true)
        .await
        .unwrap();
    first.poll_followed_external_issues().await.unwrap();
    assert!(
        store.list_issue_notifications(42).unwrap().is_empty(),
        "history and undated comments must be baselined across all pages"
    );
    write(
        root,
        "history-last.json",
        json!({"data":{"histories":[last_history,history(52)]}}),
    );
    comments(root, 2);
    due(&store);
    first.poll_followed_external_issues().await.unwrap();
    let notifications = store.list_issue_notifications(42).unwrap();
    assert_eq!(notifications.len(), 3);
    for kind in ["comment", "status", "assignee"] {
        assert!(notifications
            .iter()
            .any(|row| row["payload"]["event"] == kind));
    }
    assert!(store.list_issue_notifications(43).unwrap().is_empty());
    drop(first);
    let store = LocalTaskStore::open(path).unwrap();
    let restored = runtime(store.clone(), root);
    due(&store);
    restored.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        store.list_issue_notifications(42).unwrap().len(),
        3,
        "restart must preserve receipts"
    );
    comments(root, 3);
    std::fs::write(root.join("denied"), "").unwrap();
    due(&store);
    restored.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        store.list_issue_notifications(42).unwrap().len(),
        3,
        "source access must be checked before events"
    );
    std::fs::remove_file(root.join("denied")).unwrap();
    restored
        .set_task_following(&project.id, task, 42, false)
        .await
        .unwrap();
    due(&store);
    let requests = std::fs::read_to_string(root.join("requests.log")).unwrap();
    restored.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("requests.log")).unwrap(),
        requests
    );
    restored
        .set_task_following(&project.id, task, 42, true)
        .await
        .unwrap();
    restored.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        store.list_issue_notifications(42).unwrap().len(),
        3,
        "refollowing must baseline intervening comments"
    );
    comments(root, 4);
    due(&store);
    restored.poll_followed_external_issues().await.unwrap();
    assert_eq!(store.list_issue_notifications(42).unwrap().len(), 4);
}
