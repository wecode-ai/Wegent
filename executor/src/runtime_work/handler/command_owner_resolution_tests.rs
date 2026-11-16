//! Owner resolution preserves uncertainty, durability and original execution identity.
use super::*;
use crate::runtime_work::handler::tests::{install_native_history, isolated_runtime_work_handler};

fn fixture(label: &str) -> (RuntimeWorkRpcHandler, PathBuf, SpawnTurnRequest, Value) {
    let (mut handler, root) = isolated_runtime_work_handler(label);
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.command_journal.lock().unwrap().clear();
    install_native_history(
        &mut handler,
        &root,
        vec![json!({"id":"current","status":"interrupted","items":[]})],
        None,
    );
    fs::write(root.join("thread_read.json"), json!({"thread":{"id":"thread-1","status":{"type":"idle"},"cwd":"/tmp/project","historyMode":"paginated"}}).to_string()).unwrap();
    fs::write(
        root.join("thread_timeline_list.json"),
        json!({"data":[{"type":"turnStarted","position":1,"turnId":"current"}],"nextCursor":null})
            .to_string(),
    )
    .unwrap();
    let payload = json!({"taskId":"task-1","commandId":"command","message":"input","executionRequest":{"task_id":"task-1","subtask_id":"input-1","user_id":7,"device_id":"device-1","prompt":"input"}});
    let mut request = execution_request(&payload).unwrap();
    apply_runtime_payload_metadata(&mut request, &payload);
    let turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-1".into(),
        runtime: "codex".into(),
        request,
        send_payload: Some(payload),
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    };
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".into(),
        thread_id: Some("thread-1".into()),
        runtime: "codex".into(),
        title: "Reviewed execution".into(),
        runtime_handle: json!({"executionRequest":turn.request}),
        ..Default::default()
    });
    let mut command = RuntimeCommand::from_turn(&turn, CommandState::RecoveryRequired)
        .unwrap()
        .unwrap();
    command.native = Some((0, "thread-1".into(), "current".into()));
    let resolve = json!({"taskId":"task-1","commandId":"command","userId":7,"decision":"abandon","requestId":"review-1","expectedFingerprint":command.fingerprint,"expectedNative":command.native});
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(command.key(), command);
    (handler, root, turn, resolve)
}

async fn cleanup(handler: &RuntimeWorkRpcHandler, root: PathBuf) {
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owner_abandonment_is_durable_idempotent_and_never_replays_unknown_execution() {
    let (handler, root, turn, resolve) = fixture("owner-resolution-durable");
    let review = handler
        .dispatch_method(
            "runtime.tasks.commands.get",
            json!({"taskId":"task-1","commandId":"command","userId":7}),
        )
        .await
        .unwrap();
    assert_eq!(review["state"], "recovery_required");
    assert_eq!(review["nativeOutcome"], "unknown");
    assert!(review["ownerReview"]
        .as_object()
        .unwrap()
        .values()
        .all(|v| v == true));
    let receipt = handler
        .dispatch_method("runtime.tasks.commands.resolve", resolve.clone())
        .await
        .unwrap();
    assert_eq!(receipt["state"], "abandoned");
    assert_eq!(receipt["nativeOutcome"], "unknown");
    assert_eq!(receipt["native"], resolve["expectedNative"]);
    assert_eq!(receipt["taskTitle"], "Reviewed execution");
    assert_eq!(receipt["requiresUserReview"], false);
    let again = handler
        .resolve_command_owner(resolve.clone())
        .await
        .unwrap();
    assert_eq!(again["ownerResolution"], receipt["ownerResolution"]);
    let mut stale = resolve;
    stale["requestId"] = json!("another-review");
    assert_eq!(
        handler.resolve_command_owner(stale).await.unwrap_err().code,
        "command_resolution_conflict"
    );
    assert_eq!(
        handler.existing_command(&turn).unwrap_err().code,
        "command_abandoned"
    );
    let persisted = super::super::turns::read_runtime_turn_state(&handler.turn_queue_path).unwrap();
    let saved = &persisted.commands[&key("task-1", "command")];
    assert_eq!(saved.state, CommandState::RecoveryRequired);
    assert!(saved.is_owner_abandoned());
    // An older reader ignores the new optional owner disposition while retaining its safe native state.
    #[derive(serde::Deserialize)]
    struct PreviousCommand {
        state: CommandState,
        native: Option<(u64, String, String)>,
    }
    let previous: PreviousCommand =
        serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
    assert_eq!(previous.state, CommandState::RecoveryRequired);
    assert_eq!(previous.native, saved.native);
    let mut journal = persisted.commands.clone();
    assert_eq!(
        project_queue(&mut journal, &VecDeque::from([turn.clone()]), &[])
            .unwrap_err()
            .code,
        "command_not_dispatchable"
    );
    assert_eq!(
        saved.owner_resolution.as_ref().unwrap(),
        &receipt["ownerResolution"]
    );
    let requests = fs::read_to_string(root.join("requests.jsonl")).unwrap();
    assert!(requests
        .lines()
        .all(|line| serde_json::from_str::<Value>(line).unwrap()["method"] != "turn/start"));
    cleanup(&handler, root).await;
}

#[tokio::test]
async fn owner_resolution_rejects_stale_foreign_and_active_execution() {
    let (handler, root, _, resolve) = fixture("owner-resolution-guards");
    for (field, value) in [
        ("expectedFingerprint", json!("changed")),
        ("expectedNative", json!([0, "thread-1", "different"])),
        ("decision", json!("retry")),
    ] {
        let mut wrong = resolve.clone();
        wrong[field] = value;
        assert_eq!(
            handler.resolve_command_owner(wrong).await.unwrap_err().code,
            "command_resolution_conflict"
        );
    }
    let mut foreign = handler.clone();
    foreign.device_id = "other-device".into();
    assert_eq!(
        foreign
            .resolve_command_owner(resolve.clone())
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    let mut wrong = resolve.clone();
    wrong["userId"] = json!(8);
    assert!(handler.resolve_command_owner(wrong).await.is_err());
    let command = handler.command_journal.lock().unwrap()[&key("task-1", "command")].clone();
    let mut missing_device = command.clone();
    missing_device.turn.request.device_id = None;
    assert_eq!(
        handler
            .check_command_resolution_owner(&missing_device, 7)
            .unwrap_err()
            .code,
        "permission_denied"
    );
    handler
        .active_goal_turns
        .lock()
        .unwrap()
        .insert("task-1".into(), command.turn.clone());
    assert_eq!(
        handler
            .resolve_command_owner(resolve)
            .await
            .unwrap_err()
            .code,
        "command_resolution_active"
    );
    assert_eq!(
        handler.command_journal.lock().unwrap()[&command.key()].state,
        CommandState::RecoveryRequired
    );
    handler.active_goal_turns.lock().unwrap().clear();
    cleanup(&handler, root).await;
}

#[tokio::test]
async fn failed_owner_resolution_commit_rolls_back_without_inventing_a_receipt() {
    let (mut handler, root, _, resolve) = fixture("owner-resolution-commit-failure");
    let invalid = root.join("queue-is-a-directory");
    fs::create_dir_all(&invalid).unwrap();
    handler.turn_queue_path = Arc::new(invalid);
    assert!(handler.resolve_command_owner(resolve).await.is_err());
    let command = handler.command_journal.lock().unwrap()[&key("task-1", "command")].clone();
    assert_eq!(command.state, CommandState::RecoveryRequired);
    assert!(command.owner_resolution.is_none());
    cleanup(&handler, root).await;
}

#[tokio::test]
async fn owner_resolution_checks_the_connected_account_instead_of_trusting_payload_user() {
    use axum::{routing::get, Json, Router};
    let app = Router::new().route("/api/users/me", get(|| async { Json(json!({"id":8})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (handler, root, _, resolve) = fixture("owner-resolution-connected-account");
    *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
        backend_url: url,
        auth_token: "synthetic-test-token".into(),
        ..Default::default()
    });
    assert_eq!(
        handler
            .resolve_command_owner(resolve)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert_eq!(
        handler.command_journal.lock().unwrap()[&key("task-1", "command")].state,
        CommandState::RecoveryRequired
    );
    server.abort();
    // No native request was made because account verification failed first.
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn abandoned_receipt_retires_only_original_assessment_after_restart_without_replaying_actions(
) {
    let (handler, root, _, _) = fixture("owner-resolution-controller-restart");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "device-1").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
    let settings = store
        .save_personal_stand_in(7, "device-1", settings)
        .unwrap();
    let event = store
        .enqueue_stand_in_event(
            7,
            json!("pending"),
            json!({"kind":"connection","roleIds":["@primary"]}),
        )
        .unwrap();
    store.save_stand_in_processing_state(7,&json!({"batchId":"old-batch","snapshot":{"events":[event]},"routerSnapshot":{"events":[event]}})).unwrap();
    let mut action = store
        .queue_stand_in_action(
            7,
            "device-1",
            "old-batch",
            "create_work",
            json!({"eventIds":[event["id"]]}),
        )
        .unwrap();
    action["kind"] = json!("assess");
    action["status"] = json!("sending");
    store.save_stand_in_action(7, &action).unwrap();
    let mut original = handler
        .command_journal
        .lock()
        .unwrap()
        .remove(&key("task-1", "command"))
        .unwrap();
    original.turn.local_task_id = "stand-in-coordinator-7".into();
    original.turn.request.task_id = original.turn.local_task_id.clone();
    original
        .turn
        .request
        .extra
        .insert("runtime_command_id".into(), action["id"].clone());
    let native = original.native.clone();
    original = RuntimeCommand::from_turn(&original.turn, CommandState::RecoveryRequired)
        .unwrap()
        .unwrap();
    original.native = native;
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: original.turn.local_task_id.clone(),
        thread_id: Some("thread-1".into()),
        runtime: "codex".into(),
        runtime_handle: json!({"executionRequest":original.turn.request}),
        ..Default::default()
    });
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(original.key(), original.clone());
    let mut state = store.stand_in_processing_state(7).unwrap();
    state["error"] = json!({"code":"coordination_recovery_required","commandId":original.id,"taskId":original.turn.local_task_id});
    store.save_stand_in_processing_state(7, &state).unwrap();
    let resolve = json!({"taskId":original.turn.local_task_id,"commandId":original.id,"userId":7,"decision":"abandon","requestId":"review-1","expectedFingerprint":original.fingerprint,"expectedNative":original.native});
    let receipt = handler.resolve_command_owner(resolve).await.unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "sending");
    // Restore the durable journal before any processing/check call: a lost UI second step is safe.
    *handler.command_journal.lock().unwrap() =
        super::super::turns::read_runtime_turn_state(&handler.turn_queue_path)
            .unwrap()
            .commands;
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    let retired = store.stand_in_actions(7).unwrap();
    assert_eq!(retired[0]["status"], "cancelled");
    assert_eq!(retired[0]["resolution"], "owner_abandoned");
    assert_eq!(retired[0]["result"]["nativeOutcome"], "unknown");
    let state = store.stand_in_processing_state(7).unwrap();
    assert!(state["error"].is_null());
    assert!(state["snapshot"].is_null());
    assert_eq!(store.stand_in_events(7).unwrap()[0], event);
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap(), retired);
    let mut foreign = receipt.clone();
    foreign["ownerResolution"]["deviceId"] = json!("other-device");
    assert!(store
        .retire_abandoned_stand_in_assessment(7, "device-1", &original.id, foreign)
        .is_err());
    assert_eq!(store.stand_in_actions(7).unwrap(), retired);
    cleanup(&handler, root).await;
}

#[tokio::test]
async fn native_unloaded_owner_resolution_preserves_unknown_history_and_original_binding() {
    let (handler, root, _, resolve) = fixture("owner-resolution-native-unloaded");
    fs::write(
        root.join("thread_read.json"),
        json!({"thread":{"id":"thread-1","status":{"type":"notLoaded"}}}).to_string(),
    )
    .unwrap();
    let native = handler.read_codex_recent_turns("thread-1").await.unwrap();
    assert_eq!(native.diagnostic_summary()["runtimeStatus"], "notLoaded");
    assert_eq!(
        native.diagnostic_summary()["latestTurnStatus"],
        "interrupted"
    );
    assert_eq!(native.diagnostic_summary()["derivedActivity"], "Unknown");
    assert!(!native.is_idle());
    assert_eq!(native.terminal_task_status(), None);
    let receipt = handler
        .dispatch_method("runtime.tasks.commands.resolve", resolve.clone())
        .await
        .unwrap();
    assert_eq!(receipt["state"], "abandoned");
    assert_eq!(receipt["nativeOutcome"], "unknown");
    assert_eq!(receipt["native"], resolve["expectedNative"]);
    assert_eq!(
        handler.command_journal.lock().unwrap()[&key("task-1", "command")].state,
        CommandState::RecoveryRequired
    );
    let requests = fs::read_to_string(root.join("requests.jsonl")).unwrap();
    assert!(requests.lines().all(|line| !matches!(
        serde_json::from_str::<Value>(line).unwrap()["method"].as_str(),
        Some("turn/start" | "turn/interrupt")
    )));
    cleanup(&handler, root).await;
}

#[tokio::test]
async fn native_owner_resolution_rejects_positive_activity_and_unavailable_runtime_status() {
    for (index, status, expected) in [
        (0, Some("active"), "command_resolution_active"),
        (1, Some("systemError"), "command_resolution_unavailable"),
        (2, Some("unrecognized"), "command_resolution_unavailable"),
        (3, None, "command_resolution_unavailable"),
    ] {
        let (handler, root, _, resolve) = fixture(&format!("owner-resolution-runtime-{index}"));
        let mut thread = json!({"id":"thread-1"});
        if let Some(status) = status {
            thread["status"] = json!({"type":status});
        }
        fs::write(
            root.join("thread_read.json"),
            json!({"thread":thread}).to_string(),
        )
        .unwrap();
        if status.is_none() {
            fs::write(root.join("thread_turns_list.json"),json!({"data":[{"id":"current","status":"inProgress","items":[]}],"nextCursor":null}).to_string()).unwrap();
        }
        assert_eq!(
            handler
                .resolve_command_owner(resolve)
                .await
                .unwrap_err()
                .code,
            expected
        );
        let command = handler.command_journal.lock().unwrap()[&key("task-1", "command")].clone();
        assert_eq!(command.state, CommandState::RecoveryRequired);
        assert!(command.owner_resolution.is_none());
        cleanup(&handler, root).await;
    }
}

#[tokio::test]
async fn unloaded_native_does_not_bypass_local_goal_or_queued_admission() {
    let (handler, root, turn, resolve) = fixture("owner-resolution-unloaded-local-admission");
    fs::write(
        root.join("thread_read.json"),
        json!({"thread":{"id":"thread-1","status":{"type":"notLoaded"}}}).to_string(),
    )
    .unwrap();
    handler
        .active_goal_turns
        .lock()
        .unwrap()
        .insert("task-1".into(), turn.clone());
    assert_eq!(
        handler
            .resolve_command_owner(resolve.clone())
            .await
            .unwrap_err()
            .code,
        "command_resolution_active"
    );
    handler.active_goal_turns.lock().unwrap().clear();
    handler
        .store
        .update_task("task-1", |link| link.goal_status = Some("active".into()));
    assert_eq!(
        handler
            .resolve_command_owner(resolve.clone())
            .await
            .unwrap_err()
            .code,
        "command_resolution_active"
    );
    handler
        .store
        .update_task("task-1", |link| link.goal_status = None);
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .push_back(turn);
    assert_eq!(
        handler
            .resolve_command_owner(resolve)
            .await
            .unwrap_err()
            .code,
        "command_resolution_active"
    );
    handler.turn_scheduler.lock().unwrap().queued_turns.clear();
    assert!(
        handler.command_journal.lock().unwrap()[&key("task-1", "command")]
            .owner_resolution
            .is_none()
    );
    cleanup(&handler, root).await;
}
