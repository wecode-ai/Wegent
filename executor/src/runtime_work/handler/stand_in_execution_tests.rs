use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn rejected_local_creation_preserves_the_issue_reservation() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Stand-in"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Issue"})).unwrap(),
        )
        .unwrap();
    let error = handler
        .create_stand_in_task(
            &json!({"id":"default","projectId":project.id,"projectStore":"local"}),
            &serde_json::to_value(&issue).unwrap(),
            &json!({"humanAssignmentId":"human"}),
            json!({"schemaVersion":99}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported_schema_version");
    let task_id = handler.stand_in_task_id(
        &json!({"id":"default","projectId":project.id,"projectStore":"local"}),
        &serde_json::to_value(&issue).unwrap(),
    );
    assert!(store.find_user_task_binding("mac", &task_id).is_ok());
    assert!(handler.local_task_link(&task_id).is_none());
}

#[tokio::test]
async fn rejected_cloud_creation_preserves_the_issue_reservation() {
    let bindings = Arc::new(AtomicUsize::new(0));
    let created = bindings.clone();
    let removed = bindings.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route(
            "/api/v1/cloud-projects/project",
            get(|| async { Json(json!({"access_role":"Developer"})) }),
        )
        .route(
            "/api/v1/cloud-projects/project/execution-environments",
            get(|| async { Json(json!({"items":[{"device_key":"mac","can_use":true}]})) }),
        )
        .route(
            "/api/v1/loop-items/issue/tasks",
            axum::routing::post(move || {
                created.fetch_add(1, Ordering::SeqCst);
                async { Json(json!({"id":1})) }
            })
            .delete(move || {
                removed.fetch_sub(1, Ordering::SeqCst);
                async { axum::http::StatusCode::NO_CONTENT }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let runtime_root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(runtime_root.path().join("runtime-index.json")),
        task_store_path: Arc::new(runtime_root.path().join("tasks.sqlite")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let error = handler
        .create_stand_in_task(
            &json!({"id":"default","projectId":"project","projectStore":"cloud","userId":7}),
            &json!({"id":"issue","title":"Issue"}),
            &json!({"humanAssignmentId":"human"}),
            json!({"schemaVersion":99}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported_schema_version");
    assert_eq!(bindings.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn deleted_stand_in_is_not_replayed_during_or_after_background_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let mut config = json!({"id":"review","projectId":"project","projectStore":"local","userId":7,"workspace":{"projectKey":"unregistered-project"}});
    let issue = json!({"id":"issue"});
    let binding = json!({"humanAssignmentId":"human"});
    let task_id = handler.stand_in_task_id(&config, &issue);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        status: "archived".into(),
        ..RuntimeTaskLink::default()
    });
    handler
        .store
        .mark_deleted_archived_task_ids([task_id.clone()]);
    for cleanup_finished in [false, true] {
        if cleanup_finished {
            handler.store.delete_task(&task_id);
        }
        for manual in [false, true] {
            config["manual"] = json!(manual);
            handler
                .execute_stand_in_task(&config, &issue, &binding)
                .await
                .unwrap();
        }
        assert!(handler.store.is_deleted_archived_task_id(&task_id));
        assert_eq!(
            handler.local_task_link(&task_id).is_none(),
            cleanup_finished
        );
    }
    config["manual"] = json!(false);
    let reassigned = json!({"humanAssignmentId":"new-human-assignment"});
    assert_eq!(handler.stand_in_task_id(&config, &issue), task_id);
    handler
        .execute_stand_in_task(&config, &issue, &reassigned)
        .await
        .unwrap();
    assert!(handler.local_task_link(&task_id).is_none());
}

#[tokio::test]
async fn manual_delegation_does_not_report_a_deleted_task_as_running() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Deleted work"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Deleted work","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    store
        .save_stand_in_settings(
            &project.id,
            7,
            json!({"id":"review","projectStore":"local","executionDeviceId":"mac","version":0,"enabled":true,"prompt":"Review carefully"}),
        )
        .unwrap();
    let task_id = format!("stand-in-{}-1-review", issue.id);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        status: "archived".into(),
        ..RuntimeTaskLink::default()
    });
    handler.store.mark_deleted_archived_task_ids([task_id]);
    let error = handler.run_stand_in(json!({"projectId":project.id,"issueId":issue.id,"userId":7,"projectStore":"local","standInId":"review"})).await.unwrap_err();
    assert_eq!(error.code, "assignment_already_handled");
}

#[tokio::test]
async fn project_background_policy_queues_once_and_routed_work_does_not_reenter_intake() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Receipts"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Review","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    let mut config = json!({"id":"review","projectId":project.id,"projectStore":"local","userId":7,"workspace":{"projectKey":"unregistered-project"},"handlingPolicy":{"automatic":true,"askBeforeAct":true,"immediate":false}});
    let binding = json!({"humanAssignmentId":format!("{}-1",issue.id)});
    let issue = serde_json::to_value(issue).unwrap();
    for _ in 0..2 {
        handler
            .execute_stand_in_task(&config, &issue, &binding)
            .await
            .unwrap();
    }
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "assignment");
    assert_eq!(events[0]["assignmentId"], binding["humanAssignmentId"]);
    assert!(handler.local_task_links(true).is_empty());
    let receipt = store
        .assignment_receipts(&project.id, issue["id"].as_str().unwrap())
        .unwrap();
    assert!(
        receipt[0]["stand_in_received_at"].is_string(),
        "Queued work is received before model preparation"
    );
    assert!(receipt[0]["human_read_at"].is_null());
    config["intakeRouted"] = json!(true);
    let error = handler
        .execute_stand_in_task(&config, &issue, &binding)
        .await
        .unwrap_err();
    assert_eq!(error.code, "workspace_unavailable");
    assert_eq!(store.stand_in_events(7).unwrap().len(), 1);
}
