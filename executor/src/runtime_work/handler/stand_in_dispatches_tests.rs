use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn pending_cloud_binding_is_finalized_without_replaying_an_accepted_task() {
    let root = tempfile::tempdir().unwrap();
    let issue = json!({"id":"issue","title":"Accepted work","cloud_project_id":"project","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    let current_issue = issue.clone();
    let row = Arc::new(Mutex::new(json!({})));
    let current_row = row.clone();
    let writes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let written = writes.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route(
            "/api/v1/loop-items/issue",
            get(move || {
                let value = current_issue.clone();
                async { Json(value) }
            }),
        )
        .route(
            "/api/v1/loop-items/issue/tasks",
            get(move || {
                let value = current_row.lock().unwrap().clone();
                async move { Json(json!([value])) }
            })
            .post(move |Json(body): Json<Value>| {
                written.lock().unwrap().push(body);
                async { Json(json!({"id":"binding"})) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.save_stand_in_settings("project", 7, json!({"id":"review","projectStore":"cloud","executionDeviceId":"mac","version":0,"enabled":true,"prompt":"Review"})).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    let config = handler
        .stand_in_project_configs(&[settings], "project", "cloud")
        .into_iter()
        .find(|config| config["id"] == "review")
        .unwrap();
    let task_id = handler.stand_in_task_id(&config, &issue);
    *row.lock().unwrap() =
        json!({"task_id":task_id,"device_id":"mac","task_user_id":7,"stand_in_pending":true});
    let ids = handler
        .queue_stand_in_dispatches(&[config], &issue)
        .unwrap();
    assert_eq!(ids.len(), 1);
    let intent = store.pending_stand_in_dispatches().unwrap().remove(0).1;
    let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":7,"projectStore":"cloud","cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"human"});
    for changed in [
        json!({"userId":8}),
        json!({"cloudProjectId":"other"}),
        json!({"standInId":"other"}),
    ] {
        let mut foreign = origin.clone();
        foreign
            .as_object_mut()
            .unwrap()
            .extend(changed.as_object().unwrap().clone());
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: task_id.clone(),
            status: "done".into(),
            runtime_handle: json!({"origin":foreign}),
            ..Default::default()
        });
        handler
            .reconcile_stand_in_dispatch(&store, &intent)
            .await
            .unwrap();
        assert!(
            writes.lock().unwrap().is_empty(),
            "A foreign task must not authorize a binding repair"
        );
    }
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        status: "done".into(),
        runtime_handle: json!({"origin":origin}),
        ..Default::default()
    });
    handler
        .reconcile_stand_in_dispatch(&store, &intent)
        .await
        .unwrap();
    assert_eq!(writes.lock().unwrap().len(), 1);
    let written = writes.lock().unwrap()[0].clone();
    assert_eq!(written["standInPending"], false);
    assert_eq!(written["taskId"], task_id);
    assert_eq!(handler.local_task_links(true).len(), 1);
    assert_eq!(handler.local_task_link(&task_id).unwrap().status, "done");
    server.abort();
}

#[tokio::test]
async fn automatic_intent_keeps_its_device_before_cloud_reservation_exists() {
    let root = tempfile::tempdir().unwrap();
    let issue = json!({"id":"issue","cloud_project_id":"project","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    let current_issue = issue.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/loop-items/issue", get(move || { let issue = current_issue.clone(); async { Json(issue) } }))
        .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2099-01-01T00:00:00Z"}]})) }))
        .route("/api/v1/loop-items/issue/tasks", get(|| async { Json(json!([])) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.save_stand_in_settings("project", 7, json!({"id":"review","projectStore":"cloud","executionDeviceId":"mac","version":0,"enabled":true,"prompt":"Review","workspace":{"projectKey":"not-registered","workspacePath":root.path(),"executionMode":"current_workspace"}})).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let config = handler
        .stand_in_project_configs(&[settings.clone()], "project", "cloud")
        .into_iter()
        .find(|config| config["id"] == "review")
        .unwrap();
    handler
        .queue_stand_in_dispatches(&[config], &issue)
        .unwrap();
    let intent = store.pending_stand_in_dispatches().unwrap().remove(0).1;
    let role = settings["roles"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|role| role["id"] == "review")
        .unwrap();
    role["executionDeviceId"] = json!("remote");
    let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let moved = handler
        .stand_in_project_configs(&[saved], "project", "cloud")
        .into_iter()
        .find(|config| config["id"] == "review")
        .unwrap();
    assert!(handler
        .queue_stand_in_dispatches(&[moved], &issue)
        .unwrap()
        .is_empty());
    let error = handler
        .reconcile_stand_in_dispatch(&store, &intent)
        .await
        .unwrap_err();
    assert_eq!(
        error.code, "workspace_unavailable",
        "Accepted work must reach preparation on its original device"
    );
    assert!(handler.local_task_links(true).is_empty());
    server.abort();
}

#[tokio::test]
async fn manual_wrong_device_rejection_cannot_be_recovered_as_accepted_work() {
    let root = tempfile::tempdir().unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let count = reads.clone();
    let router = Router::new().route(
        "/api/v1/loop-items/issue/tasks",
        get(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async { Json(json!([])) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let config = json!({"id":"default","userId":7,"projectId":"project","projectStore":"cloud","executionDeviceId":"remote","manual":true});
    let issue = json!({"id":"issue","cloud_project_id":"project"});
    let task_id = handler.stand_in_task_id(&config, &issue);
    let error = handler
        .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
        .await
        .unwrap_err();
    assert_eq!(error.code, "wrong_device");
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());

    // An older process may have persisted the same rejection before shutdown.
    let mut accepted = config.clone();
    accepted["executionDeviceId"] = json!("mac");
    let ids = handler
        .queue_stand_in_dispatches(std::slice::from_ref(&accepted), &issue)
        .unwrap();
    store
        .defer_stand_in_dispatch(&ids[0], "wrong_device")
        .unwrap();
    handler
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 10)
        .await
        .unwrap();
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "Rejected work must not reach recovery execution"
    );
    assert!(handler.local_task_link(&task_id).is_none());
    let ids = handler
        .queue_stand_in_dispatches(&[accepted], &issue)
        .unwrap();
    store
        .defer_stand_in_dispatch(&ids[0], "cloud_request_failed")
        .unwrap();
    assert_eq!(
        handler
            .start_cloud_stand_in_with_roles(&[config], &issue)
            .await
            .unwrap_err()
            .code,
        "wrong_device"
    );
    let pending = store.pending_stand_in_dispatches().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1["errorCode"], "cloud_request_failed");
    assert_eq!(pending[0].1["retryCount"], 1);
    server.abort();
}

#[test]
fn initial_fanout_failure_does_not_discard_other_roles_dispatch_intents() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let ids = ["misconfigured", "temporarily-offline"].map(|role| {
        store
            .queue_stand_in_dispatch(&json!({"userId":7,"roleId":role}))
            .unwrap()
    });
    handler.settle_stand_in_dispatches(
        &ids,
        Some(&AppIpcError::new(
            "workspace_unavailable",
            "First role needs configuration",
        )),
    );
    let pending = store.pending_stand_in_dispatches().unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().all(|(_, intent)| intent["retryCount"] == 1));
    assert!(retryable_dispatch_error(&AppIpcError::new(
        "stand_in_settings",
        "Storage is temporarily unavailable"
    )));
    assert!(!retryable_dispatch_error(&AppIpcError::new(
        "invalid_assignment",
        "Reassigned"
    )));
}

#[test]
fn settlement_failure_preserves_intent_until_storage_recovers() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let id = store.queue_stand_in_dispatch(&json!({"userId":7})).unwrap();
    let connection = rusqlite::Connection::open(handler.task_store_path.as_ref()).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_settlement BEFORE DELETE ON loop_items WHEN OLD.resource_type='stand_in_dispatch' BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;").unwrap();
    handler.settle_stand_in_dispatches(std::slice::from_ref(&id), None);
    assert_eq!(store.pending_stand_in_dispatches().unwrap().len(), 1);
    connection
        .execute_batch("DROP TRIGGER reject_settlement")
        .unwrap();
    handler.settle_stand_in_dispatches(&[id], None);
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());
}

#[test]
fn dispatch_intent_requires_backend_scope_and_ignores_unmatched_roles() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let config = json!({"id":"review","tags":["review"]});
    let mut issue =
        json!({"human_task_binding":{"humanAssignmentId":"human","assignmentId":"event"}});
    assert!(handler
        .queue_stand_in_dispatches(std::slice::from_ref(&config), &issue)
        .unwrap()
        .is_empty());
    issue["tags"] = json!(["review"]);
    assert_eq!(
        handler
            .queue_stand_in_dispatches(&[config], &issue)
            .unwrap_err()
            .code,
        "cloud_unavailable"
    );
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());
}

#[tokio::test]
async fn stand_in_dispatch_recovers_a_reservation_after_failure_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let user = Arc::new(AtomicUsize::new(7));
    let current_user = user.clone();
    let issue = Arc::new(Mutex::new(
        json!({"id":"issue","cloud_project_id":"project","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}}),
    ));
    let current_issue = issue.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let router = Router::new()
        .route("/api/users/me", get(move || {
            let id = current_user.load(Ordering::SeqCst);
            async move { Json(json!({"id":id})) }
        }))
        .route("/api/v1/loop-items/issue", get(move || {
            let value = current_issue.lock().unwrap().clone();
            async move { Json(value) }
        }))
        .route("/api/v1/loop-items/issue/assignments", get(move || {
            let attempt = count.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({})))
                } else {
                    (axum::http::StatusCode::OK, Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2099-01-01T00:00:00Z"}]})))
                }
            }
        }))
        .route("/api/v1/loop-items/issue/tasks", get(|| async { Json(json!([{"human_assignment_id":"human","device_id":"mac","task_id":"stand-in-human-review"}])) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let make_handler = || {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url.clone(),
            auth_token: "test".into(),
            ..Default::default()
        })));
        handler
    };
    let handler = make_handler();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.save_stand_in_settings("project", 7, json!({"id":"review","projectStore":"cloud","executionDeviceId":"mac","version":0,"enabled":true,"prompt":"Review","workspace":{"projectKey":"not-registered","workspacePath":root.path(),"executionMode":"current_workspace"}})).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    let config = handler
        .stand_in_project_configs(&[settings], "project", "cloud")
        .into_iter()
        .find(|config| config["id"] == "review")
        .unwrap();
    let initial_issue = issue.lock().unwrap().clone();
    let error = handler
        .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &initial_issue)
        .await
        .unwrap_err();
    assert_eq!(error.code, "cloud_request_failed");
    let pending = store.pending_stand_in_dispatches().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1["retryCount"], 1);
    handler
        .queue_stand_in_dispatches(std::slice::from_ref(&config), &issue.lock().unwrap())
        .unwrap();
    assert_eq!(store.pending_stand_in_dispatches().unwrap().len(), 1);
    drop(handler);
    let restarted = make_handler();
    restarted.flush_stand_in_dispatches().await.unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "Restart must preserve backoff"
    );
    user.store(8, Ordering::SeqCst);
    restarted
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 10)
        .await
        .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "Another account must not execute persisted work"
    );
    assert_eq!(store.pending_stand_in_dispatches().unwrap().len(), 1);
    user.store(7, Ordering::SeqCst);
    restarted
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 20)
        .await
        .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "A same-device reservation must reach preparation again"
    );
    assert!(
        store.pending_stand_in_dispatches().unwrap().is_empty(),
        "Configuration failures require human action, not endless execution retries"
    );
    assert!(restarted.local_task_links(true).is_empty());
    restarted
        .queue_stand_in_dispatches(std::slice::from_ref(&config), &initial_issue)
        .unwrap();
    issue.lock().unwrap()["human_task_binding"]["assignmentId"] = json!("reassigned");
    restarted
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 100)
        .await
        .unwrap();
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "A stale assignment must never reach dispatch"
    );
    *issue.lock().unwrap() = initial_issue.clone();
    restarted
        .queue_stand_in_dispatches(&[config], &initial_issue)
        .unwrap();
    restarted.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human-review".into(),
        status: "failed".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":7,"projectStore":"cloud","cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"human"}}),
        ..Default::default()
    });
    restarted
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 100)
        .await
        .unwrap();
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "An accepted failed task needs explicit retry, not intent replay"
    );
    server.abort();
}

#[tokio::test]
async fn manual_issue_startup_intent_survives_restart_without_assignment_or_intake() {
    let root = tempfile::tempdir().unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let count = reads.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/loop-items/issue", get(|| async {
            Json(json!({"id":"issue","cloud_project_id":"project","assignee_user_id":null,"permissions":{"execute":true}}))
        }))
        .route("/api/v1/loop-items/issue/tasks", get(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async { axum::http::StatusCode::SERVICE_UNAVAILABLE }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let make_handler = || RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime.json")),
        task_store_path: Arc::new(root.path().join("tasks.sqlite")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url.clone(),
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let handler = make_handler();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let error = handler
        .run_stand_in(json!({
            "projectId":"project","issueId":"issue","userId":7,"projectStore":"cloud"
        }))
        .await
        .unwrap_err();
    assert_eq!(error.code, "cloud_request_failed");
    let pending = store.pending_stand_in_dispatches().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1["manual"], true);
    assert_eq!(pending[0].1["retryCount"], 1);
    let mut moved = store.personal_stand_in(7, "mac").unwrap();
    moved["roles"][0]["executionDeviceId"] = json!("remote");
    store.save_personal_stand_in(7, "mac", moved).unwrap();
    drop(handler);
    let restarted = make_handler();
    restarted
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 10)
        .await
        .unwrap();
    assert_eq!(
        reads.load(Ordering::SeqCst),
        2,
        "Paused intake and absent project subscriptions cannot discard an accepted manual request"
    );
    assert_eq!(
        store.pending_stand_in_dispatches().unwrap()[0].1["retryCount"],
        2
    );
    let config = json!({"id":"default","userId":7,"projectId":"project","projectStore":"cloud"});
    let task = restarted.stand_in_task_id(&config, &json!({"id":"issue"}));
    restarted.upsert_local_task(RuntimeTaskLink {
        local_task_id: task,
        status: "failed".into(),
        ..Default::default()
    });
    restarted
        .flush_stand_in_dispatches_at(chrono::Utc::now().timestamp() + 30)
        .await
        .unwrap();
    assert!(store.pending_stand_in_dispatches().unwrap().is_empty());
    assert_eq!(
        reads.load(Ordering::SeqCst),
        2,
        "Accepted work must never be replayed by startup recovery"
    );
    server.abort();
}

#[tokio::test]
async fn stand_in_dispatch_does_not_replay_accepted_or_deleted_work() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let config = json!({"id":"review","manual":true,"recoveringDispatch":true});
    let issue =
        json!({"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    for status in ["running", "done", "failed", "cancelled", "archived"] {
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "stand-in-human-review".into(),
            status: status.into(),
            runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","humanAssignmentId":"human"}}),
            ..Default::default()
        });
        assert!(handler
            .queue_stand_in_dispatches(std::slice::from_ref(&config), &issue)
            .unwrap()
            .is_empty());
        handler
            .create_stand_in_task(
                &config,
                &issue,
                &issue["human_task_binding"],
                json!({"schemaVersion":99}),
            )
            .await
            .unwrap();
        assert_eq!(
            handler
                .local_task_link("stand-in-human-review")
                .unwrap()
                .status,
            status,
            "Recovery must recheck acceptance under the task gate, even for failed work"
        );
    }
    handler
        .store
        .mark_deleted_archived_task_ids(["stand-in-human-review".into()])
        .unwrap();
    handler.store.delete_task("stand-in-human-review");
    assert!(handler
        .queue_stand_in_dispatches(&[config], &issue)
        .unwrap()
        .is_empty());
}
