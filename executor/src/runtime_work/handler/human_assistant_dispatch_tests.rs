use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

struct Fixture {
    _root: tempfile::TempDir,
    handler: RuntimeWorkRpcHandler,
    server: tokio::task::JoinHandle<()>,
    issue: Arc<Mutex<Value>>,
    items: Arc<Mutex<Value>>,
    bindings: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<Value>>>,
    failures: Arc<Mutex<Vec<Value>>>,
    assignments: Arc<AtomicUsize>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture() -> Fixture {
    let issue = Arc::new(Mutex::new(
        json!({"id":"issue","title":"Private work","cloud_project_id":"project","assignee_user_id":7,"permissions":{"execute":true},
        "human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"},
        "human_assistant_dispatch":{"dispatchId":"dispatch","dispatchState":"waiting_device","executionId":"42"}}),
    ));
    let items = Arc::new(Mutex::new(json!([])));
    let bindings = Arc::new(Mutex::new(json!([])));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let failures = Arc::new(Mutex::new(Vec::new()));
    let assignments = Arc::new(AtomicUsize::new(0));
    let current = issue.clone();
    let listed = items.clone();
    let linked = bindings.clone();
    let linked_write = bindings.clone();
    let accepted = requests.clone();
    let failed = failures.clone();
    let assignment_reads = assignments.clone();
    let router = Router::new()
        .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
        .route("/api/v1/cloud-projects", get(|| async { Json(json!({"items":[{"id":"project"}]})) }))
        .route("/api/v1/cloud-projects/project/loop-items", get(move || {
            let items = listed.lock().unwrap().clone();
            async move { Json(json!({"items":items})) }
        }))
        .route("/api/v1/loop-items/issue", get(move || {
            let issue = current.lock().unwrap().clone();
            async move { Json(issue) }
        }))
        .route("/api/v1/loop-items/issue/assignments", get(move || {
            assignment_reads.fetch_add(1, Ordering::SeqCst);
            async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2020-01-01T00:00:00Z"}]})) }
        }))
        .route("/api/v1/loop-items/issue/tasks", get(move || {
            let rows = linked.lock().unwrap().clone();
            async move { Json(rows) }
        }).post(move |Json(body): Json<Value>| {
            *linked_write.lock().unwrap() = json!([{"task_id":body["taskId"],"device_id":body["deviceId"],"task_user_id":7,"human_assignment_id":body["humanAssignmentId"],"stand_in_pending":body["standInPending"],"stand_in_conversation_id":body["standInConversationId"],"execution_id":"42"}]);
            accepted.lock().unwrap().push(body);
            async { Json(json!({"id":"binding","execution_id":"42"})) }
        }))
        .route("/api/v1/loop-items/issue/assignments/assignment/receipt", axum::routing::post(|| async { Json(json!({})) }))
        .route("/api/v1/cloud-projects/project/executions/42/dispatch-failed", axum::routing::post(move |Json(body): Json<Value>| {
            failed.lock().unwrap().push(body);
            async { Json(json!({"status":"failed"})) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.turn_queue_path = Arc::new(root.path().join("turn-queue.json"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: url,
        auth_token: "test".into(),
        ..Default::default()
    })));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"Handle assigned work","preferences":"",
        "collaboration":{"enabled":true,"allProjects":false,"projects":[{"id":"forbidden","store":"cloud"},{"id":"project","store":"cloud"}],"excludedProjects":[],"tags":[]}});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    Fixture {
        _root: root,
        handler,
        server,
        issue,
        items,
        bindings,
        requests,
        failures,
        assignments,
    }
}

fn config(fixture: &Fixture) -> Value {
    let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
    fixture
        .handler
        .stand_in_project_configs(
            &store.declared_personal_stand_ins("mac").unwrap(),
            "project",
            "cloud",
        )
        .into_iter()
        .find(|role| role["id"] == "@primary")
        .unwrap()
}

#[tokio::test]
async fn durable_primary_admission_creates_one_private_queued_task_with_frozen_execution() {
    let fixture = fixture().await;
    {
        let mut scheduler = fixture.handler.turn_scheduler.lock().unwrap();
        scheduler.queued_turns.clear();
        scheduler.settings.max_concurrent_stand_in_tasks = 1;
        scheduler
            .active_task_ids
            .insert("other-stand-in".into(), RuntimeTaskKind::StandIn);
    }
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    for _ in 0..2 {
        fixture
            .handler
            .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
            .await
            .unwrap();
    }
    let task_id = fixture.handler.stand_in_task_id(&config, &issue);
    let task = fixture.handler.local_task_link(&task_id).unwrap();
    assert_eq!(fixture.handler.local_task_links(true).len(), 1);
    assert_eq!(
        fixture.handler.queued_local_task_position(&task_id),
        Some(0)
    );
    assert_eq!(task.runtime_handle["origin"]["executionId"], "42");
    assert_eq!(
        task.runtime_handle["executionRequest"]["origin"]["executionId"],
        "42"
    );
    assert_eq!(
        task.runtime_handle["origin"]["humanAssistantDispatchId"],
        "dispatch"
    );
    assert_eq!(task.runtime_handle["origin"]["publicConversation"], false);
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|body| body["humanAssistantDispatchId"] == "dispatch"
            && body["assignmentId"] == "assignment"));
    assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
    assert!(fixture.handler.turn_queue_path.exists());
}

#[tokio::test]
async fn durable_recovery_ignores_history_and_terminal_intents_after_one_hundred_items() {
    let fixture = fixture().await;
    let issue = fixture.issue.lock().unwrap().clone();
    let mut history = issue.clone();
    history
        .as_object_mut()
        .unwrap()
        .remove("human_assistant_dispatch");
    *fixture.items.lock().unwrap() = json!([history.clone()]);
    fixture
        .handler
        .recover_cloud_assistant_dispatches()
        .await
        .unwrap();
    assert_eq!(fixture.assignments.load(Ordering::SeqCst), 0);
    let config = config(&fixture);
    *fixture.bindings.lock().unwrap() = json!([{"task_id":fixture.handler.stand_in_task_id(&config, &issue),"device_id":"other","task_user_id":7}]);
    let mut items = vec![history; 101];
    items.push(issue.clone());
    *fixture.items.lock().unwrap() = json!(items);
    fixture
        .handler
        .recover_cloud_assistant_dispatches()
        .await
        .unwrap();
    assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
    assert!(fixture.handler.local_task_links(true).is_empty());
    for state in [
        "no_authorized_assistant",
        "cancelled",
        "completed",
        "running",
    ] {
        let mut issue = issue.clone();
        issue["human_assistant_dispatch"]["dispatchState"] = json!(state);
        *fixture.items.lock().unwrap() = json!([issue]);
        fixture
            .handler
            .recover_cloud_assistant_dispatches()
            .await
            .unwrap();
    }
    assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn replayed_nonprimary_or_terminal_intents_cannot_start_an_automatic_turn() {
    let fixture = fixture().await;
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let mut another_role = config.clone();
    another_role["id"] = json!("review");
    fixture
        .handler
        .execute_stand_in_task(&another_role, &issue, &issue["human_task_binding"])
        .await
        .unwrap();
    for state in [
        "cancelled",
        "completed",
        "running",
        "no_authorized_assistant",
    ] {
        let mut issue = issue.clone();
        issue["human_assistant_dispatch"]["dispatchState"] = json!(state);
        fixture
            .handler
            .execute_stand_in_task(&config, &issue, &issue["human_task_binding"])
            .await
            .unwrap();
    }
    assert!(fixture.requests.lock().unwrap().is_empty());
    assert!(fixture.handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn native_turn_authorization_rechecks_a_queued_dispatch_after_cancellation_or_reassignment() {
    let fixture = fixture().await;
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let payload = fixture
        .handler
        .prepare_stand_in_task(&config, &issue, &issue["human_task_binding"])
        .await
        .unwrap();
    let request = execution_request(&payload).unwrap();
    let task_id = fixture.handler.stand_in_task_id(&config, &issue);
    fixture.handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id,
        runtime_handle: json!({"origin":payload["origin"]}),
        ..Default::default()
    });
    fixture.issue.lock().unwrap()["human_assistant_dispatch"]["dispatchState"] = json!("queued");
    fixture
        .handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    fixture.issue.lock().unwrap()["human_assistant_dispatch"]["dispatchState"] =
        json!("cancelling");
    assert_eq!(
        fixture
            .handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap_err(),
        "Assistant assignment is no longer current"
    );
    fixture.issue.lock().unwrap()["human_assistant_dispatch"] =
        json!({"dispatchState":"queued","dispatchId":"new-assignment","executionId":"43"});
    assert_eq!(
        fixture
            .handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap_err(),
        "Assistant assignment is no longer current"
    );
}

#[tokio::test]
async fn native_turn_rechecks_revoked_local_grants_without_rebinding_another_device() {
    let fixture = fixture().await;
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let payload = fixture
        .handler
        .prepare_stand_in_task(&config, &issue, &issue["human_task_binding"])
        .await
        .unwrap();
    let request = execution_request(&payload).unwrap();
    let task_id = fixture.handler.stand_in_task_id(&config, &issue);
    fixture.handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id,
        runtime_handle: json!({"origin":payload["origin"]}),
        ..Default::default()
    });
    fixture.issue.lock().unwrap()["human_assistant_dispatch"]["dispatchState"] = json!("queued");
    let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
    let settings = store.declared_personal_stand_ins("mac").unwrap().remove(0);
    fixture
        .handler
        .validate_project_coordinator_request(&request)
        .await
        .unwrap();
    for change in [
        json!({"enabled":false}),
        json!({"executionDeviceId":"other-device"}),
        json!({"collaboration":{"enabled":false}}),
        json!({"collaboration":{"projects":[]}}),
        json!({"collaboration":{"excludedProjects":[{"id":"project","store":"cloud"}]}}),
        json!({"collaboration":{"tags":["different-tag"]}}),
        json!({"collaboration":{"projectPolicies":[{"id":"project","store":"cloud","policy":{"automatic":false,"askBeforeAct":false}}]}}),
    ] {
        let mut revoked = settings.clone();
        revoked["version"] =
            store.declared_personal_stand_ins("mac").unwrap()[0]["version"].clone();
        for (key, value) in change.as_object().unwrap() {
            if key == "collaboration" {
                for (field, value) in value.as_object().unwrap() {
                    revoked["primary"][key][field] = value.clone();
                }
            } else {
                revoked["primary"][key] = value.clone();
            }
        }
        store.save_personal_stand_in(7, "mac", revoked).unwrap();
        assert_eq!(
            fixture
                .handler
                .validate_project_coordinator_request(&request)
                .await
                .unwrap_err(),
            "Default assistant authorization is unavailable",
            "revoked grant: {change}"
        );
    }
    let mut other_device = settings;
    other_device["version"] =
        store.declared_personal_stand_ins("mac").unwrap()[0]["version"].clone();
    other_device["executionDeviceId"] = json!("other-device");
    store
        .save_personal_stand_in(7, "other-device", other_device)
        .unwrap();
    assert_eq!(
        fixture
            .handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap_err(),
        "Default assistant authorization is unavailable"
    );
    assert!(store.declared_personal_stand_ins("mac").unwrap().is_empty());
    assert_eq!(
        store
            .declared_personal_stand_ins("other-device")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn versioned_cancellation_signals_only_the_matching_active_frozen_execution() {
    let fixture = fixture().await;
    let task_id = "shared-task";
    fixture.handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.into(),
        runtime_handle: json!({"origin":{"humanAssistantDispatchId":"old","executionId":"41"}}),
        ..Default::default()
    });
    let (cancel, mut cancellation) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    let local_execution =
        fixture
            .handler
            .start_local_task_execution(task_id.into(), cancel, stopped);
    let mut request = ExecutionRequest::default();
    request.extra.insert(
        "origin".into(),
        json!({"humanAssistantDispatchId":"current","executionId":"42"}),
    );
    fixture
        .handler
        .active_local_executions
        .lock()
        .unwrap()
        .get_mut(task_id)
        .unwrap()
        .request = Some(request);
    let old = fixture
        .handler
        .cancel_task(json!({"taskId":task_id,"executionId":"41"}))
        .await
        .unwrap();
    assert_eq!(old["accepted"], false);
    assert!(matches!(
        cancellation.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert!(!fixture.handler.active_local_executions.lock().unwrap()[task_id].stop_requested);
    let current = fixture
        .handler
        .cancel_task(json!({"taskId":task_id,"executionId":"42"}))
        .await
        .unwrap();
    assert_eq!(current["accepted"], true);
    assert_eq!(current["cleanupPending"], true);
    assert_eq!(cancellation.try_recv(), Ok(()));
    assert!(fixture
        .handler
        .finish_local_task_execution(task_id, local_execution));
    let missing = fixture
        .handler
        .cancel_task(json!({"taskId":task_id,"executionId":"42"}))
        .await
        .unwrap();
    assert_eq!(missing["accepted"], false);
}

#[tokio::test]
async fn durable_wakeup_does_not_rebind_another_devices_authorization() {
    let fixture = fixture().await;
    let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
    store.personal_stand_in(7, "other").unwrap();
    fixture.handler.process_stand_in_assignment(json!({"projectId":"project","itemId":"issue","assignmentId":"assignment","recipientUserId":7})).await.unwrap();
    assert_eq!(
        store.personal_stand_in(7, "").unwrap()["executionDeviceId"],
        "other"
    );
    assert_eq!(fixture.assignments.load(Ordering::SeqCst), 0);
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn durable_preflight_failure_is_persisted_before_reserving_or_starting_a_task() {
    let fixture = fixture().await;
    let mut config = config(&fixture);
    config["workspace"] = json!({"projectKey":"missing","workspacePath":"/not-present","executionMode":"current_workspace"});
    let issue = fixture.issue.lock().unwrap().clone();
    let error = fixture
        .handler
        .start_cloud_stand_in_with_roles(&[config], &issue)
        .await
        .unwrap_err();
    assert_eq!(error.code, "workspace_unavailable");
    assert_eq!(
        fixture.failures.lock().unwrap()[0]["note"],
        "workspace_unavailable"
    );
    assert!(fixture.requests.lock().unwrap().is_empty());
    assert!(fixture.handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn durable_brief_keeps_work_private_while_mentions_and_manual_work_keep_their_contract() {
    let fixture = fixture().await;
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let binding = &issue["human_task_binding"];
    let payload = fixture
        .handler
        .prepare_stand_in_task(&config, &issue, binding)
        .await
        .unwrap();
    assert!(payload["message"]
        .as_str()
        .unwrap()
        .contains("可核验的证据引用"));
    assert!(!payload["executionRequest"]["system_prompt"]
        .as_str()
        .unwrap()
        .contains("Each of your public assistant messages"));
    assert_eq!(payload["origin"]["publicConversation"], false);
    for changed in [
        json!({"manual":true}),
        json!({"triggerCommentId":"comment"}),
    ] {
        let mut legacy = config.clone();
        legacy
            .as_object_mut()
            .unwrap()
            .extend(changed.as_object().unwrap().clone());
        let legacy = fixture
            .handler
            .prepare_stand_in_task(&legacy, &issue, binding)
            .await
            .unwrap();
        assert_eq!(legacy["origin"]["publicConversation"], true);
        assert!(legacy["origin"].get("humanAssistantDispatchId").is_none());
    }
    let task_id = fixture.handler.stand_in_task_id(&config, &issue);
    fixture.handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.clone(),
        thread_id: Some("thread".into()),
        runtime_handle: json!({"origin":payload["origin"],"lastTurnId":"turn"}),
        ..Default::default()
    });
    for message in [
        json!({"method":"turn/started","params":{"threadId":"thread","turnId":"turn"}}),
        json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"private","type":"agentMessage","phase":"commentary","text":"Private progress"}}}),
    ] {
        fixture
            .handler
            .persist_stand_in_issue_reply(&task_id, &message.into());
    }
    assert!(fixture
        .handler
        .local_task_link(&task_id)
        .unwrap()
        .runtime_handle["standInIssueReplies"]
        .is_null());
}
