use super::*;

fn fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["processing"] = json!({"mode":"silent","intervalMinutes":5});
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    (handler, store, settings)
}

#[tokio::test]
async fn empty_intake_and_future_checks_do_not_prepare_or_start_a_model() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    assert!(handler.local_task_links(true).is_empty());
    store
        .save_stand_in_processing_state(7, &json!({"nextCheckAt":"2000-01-01T00:00:00Z"}))
        .unwrap();
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    let idle = store.stand_in_processing_state(7).unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(idle["nextCheckAt"].as_str().unwrap()).unwrap()
            > chrono::Utc::now()
    );
    assert!(idle["lastCheckAt"].is_null());
    assert!(handler.local_task_links(true).is_empty());
    let event = store
        .enqueue_stand_in_event(
            7,
            json!(["test"]),
            json!({"kind":"connection","roleIds":["default"]}),
        )
        .unwrap();
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    let state = store.stand_in_processing_state(7).unwrap();
    assert!(state["nextCheckAt"].is_string());
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    assert_eq!(store.stand_in_events(7).unwrap(), vec![event]);
    assert!(handler.local_task_links(true).is_empty());
    assert_eq!(
        handler
            .process_stand_in_user(&store, 7, true)
            .await
            .unwrap_err()
            .code,
        "model_unavailable"
    );
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
}

#[tokio::test]
async fn commands_recover_after_restart_and_deferred_events_wait_until_due() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(
            7,
            json!(["test"]),
            json!({"kind":"connection","roleIds":["default"]}),
        )
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
        .enqueue_stand_in_event(
            7,
            json!(["one"]),
            json!({"kind":"connection","roleIds":["default"]}),
        )
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
        .process_stand_in_user(&store, 7, true)
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
async fn switching_to_immediate_preserves_disabled_intake_and_isolates_source_failures() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    settings["processing"]["mode"] = json!("immediate");
    let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    for id in ["one", "two"] {
        store.enqueue_stand_in_event(7,json!([id]),json!({"kind":"connection","source":{"id":id},"message":{"id":id},"roleIds":["default"]})).unwrap();
    }
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    assert!(store
        .stand_in_events(7)
        .unwrap()
        .iter()
        .all(|event| event["status"] == "pending"));
    settings["roles"][0]["enabled"] = json!(true);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    assert!(store
        .stand_in_events(7)
        .unwrap()
        .iter()
        .all(|event| event["status"] == "pending" && event["error"]["code"] == "source_removed"));
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn settings_save_waits_for_dispatch_and_cancelled_commands_stay_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!(["test"]), json!({"kind":"followup"}))
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
    settings["processing"]["mode"] = json!("immediate");
    let save = handler.personal_stand_in_settings(json!({"userId":7,"settings":settings}), true);
    tokio::pin!(save);
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut save)
        .await
        .is_err());
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "pending");
    drop(guard);
    save.await.unwrap();
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "cancelled");
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
    assert!(handler.local_task_links(true).is_empty());
}

#[tokio::test]
async fn saving_after_failed_processing_clears_old_error_and_uses_new_interval() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    store
        .enqueue_stand_in_event(7, json!(["test"]), json!({"kind":"followup"}))
        .unwrap();
    assert_eq!(
        handler
            .process_stand_in_user(&store, 7, true)
            .await
            .unwrap_err()
            .code,
        "model_unavailable"
    );
    assert_eq!(
        store.stand_in_processing_state(7).unwrap()["error"]["code"],
        "model_unavailable"
    );
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["processing"]["intervalMinutes"] = json!(15);
    handler
        .personal_stand_in_settings(json!({"userId":7,"settings":settings}), true)
        .await
        .unwrap();
    let state = store.stand_in_processing_state(7).unwrap();
    assert!(state["error"].is_null());
    assert!(
        chrono::DateTime::parse_from_rfc3339(state["nextCheckAt"].as_str().unwrap()).unwrap()
            > chrono::Utc::now() + chrono::Duration::minutes(14)
    );
}

#[tokio::test]
async fn manual_checks_wait_for_busy_processing_and_revalidate_saved_mode() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    let gate = handler.task_send_gate("stand-in-processing:7");
    let guard = gate.lock().await;
    handler
        .process_stand_in_user(&store, 7, false)
        .await
        .unwrap();
    let check = handler.check_stand_in_processing(json!({"userId":7}));
    tokio::pin!(check);
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut check)
        .await
        .is_err());
    settings["processing"]["mode"] = json!("immediate");
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    drop(guard);
    assert_eq!(check.await.unwrap_err().code, "bad_request");
    let state = store.stand_in_processing_state(7).unwrap();
    assert!(state["error"].is_null());
    assert!(state["nextCheckAt"].is_null());
    assert!(handler.local_task_links(true).is_empty());
}
