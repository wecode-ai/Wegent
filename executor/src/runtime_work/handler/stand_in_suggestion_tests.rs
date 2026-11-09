use super::*;

#[tokio::test]
async fn connection_processing_follows_explicit_policy_not_optional_duties() {
    for (prompt, preferences) in [
        ("", ""),
        ("  ", "\n"),
        ("Draft deployment answers for this group", ""),
        ("", "Track important questions and prepare factual answers"),
    ] {
        for immediate in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (handler, store, mut settings, _) = fixture(root.path());
            settings["roles"][0]["prompt"] = json!(prompt);
            settings["roles"][0]["preferences"] = json!(preferences);
            settings["roles"][0]["connections"][0]["policy"]["immediate"] = json!(immediate);
            let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
            let snapshot = handler.coordination_rpc("runtime.coordination.snapshot",json!({
            "contextId":"personal:7","revision":LocalTaskStore::coordination_configuration_version(&settings)
        })).await.unwrap();
            assert_eq!(
                snapshot["events"][0]["processingMode"],
                if immediate { "immediate" } else { "silent" }
            );
            assert_eq!(!snapshot["events"][0]["dispatch"].is_null(), immediate);
            assert!(handler.local_task_links(true).is_empty());
            assert!(store.stand_in_processing_state(7).unwrap()["batchId"].is_null());
        }
    }
}

fn fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value, Value) {
    provider_fixture(
        root,
        crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,
        "group",
    )
}

fn provider_fixture(
    root: &Path,
    provider: &str,
    kind: &str,
) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value, Value) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
    settings["roles"][0]["enabled"] = json!(true);
    settings["roles"][0]["connections"] = json!([{"providerId":provider,
        "id":"group","profile":"account","kind":kind,"name":"Group",
        "boundary":{"partition":"events","sequence":5},
        "policy":{"automatic":true,"askBeforeAct":true,"immediate":false}}]);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let event = store.enqueue_stand_in_event(7,json!("mentions"),json!({"kind":"connection","roleIds":["default"],
        "source":{"providerId":provider,"id":"group","profile":"account","kind":kind},
        "message":{"id":"mention","position":{"partition":"events","sequence":6},"at":chrono::Utc::now().to_rfc3339(),"eventType":"created","text":"Can you explain the deployment process?"}})).unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    let action = store.queue_stand_in_action(7,"mac","batch","suggest_action",json!({"eventIds":[event["id"]],
        "roleId":"default","message":"You have a group mention asking about deployment. I can prepare an answer for you to review."})).unwrap();
    (handler, store, settings, action)
}

fn accept_activity(handler: &RuntimeWorkRpcHandler, command_id: &str) {
    use crate::runtime_work::handler::command_journal::{CommandState, RuntimeCommand};
    let mut request = ExecutionRequest::default();
    request.extra.insert("user_id".into(), json!(7));
    let command = RuntimeCommand {
        id: command_id.into(),
        fingerprint: "previously-accepted".into(),
        state: CommandState::Settled,
        accepted_at: 1,
        owner_resolution: None,
        native: None,
        turn: SpawnTurnRequest {
            task_kind: None,
            local_task_id: super::super::stand_in_conversations::conversation_task_id(7, None),
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
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(command.key(), command);
}

#[tokio::test]
async fn accepted_suggestions_consume_evidence_once_without_creating_or_authorizing_work() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings, action) = fixture(root.path());
    accept_activity(&handler, action["id"].as_str().unwrap());
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    let saved = store.stand_in_actions(7).unwrap().pop().unwrap();
    assert_eq!(saved["status"], "succeeded");
    assert_eq!(saved["result"]["commandId"], action["id"]);
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "handled");
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert!(handler.local_task_links(true).is_empty());
    assert!(store.list_stand_in_work(7, None).unwrap().is_empty());
    assert_eq!(store.personal_stand_in(7, "mac").unwrap(), settings);
    assert_eq!(handler.command_journal.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn connection_provider_envelopes_share_the_same_private_finding_flow() {
    // Test providers exercise the common envelope, not external service compatibility.
    for (provider, kind) in [
        (
            crate::task_runtime::personal_stand_in::EMAIL_PROVIDER,
            "inbox",
        ),
        ("@test/github/events", "repository"),
        ("@test/calendar/events", "calendar"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, settings, action) = provider_fixture(root.path(), provider, kind);
        accept_activity(&handler, action["id"].as_str().unwrap());
        handler
            .execute_coordinator_actions(&store, 7, &settings)
            .await
            .unwrap();
        assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "succeeded");
        assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "handled");
        assert!(handler.local_task_links(true).is_empty());
        assert!(store.list_stand_in_work(7, None).unwrap().is_empty());
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), settings);
    }
}

#[tokio::test]
async fn a_waiting_primary_defers_suggestions_without_consuming_their_events() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings, _) = fixture(root.path());
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: super::super::stand_in_conversations::conversation_task_id(7, None),
        interaction_status: Some("waitingForApproval".into()),
        ..Default::default()
    });
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "sending");
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
    assert_eq!(handler.local_task_links(true).len(), 1);
}

#[tokio::test]
async fn suggestions_revalidate_source_scope_timing_and_live_permissions_before_delivery() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings, action) = fixture(root.path());
    let event = store.stand_in_events(7).unwrap().pop().unwrap();
    for (field, value) in [("enabled", json!(false)), ("connections", json!([]))] {
        let mut changed = settings.clone();
        changed["roles"][0][field] = value;
        assert!(handler
            .deliver_connection_suggestion(7, &changed, &action, std::slice::from_ref(&event))
            .await
            .is_err());
    }
    let mut paused = settings.clone();
    paused["roles"][0]["connections"][0]["policy"]["automatic"] = json!(false);
    assert!(handler
        .deliver_connection_suggestion(7, &paused, &action, std::slice::from_ref(&event))
        .await
        .is_err());
    for (field, value) in [
        ("userId", json!(8)),
        ("kind", json!("calendar")),
        ("roleIds", json!(["foreign"])),
    ] {
        let mut changed = event.clone();
        changed[field] = value;
        assert!(handler
            .deliver_connection_suggestion(7, &settings, &action, &[changed])
            .await
            .is_err());
    }
    let mut old = event;
    old["message"]["at"] = json!("2000-01-01T00:00:00Z");
    assert!(handler
        .deliver_connection_suggestion(7, &settings, &action, &[old])
        .await
        .is_err());
    assert!(handler.local_task_links(true).is_empty());
    assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "pending");
}
