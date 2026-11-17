// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{http::StatusCode, routing::get, Json, Router};

#[derive(Clone, Copy)]
enum ConcurrentIssueChange {
    Description,
    Title,
    Project,
    RepeatedConflict,
    ReadConflict,
    Denial(StatusCode, &'static str),
}

async fn generated_cloud_title_after_concurrent_change(
    change: ConcurrentIssueChange,
) -> (Result<(), AppIpcError>, Value, Vec<Value>) {
    let issue = Arc::new(Mutex::new(json!({
        "cloud_project_id":"project", "title":"Original", "version":1,
        "description":"Original description"
    })));
    let writes = Arc::new(Mutex::new(Vec::new()));
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let read_issue = issue.clone();
    let write_issue = issue.clone();
    let captured = writes.clone();
    let router = Router::new().route(
        "/api/v1/loop-items/issue",
        get(move || {
            let mut issue = read_issue.lock().unwrap();
            let snapshot = issue.clone();
            // Another real writer commits after our read, before our conditional PATCH.
            if reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0
                || matches!(change, ConcurrentIssueChange::RepeatedConflict)
            {
                issue["version"] = json!(issue["version"].as_u64().unwrap() + 1);
                issue["description"] = json!("Concurrent description");
                match change {
                    ConcurrentIssueChange::Title => issue["title"] = json!("Human title"),
                    ConcurrentIssueChange::Project => issue["cloud_project_id"] = json!("other"),
                    _ => {}
                }
            }
            async move {
                if matches!(change, ConcurrentIssueChange::ReadConflict) {
                    (
                        StatusCode::CONFLICT,
                        Json(json!({"detail":{"code":"version_conflict"}})),
                    )
                } else {
                    (StatusCode::OK, Json(snapshot))
                }
            }
        })
        .patch(move |Json(body): Json<Value>| {
            captured.lock().unwrap().push(body.clone());
            let mut issue = write_issue.lock().unwrap();
            let response = if let ConcurrentIssueChange::Denial(status, code) = change {
                (
                    status,
                    json!({"detail":{"code":code,"message":"private response"}}),
                )
            } else if body["version"] != issue["version"] {
                (
                    StatusCode::CONFLICT,
                    json!({"detail":{"code":"version_conflict","message":"TODO changed"}}),
                )
            } else {
                issue["title"] = body["title"].clone();
                issue["version"] = json!(issue["version"].as_u64().unwrap() + 1);
                (StatusCode::OK, issue.clone())
            };
            async move { (response.0, Json(response.1)) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime-index.json")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url,
            auth_token: "synthetic-test-token".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("isolated-device", "unused")
    };
    let result = handler
        .sync_generated_issue_title(
            &RuntimeTaskLink {
                runtime_handle: json!({"origin":{
                    "projectStore":"cloud", "cloudProjectId":"project", "loopItemId":"issue",
                    "generatedIssueTitle":"Original"
                }}),
                ..Default::default()
            },
            "Generated title",
        )
        .await;
    server.abort();
    let issue = issue.lock().unwrap().clone();
    let writes = writes.lock().unwrap().clone();
    (result, issue, writes)
}

#[tokio::test]
async fn generated_cloud_title_rebases_only_an_unchanged_title_after_version_conflict() {
    let (result, issue, writes) =
        generated_cloud_title_after_concurrent_change(ConcurrentIssueChange::Description).await;
    result.unwrap();
    assert_eq!(issue["title"], "Generated title");
    assert_eq!(issue["description"], "Concurrent description");
    assert_eq!(
        writes,
        vec![
            json!({"version":1,"title":"Generated title"}),
            json!({"version":2,"title":"Generated title"})
        ]
    );
}

#[tokio::test]
async fn generated_cloud_title_preserves_a_manual_edit_during_the_conflict() {
    let (result, issue, writes) =
        generated_cloud_title_after_concurrent_change(ConcurrentIssueChange::Title).await;
    result.unwrap();
    assert_eq!(issue["title"], "Human title");
    assert_eq!(writes.len(), 1);
}

#[tokio::test]
async fn generated_cloud_title_revalidates_project_identity_before_rebasing() {
    let (result, _, writes) =
        generated_cloud_title_after_concurrent_change(ConcurrentIssueChange::Project).await;
    assert_eq!(result.unwrap_err().code, "permission_denied");
    assert_eq!(writes.len(), 1);
}

#[tokio::test]
async fn generated_cloud_title_never_repeats_denied_or_unrelated_failed_writes() {
    for (status, code) in [
        (StatusCode::FORBIDDEN, "version_conflict"),
        (StatusCode::CONFLICT, "unrelated_conflict"),
        (StatusCode::INTERNAL_SERVER_ERROR, "version_conflict"),
    ] {
        let (result, _, writes) = generated_cloud_title_after_concurrent_change(
            ConcurrentIssueChange::Denial(status, code),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "cloud_request_failed");
        assert!(!error.message.contains("private response"));
        assert_eq!(writes.len(), 1);
    }
}

#[tokio::test]
async fn generated_cloud_title_reports_repeated_concurrent_conflicts() {
    let (result, issue, writes) =
        generated_cloud_title_after_concurrent_change(ConcurrentIssueChange::RepeatedConflict)
            .await;
    assert_eq!(result.unwrap_err().code, "version_conflict");
    assert_eq!(issue["title"], "Original");
    // Preserve main's bounded three-attempt CAS contract; every rejected attempt revalidates.
    assert_eq!(writes.len(), 3);
}

#[tokio::test]
async fn generated_cloud_title_preserves_read_failures_without_attempting_a_write() {
    let (result, _, writes) =
        generated_cloud_title_after_concurrent_change(ConcurrentIssueChange::ReadConflict).await;
    assert_eq!(result.unwrap_err().code, "cloud_request_failed");
    assert!(writes.is_empty());
}

#[test]
fn generated_title_does_not_overwrite_a_concurrent_manual_rename_or_publish_an_event() {
    let (mut handler, root) = isolated_runtime_work_handler("title-manual-race");
    let (events_tx, mut events) = tokio::sync::broadcast::channel(8);
    handler.event_tx = Some(events_tx);
    let before = RuntimeTaskLink {
        local_task_id: "task-title-race".into(),
        title: "Original".into(),
        ..Default::default()
    };
    handler.upsert_local_task(before.clone());
    handler.store.update_task(&before.local_task_id, |task| {
        task.title = "My manual title".into();
    });
    let actual = handler
        .commit_runtime_task_title(before, "Generated title".into(), Some("Original"))
        .unwrap();
    assert_eq!(actual.title, "My manual title");
    assert_eq!(
        handler.local_task_link("task-title-race").unwrap().title,
        "My manual title"
    );
    assert!(events.try_recv().is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn title_updates_preserve_runtime_changes_since_the_title_request_started() {
    let (handler, root) = isolated_runtime_work_handler("title-runtime-race");
    let before = RuntimeTaskLink {
        local_task_id: "task-title-race".into(),
        title: "Original".into(),
        status: "running".into(),
        ..Default::default()
    };
    handler.upsert_local_task(before.clone());
    handler.store.update_task(&before.local_task_id, |task| {
        task.status = "done".into();
        task.thread_id = Some("real-conversation".into());
        task.runtime_handle["latestAssistantMessage"] = json!("Completed work");
    });
    handler
        .commit_runtime_task_title(before, "Generated title".into(), Some("Original"))
        .unwrap();
    let actual = handler.local_task_link("task-title-race").unwrap();
    assert_eq!(actual.status, "done");
    assert_eq!(actual.thread_id.as_deref(), Some("real-conversation"));
    assert_eq!(
        actual.runtime_handle["latestAssistantMessage"],
        "Completed work"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn generated_issue_titles_update_only_the_unchanged_autogenerated_title() {
    let (mut handler, root) = isolated_runtime_work_handler("generated-issue-title");
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Titles"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"看看cpu"})).unwrap(),
        )
        .unwrap();
    let link = RuntimeTaskLink {
        runtime_handle: json!({"origin":{"type":"board_task","projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id,"generatedIssueTitle":"看看cpu"}}),
        ..Default::default()
    };
    handler
        .sync_generated_issue_title(&link, "检查 CPU 使用情况")
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .title
            .as_deref(),
        Some("检查 CPU 使用情况")
    );
    handler
        .sync_generated_issue_title(&link, "A late title must not overwrite an edit")
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &issue.id)
            .unwrap()
            .title
            .as_deref(),
        Some("检查 CPU 使用情况")
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn generated_cloud_issue_title_rechecks_the_title_after_a_version_conflict() {
    use axum::{http::StatusCode, routing::get, Json, Router};

    for concurrent_title in ["Original", "Manual edit"] {
        let issue = Arc::new(Mutex::new(json!({
            "cloud_project_id": "42", "version": 1, "title": "Original"
        })));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let current = issue.clone();
        let updated = issue.clone();
        let captured = writes.clone();
        let router = Router::new().route(
            "/api/v1/loop-items/ISSUE-1",
            get(move || async move { Json(current.lock().unwrap().clone()) }).patch(
                move |Json(body): Json<Value>| async move {
                    captured.lock().unwrap().push(body.clone());
                    let mut issue = updated.lock().unwrap();
                    if body["version"] == 1 {
                        issue["version"] = json!(2);
                        issue["title"] = json!(concurrent_title);
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({"detail":{"code":"version_conflict"}})),
                        );
                    }
                    assert_eq!(body["version"], issue["version"]);
                    issue["title"] = body["title"].clone();
                    (StatusCode::OK, Json(issue.clone()))
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let handler = RuntimeWorkRpcHandler {
            backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
                backend_url: format!("http://{}", listener.local_addr().unwrap()),
                auth_token: "test".into(),
                ..Default::default()
            }))),
            ..RuntimeWorkRpcHandler::new("device-1", "/bin/false")
        };
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let link = RuntimeTaskLink {
            runtime_handle: json!({"origin":{
                "projectStore":"cloud", "cloudProjectId":"42", "loopItemId":"ISSUE-1",
                "generatedIssueTitle":"Original"
            }}),
            ..Default::default()
        };
        handler
            .sync_generated_issue_title(&link, "Generated")
            .await
            .unwrap();
        if concurrent_title == "Original" {
            assert_eq!(writes.lock().unwrap().len(), 2);
            assert_eq!(issue.lock().unwrap()["title"], "Generated");
        } else {
            assert_eq!(writes.lock().unwrap().len(), 1);
            assert_eq!(issue.lock().unwrap()["title"], "Manual edit");
        }
        server.abort();
    }
}

#[tokio::test]
async fn manual_rename_persists_and_publishes_the_same_title() {
    let (mut handler, root) = isolated_runtime_work_handler("manual-title-event");
    let (events_tx, mut events) = tokio::sync::broadcast::channel(8);
    handler.event_tx = Some(events_tx);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        title: "Original".to_owned(),
        status: "done".to_owned(),
        workspace_path: root.to_string_lossy().into_owned(),
        ..RuntimeTaskLink::default()
    });

    let response = handler
        .rename_task(json!({"taskId":"task-1", "title":"Private title"}))
        .await
        .unwrap();

    assert_eq!(response["accepted"], true);
    assert_eq!(
        handler.local_task_link("task-1").unwrap().title,
        "Private title"
    );
    let event = events
        .try_recv()
        .expect("Renaming must notify every subscribed viewer");
    assert_eq!(event["event"], "runtime.task.title.updated");
    assert_eq!(event["payload"]["taskId"], "task-1");
    assert_eq!(event["payload"]["data"]["title"], "Private title");
    fs::remove_dir_all(root).unwrap();
}
