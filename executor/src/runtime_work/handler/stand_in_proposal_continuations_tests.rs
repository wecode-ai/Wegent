use super::*;

fn fixture() -> (tempfile::TempDir, RuntimeWorkRpcHandler, StandInMcpIdentity) {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.turn_queue_path = Arc::new(root.path().join("turn-queue.json"));
    handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    handler.turn_scheduler = Arc::new(Mutex::new(RuntimeTurnScheduler::new(
        RuntimeSettings {
            max_concurrent_tasks: 0,
            max_concurrent_stand_in_tasks: 0,
            max_concurrent_agent_tasks: 0,
        },
        VecDeque::new(),
    )));
    handler.command_journal = Arc::new(Mutex::new(Default::default()));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"","preferences":"","connections":[]});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let task = "stand-in-chat-7-primary";
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:task.into(),runtime:"codex".into(),thread_id:Some("native-thread".into()),workspace_path:root.path().display().to_string(),runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":null},"executionRequest":{"user_id":7,"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":null}}}),..Default::default()});
    let identity = StandInMcpIdentity {
        task_id: task.into(),
        user: 7,
        device: "mac".into(),
        role: None,
        work: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
        ask_before_act: true,
        coordinator_batch: None,
    };
    (root, handler, identity)
}

fn im_followup_payload(handler: &RuntimeWorkRpcHandler, task: &str, callback: &str) -> Value {
    json!({
        "taskId": task,
        "message": callback,
        "clientUserMessageId": callback,
        "source": {"source":"im","callback_id":callback},
        "executionRequest": handler.local_task_link(task).unwrap().runtime_handle["executionRequest"]
    })
}

#[tokio::test]
async fn im_followup_queues_while_the_initial_identity_session_is_not_ready() {
    let (_root, handler, identity) = fixture();
    handler
        .store
        .update_task(&identity.task_id, |link| link.thread_id = None);
    let initial = im_followup_payload(&handler, &identity.task_id, "first-callback");
    let mut request = execution_request(&initial).unwrap();
    apply_runtime_payload_metadata(&mut request, &initial);
    handler
        .queue_turn(SpawnTurnRequest::new(
            identity.task_id.clone(),
            "codex".into(),
            request,
        ))
        .await
        .unwrap();

    let result = handler
        .dispatch_stand_in_conversation(
            im_followup_payload(&handler, &identity.task_id, "second-callback"),
            false,
        )
        .await
        .unwrap();
    assert_eq!(result["accepted"], true, "{result}");
    let scheduler = handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.queued_turns.len(), 2);
    assert_eq!(
        scheduler.queued_turns[0].request.extra["source"]["callback_id"],
        "first-callback"
    );
    assert_eq!(
        scheduler.queued_turns[1].request.extra["source"]["callback_id"],
        "second-callback"
    );
}

#[tokio::test]
async fn active_identity_steers_once_and_retains_the_im_source() {
    use super::super::tests::install_native_history;

    let _activation = crate::services::capability_activation::begin_execution().await;
    let (root, mut handler, identity) = fixture();
    let task = &identity.task_id;
    install_native_history(&mut handler, root.path(), vec![], None);
    handler
        .codex_app_server
        .request("thread/read", json!({"threadId":"native-thread"}))
        .await
        .unwrap();
    fs::write(
        root.path().join("turn_steer.json"),
        r#"{"turnId":"active-turn"}"#,
    )
    .unwrap();
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    let execution = handler.start_local_task_execution(task.clone(), cancel, stopped);
    let mut payload = im_followup_payload(&handler, task, "new-callback");
    payload["source"]["channel_type"] = json!("dingtalk");
    payload["additionalContext"] =
        json!({"quoted":{"kind":"untrusted","value":"Previous message"}});
    let request = execution_request(&payload).unwrap();
    handler.bind_native_turn_start(task, &request, execution, "native-thread", "active-turn");
    for _ in 0..2 {
        let result = handler
            .dispatch_stand_in_conversation(payload.clone(), false)
            .await
            .unwrap();
        assert_eq!(result["guided"], true, "{result}");
        assert_eq!(result["turnId"], "active-turn");
    }
    handler.set_interaction_status(task, Some(INTERACTION_WAITING_FOR_USER_INPUT));
    let waiting = handler
        .dispatch_stand_in_conversation(
            im_followup_payload(&handler, task, "while-approval-pending"),
            false,
        )
        .await
        .unwrap();
    assert_eq!(waiting["guided"], true);
    assert_eq!(waiting["turnId"], "active-turn");
    assert_eq!(
        handler
            .local_task_link(task)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_WAITING_FOR_USER_INPUT)
    );
    let requests = fs::read_to_string(root.path().join("requests.jsonl")).unwrap();
    let mut steers = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|request| request["method"] == "turn/steer");
    let steer = steers.next().unwrap();
    assert_eq!(
        steers.next().unwrap()["params"]["input"][0]["text"],
        "while-approval-pending"
    );
    assert!(steers.next().is_none());
    assert_eq!(steer["params"]["expectedTurnId"], "active-turn");
    assert_eq!(steer["params"]["input"][0]["text"], "new-callback");
    assert_eq!(
        steer["params"]["additionalContext"]["quoted"]["value"],
        "Previous message"
    );
    assert!(handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .is_empty());
    let event = handler.request_for_codex_event(task, &request, Some("active-turn"));
    assert_eq!(
        event.extra["standInGuidanceSources"]["new-callback"],
        payload["source"]
    );
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
}

#[tokio::test]
async fn im_followup_rejects_an_idle_identity_with_a_missing_session() {
    let (_root, handler, identity) = fixture();
    handler
        .store
        .update_task(&identity.task_id, |link| link.thread_id = None);
    let result = handler
        .dispatch_stand_in_conversation(
            im_followup_payload(&handler, &identity.task_id, "idle-callback"),
            false,
        )
        .await
        .unwrap_err();
    assert_eq!(result.code, "missing_runtime_session");
    assert!(handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .is_empty());
}

async fn owner_input(
    handler: &RuntimeWorkRpcHandler,
    identity: &StandInMcpIdentity,
    command: &str,
) -> Value {
    let mut request = handler
        .local_task_link(&identity.task_id)
        .unwrap()
        .runtime_handle["executionRequest"]
        .clone();
    request[OWNER] = json!({"id":"model-forgery","revision":999999});
    let result=handler.send_message(json!({"taskId":identity.task_id,"commandId":command,"message":"Continue my requested work","executionRequest":request,"queueIfBusy":true})).await.unwrap();
    assert_eq!(result["accepted"], true);
    let owner = handler
        .current_stand_in_owner_request(&identity.task_id)
        .unwrap();
    assert_ne!(owner["id"], "model-forgery");
    // Model execution starts from this same accepted native queue snapshot.
    let accepted = handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .back()
        .unwrap()
        .request
        .clone();
    handler.store.update_task(&identity.task_id, |link| {
        store_runtime_execution_request(&mut link.runtime_handle, &accepted)
    });
    owner
}

fn proposal(handler: &RuntimeWorkRpcHandler, identity: &StandInMcpIdentity, resume: bool) -> Value {
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store
        .personal_stand_in(identity.user, &identity.device)
        .unwrap();
    handler.propose_stand_in_profile(identity,&json!({"summary":"Continue this request after configuration","settings":settings,"continueCurrentRequest":resume})).unwrap()
}

#[tokio::test]
async fn collaboration_owner_inputs_deduplicate_and_resume_configuration_in_the_home_thread() {
    let (_root, handler, mut identity) = fixture();
    let mut actor = handler.local_task_link(&identity.task_id).unwrap();
    identity.task_id.push_str("-collaboration");
    actor.local_task_id = identity.task_id.clone();
    actor.runtime_handle["origin"]["conversationScope"] = json!("collaboration");
    actor.runtime_handle["executionRequest"]["origin"] = actor.runtime_handle["origin"].clone();
    handler.upsert_local_task(actor.clone());
    let payload = json!({"taskId":identity.task_id,"message":"Continue my homepage request",
        "clientUserMessageId":"home-input","queueIfBusy":true,
        "executionRequest":actor.runtime_handle["executionRequest"]});
    for _ in 0..2 {
        assert_eq!(
            handler.send_message(payload.clone()).await.unwrap()["accepted"],
            true
        );
    }
    assert_eq!(handler.command_journal.lock().unwrap().len(), 1);
    let accepted = {
        let scheduler = handler.turn_scheduler.lock().unwrap();
        assert_eq!(scheduler.queued_turns.len(), 1);
        scheduler.queued_turns[0].request.clone()
    };
    handler.store.update_task(&identity.task_id, |link| {
        store_runtime_execution_request(&mut link.runtime_handle, &accepted)
    });
    let draft = proposal(&handler, &identity, true);
    assert_eq!(draft["willContinueCurrentRequest"], true);
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store
        .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), true, None)
        .unwrap();
    let pending = store
        .pending_stand_in_proposal_continuations("mac")
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["ownerRequest"]["taskId"], identity.task_id);
    handler
        .flush_stand_in_proposal_continuations()
        .await
        .unwrap();
    let scheduler = handler.turn_scheduler.lock().unwrap();
    assert_eq!(scheduler.queued_turns.len(), 2);
    assert!(scheduler
        .queued_turns
        .iter()
        .all(|turn| turn.local_task_id == identity.task_id));
    drop(scheduler);
    for scope in [Value::Null, json!("unknown")] {
        handler.store.update_task(&identity.task_id, |link| {
            link.runtime_handle["origin"]["conversationScope"] = scope
        });
        assert_eq!(
            handler
                .propose_stand_in_profile(&identity, &json!({}))
                .unwrap_err()
                .code,
            "owner_request_changed"
        );
    }
}

#[tokio::test]
async fn owner_input_without_a_client_command_is_natively_journaled() {
    let (_root, handler, identity) = fixture();
    let request = handler
        .local_task_link(&identity.task_id)
        .unwrap()
        .runtime_handle["executionRequest"]
        .clone();
    let result=handler.send_message(json!({"taskId":identity.task_id,"message":"Connect this source and continue my work","executionRequest":request,"queueIfBusy":true})).await.unwrap();
    assert_eq!(result["accepted"], true);
    let command = handler
        .command_journal
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(command.id.starts_with("stand-in-owner-input:"));
    assert_eq!(
        command.turn.request.extra[OWNER],
        handler
            .current_stand_in_owner_request(&identity.task_id)
            .unwrap()
    );
}

#[tokio::test]
async fn retrying_the_same_owner_client_message_preserves_its_generation_and_receipt() {
    let (_root, handler, identity) = fixture();
    let request = handler
        .local_task_link(&identity.task_id)
        .unwrap()
        .runtime_handle["executionRequest"]
        .clone();
    let input = json!({"taskId":identity.task_id,"clientUserMessageId":"same-native-client-message","message":"Connect and continue this work","executionRequest":request,"queueIfBusy":true});
    assert_eq!(
        handler.send_message(input.clone()).await.unwrap()["accepted"],
        true
    );
    let first = handler
        .current_stand_in_owner_request(&identity.task_id)
        .unwrap();
    let before = handler.turn_scheduler.lock().unwrap().queued_turns.len();
    handler.send_message(input.clone()).await.unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(first)
    );
    assert_eq!(
        handler.turn_scheduler.lock().unwrap().queued_turns.len(),
        before
    );
    let mut changed = input;
    changed["message"] = json!("A different request with a reused client ID");
    assert!(handler.send_message(changed).await.is_err());
    assert_eq!(
        handler.turn_scheduler.lock().unwrap().queued_turns.len(),
        before
    );
}

#[tokio::test]
async fn accepted_proposal_uses_native_queue_and_keeps_owner_across_background_activity() {
    let (_root, handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner-1").await;
    let settings = LocalTaskStore::open(handler.task_store_path.as_ref())
        .unwrap()
        .personal_stand_in(7, "mac")
        .unwrap();
    let draft=handler.stand_in_task_operation(identity.clone(),"propose_profile",json!({"settings":settings,"summary":"Continue this exact requested work","continueCurrentRequest":true})).await.unwrap();
    assert_eq!(draft["willContinueCurrentRequest"], true);
    handler
        .deliver_primary_activity(
            7,
            "background-result",
            "An existing delegated task ended",
            "工作已结束",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(owner.clone())
    );
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    handler
        .stand_in_proposal(
            json!({"userId":7,"proposalId":draft["id"],"accept":true}),
            true,
        )
        .await
        .unwrap();
    let turns = handler.turn_scheduler.lock().unwrap().queued_turns.clone();
    let resumed = turns
        .iter()
        .find(|turn| {
            turn.request.extra["runtime_command_id"]
                == format!("stand-in-proposal-resume:{}", draft["id"].as_str().unwrap())
        })
        .unwrap();
    assert_eq!(resumed.request.extra[EXPECTED], owner);
    assert!(resumed.request.extra.get("standInDelegation").is_none());
    assert!(store
        .pending_stand_in_proposal_continuations("mac")
        .unwrap()
        .is_empty());
    handler
        .flush_stand_in_proposal_continuations()
        .await
        .unwrap();
    assert_eq!(
        handler.turn_scheduler.lock().unwrap().queued_turns.len(),
        turns.len()
    );
    assert!(store
        .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), true, None)
        .is_err());
    assert_eq!(
        handler.turn_scheduler.lock().unwrap().queued_turns.len(),
        turns.len()
    );
}

#[tokio::test]
async fn missing_owner_plain_configuration_and_rejection_never_wake() {
    for (known, resume, accept) in [
        (false, true, true),
        (true, false, true),
        (true, true, false),
    ] {
        let (_root, handler, identity) = fixture();
        if known {
            owner_input(&handler, &identity, "owner").await;
        }
        let draft = proposal(&handler, &identity, resume);
        assert_eq!(draft["willContinueCurrentRequest"], known && resume);
        let before = handler.turn_scheduler.lock().unwrap().queued_turns.len();
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store
            .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), accept, None)
            .unwrap();
        handler
            .flush_stand_in_proposal_continuations()
            .await
            .unwrap();
        assert_eq!(
            handler.turn_scheduler.lock().unwrap().queued_turns.len(),
            before
        );
        assert!(store
            .pending_stand_in_proposal_continuations("mac")
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn changed_owner_or_cancellation_revokes_pending_and_already_queued_continuations() {
    for cancel in [false, true] {
        let (_root, handler, identity) = fixture();
        owner_input(&handler, &identity, "owner").await;
        let draft = proposal(&handler, &identity, true);
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store
            .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), true, None)
            .unwrap();
        handler
            .flush_stand_in_proposal_continuations()
            .await
            .unwrap();
        let queued = handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .back()
            .unwrap()
            .clone();
        assert!(handler.stand_in_owner_request_matches(&queued.request, &identity.task_id));
        let next = proposal(&handler, &identity, true);
        store
            .resolve_stand_in_proposal(7, "mac", next["id"].as_str().unwrap(), true, None)
            .unwrap();
        if cancel {
            handler
                .cancel_task(json!({"taskId":identity.task_id}))
                .await
                .unwrap();
        } else {
            owner_input(&handler, &identity, "replacement-owner").await;
        }
        assert!(!handler.stand_in_owner_request_matches(&queued.request, &identity.task_id));
        let before = handler.turn_scheduler.lock().unwrap().queued_turns.len();
        handler
            .flush_stand_in_proposal_continuations()
            .await
            .unwrap();
        assert_eq!(
            handler.turn_scheduler.lock().unwrap().queued_turns.len(),
            before
        );
        assert!(store
            .pending_stand_in_proposal_continuations("mac")
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn proposal_identity_and_delivery_revalidate_owner_device_role_and_lifecycle() {
    for field in ["userId", "deviceId", "standInId", "archived"] {
        let (_root, handler, identity) = fixture();
        owner_input(&handler, &identity, "owner").await;
        let draft = proposal(&handler, &identity, true);
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store
            .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), true, None)
            .unwrap();
        handler.store.update_task(&identity.task_id, |actor| {
            if field == "archived" {
                actor.status = "archived".into();
            } else {
                actor.runtime_handle["origin"][field] = json!("foreign");
            }
        });
        assert!(handler
            .propose_stand_in_profile(&identity, &json!({}))
            .is_err());
        let before = handler.turn_scheduler.lock().unwrap().queued_turns.len();
        handler
            .flush_stand_in_proposal_continuations()
            .await
            .unwrap();
        assert_eq!(
            handler.turn_scheduler.lock().unwrap().queued_turns.len(),
            before
        );
        assert!(store
            .pending_stand_in_proposal_continuations("mac")
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn restart_after_queue_acceptance_before_outbox_ack_uses_the_original_receipt() {
    let (root, mut handler, identity) = fixture();
    owner_input(&handler, &identity, "owner").await;
    let draft = proposal(&handler, &identity, true);
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store
        .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), true, None)
        .unwrap();
    // Emulate the durable queue commit preceding its independent SQLite ack.
    let owner = handler
        .current_stand_in_owner_request(&identity.task_id)
        .unwrap();
    let command = format!("stand-in-proposal-resume:{}", draft["id"].as_str().unwrap());
    handler
        .deliver_identity_activity(
            7,
            None,
            &command,
            "Resume exact owner request",
            "配置已确认",
            Some(&owner),
        )
        .await
        .unwrap()
        .unwrap();
    let state =
        super::super::turns::read_runtime_turn_state(handler.turn_queue_path.as_ref()).unwrap();
    let count = state.queued_turns.len();
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.command_journal = Arc::new(Mutex::new(state.commands));
    handler.turn_scheduler.lock().unwrap().queued_turns = state.queued_turns;
    handler
        .flush_stand_in_proposal_continuations()
        .await
        .unwrap();
    assert_eq!(
        handler.turn_scheduler.lock().unwrap().queued_turns.len(),
        count
    );
    assert!(store
        .pending_stand_in_proposal_continuations("mac")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn immediate_owner_admission_survives_crash_before_link_generation_write() {
    let (root, mut handler, identity) = fixture();
    let old = owner_input(&handler, &identity, "old-owner").await;
    let mut immediate = handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .pop_front()
        .unwrap();
    apply_runtime_payload_metadata(
        &mut immediate.request,
        &json!({"commandId":"immediate-owner","message":"A new explicit owner request"}),
    );
    handler
        .stamp_stand_in_owner_request(&identity.task_id, &mut immediate.request, false)
        .unwrap();
    let new_owner = immediate.request.extra[OWNER].clone();
    assert_ne!(new_owner, old);
    handler
        .persist_turn_queue(VecDeque::new(), None, &[immediate])
        .await
        .unwrap();
    // Recreate the exact pre-link-write state while retaining the real native journal commit.
    handler.store.update_task(&identity.task_id, |link| {
        link.runtime_handle[OWNER] = old.clone()
    });
    // The accepted immediate turn exists only in the durable journal at this boundary.
    let saved =
        super::super::turns::read_runtime_turn_state(handler.turn_queue_path.as_ref()).unwrap();
    assert!(saved.queued_turns.is_empty());
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    assert_eq!(
        handler
            .local_task_link(&identity.task_id)
            .unwrap()
            .runtime_handle[OWNER],
        old
    );
    handler.command_journal = Arc::new(Mutex::new(saved.commands));
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(new_owner)
    );
}

fn stamped_replacement(
    handler: &RuntimeWorkRpcHandler,
    identity: &StandInMcpIdentity,
) -> SpawnTurnRequest {
    let mut turn = handler.turn_scheduler.lock().unwrap().queued_turns[0].clone();
    apply_runtime_payload_metadata(
        &mut turn.request,
        &json!({"commandId":"replacement-owner","message":"A replacement owner request"}),
    );
    handler
        .stamp_stand_in_owner_request(&identity.task_id, &mut turn.request, false)
        .unwrap();
    turn
}

fn cancelled_owner(owner: &Value) -> Value {
    let mut cancelled = owner.clone();
    cancelled["cancelled"] = json!(true);
    cancelled
}

#[tokio::test]
async fn same_owner_cancellation_merges_with_journal_and_late_false_projection() {
    let (_root, handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner").await;
    handler
        .cancel_stand_in_owner_request(&identity.task_id, &owner)
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(cancelled_owner(&owner))
    );
    handler.record_stand_in_owner_admission(&identity.task_id, &owner);
    handler
        .cancel_stand_in_owner_request(&identity.task_id, &owner)
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(cancelled_owner(&owner))
    );
    assert_eq!(
        handler
            .local_task_link(&identity.task_id)
            .unwrap()
            .runtime_handle[OWNER],
        cancelled_owner(&owner)
    );
}

#[tokio::test]
async fn same_revision_conflicting_owner_identity_remains_rejected() {
    let (_root, handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner").await;
    for field in ["id", "unexpected_identity_field"] {
        let mut conflicting = cancelled_owner(&owner);
        conflicting[field] = json!("another-identity");
        handler.store.update_task(&identity.task_id, |link| {
            link.runtime_handle[OWNER] = conflicting.clone()
        });
        handler.record_stand_in_owner_admission(&identity.task_id, &owner);
        handler
            .cancel_stand_in_owner_request(&identity.task_id, &owner)
            .unwrap();
        assert_eq!(
            handler.current_stand_in_owner_request(&identity.task_id),
            None
        );
        assert_eq!(
            handler
                .local_task_link(&identity.task_id)
                .unwrap()
                .runtime_handle[OWNER],
            conflicting
        );
    }
}

#[tokio::test]
async fn cancelling_owner_does_not_consume_an_already_stamped_replacement_revision() {
    let (_root, handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner").await;
    let replacement = stamped_replacement(&handler, &identity);
    let next_owner = replacement.request.extra[OWNER].clone();
    assert_eq!(
        next_owner["revision"],
        owner["revision"].as_u64().unwrap() + 1
    );
    handler
        .cancel_stand_in_owner_request(&identity.task_id, &owner)
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(cancelled_owner(&owner))
    );
    handler
        .persist_turn_queue(VecDeque::new(), None, &[replacement])
        .await
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(next_owner)
    );
}

#[tokio::test]
async fn cancelling_old_preparation_preserves_journal_only_and_published_replacement() {
    let (_root, handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner").await;
    let replacement = stamped_replacement(&handler, &identity);
    let next_owner = replacement.request.extra[OWNER].clone();
    handler
        .persist_turn_queue(VecDeque::new(), None, &[replacement])
        .await
        .unwrap();
    handler.store.update_task(&identity.task_id, |link| {
        link.runtime_handle[OWNER] = owner.clone();
        link.runtime_handle["executionRequest"][OWNER] = owner.clone();
    });
    assert_eq!(
        handler
            .local_task_link(&identity.task_id)
            .unwrap()
            .runtime_handle["executionRequest"][OWNER],
        owner
    );
    handler
        .cancel_stand_in_owner_request(&identity.task_id, &owner)
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(next_owner.clone())
    );
    handler.record_stand_in_owner_admission(&identity.task_id, &next_owner);
    handler
        .cancel_stand_in_owner_request(&identity.task_id, &owner)
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(next_owner.clone())
    );
    assert_eq!(
        handler
            .local_task_link(&identity.task_id)
            .unwrap()
            .runtime_handle[OWNER],
        next_owner
    );
}

#[tokio::test]
async fn journal_only_owner_cancellation_survives_restart_and_revokes_proposal_resume() {
    let (root, mut handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner").await;
    let draft = proposal(&handler, &identity, true);
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store
        .resolve_stand_in_proposal(7, "mac", draft["id"].as_str().unwrap(), true, None)
        .unwrap();
    handler.store.update_task(&identity.task_id, |link| {
        link.runtime_handle[OWNER] = Value::Null;
        link.runtime_handle["executionRequest"][OWNER] = Value::Null;
    });
    handler.turn_scheduler.lock().unwrap().queued_turns.clear();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(owner.clone())
    );
    handler
        .invalidate_stand_in_owner_request(&identity.task_id)
        .unwrap();
    let saved =
        super::super::turns::read_runtime_turn_state(handler.turn_queue_path.as_ref()).unwrap();
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.command_journal = Arc::new(Mutex::new(saved.commands));
    handler.turn_scheduler.lock().unwrap().queued_turns = saved.queued_turns;
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(cancelled_owner(&owner))
    );
    let before = handler.turn_scheduler.lock().unwrap().queued_turns.len();
    handler
        .flush_stand_in_proposal_continuations()
        .await
        .unwrap();
    assert_eq!(
        handler.turn_scheduler.lock().unwrap().queued_turns.len(),
        before
    );
    assert!(store
        .pending_stand_in_proposal_continuations("mac")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cancelling_journal_owner_projects_over_an_older_link_without_identity_change() {
    let (_root, handler, identity) = fixture();
    let owner = owner_input(&handler, &identity, "owner").await;
    let replacement = stamped_replacement(&handler, &identity);
    let next_owner = replacement.request.extra[OWNER].clone();
    handler
        .persist_turn_queue(VecDeque::new(), None, &[replacement])
        .await
        .unwrap();
    handler.store.update_task(&identity.task_id, |link| {
        link.runtime_handle[OWNER] = owner.clone();
        link.runtime_handle["executionRequest"][OWNER] = owner;
    });
    handler
        .invalidate_stand_in_owner_request(&identity.task_id)
        .unwrap();
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(cancelled_owner(&next_owner))
    );
    handler.record_stand_in_owner_admission(&identity.task_id, &next_owner);
    assert_eq!(
        handler.current_stand_in_owner_request(&identity.task_id),
        Some(cancelled_owner(&next_owner))
    );
}
