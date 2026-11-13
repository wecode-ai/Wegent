use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn assignment_history_includes_archived_work_and_preserves_ownership() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let origin = json!({"initiatedBy":"stand_in","projectStore":"cloud","userId":7,
        "cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"human"});
    for (id, changed) in [
        ("archived", json!({})),
        ("other-user", json!({"userId":8})),
        ("reassigned", json!({"humanAssignmentId":"new-human"})),
        ("other-project", json!({"cloudProjectId":"other"})),
        ("other-issue", json!({"loopItemId":"other"})),
        ("local", json!({"projectStore":"local"})),
        ("ordinary", json!({"initiatedBy":"user"})),
        ("deleted", json!({})),
    ] {
        let mut task_origin = origin.clone();
        task_origin
            .as_object_mut()
            .unwrap()
            .extend(changed.as_object().unwrap().clone());
        let link = RuntimeTaskLink {
            local_task_id: id.into(),
            status: "archived".into(),
            runtime_handle: json!({"origin":task_origin}),
            ..RuntimeTaskLink::default()
        };
        handler.upsert_local_task(link.clone());
        if id == "deleted" {
            handler.mark_archived_link_deleted(&link).unwrap();
        }
    }
    let payload = json!({"userId":7,"assignments":[{
        "projectId":"project","itemId":"issue","humanAssignmentId":"human"
    }]});
    let result = handler
        .dispatch("runtime.stand_in.assignment_tasks", payload)
        .await
        .unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["taskId"], "archived");
    assert_eq!(result["items"][0]["status"], "archived");
    assert_eq!(result["items"][0]["runtimeHandle"]["origin"], origin);
    assert!(handler
        .stand_in_assignment_tasks(json!({"assignments":[]}))
        .is_err());
    assert_eq!(
        handler
            .stand_in_assignment_tasks(json!({"userId":7,"assignments":[{}]}))
            .unwrap()["items"],
        json!([])
    );
}

#[tokio::test]
async fn round_work_validates_the_issue_event_without_replacing_member_identity() {
    let bindings = Arc::new(AtomicUsize::new(0));
    let calls = bindings.clone();
    let router = Router::new()
        .route("/api/v1/loop-items/issue/assignments", get(|| async {
            Json(json!({"items":[{"id":"issue-event","status":"active","created_at":"2099-01-01T00:00:00Z"}]}))
        }))
        .route("/api/v1/loop-items/issue/tasks", get(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Json(json!([{"human_assignment_id":"human","device_id":"other","task_id":"stand-in-human-review"}])) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let config = json!({"id":"review","projectId":"project","projectStore":"cloud","userId":7,"enabledAfter":"2000-01-01T00:00:00Z"});
    let mut issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{
        "humanAssignmentId":"human","assignmentId":"member-work", "dispatchRoundId":"round-1","issueAssignmentId":"issue-event"
    }});
    handler
        .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
        .await
        .unwrap();
    assert_eq!(bindings.load(Ordering::SeqCst), 1);
    assert_eq!(issue["human_task_binding"]["assignmentId"], "member-work");
    issue["human_task_binding"]["issueAssignmentId"] = json!("superseded-event");
    handler
        .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
        .await
        .unwrap();
    assert_eq!(bindings.load(Ordering::SeqCst), 1);
    issue["human_task_binding"]
        .as_object_mut()
        .unwrap()
        .remove("issueAssignmentId");
    assert_eq!(
        handler
            .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
            .await
            .unwrap_err()
            .code,
        "invalid_assignment"
    );
    assert_eq!(bindings.load(Ordering::SeqCst), 1);
    assert!(handler.local_task_links(true).is_empty());
    server.abort();
}

#[tokio::test]
async fn cloud_assignment_checks_eligible_general_role_before_later_enabled_tagged_role() {
    let bindings = Arc::new(AtomicUsize::new(0));
    let calls = bindings.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }))
        .route("/api/v1/loop-items/issue/assignments", get(|| async {
            Json(json!({"items":[{"id":"event","status":"active","created_at":"2026-11-12T10:01:00Z"}]}))
        }))
        .route("/api/v1/loop-items/issue/tasks", get(move || {
            let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            async move { Json(if first { json!([{"human_assignment_id":"human","task_id":"stand-in-human"}]) } else { json!([]) }) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let configs = [
        json!({"id":"general","projectId":"project","projectStore":"cloud","userId":7,"enabledAfter":"2026-11-12T10:00:00Z"}),
        json!({"id":"review","projectId":"project","projectStore":"cloud","userId":7,"tags":["review"],"enabledAfter":"2026-11-12T10:02:00Z"}),
    ];
    let issue = json!({"id":"issue","assignee_user_id":7,"tags":["review"],"human_task_binding":{
        "humanAssignmentId":"human","assignmentId":"member","dispatchRoundId":"round","issueAssignmentId":"event"
    }});
    handler
        .start_cloud_stand_in_with_roles(&configs, &issue)
        .await
        .unwrap();
    assert_eq!(
        bindings.load(Ordering::SeqCst),
        1,
        "The eligible general role must reach the existing-binding check"
    );
    assert!(
        handler.local_task_links(true).is_empty(),
        "The existing binding must prevent a second execution"
    );
    let error = handler
        .start_cloud_stand_in_with_roles(&configs, &issue)
        .await
        .unwrap_err();
    assert_eq!(error.code, "cloud_request_failed");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert!(
        store
            .pending_stand_in_dispatches()
            .unwrap()
            .iter()
            .any(|(_, intent)| intent["roleId"] == "general"),
        "A transient failure must retain the actually selected eligible role for recovery"
    );
    assert!(handler.local_task_links(true).is_empty());
    server.abort();
}

#[tokio::test]
async fn stand_in_entry_futures_leave_room_on_windows_worker_stacks() {
    let handler = RuntimeWorkRpcHandler::new("measurement", "unused");
    fn future_size<F: Future>(_: impl FnOnce() -> F) -> usize {
        std::mem::size_of::<F>()
    }
    // Match Clippy's large-future boundary before nested polling amplifies it.
    for (entry, bytes) in [
        ("manual", future_size(|| handler.run_stand_in(json!({})))),
        (
            "assignment",
            future_size(|| handler.handle_stand_in_assignment(json!({}))),
        ),
        ("scheduler", future_size(|| handler.poll_local_stand_ins())),
        (
            "dispatch_reconciliation",
            future_size(|| handler.flush_stand_in_dispatches()),
        ),
    ] {
        assert!(
            bytes < 16 * 1024,
            "{entry} future uses {bytes} inline bytes"
        );
    }
}

#[tokio::test]
async fn manual_issue_work_needs_no_assignment_or_intake_subscription() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Manual identity"})).unwrap())
        .unwrap();
    let mut issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Work","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    let payload =
        json!({"projectId":project.id,"issueId":issue.id,"userId":7,"projectStore":"local"});
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["enabled"] = json!(false);
    settings["roles"][0]["collaboration"]["enabled"] = json!(false);
    settings["roles"][0]["workspace"] = json!({"projectKey":"unregistered-manual-project","workspacePath":root.path(),"executionMode":"current_workspace"});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    for assignee in [Value::Null, json!(8), json!(7)] {
        issue = store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(
                    json!({"version":issue.version,"assignee_user_id":assignee}),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            handler
                .run_stand_in(payload.clone())
                .await
                .unwrap_err()
                .code,
            "workspace_unavailable",
            "Manual work must reach execution preparation regardless of assignment"
        );
        assert_eq!(
            serde_json::to_value(store.get_task(&project.id, &issue.id).unwrap()).unwrap()
                ["assignee_user_id"],
            assignee,
            "Starting a conversation must not reassign the Issue"
        );
    }
    let task_id = format!("stand-in-{}-1-default", issue.id);
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        status: "done".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"default","userId":7,"projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id,"humanAssignmentId":format!("{}-1",issue.id)}}),
        ..RuntimeTaskLink::default()
    });
    assert_eq!(
        handler.run_stand_in(payload).await.unwrap()["taskId"],
        task_id
    );
}

#[tokio::test]
async fn redirected_role_polls_only_existing_local_issue_work() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["enabled"] = json!(true);
    settings["roles"][0]["executionDeviceId"] = json!("remote");
    settings["roles"][0]["collaboration"]["enabled"] = json!(true);
    settings["roles"][0]["collaboration"]["policy"]["immediate"] = json!(false);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Redirected local work"})).unwrap())
        .unwrap();
    let mut issues = Vec::new();
    for title in ["Existing work", "New work"] {
        issues.push(
            store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":title,"assignee_user_id":7})).unwrap(),
                )
                .unwrap(),
        );
    }
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "existing-task".into(),
        status: "done".into(),
        runtime_handle: json!({"standInIssueWakeups":[],"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"default","userId":7,"projectStore":"local","cloudProjectId":project.id,"loopItemId":issues[0].id}}),
        ..Default::default()
    });
    handler.poll_local_stand_ins().await.unwrap();
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["issueId"], issues[0].id);
    assert!(store.list_task_bindings(&issues[1].id).unwrap().is_empty());
    assert_eq!(handler.local_task_links(false).len(), 1);
    assert_eq!(
        handler
            .run_stand_in(json!({"projectId":project.id,"issueId":issues[1].id,"userId":7,"standInId":"default","projectStore":"local"}))
            .await
            .unwrap_err()
            .code,
        "wrong_device"
    );
}

#[tokio::test]
async fn prior_assignment_binding_blocks_new_local_role_executions() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Existing assignment"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Work","assignee_user_id":7})).unwrap(),
        )
        .unwrap();
    let human = format!("{}-1", issue.id);
    store.bind_task(&project.id, Some(&issue.id), None, serde_json::from_value(json!({"deviceId":"other","taskId":format!("stand-in-{human}"),"humanAssignmentId":human})).unwrap(), None).unwrap();
    let configs = ["review","docs"].map(|id| json!({"id":id,"userId":7,"projectId":project.id,"projectStore":"local","enabledAfter":"2000-01-01T00:00:00Z"}));
    handler.poll_local_stand_in(&configs).await.unwrap();
    assert_eq!(store.list_task_bindings(&issue.id).unwrap().len(), 1);
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn personal_task_creation_prevents_roles_from_reserving_additional_tasks() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Personal work"})).unwrap())
        .unwrap();
    let issue = store
        .create_task_with_schedule(
            &project.id,
            serde_json::from_value(json!({"title":"My work","assignee_user_id":0})).unwrap(),
            None,
            None,
            true,
        )
        .unwrap();
    let issue_value = serde_json::to_value(&issue).unwrap();
    assert!(super::stand_in::personal_task_claimed(&issue_value));
    let configs = ["review", "docs"].map(|id| json!({"id":id,"userId":0,"projectId":project.id,"projectStore":"local","enabledAfter":"2000-01-01T00:00:00Z"}));
    // Polling between Issue creation and task binding must not create reservations.
    handler.poll_local_stand_in(&configs).await.unwrap();
    assert!(store.list_task_bindings(&issue.id).unwrap().is_empty());
    store
        .bind_task(
            &project.id,
            Some(&issue.id),
            None,
            serde_json::from_value(json!({"deviceId":"mac","taskId":"my-task"})).unwrap(),
            None,
        )
        .unwrap();
    handler.poll_local_stand_in(&configs).await.unwrap();
    assert_eq!(store.list_task_bindings(&issue.id).unwrap().len(), 1);
    assert!(handler.local_task_links(true).is_empty());
    let projected_cloud =
        json!({"personal_task_assignment_at":"first","assignment_history":[{"at":"first"}]});
    assert!(super::stand_in::personal_task_claimed(&projected_cloud));
    assert!(!super::stand_in::personal_task_claimed(
        &json!({"personal_task_assignment_at":"first","assignment_history":[{"at":"first"},{"at":"reassigned"}]})
    ));
}

#[tokio::test]
async fn prior_assignment_binding_blocks_new_cloud_role_executions() {
    let router = Router::new()
        .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2026-10-25T00:00:00Z"}]})) }))
        .route("/api/v1/loop-items/issue/tasks", get(|| async { Json(json!([{"human_assignment_id":"human","device_id":"other","task_id":"stand-in-human"}])) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let configs = ["review","docs"].map(|id| json!({"id":id,"userId":7,"projectId":"project","projectStore":"cloud","enabledAfter":"2000-01-01T00:00:00Z"}));
    let issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    handler
        .start_cloud_stand_in_with_roles(&configs, &issue)
        .await
        .unwrap();
    assert!(handler.local_task_links(true).is_empty());
    server.abort();
}

#[test]
fn assignment_tasks_are_owned_by_each_role_and_reuse_existing_execution_identity() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    let role = json!({"id":"review","userId":7,"projectStore":"local","projectId":"project"});
    let binding = json!({"id":"issue"});
    let mut other = role.clone();
    other["id"] = json!("docs");
    assert_ne!(
        handler.stand_in_task_id(&role, &binding),
        handler.stand_in_task_id(&other, &binding)
    );
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "existing-execution".into(),
        status: "done".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","loopItemId":"issue","initiatedBy":"stand_in","standInId":"review","userId":7,"projectStore":"local","cloudProjectId":"project","humanAssignmentId":"human"}}),
        ..RuntimeTaskLink::default()
    });
    assert_eq!(
        handler.stand_in_task_id(&role, &binding),
        "existing-execution"
    );
    assert_ne!(
        handler.stand_in_task_id(&other, &binding),
        "existing-execution"
    );
    let mut unrelated = role;
    unrelated["projectStore"] = json!("cloud");
    assert_ne!(
        handler.stand_in_task_id(&unrelated, &binding),
        "existing-execution"
    );
}

#[tokio::test]
async fn manual_cloud_conversations_ignore_status_and_assignment_but_keep_project_scope() {
    let issue = Arc::new(Mutex::new(json!({})));
    let current = issue.clone();
    let reads = Arc::new(AtomicUsize::new(0));
    let assignment_reads = reads.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/loop-items/issue", get(move || {
            let value = current.lock().unwrap().clone();
            async move { Json(value) }
        }))
        .route("/api/v1/loop-items/issue/assignments", get(move || {
            assignment_reads.fetch_add(1, Ordering::SeqCst);
            async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2026-10-20T12:00:01Z"}]})) }
        }))
        .route("/api/v1/loop-items/issue/tasks", get(|| async {
            Json(json!([{"human_assignment_id":"human","device_id":"mac","task_id":"stand-in-human-default"}]))
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human-default".into(),
        status: "running".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"default","userId":7,"projectStore":"cloud","cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"human"}}),
        ..RuntimeTaskLink::default()
    });
    let payload = json!({"id":"default","projectId":"project","issueId":"issue","userId":7,"projectStore":"cloud","standInId":"default"});
    let config = json!({"id":"default","projectId":"project","userId":7,"enabledAfter":"2020-01-01T00:00:00Z","workspace":{"projectKey":"unregistered-project"}});
    let mut automatic = handler.clone();
    automatic.store = RuntimeWorkStore::new(root.path().join("automatic-index.json"));
    for status in [
        "inbox",
        "pending",
        "in_progress",
        "in_review",
        "completed",
        "cancelled",
        "custom",
    ] {
        let value = json!({"id":"issue","cloud_project_id":"project","assignee_user_id":7,"status":status,"completed_at":"2026-10-20T12:00:00Z","human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
        *issue.lock().unwrap() = value.clone();
        let before = reads.load(Ordering::SeqCst);
        let result = handler.run_stand_in(payload.clone()).await.unwrap();
        assert_eq!(result["taskId"], "stand-in-human-default", "{status}");
        assert_eq!(reads.load(Ordering::SeqCst), before, "{status}");
        // Automatic handling must also reach current assignment validation.
        let error = automatic
            .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &value)
            .await
            .unwrap_err();
        assert_eq!(
            error.code, "workspace_unavailable",
            "An orphan reservation must reach execution preparation"
        );
        assert_eq!(reads.load(Ordering::SeqCst), before + 1, "{status}");
    }
    for (field, value) in [
        ("cloud_project_id", json!("other")),
        ("assignee_user_id", json!(8)),
    ] {
        let original = issue.lock().unwrap().clone();
        issue.lock().unwrap()[field] = value;
        let before = reads.load(Ordering::SeqCst);
        let result = handler.run_stand_in(payload.clone()).await;
        if field == "cloud_project_id" {
            assert_eq!(result.unwrap_err().code, "permission_denied");
        } else {
            assert_eq!(result.unwrap()["taskId"], "stand-in-human-default");
        }
        assert_eq!(reads.load(Ordering::SeqCst), before);
        *issue.lock().unwrap() = original;
    }
    server.abort();
}

#[tokio::test]
async fn cloud_assignment_selects_one_role_and_continues_to_later_issues_after_failure() {
    let started = Arc::new(AtomicUsize::new(0));
    let calls = started.clone();
    let router = Router::new()
        .route("/api/users/me", get(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Json(json!({"id":8})) }
        }))
        .route("/api/v1/loop-items/{id}/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2026-10-20T12:00:01Z"}]})) }))
        .route("/api/v1/loop-items/{id}/tasks", get(|| async { Json(json!([])) }))
        .route("/api/v1/cloud-projects/project/execution-environments", get(|| async { Json(json!({"items":[{"device_key":"mac","can_use":true}]})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let configs = [("one","review"),("two","review"),("docs","docs")].map(|(id,tag)| json!({"id":id,"projectId":"project","projectStore":"cloud","userId":7,"tags":[tag],"enabledAfter":"2020-01-01T00:00:00Z"}));
    for issue in [
        json!({"id":"failed","assignee_user_id":7,"tags":["review"],"human_task_binding":{"humanAssignmentId":"failed-human","assignmentId":"assignment"}}),
        json!({"id":"later","assignee_user_id":7,"tags":["docs"],"human_task_binding":{"humanAssignmentId":"later-human","assignmentId":"assignment"}}),
    ].iter() {
        assert!(handler.start_cloud_stand_in_with_roles(&configs, issue).await.is_err());
    }
    assert_eq!(
        started.load(Ordering::SeqCst),
        2,
        "One review role and the later docs role must reach preparation"
    );
    server.abort();
}

#[test]
fn tag_rules_include_every_eligible_role_without_suppressing_untagged_roles() {
    let configs = vec![
        json!({"id":"default","tags":[]}),
        json!({"id":"review","tags":["review","security"]}),
        json!({"id":"docs","tags":["docs"]}),
    ];
    assert_eq!(
        super::super::personal_stand_in::matching_personal_roles(
            &configs,
            &json!({"tags":["review"]})
        )
        .iter()
        .map(|role| role["id"].as_str().unwrap())
        .collect::<Vec<_>>(),
        vec!["default", "review"]
    );
    assert_eq!(
        super::super::personal_stand_in::matching_personal_roles(
            &configs,
            &json!({"tags":["other"]})
        )[0]["id"],
        "default"
    );
    assert_eq!(
        super::super::personal_stand_in::matching_personal_roles(
            &configs,
            &json!({"tags":["review","docs"]})
        )
        .len(),
        3
    );
    assert!(super::super::personal_stand_in::matching_personal_roles(
        &configs[1..],
        &json!({"tags":["other"]})
    )
    .is_empty());
}

#[test]
fn selected_agent_uses_existing_runner_compiler_and_keeps_capabilities() {
    let model = json!({"runtime":"codex","provider":"native","model_id":"model"});
    let agent = json!({"id":"reviewer","name":"Reviewer","runtime":"codex","execution_policy":{"mode":"fixed","environment_id":"mac"},"model_policy":{"mode":"fixed","model":model},"system_prompt":"Review carefully","additional_skills":["review"],"plugins":[{"id":"plugin"}],"mcp_servers":{"tools":{}}});
    let catalog = json!({"runtimes":["codex"],"models":[{"runtime":"codex","provider":"native","model_id":"model","local_model_id":"model","is_default":true}]});
    let mut payload =
        json!({"taskId":"task","message":"Handle this task","origin":{"initiatedBy":"stand_in"}});
    apply_stand_in_agent(&mut payload, &agent, &catalog, "mac", None).unwrap();
    assert_eq!(
        payload["executionRequest"]["system_prompt"],
        "Review carefully"
    );
    assert_eq!(payload["executionRequest"]["bot"][0]["id"], "reviewer");
    assert_eq!(
        payload["executionRequest"]["preload_skills"],
        json!(["review"])
    );
    assert_eq!(
        payload["executionRequest"]["model_config"]["model_id"],
        "model"
    );
    assert!(
        apply_stand_in_agent(&mut json!({}), &agent, &catalog, "another-device", None).is_err()
    );
}

#[test]
fn historical_and_invalid_assignments_never_trigger() {
    let settings = json!({"enabledAfter":"2026-10-20T12:00:00Z"});
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-20T11:59:59Z"}),
        &settings
    ));
    assert!(assignment_after_enable(
        &json!({"created_at":"2026-10-20T12:00:01Z"}),
        &settings
    ));
    assert!(assignment_after_enable(
        &json!({"created_at":"2026-10-20T20:00:01+08:00"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-20T20:00:01"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"invalid"}),
        &settings
    ));
}

#[tokio::test]
async fn existing_manual_binding_prevents_another_device_from_creating_a_task() {
    let bindings = Arc::new(AtomicUsize::new(0));
    let calls = bindings.clone();
    let router = Router::new()
            .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2026-10-20T12:00:01Z"}]})) }))
            .route("/api/v1/loop-items/issue/tasks", get(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Json(json!([{"human_assignment_id":"human","device_id":"other","task_id":"stand-in-human-default"}])) }
            }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let config = json!({"id":"default","projectId":"project","userId":7,"enabledAfter":"2026-10-20T12:00:00Z"});
    let issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    handler
        .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
        .await
        .unwrap();
    assert_eq!(bindings.load(Ordering::SeqCst), 1);
    assert!(handler.local_task_link("stand-in-human-default").is_none());
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human-default".into(),
        status: "failed".into(),
        ..RuntimeTaskLink::default()
    });
    let mut manual = config;
    manual["manual"] = json!(true);
    let error = handler
        .start_cloud_stand_in_with_roles(std::slice::from_ref(&manual), &issue)
        .await
        .unwrap_err();
    assert_eq!(error.code, "wrong_device");
    assert_eq!(bindings.load(Ordering::SeqCst), 2);
    assert_eq!(
        handler
            .local_task_link("stand-in-human-default")
            .unwrap()
            .status,
        "failed"
    );
    server.abort();
}

#[tokio::test]
async fn existing_matching_role_does_not_revalidate_unrelated_roles() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human-review".into(),
        status: "running".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":7,"projectStore":"cloud","cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"human"}}),
        ..RuntimeTaskLink::default()
    });
    let configs = ["review", "docs"].map(
        |id| json!({"id":id,"projectId":"project","projectStore":"cloud","userId":7,"tags":[id]}),
    );
    let issue = json!({"id":"issue","assignee_user_id":7,"tags":["review"],"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    handler
        .start_cloud_stand_in_with_roles(&configs, &issue)
        .await
        .unwrap();
    assert!(handler.local_task_link("stand-in-human-docs").is_none());
}

#[tokio::test]
async fn same_device_binding_without_a_task_requires_revalidation_for_every_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(None));
    let mut config =
        json!({"id":"default","projectId":"project","projectStore":"cloud","userId":7});
    let issue = json!({"id":"issue"});
    let binding = json!({"humanAssignmentId":"human","assignmentId":"event"});
    let existing = json!([{"human_assignment_id":"human","task_id":"stand-in-human-default","device_id":"mac"}]);
    let error = handler
        .dispatch_cloud_stand_in_role(&config, &issue, &binding, &existing)
        .await
        .unwrap_err();
    assert_eq!(error.code, "cloud_unavailable");
    assert!(handler.local_task_links(true).is_empty());
    config["intakeRouted"] = json!(true);
    let error = handler
        .dispatch_cloud_stand_in_role(&config, &issue, &binding, &existing)
        .await
        .unwrap_err();
    assert_eq!(
        error.code, "cloud_unavailable",
        "Routed work must revalidate cloud authority before preparing execution"
    );
    assert!(handler.local_task_links(true).is_empty());
    config["intakeRouted"] = json!(false);
    config["manual"] = json!(true);
    let error = handler
        .dispatch_cloud_stand_in_role(&config, &issue, &binding, &existing)
        .await
        .unwrap_err();
    assert_eq!(error.code, "cloud_unavailable");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store
        .enqueue_stand_in_event(
            7,
            json!("queued-assignment"),
            json!({
                "kind":"assignment","projectId":"project","projectStore":"cloud",
                "issueId":"issue","assignmentId":"event","roleIds":["default"]
            }),
        )
        .unwrap();
    let error = handler
        .dispatch_cloud_stand_in_role(&config, &issue, &binding, &existing)
        .await
        .unwrap_err();
    assert_eq!(error.code, "cloud_unavailable", "Explicit delegation of pending intake must revalidate authority instead of being discarded as duplicate work");
}

#[tokio::test]
async fn manual_cloud_retry_reaches_preparation_without_mutating_an_existing_binding() {
    let mutations = Arc::new(AtomicUsize::new(0));
    let writes = mutations.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/cloud-projects/project", get(|| async { Json(json!({"access_role":"Developer"})) }))
        .route("/api/v1/cloud-projects/project/execution-environments", get(|| async { Json(json!({"items":[{"device_key":"mac","can_use":true}]})) }))
        .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active"}]})) }))
        .route("/api/v1/loop-items/issue/tasks", get(|| async { Json(json!([{"human_assignment_id":"human","device_id":"mac","task_id":"stand-in-human-default"}])) }).post(move || {
            writes.fetch_add(1, Ordering::SeqCst);
            async { Json(json!({})) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let mut config = json!({"id":"default","projectId":"project","projectStore":"cloud","userId":7,"manual":true,"workspace":{"projectKey":"unregistered-retry-project"}});
    let issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
    for status in ["failed", "archived"] {
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "stand-in-human-default".into(),
            status: status.into(),
            ..RuntimeTaskLink::default()
        });
        config["manual"] = json!(true);
        let error = handler
            .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
            .await
            .unwrap_err();
        assert_eq!(error.code, "workspace_unavailable");
        config["manual"] = json!(false);
        handler
            .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
            .await
            .unwrap();
        assert_eq!(mutations.load(Ordering::SeqCst), 0);
        assert_eq!(
            handler
                .local_task_link("stand-in-human-default")
                .unwrap()
                .status,
            status
        );
    }
    server.abort();
}

#[tokio::test]
async fn archived_local_stand_in_requires_real_preparation_before_reporting_success() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human-default".into(),
        status: "archived".into(),
        runtime_handle: json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"default","userId":7,"projectStore":"local","cloudProjectId":"project","loopItemId":"issue","humanAssignmentId":"human"}}),
        ..RuntimeTaskLink::default()
    });
    let mut config = json!({"id":"default","projectId":"project","projectStore":"local","userId":7,"workspace":{"projectKey":"unregistered-project"}});
    let issue = json!({"id":"issue"});
    let binding = json!({"humanAssignmentId":"human"});
    handler
        .start_local_stand_in(&config, &issue, &binding)
        .await
        .unwrap();
    config["manual"] = json!(true);
    let error = handler
        .start_local_stand_in(&config, &issue, &binding)
        .await
        .unwrap_err();
    assert_eq!(error.code, "workspace_unavailable");
    assert_eq!(
        handler
            .local_task_link("stand-in-human-default")
            .unwrap()
            .status,
        "archived"
    );
}

#[tokio::test]
async fn executor_rejects_settings_for_a_different_device() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let error = handler.stand_in_settings(json!({"id":"default","projectId":"project","userId":7,"projectStore":"local","settings":{"executionDeviceId":"cloud"}}), true).await.unwrap_err();
    assert_eq!(error.code, "wrong_device");
}

#[tokio::test]
async fn explicit_retry_reuses_failed_task_and_preserves_a_rejected_restart_reservation() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    // Collection probes app-server state even when task validation rejects the retry.
    // Keep those probes out of other tests' process-wide default Home fixtures.
    handler.codex_app_server = handler
        .codex_app_server
        .for_home(root.path().join("codex"))
        .unwrap();
    handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "stand-in-human-default".into(),
        status: "failed".into(),
        workspace_path: root.path().to_string_lossy().into_owned(),
        ..RuntimeTaskLink::default()
    });
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Retry"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Issue"})).unwrap(),
        )
        .unwrap();
    let config = json!({"id":"default","projectId":project.id,"projectStore":"local"});
    let binding = json!({"humanAssignmentId":"human"});
    let payload =
        json!({"taskId":"stand-in-human-default","executionRequest":{"schema_version":99}});
    handler.store.update_task("stand-in-human-default", |task| task.runtime_handle = json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"default","userId":null,"projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id,"humanAssignmentId":"human"}}));
    handler
        .create_stand_in_task(
            &config,
            &serde_json::to_value(&issue).unwrap(),
            &binding,
            payload.clone(),
        )
        .await
        .unwrap();
    assert!(store
        .find_user_task_binding("mac", "stand-in-human-default")
        .is_err());
    let mut explicit = config;
    explicit["manual"] = json!(true);
    assert!(handler
        .create_stand_in_task(
            &explicit,
            &serde_json::to_value(&issue).unwrap(),
            &binding,
            payload
        )
        .await
        .is_err());
    assert!(store
        .find_user_task_binding("mac", "stand-in-human-default")
        .is_ok());
    assert_eq!(
        handler
            .local_task_link("stand-in-human-default")
            .unwrap()
            .status,
        "failed"
    );
}

#[tokio::test]
async fn personal_stand_in_checks_actor_without_project_device_setup() {
    let router = Router::new().route("/api/users/me", get(|| async { Json(json!({"id":7})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let handler = RuntimeWorkRpcHandler {
        store: RuntimeWorkStore::new(root.path().join("runtime-index.json")),
        backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        }))),
        ..RuntimeWorkRpcHandler::new("mac", "unused")
    };
    let mut config = json!({"id":"default","projectId":"project","userId":8});
    assert_eq!(
        handler.verify_runtime_user(&config).await.unwrap_err().code,
        "permission_denied"
    );
    config["userId"] = json!(7);
    handler.verify_runtime_user(&config).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn enabled_settings_save_offline_without_agent_model_or_workspace_preparation() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let prompt = "x".repeat(16000);
    let settings = json!({
        "enabled":true,"executionDeviceId":"mac","version":0,"prompt":prompt,
        "name":"n".repeat(200),"tags":(0..60).map(|n| n.to_string()).collect::<Vec<_>>(),
        "agentId":"not-loaded",
        "model":{"runtime":"codex","provider":"native","model_id":"not-loaded"},
        "workspace":{"projectKey":"not-indexed","workspacePath":"/not-present","executionMode":"git_worktree"}
    });
    let saved = handler
        .stand_in_settings(
            json!({
                "projectId":"cloud-project","projectStore":"cloud","userId":7,"settings":settings
            }),
            true,
        )
        .await
        .unwrap();
    assert_eq!(saved["enabled"], true);
    assert_eq!(saved["version"], 1);
    assert_eq!(saved["prompt"], prompt);
    assert_eq!(saved["workspace"], settings["workspace"]);
}

#[tokio::test]
async fn default_personal_task_needs_no_project_environment() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let payload = handler
        .prepare_stand_in_task(
            &json!({"id":"default","projectStore":"local","projectId":"not-configured","userId":7}),
            &json!({"id":"issue","title":"Task"}),
            &json!({"humanAssignmentId":"human"}),
        )
        .await
        .unwrap();
    assert_eq!(
        payload["taskId"],
        handler.stand_in_task_id(
            &json!({"id":"default","projectStore":"local","projectId":"not-configured","userId":7}),
            &json!({"id":"issue"})
        )
    );
    assert_eq!(payload["executionRequest"]["bot"][0]["shell_type"], "Codex");
    assert!(payload.get("workspacePath").is_none());
    let request = execution_request(&payload).unwrap();
    assert!(is_standalone_chat_workspace(&request));
}

#[tokio::test]
async fn project_work_does_not_copy_private_preferences_into_the_source_prompt() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    for preference in ["Always use concise replies", ""] {
        let mut personal = store.personal_stand_in(7, "mac").unwrap();
        personal["primary"] =
            json!({"enabled":true,"prompt":"Coordinate","preferences":preference});
        store.save_personal_stand_in(7, "mac", personal).unwrap();
        let payload = handler
            .prepare_stand_in_task(
                &json!({"id":"default","projectStore":"local","projectId":"project","userId":7,"sharedPreferences":"Stale preference"}),
                &json!({"id":"issue","title":"Task"}),
                &json!({"humanAssignmentId":"human"}),
            )
            .await
            .unwrap();
        let prompt = payload["message"].as_str().unwrap();
        assert!(!prompt.contains("Shared personal preferences"));
        assert!(!prompt.contains("Always use concise replies"));
        assert!(!prompt.contains("Stale preference"));
        if preference.is_empty() {
            assert!(!prompt.contains("Always use concise replies"));
        }
    }
}

#[test]
fn cloud_assignments_created_in_the_enable_second_are_not_lost() {
    let settings = json!({"id":"default","projectStore":"cloud","enabledAfter":"2026-10-22T06:54:17.591610+00:00"});
    assert!(assignment_after_enable(
        &json!({"created_at":"2026-10-22T06:54:17Z"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-22T06:54:16Z"}),
        &settings
    ));
    assert!(!assignment_after_enable(
        &json!({"created_at":"2026-10-22T06:54:17Z"}),
        &json!({"id":"default","projectStore":"local","enabledAfter":settings["enabledAfter"]})
    ));
}

#[tokio::test]
async fn independent_stand_in_does_not_resolve_old_agents_or_require_a_backend() {
    let handler = RuntimeWorkRpcHandler::new("mac", "unused");
    for reference in [
        json!({"agentResourceId":11}),
        json!({"agentId":"deleted","agentProject":{"id":"old","store":"cloud"}}),
    ] {
        let mut config = reference;
        config["userId"] = json!(7);
        let prepared = handler
            .prepare_stand_in_execution(
                json!({"message":"Review","origin":{"type":"stand_in_identity"}}),
                &config,
            )
            .await
            .unwrap();
        assert_eq!(prepared["executionRequest"]["team_id"], 0);
        assert_eq!(prepared["executionRequest"]["user_id"], 7);
        assert_eq!(
            prepared["executionRequest"]["bot"][0]["shell_type"],
            "Codex"
        );
    }
}

#[tokio::test]
async fn personal_settings_project_view_retains_the_requested_storage_kind() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let cloud = handler
        .stand_in_settings(
            json!({"userId":7,"projectId":"future-project","projectStore":"cloud"}),
            false,
        )
        .await
        .unwrap();
    assert_eq!(cloud["projectStore"], "cloud");
    assert_eq!(cloud["projectId"], "future-project");
}

#[tokio::test]
async fn independent_stand_in_keeps_connections_when_old_project_binding_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let initial = store.personal_stand_in(7, "mac").unwrap();
    let saved = store.save_personal_stand_in(7, "mac", initial).unwrap();
    let mut draft = saved.clone();
    draft["roles"][0]["agentId"] = json!("project-agent");
    draft["roles"][0]["agentProject"] = json!({"id":"project","store":"cloud"});
    draft["roles"][0]["connections"] = json!([{
        "providerId":"example","id":"group","kind":"group","profile":"work","name":"Group",
        "policy":{"automatic":true,"askBeforeAct":true}
    }]);
    let result = handler
        .personal_stand_in_settings(json!({"userId":7,"settings":draft}), true)
        .await
        .unwrap();
    assert!(result["roles"][0].get("agentId").is_none());
    assert!(result["roles"][0].get("agentProject").is_none());
    assert_eq!(result["roles"][0]["connections"][0]["id"], "group");
    assert_eq!(store.personal_stand_in(7, "mac").unwrap(), result);
}
