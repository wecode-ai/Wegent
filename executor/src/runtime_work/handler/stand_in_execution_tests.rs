use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn accepted_local_task_repairs_only_its_existing_pending_binding() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Repair"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Accepted"})).unwrap(),
        )
        .unwrap();
    let issue = serde_json::to_value(issue).unwrap();
    let config = json!({"id":"review","projectId":project.id,"projectStore":"local","userId":0});
    let binding = json!({"humanAssignmentId":"human"});
    handler
        .accept_stand_in_assignment(&config, &issue, &binding)
        .await
        .unwrap();
    let task_id = handler.stand_in_task_id(&config, &issue);
    assert_eq!(
        store
            .find_user_task_binding("mac", &task_id)
            .unwrap()
            .stand_in_pending,
        Some(true)
    );
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(), status: "done".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":0,"projectStore":"local","cloudProjectId":project.id,"loopItemId":issue["id"],"humanAssignmentId":"human"}}),
        ..Default::default()
    });
    handler
        .reconcile_accepted_stand_in_binding(&config, &issue, &binding)
        .await
        .unwrap();
    assert_eq!(
        store
            .find_user_task_binding("mac", &task_id)
            .unwrap()
            .stand_in_pending,
        Some(false)
    );
    assert_eq!(handler.local_task_link(&task_id).unwrap().status, "done");
    store
        .unbind_task("mac", &task_id, issue["id"].as_str())
        .unwrap();
    handler
        .reconcile_accepted_stand_in_binding(&config, &issue, &binding)
        .await
        .unwrap();
    assert!(
        store.find_user_task_binding("mac", &task_id).is_err(),
        "Recovery must preserve an intentional unlink"
    );
    assert_eq!(handler.local_task_links(true).len(), 1);
}

#[test]
fn assignment_handled_by_another_role_preserves_scope_and_new_wakeups() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let config = json!({"id":"docs","userId":7,"projectStore":"local","projectId":"project"});
    let issue = json!({"id":"issue"});
    let binding = json!({"humanAssignmentId":"accepted"});
    let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":7,"projectStore":"local","cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"accepted"});
    let reservation = json!({"task_id":"original-task"});
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "original-task".into(),
        status: "done".into(),
        runtime_handle: json!({"origin":origin}),
        ..RuntimeTaskLink::default()
    });
    assert!(handler.assignment_handled_by_another_role(&config, &issue, &binding, &reservation));
    assert!(!handler.assignment_handled_by_another_role(
        &config,
        &issue,
        &json!({"humanAssignmentId":"reassigned"}),
        &reservation
    ));
    let mut manual = config.clone();
    manual["manual"] = json!(true);
    assert!(!handler.assignment_handled_by_another_role(&manual, &issue, &binding, &reservation));
    for (field, value) in [
        ("userId", json!(8)),
        ("projectStore", json!("cloud")),
        ("cloudProjectId", json!("other-project")),
        ("loopItemId", json!("other-issue")),
        ("standInId", json!("docs")),
    ] {
        let mut foreign = origin.clone();
        foreign[field] = value;
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "original-task".into(),
            runtime_handle: json!({"origin":foreign}),
            ..RuntimeTaskLink::default()
        });
        assert!(
            !handler.assignment_handled_by_another_role(&config, &issue, &binding, &reservation),
            "{field}"
        );
    }
}

#[tokio::test]
async fn pending_reservation_blocks_another_role_before_any_runtime_task_exists() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Reserved"})).unwrap())
        .unwrap();
    let issue = serde_json::to_value(
        store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Pending assignment","assignee_user_id":0}))
                    .unwrap(),
            )
            .unwrap(),
    )
    .unwrap();
    let first = json!({"id":"review","userId":0,"projectStore":"local","projectId":project.id});
    let receipt = store
        .assignment_receipts(&project.id, issue["id"].as_str().unwrap())
        .unwrap();
    let binding = json!({"humanAssignmentId":receipt[0]["id"]});
    handler
        .accept_stand_in_assignment(&first, &issue, &binding)
        .await
        .unwrap();
    let rows = store
        .list_task_bindings(issue["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].stand_in_pending, Some(true));
    assert!(handler.store.get_task_summary(&rows[0].task_id).is_none());
    let mut candidate = first.clone();
    candidate["id"] = json!("docs");
    let reservation = serde_json::to_value(&rows[0]).unwrap();
    assert!(handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &reservation));
    assert!(!handler.assignment_handled_by_another_role(&first, &issue, &binding, &reservation));
    assert!(!handler.assignment_handled_by_another_role(
        &candidate,
        &issue,
        &json!({"humanAssignmentId":"reassigned"}),
        &reservation
    ));
    for (field, value) in [
        ("userId", json!(7)),
        ("projectStore", json!("cloud")),
        ("cloudProjectId", json!("other-project")),
        ("loopItemId", json!("other-issue")),
        ("standInId", json!("docs")),
        ("runtimeTaskId", json!("other-task")),
        ("initiatedBy", json!("user")),
    ] {
        let mut foreign = reservation.clone();
        foreign["executionContext"]["origin"][field] = value;
        assert!(
            !handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &foreign),
            "{field}"
        );
    }
    let mut settled = reservation.clone();
    settled["stand_in_pending"] = json!(false);
    assert!(!handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &settled));
}

#[test]
fn pending_cloud_binding_keeps_role_and_assignment_ownership_without_a_runtime_summary() {
    let root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime-index.json")),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let first = json!({"id":"review","userId":7,"projectStore":"cloud","projectId":"project"});
    let issue = json!({"id":"issue"});
    let binding = json!({"humanAssignmentId":"assignment"});
    let task_id = handler.stand_in_task_id(&first, &issue);
    let row = json!({"task_id":task_id,"task_user_id":7,"stand_in_pending":true,
        "human_assignment_id":"assignment","executionContext":{"origin":handler.stand_in_issue_origin(&first,&issue,&binding)}});
    let mut candidate = first.clone();
    candidate["id"] = json!("docs");
    assert!(handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &row));
    let mut foreign = row.clone();
    foreign["task_user_id"] = json!(8);
    assert!(!handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &foreign));
    candidate["manual"] = json!(true);
    assert!(!handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &row));
    candidate["manual"] = json!(false);
    candidate["triggerCommentId"] = json!("explicit-mention");
    assert!(!handler.assignment_handled_by_another_role(&candidate, &issue, &binding, &row));
}

#[tokio::test]
async fn moved_roles_leave_existing_issue_work_on_its_original_device() {
    let root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime-index.json")),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud","executionDeviceId":"remote"});
    let old_issue = json!({"id":"existing-issue"});
    let new_issue = json!({"id":"new-issue"});
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "existing-task".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","userId":7,"standInId":"review","projectStore":"cloud","cloudProjectId":"project","loopItemId":"existing-issue"}}),
        ..Default::default()
    });
    assert!(handler.stand_in_issue_runs_here(&config, &old_issue));
    assert!(!handler.stand_in_issue_runs_here(&config, &new_issue));
    handler
        .execute_stand_in_task(&config, &new_issue, &json!({}))
        .await
        .unwrap();
    assert_eq!(handler.local_task_links(false).len(), 1);
    assert!(handler.local_task_link("existing-task").is_some());
}

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
    assert_eq!(
        store
            .find_user_task_binding("mac", &task_id)
            .unwrap()
            .stand_in_pending,
        Some(true)
    );
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
        .mark_deleted_archived_task_ids([task_id.clone()])
        .unwrap();
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
    handler
        .store
        .mark_deleted_archived_task_ids([task_id])
        .unwrap();
    let error = handler.run_stand_in(json!({"projectId":project.id,"issueId":issue.id,"userId":7,"projectStore":"local","standInId":"review"})).await.unwrap_err();
    assert_eq!(error.code, "assignment_already_handled");
    assert_eq!(
        error.message,
        "This assignment has already been handled or is no longer active"
    );
}

#[tokio::test]
async fn deleted_issue_preserves_old_wakes_but_allows_new_grants_after_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let index_path = root.path().join("runtime-index.json");
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Deleted Issue"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Deleted Issue"})).unwrap(),
        )
        .unwrap();
    let config = json!({"id":"review","projectId":project.id,"projectStore":"local","userId":7});
    let issue = serde_json::to_value(issue).unwrap();
    let task_id = handler.stand_in_task_id(&config, &issue);
    handler
        .store
        .bind_issue_conversation(&task_id, &task_id)
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(), thread_id: Some("deleted-thread".into()), status: "archived".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","humanAssignmentId":"human"},"standInIssueWakeups":["human","mention:old"]}),
        ..RuntimeTaskLink::default()
    });
    handler
        .mark_archived_link_deleted(&handler.local_task_link(&task_id).unwrap())
        .unwrap();
    for old in ["human", "mention:old"] {
        assert!(handler.stand_in_assignment_is_handled(
            &config,
            &task_id,
            &json!({"humanAssignmentId":old})
        ));
    }
    let new = json!({"humanAssignmentId":"mention:new"});
    assert!(!handler.stand_in_assignment_is_handled(&config, &task_id, &new));
    let error = handler
        .create_stand_in_task(&config, &issue, &new, json!({"schemaVersion":99}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "stand_in_busy");
    assert!(handler.store.is_deleted_archived_task_id(&task_id));
    handler.store.delete_task(&task_id);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    assert_eq!(handler.stand_in_task_id(&config, &issue), task_id);
    let error = handler
        .create_stand_in_task(&config, &issue, &new, json!({"schemaVersion":99}))
        .await
        .unwrap_err();
    assert_eq!(
        error.code, "unsupported_schema_version",
        "New wake must reach normal task creation after cleanup"
    );
    assert!(!handler.store.is_deleted_archived_task_id(&task_id));
    assert!(handler.store.is_deleted_archived_task_id("deleted-thread"));
    handler.store = RuntimeWorkStore::new(index_path);
    for old in ["human", "mention:old"] {
        assert!(handler.stand_in_assignment_is_handled(
            &config,
            &task_id,
            &json!({"humanAssignmentId":old})
        ));
    }
    assert!(!handler.stand_in_assignment_is_handled(&config, &task_id, &new));
    assert!(!handler.stand_in_assignment_is_handled(
        &config,
        &task_id,
        &json!({"humanAssignmentId":"new-assignment"})
    ));
}

#[tokio::test]
async fn issue_deletion_stops_when_wakeup_snapshot_cannot_be_persisted() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("runtime-index.json");
    let backup = root.path().join("saved-index.json");
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(path.clone());
    let task = RuntimeTaskLink {
        local_task_id: "issue-conversation".into(),
        thread_id: Some("native-thread".into()),
        status: "archived".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","humanAssignmentId":"accepted"}}),
        ..RuntimeTaskLink::default()
    };
    handler.upsert_local_task(task.clone());
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    let result = handler.delete_archived_link(task.clone()).await;
    assert_eq!(result["accepted"], false);
    assert_ne!(result["deleted"], true);
    assert!(handler.local_task_link(&task.local_task_id).is_some());
    assert!(!handler
        .store
        .is_deleted_archived_task_id(&task.local_task_id));
    assert_eq!(
        handler
            .store
            .deleted_issue_wakeup(&task.local_task_id, "accepted"),
        None
    );
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    let reopened = RuntimeWorkStore::new(path);
    assert!(reopened.get_task(&task.local_task_id).is_some());
    assert!(!reopened.is_deleted_archived_task_id(&task.local_task_id));
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
