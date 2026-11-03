use super::*;

fn fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
    settings["roles"][0]["enabled"] = json!(true);
    settings["roles"][0]["connections"] = json!([{ "providerId":"@wegent/dsh-connection-dingtalk/dingtalk", "id":"group", "profile":"default", "kind":"group", "name":"Group", "policy":{"automatic":true,"askBeforeAct":true,"immediate":false} }]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    (handler, store, settings)
}

fn connection_event() -> Value {
    json!({"roleScoped":true,"kind":"connection","source":{"providerId":"@wegent/dsh-connection-dingtalk/dingtalk","id":"group","profile":"default","kind":"group"},"message":{"id":"event","text":"Source message","at":chrono::Utc::now().to_rfc3339()},"roleIds":["default"]})
}

#[tokio::test]
async fn a_waiting_assessment_retires_only_after_the_original_question_is_resolved() {
    use super::super::command_journal::{CommandState, RuntimeCommand};
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!("waiting-batch"), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    let mut action = store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "create_work",
            json!({"eventIds":[event["id"]]}),
        )
        .unwrap();
    action["kind"] = json!("assess");
    action["status"] = json!("sending");
    store.save_stand_in_action(7, &action).unwrap();
    let mut request = ExecutionRequest::default();
    request.extra.insert("user_id".into(), json!(7));
    let command = RuntimeCommand {
        id: action["id"].as_str().unwrap().into(),
        fingerprint: "original-assessment".into(),
        state: CommandState::AwaitingUser,
        accepted_at: 1,
        turn: SpawnTurnRequest {
            local_task_id: task_id(7),
            runtime: "codex".into(),
            request,
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        },
        native: None,
    };
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(command.key(), command);
    let mut link = RuntimeTaskLink {
        local_task_id: task_id(7),
        status: "active".into(),
        interaction_status: Some("waitingForUserInput".into()),
        ..Default::default()
    };
    handler.upsert_local_task(link.clone());
    let wake = json!({"contextId":"personal:7"});
    assert_eq!(
        handler
            .coordination_rpc("runtime.coordination.wake", wake.clone())
            .await
            .unwrap_err()
            .code,
        "work_awaiting_user"
    );
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "sending");
    // Native completion of an explicit answer clears the original interaction.
    link.interaction_status = None;
    link.status = "done".into();
    handler.upsert_local_task(link);
    handler
        .coordination_rpc("runtime.coordination.wake", wake)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "cancelled");
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["id"], event["id"]);
    let journal = handler.command_journal.lock().unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(
        journal.values().next().unwrap().state,
        CommandState::AwaitingUser
    );
}

#[test]
fn unavailable_work_transcript_does_not_fail_or_consume_intake() {
    let _lock = crate::test_env::lock();
    let environment = tempfile::tempdir().unwrap();
    let _env: Vec<_> = [
        "HOME",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_WORKBENCH_HOME",
        "WEGENT_CAPABILITIES_HOME",
    ]
    .into_iter()
    .map(|key| {
        let directory = environment.path().join(key);
        fs::create_dir_all(&directory).unwrap();
        super::super::tests::ScalarEnv::set(key, directory.to_str().unwrap())
    })
    .collect();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    settings["primary"]["enabled"] = json!(true);
    settings["primary"]["model"] = json!({"runtime":"codex"});
    let source_event = connection_event();
    let work = store
        .ingest_stand_in_message(
            7,
            "default",
            &source_event["source"],
            &source_event["message"],
            None,
        )
        .unwrap();
    let work_id = work["id"].as_str().unwrap();
    let link = RuntimeTaskLink {
        local_task_id: work_id.to_owned(),
        status: "active".into(),
        thread_id: Some("00000000-0000-0000-0000-000000000001".into()),
        runtime_handle: json!({"origin":{"type":"connection_work","initiatedBy":"stand_in","userId":7,"standInId":"default"}}),
        ..Default::default()
    };
    handler.upsert_local_task(link.clone());
    handler
        .validate_followup_role(&store, 7, &settings["roles"][0], &link)
        .await
        .unwrap();
    let event = store
        .enqueue_stand_in_event(7, json!(["test"]), connection_event())
        .unwrap();
    assert!(handler
        .transcript(json!({"taskId":work_id,"limit":3}))
        .await
        .is_err());
    assert_eq!(
        handler
            .coordination_works(&store, 7, &settings)
            .await
            .unwrap(),
        Vec::<Value>::new()
    );
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["id"], event["id"]);
    assert!(handler.local_task_link(&task_id(7)).is_none());
    assert_eq!(store.stand_in_events(7).unwrap(), vec![event]);
    });
}

#[tokio::test]
async fn empty_intake_and_future_events_do_not_prepare_or_start_a_model() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let empty = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(empty["events"], json!([]));
    let mut event = connection_event();
    event["notBefore"] = json!("2099-01-01T00:00:00Z");
    let event = store
        .enqueue_stand_in_event(7, json!("future"), event)
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    let error=handler.coordination_rpc("runtime.coordination.commit",json!({"contextId":"personal:7","snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Assess this batch","nextWakeAt":null})).await.unwrap_err();
    assert_eq!(error.code, "not_due");
    assert!(handler.local_task_links(true).is_empty());
    assert!(store.stand_in_actions(7).unwrap().is_empty());
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
}

#[tokio::test]
async fn commands_recover_after_restart_and_deferred_events_wait_until_due() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!(["test"]), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "defer_events",
            json!({"eventIds":[event["id"]],"at":"2099-01-01T00:00:00Z","reason":"Wait"}),
        )
        .unwrap();
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert!(!due(
        &store.stand_in_events(7).unwrap()[0],
        chrono::Utc::now()
    ));
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "succeeded");
    store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "ignore_events",
            json!({"eventIds":[event["id"]],"reason":"Irrelevant"}),
        )
        .unwrap();
    drop(store);
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "handled");
    assert_eq!(store.stand_in_actions(7).unwrap().len(), 2);
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn waiting_work_never_accepts_an_automatic_reply_and_foreign_tasks_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings) = fixture(root.path());
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id:"work".into(),status:"active".into(),interaction_status:Some("waitingForUserInput".into()),
        runtime_handle:json!({"origin":{"initiatedBy":"stand_in","userId":7,"standInId":"default"}}),..Default::default()
    });
    let action = json!({"id":"followup","kind":"continue_work","arguments":{"taskId":"work","eventIds":[],"message":"Progress?"}});
    assert!(handler
        .execute_coordinator_action(&store, 7, &settings, &action)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        handler
            .execute_coordinator_action(&store, 8, &settings, &action)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    assert!(handler
        .store
        .list_task_summaries(false)
        .iter()
        .all(|link| link
            .runtime_handle
            .get("userMessagePresentations")
            .is_none()));
}

#[test]
fn work_changes_are_observed_once_without_waking_for_historical_completion() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let mut link = RuntimeTaskLink {
        local_task_id: "work".into(),
        status: "active".into(),
        turn_status: Some("completed".into()),
        completed_at: Some(10),
        runtime_handle: json!({"origin":{"initiatedBy":"stand_in","userId":7,"standInId":"default"}}),
        ..Default::default()
    };
    handler.upsert_local_task(link.clone());
    let mut state = json!({});
    handler
        .observe_stand_in_work(&store, 7, &mut state)
        .unwrap();
    assert!(store.stand_in_events(7).unwrap().is_empty());
    link.completed_at = Some(20);
    handler.upsert_local_task(link);
    handler
        .observe_stand_in_work(&store, 7, &mut state)
        .unwrap();
    handler
        .observe_stand_in_work(&store, 7, &mut state)
        .unwrap();
    assert_eq!(store.stand_in_events(7).unwrap().len(), 1);
}

#[tokio::test]
async fn events_waiting_on_a_queued_followup_do_not_launch_another_coordinator() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"work".into(),status:"active".into(),interaction_status:Some("waitingForUserInput".into()),runtime_handle:json!({"origin":{"initiatedBy":"stand_in","userId":7,"standInId":"default"}}),..Default::default()});
    let event = store
        .enqueue_stand_in_event(7, json!(["one"]), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(
            7,
            &json!({"batchId":"batch","nextCheckAt":"2000-01-01T00:00:00Z"}),
        )
        .unwrap();
    store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "continue_work",
            json!({"taskId":"work","eventIds":[event["id"]],"message":"Progress?"}),
        )
        .unwrap();
    handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert!(handler.local_task_link(&task_id(7)).is_none());
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "sending");
}

#[test]
fn coordinator_is_persistent_but_absent_from_normal_task_lists() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _, _) = fixture(root.path());
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id(7),
        status: "active".into(),
        runtime_handle: json!({"origin":{"type":"stand_in_coordinator","userId":7}}),
        ..Default::default()
    });
    assert!(handler.local_task_link(&task_id(7)).is_some());
    assert!(handler.collect_cached_links(false).is_empty());
    let mut link = handler.local_task_link(&task_id(7)).unwrap();
    link.status = "failed".into();
    link.runtime_handle["lastError"] = json!("Model disconnected");
    handler.upsert_local_task(link);
    let status = handler
        .stand_in_processing_status(json!({"userId":7}))
        .unwrap();
    assert_eq!(status["error"]["message"], "Model disconnected");
    assert!(status.get("snapshot").is_none());
}

#[tokio::test]
async fn disconnected_sources_are_cancelled_before_entering_a_new_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    store
        .enqueue_stand_in_event(7, json!(["removed-source"]), connection_event())
        .unwrap();
    settings["roles"][0]["connections"] = json!([]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "cancelled");
    assert!(store.stand_in_processing_state(7).unwrap()["snapshot"].is_null());
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn settings_save_waits_for_dispatch_and_cancelled_commands_stay_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!(["test"]), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "ignore_events",
            json!({"eventIds":[event["id"]]}),
        )
        .unwrap();
    let gate = handler.task_send_gate("stand-in-processing:7");
    let guard = gate.lock().await;
    settings["roles"][0]["connections"][0]["policy"]["immediate"] = json!(true);
    let save = handler.personal_stand_in_settings(json!({"userId":7,"settings":settings}), true);
    tokio::pin!(save);
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut save)
        .await
        .is_err());
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "pending");
    drop(guard);
    save.await.unwrap();
    handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "cancelled");
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn saving_after_failed_processing_clears_old_error_and_keeps_system_owned_interval() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    store
        .enqueue_stand_in_event(7, json!(["test"]), connection_event())
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    let event = store.stand_in_events(7).unwrap().remove(0);
    handler.coordination_rpc("runtime.coordination.commit",json!({"contextId":"personal:7","snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Assess this batch","nextWakeAt":null})).await.unwrap();
    assert_eq!(
        store.stand_in_actions(7).unwrap()[0]["error"]["code"],
        "model_unavailable"
    );
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["prompt"] = json!("Updated requirements");
    handler
        .personal_stand_in_settings(json!({"userId":7,"settings":settings}), true)
        .await
        .unwrap();
    let state = store.stand_in_processing_state(7).unwrap();
    assert!(state["error"].is_null());
    assert!(
        chrono::DateTime::parse_from_rfc3339(state["nextCheckAt"].as_str().unwrap()).unwrap()
            > chrono::Utc::now() + chrono::Duration::minutes(4)
    );
}

#[tokio::test]
async fn manual_checks_wait_for_busy_processing_and_revalidate_paused_identity() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    let gate = handler.task_send_gate("stand-in-processing:7");
    let guard = gate.lock().await;
    let check = handler.check_stand_in_processing(json!({"userId":7}));
    tokio::pin!(check);
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut check)
        .await
        .is_err());
    settings["primary"] = json!({"enabled":false,"prompt":"","preferences":""});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    drop(guard);
    assert_eq!(check.await.unwrap_err().code, "bad_request");
    let state = store.stand_in_processing_state(7).unwrap();
    assert!(state["error"].is_null());
    assert!(state["nextCheckAt"].is_string());
    assert!(handler.local_task_links(true).is_empty());
}

impl RuntimeWorkRpcHandler {
    async fn coordination_snapshot_for_test(
        &self,
        store: &LocalTaskStore,
        user: i64,
    ) -> Result<Value, AppIpcError> {
        let settings = store.personal_stand_in(user, &self.device_id).unwrap();
        self.coordination_rpc("runtime.coordination.snapshot",json!({"contextId":format!("personal:{user}"),"revision":LocalTaskStore::coordination_configuration_version(&settings)})).await
    }
}

#[tokio::test]
async fn router_migrates_legacy_connection_events_without_crossing_role_timing() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    let mut second = settings["roles"][0].clone();
    second["id"] = json!("immediate");
    second["connections"][0]["policy"]["immediate"] = json!(true);
    settings["roles"].as_array_mut().unwrap().push(second);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let mut event = connection_event();
    event.as_object_mut().unwrap().remove("roleScoped");
    event["roleIds"] = json!(["default", "immediate"]);
    let original = store
        .enqueue_stand_in_event(7, json!("legacy"), event)
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    let events = snapshot["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["processingMode"] == "immediate")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["processingMode"] == "silent")
            .count(),
        1
    );
    assert!(events
        .iter()
        .all(|event| event["receivedAt"] == original["createdAt"]));
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn verified_reply_waits_in_original_work_and_cannot_be_redirected() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let mut event = connection_event();
    let work = store
        .ingest_stand_in_message(7, "default", &event["source"], &event["message"], None)
        .unwrap();
    let work_id = work["id"].as_str().unwrap();
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:work_id.into(),status:"active".into(),interaction_status:Some("waitingForUserInput".into()),runtime_handle:json!({"origin":{"type":"connection_work","initiatedBy":"stand_in","userId":7,"standInId":"default"}}),..Default::default()});
    event["message"]["quotedMessageId"] = event["message"]["id"].clone();
    event["message"]["id"] = json!("reply");
    let event = store
        .enqueue_stand_in_event(7, json!("reply"), event)
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["binding"]["workId"], work_id);
    assert_eq!(snapshot["events"][0]["binding"]["awaitingUser"], true);
    let mut command = json!({"contextId":"personal:7","snapshotId":snapshot["id"],"actions":[{"kind":"wait_for_work","workId":"foreign-work","eventIds":[event["id"]]}],"nextWakeAt":null});
    assert_eq!(
        handler
            .coordination_rpc("runtime.coordination.commit", command.clone())
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    command["actions"][0]["workId"] = json!(work_id);
    let receipt = handler
        .coordination_rpc("runtime.coordination.commit", command.clone())
        .await
        .unwrap();
    assert_eq!(
        handler
            .coordination_rpc("runtime.coordination.commit", command)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "sending");
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
    assert!(handler.local_task_link(&task_id(7)).is_none());
    assert!(handler
        .stand_in_processing_status(json!({"userId":7}))
        .unwrap()
        .get("routerSnapshot")
        .is_none());
}

#[tokio::test]
async fn a_coordinator_wait_started_after_snapshot_cannot_have_its_batch_rotated() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!("late-wait"), connection_event())
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    let before = store.stand_in_processing_state(7).unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id(7),
        status: "active".into(),
        interaction_status: Some("waitingForUserInput".into()),
        ..Default::default()
    });
    let error=handler.coordination_rpc("runtime.coordination.commit",json!({"contextId":"personal:7","snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Assess only authorized intake","nextWakeAt":null})).await.unwrap_err();
    assert_eq!(error.code, "stale_context");
    assert_eq!(store.stand_in_processing_state(7).unwrap(), before);
    assert!(store.stand_in_actions(7).unwrap().is_empty());
}

#[tokio::test]
async fn an_approval_started_after_snapshot_never_receives_a_router_reply() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let mut event = connection_event();
    let work = store
        .ingest_stand_in_message(7, "default", &event["source"], &event["message"], None)
        .unwrap();
    let work_id = work["id"].as_str().unwrap();
    let mut link = RuntimeTaskLink {
        local_task_id: work_id.into(),
        status: "active".into(),
        runtime_handle: json!({"origin":{"type":"connection_work","initiatedBy":"stand_in","userId":7,"standInId":"default"}}),
        ..Default::default()
    };
    handler.upsert_local_task(link.clone());
    event["message"]["quotedMessageId"] = event["message"]["id"].clone();
    event["message"]["id"] = json!("late-approval");
    let event = store
        .enqueue_stand_in_event(7, json!("late-approval"), event)
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["binding"]["awaitingUser"], false);
    link.interaction_status = Some("waitingForApproval".into());
    handler.upsert_local_task(link);
    handler.coordination_rpc("runtime.coordination.commit",json!({"contextId":"personal:7","snapshotId":snapshot["id"],"actions":[{"kind":"continue_work","workId":work_id,"eventIds":[event["id"]]}],"nextWakeAt":null})).await.unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "sending");
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
    assert!(handler.local_task_link(&task_id(7)).is_none());
}

#[tokio::test]
async fn primary_created_work_feedback_stays_owned_and_requires_semantic_assessment() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings) = fixture(root.path());
    let primary = stand_in_identities(&settings)
        .into_iter()
        .find(|role| role["id"] == "@primary")
        .unwrap();
    let link = RuntimeTaskLink {
        local_task_id: "primary-created".into(),
        status: "done".into(),
        runtime_handle: json!({"origin":{"type":"stand_in_task","initiatedBy":"stand_in","userId":7,"standInId":"@primary"}}),
        ..Default::default()
    };
    handler
        .validate_followup_role(&store, 7, &primary, &link)
        .await
        .unwrap();
    assert!(handler
        .validate_followup_role(&store, 8, &primary, &link)
        .await
        .is_err());
    assert!(handler
        .validate_followup_role(&store, 7, &settings["roles"][0], &link)
        .await
        .is_err());
    handler.upsert_local_task(link);
    let event = store
        .enqueue_stand_in_event(
            7,
            json!("primary-feedback"),
            json!({"kind":"work_state","taskId":"primary-created","roleIds":["@primary"]}),
        )
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["id"], event["id"]);
    assert!(
        snapshot["events"][0]["binding"].is_null(),
        "Completion feedback must not echo an automatic continuation into itself"
    );
}
