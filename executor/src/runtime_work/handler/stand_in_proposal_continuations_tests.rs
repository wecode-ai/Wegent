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
