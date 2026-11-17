use super::*;
use axum::{routing::get, Json, Router};
use std::sync::atomic::AtomicUsize;

#[path = "human_assistant_owner_tests.rs"]
mod owner_tests;

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

#[test]
fn automation_brief_and_origin_preserve_the_same_assignment_snapshot() {
    let binding = json!({"humanAssignmentId":"human","assignmentId":"assignment"});
    let context = json!({"automation_run_id":"run","human_assignment_id":"human",
        "assignment_id":"assignment","workflow_stage_id":"ux_spec","non_workflow":false,
        "required_deliverables":[{"id":"ux_spec_file","value_type":"file"}],
        "idempotency_key":"run:human"});
    let dispatch = json!({"human_automation":context});
    let mut prompt = String::new();
    append_automation_brief(&mut prompt, &dispatch, &binding);
    assert!(prompt.contains("ux_spec_file"));
    assert!(prompt.contains("ux_spec"));
    assert!(prompt.contains("run:human"));
    let mut origin = json!({});
    append_automation_origin(&mut origin, &dispatch, &binding);
    assert_eq!(origin["human_automation"], context);
    assert_eq!(origin["workflowStageId"], "ux_spec");
    assert_eq!(origin["automationRunId"], "run");
    assert_eq!(origin["idempotencyKey"], "run:human");
    for changed in [
        json!({"humanAssignmentId":"another-human","assignmentId":"assignment"}),
        json!({"humanAssignmentId":"human","assignmentId":"another-assignment"}),
    ] {
        let mut stale = json!({});
        append_automation_origin(&mut stale, &dispatch, &changed);
        assert!(stale.get("human_automation").is_none());
    }
    let mut ordinary = dispatch.clone();
    ordinary["human_automation"]["workflow_stage_id"] = Value::Null;
    ordinary["human_automation"]["non_workflow"] = json!(true);
    let mut origin = json!({});
    append_automation_origin(&mut origin, &ordinary, &binding);
    assert_eq!(origin["workflowStageId"], Value::Null);
    assert_eq!(origin["nonWorkflow"], true);
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
        "direct_human_assignment_receipt":{"projectId":"project","issueId":"issue","humanAssignmentId":"human","ownerUserId":7,
            "dispatchId":"dispatch","state":"waiting_device","reasonCode":"waiting_device","executionId":"42",
            "runtimeTaskId":null,"deliveryId":null,"assignmentVersion":1,"updatedAt":"2026-11-16T00:00:00Z"}}),
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
    let admitted_issue = issue.clone();
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
            admitted_issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!("running");
            admitted_issue.lock().unwrap()["direct_human_assignment_receipt"]["runtimeTaskId"] = body["taskId"].clone();
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
async fn failed_start_recovery_keeps_prepared_durable_identity_and_native_authority() {
    let mut fixture = fixture().await;
    fixture.handler.command_journal = Arc::new(Mutex::new(Default::default()));
    {
        let mut scheduler = fixture.handler.turn_scheduler.lock().unwrap();
        scheduler.settings.max_concurrent_tasks = 0;
        scheduler.settings.max_concurrent_stand_in_tasks = 0;
        scheduler.settings.max_concurrent_agent_tasks = 0;
    }
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let prepared = fixture
        .handler
        .prepare_stand_in_task(&config, &issue, &issue["human_task_binding"])
        .await
        .unwrap();
    let task_id = fixture.handler.stand_in_task_id(&config, &issue);
    let mut link = RuntimeTaskLink::new_pending(
        task_id.clone(),
        fixture._root.path().display().to_string(),
        "Original assigned work".into(),
    );
    link.project_instructions = prepared["executionRequest"]["system_prompt"]
        .as_str()
        .unwrap()
        .to_owned();
    link.runtime_handle = json!({
        "origin":prepared["origin"],"executionRequest":prepared["executionRequest"],
        "standInIssueWakeups":["human"]
    });
    fixture.handler.upsert_local_task(link);
    fixture.handler.retain_failed_runtime_task(
        &task_id,
        &AppIpcError::new("runtime_start_failed", "Synthetic native startup failure"),
    );
    let mut ui_request = prepared["executionRequest"].clone();
    ui_request.as_object_mut().unwrap().remove("origin");
    ui_request["system_prompt"] = json!("");
    let retry = json!({
        "taskId":task_id,"commandId":"explicit-startup-retry",
        "message":"Retry the assigned work","executionRequest":ui_request
    });
    let response = fixture.handler.send_message(retry.clone()).await.unwrap();
    assert_eq!(response["accepted"], true);
    let duplicate = fixture.handler.send_message(retry).await.unwrap();
    assert_eq!(duplicate["state"], "queued");
    assert_eq!(
        fixture
            .handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .len(),
        1
    );
    let queued = fixture.handler.turn_scheduler.lock().unwrap().queued_turns[0]
        .request
        .clone();
    assert_eq!(queued.extra["origin"], prepared["origin"]);
    assert_eq!(
        queued.system_prompt,
        prepared["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap()
    );
    let recovered = fixture.handler.local_task_link(&task_id).unwrap();
    assert_eq!(recovered.runtime_handle["origin"], prepared["origin"]);
    assert_eq!(
        recovered.runtime_handle["standInIssueWakeups"],
        json!(["human"])
    );
    assert_eq!(fixture.handler.local_task_links(true).len(), 1);
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!("running");
    fixture
        .handler
        .validate_project_coordinator_request(&queued)
        .await
        .unwrap();
    for dispatch in [
        json!({"dispatchId":"dispatch","executionId":"42","state":"cancelled"}),
        json!({"dispatchId":"reassigned","executionId":"43","state":"queued"}),
    ] {
        fixture.issue.lock().unwrap()["direct_human_assignment_receipt"] = dispatch;
        assert_eq!(
            fixture
                .handler
                .validate_project_coordinator_request(&queued)
                .await
                .unwrap_err(),
            "Assistant assignment is no longer current"
        );
    }
    *fixture.issue.lock().unwrap() = issue;
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!("running");
    let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.declared_personal_stand_ins("mac").unwrap().remove(0);
    settings["primary"]["enabled"] = json!(false);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert_eq!(
        fixture
            .handler
            .validate_project_coordinator_request(&queued)
            .await
            .unwrap_err(),
        "Default assistant authorization is unavailable"
    );
}

#[tokio::test]
async fn preflight_failure_redacts_shared_diagnostics_before_truncation() {
    let fixture = fixture().await;
    let config = config(&fixture);
    let issue = fixture.issue.lock().unwrap().clone();
    let long_secret = "synthetic-private-value".repeat(200);
    let error = AppIpcError::new(
        "model_unavailable",
        format!(
            "Authorization: Bearer synthetic-bearer\napi_key=\"synthetic-key\"\npassword='synthetic-password'\nsecret={long_secret}\nReconnect the selected model."
        ),
    );
    fixture
        .handler
        .report_assistant_preflight_failure(&config, &issue, &error)
        .await;
    let failures = fixture.failures.lock().unwrap();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["note"], "model_unavailable");
    let message = failures[0]["error"].as_str().unwrap();
    for secret in [
        "synthetic-bearer",
        "synthetic-key",
        "synthetic-password",
        "synthetic-private-value",
    ] {
        assert!(!message.contains(secret), "credential leaked: {secret}");
    }
    assert!(message.contains("[redacted]"));
    assert!(message.contains("Reconnect the selected model."));
    assert!(message.chars().count() <= 2000);
}

#[tokio::test]
async fn receipt_scope_and_policy_cannot_fall_back_to_another_automatic_role() {
    let fixture = fixture().await;
    let config = config(&fixture);
    let mut another_role = config.clone();
    another_role["id"] = json!("review");
    for change in [
        json!({"ownerUserId":8}),
        json!({"projectId":"another-project"}),
        json!({"issueId":"another-issue"}),
        json!({"humanAssignmentId":"superseded-assignment"}),
        json!({"state":"blocked_policy","reasonCode":"tag_mismatch"}),
    ] {
        let mut issue = fixture.issue.lock().unwrap().clone();
        issue["direct_human_assignment_receipt"]
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        fixture
            .handler
            .start_cloud_stand_in_with_roles(&[another_role.clone(), config.clone()], &issue)
            .await
            .unwrap();
    }
    assert_eq!(fixture.assignments.load(Ordering::SeqCst), 0);
    assert!(fixture.requests.lock().unwrap().is_empty());
    assert!(fixture.handler.local_task_links(true).is_empty());
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
        .remove("direct_human_assignment_receipt");
    history["human_assistant_dispatch"] =
        json!({"dispatchId":"legacy","dispatchState":"queued","executionId":"old"});
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
        "blocked_policy",
        "cancelling",
        "cancelled",
        "completed",
        "running",
        "waiting_user",
        "failed",
        "superseded",
    ] {
        let mut issue = issue.clone();
        issue["direct_human_assignment_receipt"]["state"] = json!(state);
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
        "cancelling",
        "cancelled",
        "completed",
        "running",
        "blocked_policy",
        "waiting_user",
    ] {
        let mut issue = issue.clone();
        issue["direct_human_assignment_receipt"]["state"] = json!(state);
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
    for state in ["running", "waiting_user"] {
        fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!(state);
        fixture
            .handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap();
    }
    for state in [
        "queued",
        "waiting_device",
        "blocked_policy",
        "cancelling",
        "cancelled",
    ] {
        fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!(state);
        assert_eq!(
            fixture
                .handler
                .validate_project_coordinator_request(&request)
                .await
                .unwrap_err(),
            "Assistant assignment is no longer current"
        );
    }
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!("running");
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["reasonCode"] =
        json!("cancel_requested");
    assert_eq!(
        fixture
            .handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap_err(),
        "Assistant assignment is no longer current"
    );
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"] =
        json!({"state":"queued","dispatchId":"new-assignment","executionId":"43"});
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
    fixture.issue.lock().unwrap()["direct_human_assignment_receipt"]["state"] = json!("running");
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
    for requested_id in ["shared-task", "019f4c0d-b036-78f3-b879-7e5ed203ad61"] {
        assert_versioned_cancellation(requested_id).await;
    }
}

async fn assert_versioned_cancellation(requested_id: &str) {
    let fixture = fixture().await;
    let task_id = "shared-task";
    fixture.handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id.into(),
        thread_id: Some("019f4c0d-b036-78f3-b879-7e5ed203ad61".into()),
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
        .cancel_task(json!({"taskId":requested_id,"executionId":"41"}))
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
        .cancel_task(json!({"taskId":requested_id,"executionId":"42"}))
        .await
        .unwrap();
    assert_eq!(current["accepted"], true);
    assert_eq!(current["cleanupPending"], true);
    assert_eq!(current["taskId"], task_id);
    assert_eq!(cancellation.try_recv(), Ok(()));
    assert!(fixture
        .handler
        .finish_local_task_execution(task_id, local_execution));
    let missing = fixture
        .handler
        .cancel_task(json!({"taskId":requested_id,"executionId":"42"}))
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
