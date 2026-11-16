use super::*;

fn fixture() -> (tempfile::TempDir, RuntimeWorkRpcHandler, LocalTaskStore) {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "/bin/false");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.command_journal.lock().unwrap().clear();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    (root, handler, store)
}

#[test]
fn session_recovery_uses_native_receipts_and_never_restarts_unresolved_commands() {
    use super::super::command_journal::{CommandState, RuntimeCommand};
    let (_root, handler, _store) = fixture();
    let mut request = ExecutionRequest::default();
    request.extra.insert("user_id".into(), json!(7));
    let mut command = RuntimeCommand {
        id: "previous".into(),
        fingerprint: "identity".into(),
        state: CommandState::Settled,
        accepted_at: 1,
        owner_resolution: None,
        native: None,
        turn: SpawnTurnRequest {
            task_kind: None,
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
    };
    assert_eq!(
        handler
            .recover_settled_command_session(&task_id(7), 7)
            .unwrap(),
        None
    );
    for state in [
        CommandState::Queued,
        CommandState::Dispatching,
        CommandState::Started,
        CommandState::AwaitingUser,
        CommandState::RecoveryRequired,
    ] {
        command.state = state;
        handler
            .command_journal
            .lock()
            .unwrap()
            .insert(command.key(), command.clone());
        assert_eq!(
            handler
                .recover_settled_command_session(&task_id(7), 7)
                .unwrap_err()
                .code,
            "command_recovery_required"
        );
    }
    for state in [
        CommandState::Settled,
        CommandState::Failed,
        CommandState::Cancelled,
    ] {
        command.state = state;
        command.native = Some((1, "exact-native-thread".into(), "native-turn".into()));
        handler
            .command_journal
            .lock()
            .unwrap()
            .insert(command.key(), command.clone());
        assert_eq!(
            handler
                .recover_settled_command_session(&task_id(7), 7)
                .unwrap()
                .as_deref(),
            Some("exact-native-thread")
        );
    }
    assert_eq!(
        handler
            .recover_settled_command_session(&task_id(7), 8)
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

#[test]
fn start_rejections_keep_the_original_cause() {
    let error = super::super::stand_in_execution::accepted_stand_in_result(json!({"success":false,"code":"missing_runtime_session","error":"Native session was never created"})).unwrap_err();
    assert_eq!(error.code, "missing_runtime_session");
    assert_eq!(error.message, "Native session was never created");
}

#[tokio::test]
async fn direct_sources_do_not_require_duties_or_a_healthy_assessment() {
    for blocked in [false, true] {
        for (provider, kind) in [
            ("@wegent/dsh-connection-dingtalk/dingtalk", "direct"),
            ("@wegent/dsh-connection-dingtalk/dingtalk", "group"),
            ("example/events", "resource"),
        ] {
            let (_root, handler, store) = fixture();
            let mut settings = store.personal_stand_in(7, "mac").unwrap();
            let source = json!({"providerId":provider,"kind":kind,"id":"selected","name":"Selected source","profile":"account", "policy":{"automatic":true,"askBeforeAct":true,"immediate":true}});
            settings["primary"] =
                json!({"enabled":true,"prompt":"","preferences":"","connections":[source]});
            settings["roles"] = json!([]);
            let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
            let source = &settings["primary"]["connections"][0];
            let event = store.enqueue_stand_in_event(7, json!("direct"), json!({"kind":"connection","roleScoped":true,"roleIds":["@primary"],"source":source,"message":{"id":"message","text":"A new request","at":chrono::Utc::now().to_rfc3339()}})).unwrap();
            if blocked {
                store.save_stand_in_processing_state(7, &json!({"batchId":"prior","snapshot":{"marker":"immutable"},"error":{"code":"missing_runtime_session","message":"Previous assessment failed"}})).unwrap();
            }
            let snapshot = handler.coordination_rpc("runtime.coordination.snapshot", json!({"contextId":"personal:7","revision":LocalTaskStore::coordination_configuration_version(&settings)})).await.unwrap();
            assert_eq!(snapshot["events"][0]["id"], event["id"]);
            assert_eq!(
                snapshot["events"][0]["dispatch"],
                json!({"roleId":"@primary"})
            );
            assert!(handler.local_task_links(true).is_empty());
            assert!(store.stand_in_actions(7).unwrap().is_empty());
            assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
            if blocked {
                let state = store.stand_in_processing_state(7).unwrap();
                assert_eq!(state["batchId"], "prior");
                assert_eq!(state["snapshot"]["marker"], "immutable");
                assert_eq!(state["error"]["code"], "missing_runtime_session");
                let error = handler.coordination_rpc("runtime.coordination.commit",json!({"contextId":"personal:7","snapshotId":snapshot["id"],"actions":[{"kind":"assess","eventIds":[event["id"]]}],"assessmentInstructions":"Must not replace the blocked assessment","nextWakeAt":null})).await.unwrap_err();
                assert_eq!(error.code, "stale_context");
            }
        }
    }
}

#[tokio::test]
async fn revised_source_records_continue_only_the_exact_owned_work() {
    let (_root, handler, store) = fixture();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let source = json!({"providerId":"example/events","kind":"record","id":"selected","name":"Selected record","profile":"account","policy":{"automatic":true,"askBeforeAct":true,"immediate":true}});
    settings["primary"] =
        json!({"enabled":true,"prompt":"","preferences":"","connections":[source]});
    settings["roles"] = json!([]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let source = &settings["primary"]["connections"][0];
    let old = json!({"id":"record","objectId":"entity","version":"v1","text":"Old result","at":chrono::Utc::now().to_rfc3339()});
    let work = store
        .ingest_stand_in_message(7, "@primary", source, &old, None)
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: work["id"].as_str().unwrap().into(),
        status: "done".into(),
        runtime_handle: json!({"origin":{"type":"connection_work","initiatedBy":"stand_in","userId":7,"standInId":"@primary"}}),
        ..Default::default()
    });
    for (id, object, bound) in [
        ("record", "entity", true),
        ("unrelated", "entity", false),
        ("record", "other-entity", false),
    ] {
        let incoming = store.enqueue_stand_in_event(7,json!([id,object]),json!({"kind":"connection","roleScoped":true,"roleIds":["@primary"],"source":source,"message":{"id":id,"objectId":object,"version":"v2","text":"New result","at":chrono::Utc::now().to_rfc3339()}})).unwrap();
        let snapshot = handler.coordination_rpc("runtime.coordination.snapshot",json!({"contextId":"personal:7","revision":LocalTaskStore::coordination_configuration_version(&settings)})).await.unwrap();
        let event = snapshot["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["id"] == incoming["id"])
            .unwrap();
        if bound {
            assert_eq!(event["binding"]["workId"], work["id"]);
            assert!(event["dispatch"].is_null());
        } else {
            assert!(event["binding"].is_null());
            assert_eq!(event["dispatch"]["roleId"], "@primary");
        }
    }
}

#[tokio::test]
async fn direct_dispatch_preserves_a_waiting_coordinator_batch_and_silent_intake() {
    let (_root, handler, store) = fixture();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let direct = json!({"providerId":"example/events","kind":"resource","id":"direct","name":"Selected source","profile":"account", "policy":{"automatic":true,"askBeforeAct":true,"immediate":true}});
    let mut silent = direct.clone();
    silent["id"] = json!("silent");
    silent["policy"]["immediate"] = json!(false);
    settings["primary"] =
        json!({"enabled":true,"prompt":"","preferences":"","connections":[direct,silent]});
    settings["roles"] = json!([]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    for source in settings["primary"]["connections"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
    {
        let count = if source["id"] == "silent" { 101 } else { 1 };
        for index in 0..count {
            let id = format!("{}-{index}", source["id"].as_str().unwrap());
            store.enqueue_stand_in_event(7, json!(id), json!({"kind":"connection","roleScoped":true,"roleIds":["@primary"],"source":source,"message":{"id":id,"text":"Request","at":chrono::Utc::now().to_rfc3339()}})).unwrap();
        }
    }
    store
        .save_stand_in_processing_state(
            7,
            &json!({"batchId":"waiting","snapshot":{"marker":"original"}}),
        )
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task_id(7),
        interaction_status: Some("waitingForUserInput".into()),
        ..Default::default()
    });
    let snapshot = handler.coordination_rpc("runtime.coordination.snapshot", json!({"contextId":"personal:7","revision":LocalTaskStore::coordination_configuration_version(&settings)})).await.unwrap();
    assert_eq!(snapshot["events"].as_array().unwrap().len(), 1);
    assert_eq!(
        snapshot["events"][0]["dispatch"],
        json!({"roleId":"@primary"})
    );
    let state = store.stand_in_processing_state(7).unwrap();
    assert_eq!(state["batchId"], "waiting");
    assert_eq!(state["snapshot"]["marker"], "original");
    assert!(store
        .stand_in_events(7)
        .unwrap()
        .iter()
        .all(|event| event["status"] == "pending"));
}
