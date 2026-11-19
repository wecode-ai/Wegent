use super::super::command_journal::{CommandState, RuntimeCommand};
use super::super::tests::{install_native_history, ScalarEnv};
use super::*;

fn handler(root: &Path) -> RuntimeWorkRpcHandler {
    let mut handler = RuntimeWorkRpcHandler::new("device", "unused");
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    handler.turn_queue_path = Arc::new(root.join("turn-queue.json"));
    handler.command_journal = Arc::new(Mutex::new(Default::default()));
    handler.turn_scheduler = Arc::new(Mutex::new(RuntimeTurnScheduler::new(
        RuntimeSettings::default(),
        VecDeque::new(),
    )));
    handler.active_goal_turns = Arc::new(Mutex::new(Default::default()));
    handler.automation_store =
        crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
    handler
}

fn memory_review_handler(root: &Path) -> (RuntimeWorkRpcHandler, ScalarEnv) {
    let claude_home = ScalarEnv::set("WEGENT_CLAUDE_HOME", root.join("claude").to_str().unwrap());
    let mut handler = handler(root);
    install_native_history(&mut handler, root, Vec::new(), None);
    for (name, response) in [
        (
            "config_read",
            json!({"config":{"model":"review-default","model_provider":"openai"}}),
        ),
        (
            "model_list",
            json!({"data":[{"id":"review-default","model":"review-default","isDefault":true,
                "defaultReasoningEffort":"low",
                "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Low"},{"reasoningEffort":"high","description":"High"}]}]}),
        ),
    ] {
        fs::write(root.join(format!("{name}.json")), response.to_string()).unwrap();
    }
    (handler, claude_home)
}

fn queue_stand_in_turns(handler: &mut RuntimeWorkRpcHandler, root: &Path) {
    handler.worktrees = WorktreeManager::new(root.join("worktrees.json"));
    handler.turn_scheduler = Arc::new(Mutex::new(RuntimeTurnScheduler::new(
        RuntimeSettings {
            max_concurrent_tasks: 0,
            max_concurrent_stand_in_tasks: 0,
            max_concurrent_agent_tasks: 0,
        },
        VecDeque::new(),
    )));
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide native model discovery.
async fn collaboration_chat_inherits_primary_settings_with_separate_persistent_history() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let (mut handler, _claude_home) = memory_review_handler(root.path());
    queue_stand_in_turns(&mut handler, root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.materialize_implicit_primary(7, "device").unwrap();
    let mut settings = store.personal_stand_in(7, "device").unwrap();
    settings["primary"]["prompt"] = json!("Use concise project summaries.");
    settings["primary"]["model"] =
        json!({"runtime":"codex","provider":"openai","model_id":"review-default"});
    let saved = store.save_personal_stand_in(7, "device", settings).unwrap();
    let primary = handler
        .stand_in_conversation(json!({"userId":7,"message":"Personal chat"}))
        .await
        .unwrap();
    let collaboration = handler
        .stand_in_conversation(json!({"userId":7,"message":"Discuss project work",
        "options":{"conversationScope":"collaboration"}}))
        .await
        .unwrap();
    assert_ne!(primary["taskId"], collaboration["taskId"]);
    let turns = super::turns::read_runtime_turn_queue(handler.turn_queue_path.as_ref()).unwrap();
    for (address, scope) in [
        (&primary, Value::Null),
        (&collaboration, json!("collaboration")),
    ] {
        let request = &turns
            .iter()
            .find(|turn| turn.local_task_id == address["taskId"])
            .unwrap()
            .request;
        assert_eq!(request.extra["origin"]["userId"], 7);
        assert_eq!(request.extra["origin"]["standInId"], Value::Null);
        assert_eq!(request.extra["origin"]["conversationScope"], scope);
        assert!(request
            .system_prompt
            .contains("Use concise project summaries."));
        assert_eq!(
            request.system_prompt.contains("collaboration conversation"),
            scope == "collaboration"
        );
    }
    assert_eq!(store.personal_stand_in(7, "device").unwrap(), saved);
    assert_eq!(
        handler.identity_conversation_address(collaboration["taskId"].as_str().unwrap())["taskId"],
        collaboration["taskId"]
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide model discovery settings.
async fn stand_in_reasoning_aliases_keep_resolved_provider_in_execution_and_persistence() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let (mut handler, _claude_home) = memory_review_handler(root.path());
    queue_stand_in_turns(&mut handler, root.path());
    fs::write(root.path().join("model_list.json"), json!({"data":[{
        "id":"review-default","model":"review-default","isDefault":true,
        "defaultReasoningEffort":"low",
        "supportedReasoningEfforts":[{"reasoningEffort":"x-high","description":"Extra high"}, "max"]
    }]}).to_string()).unwrap();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    for (index, (key, value, expected)) in [
        ("reasoning", "x-high", "xhigh"),
        ("reasoningEffort", "extra high", "xhigh"),
        ("reasoning", "maximum", "max"),
    ]
    .into_iter()
    .enumerate()
    {
        let user = 7 + index as i64;
        store.materialize_implicit_primary(user, "device").unwrap();
        let mut settings = store.personal_stand_in(user, "device").unwrap();
        settings["primary"]["enabled"] = json!(true);
        settings["primary"]["model"] =
            json!({"runtime":"codex","provider":"openai","model_id":"review-default"});
        settings["primary"]["modelOptions"] = json!({"runnerModelProvider":"stale-provider"});
        settings["primary"]["modelOptions"][key] = json!(value);
        let saved = store
            .save_personal_stand_in(user, "device", settings)
            .unwrap();
        let address = handler
            .stand_in_conversation(json!({
                "userId":user,"message":"Use the saved stand-in model",
                "options":{"clientUserMessageId":format!("alias-{index}")}
            }))
            .await
            .unwrap();
        let task = address["taskId"].as_str().unwrap();
        let persisted = RuntimeWorkStore::new(root.path().join("runtime.json"))
            .get_task_summary(task)
            .unwrap();
        assert_eq!(
            persisted.runtime_handle["modelSelection"]["modelName"],
            "review-default"
        );
        assert_eq!(
            persisted.runtime_handle["modelSelection"]["options"]["reasoning"],
            expected
        );
        assert_eq!(
            persisted.runtime_handle["modelSelection"]["options"]["runnerModelProvider"],
            "openai"
        );
        assert!(persisted.runtime_handle["modelSelection"]["options"]
            .get("reasoningEffort")
            .is_none());
        let turns =
            super::turns::read_runtime_turn_queue(handler.turn_queue_path.as_ref()).unwrap();
        let request = &turns
            .iter()
            .find(|turn| turn.local_task_id == task)
            .unwrap()
            .request;
        assert_eq!(request.extra["origin"]["type"], "stand_in_identity");
        assert_eq!(request.model_config["model_provider"], "openai");
        assert_eq!(request.model_config["reasoning"]["effort"], expected);
        assert_eq!(request.extra["reasoning_config"]["effort"], expected);
        assert_eq!(store.personal_stand_in(user, "device").unwrap(), saved);
    }
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide model discovery settings.
async fn stand_in_activity_keeps_declared_none_default_with_empty_supported_efforts() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let (mut handler, _claude_home) = memory_review_handler(root.path());
    queue_stand_in_turns(&mut handler, root.path());
    fs::write(
        root.path().join("config_read.json"),
        json!({
            "config":{"model":"gpt-6-luna","model_provider":"openai"}
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        root.path().join("model_list.json"),
        json!({"data":[{
            "id":"gpt-6-luna","model":"gpt-6-luna","isDefault":true,
            "defaultReasoningEffort":"none","supportedReasoningEfforts":[]
        }]})
        .to_string(),
    )
    .unwrap();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.materialize_implicit_primary(7, "device").unwrap();
    let mut settings = store.personal_stand_in(7, "device").unwrap();
    settings["primary"]["enabled"] = json!(true);
    settings["primary"]["model"] =
        json!({"runtime":"codex","provider":"openai","model_id":"gpt-6-luna"});
    settings["primary"]
        .as_object_mut()
        .unwrap()
        .remove("modelOptions");
    let saved = store.save_personal_stand_in(7, "device", settings).unwrap();
    assert!(saved["primary"].get("modelOptions").is_none());
    let address = handler
        .stand_in_conversation(json!({
            "userId":7,"message":"Start the stand-in conversation",
            "options":{"clientUserMessageId":"initial-none-default"}
        }))
        .await
        .unwrap();
    let task = address["taskId"].as_str().unwrap();
    for index in 0..2 {
        let delivered = handler
            .deliver_primary_activity(
                7,
                &format!("background-{index}"),
                "A delegated task finished",
                "工作已结束",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delivered["taskId"], task);
        let persisted = RuntimeWorkStore::new(root.path().join("runtime.json"))
            .get_task_summary(task)
            .unwrap();
        assert_eq!(
            persisted.runtime_handle["modelSelection"]["modelName"],
            "gpt-6-luna"
        );
        assert_eq!(
            persisted.runtime_handle["modelSelection"]["options"]["reasoning"],
            "none"
        );
        assert_eq!(
            persisted.runtime_handle["modelSelection"]["options"]["runnerModelProvider"],
            "openai"
        );
        let turns =
            super::turns::read_runtime_turn_queue(handler.turn_queue_path.as_ref()).unwrap();
        assert_eq!(turns.len(), index + 2);
        let request = &turns.back().unwrap().request;
        assert_eq!(request.model_config["model_id"], "gpt-6-luna");
        assert_eq!(request.model_config["model_provider"], "openai");
        assert_eq!(request.model_config["reasoning"]["effort"], "none");
        assert_eq!(request.extra["reasoning_config"]["effort"], "none");
        assert_eq!(store.personal_stand_in(7, "device").unwrap(), saved);
    }
    for effort in ["high", "max", "not-a-grade"] {
        let mut unsupported = store.personal_stand_in(7, "device").unwrap();
        unsupported["primary"]["modelOptions"] = json!({"reasoning":effort});
        let saved = store
            .save_personal_stand_in(7, "device", unsupported)
            .unwrap();
        let error = handler
            .stand_in_conversation(json!({
                "userId":7,"message":"Use this unsupported effort"
            }))
            .await
            .unwrap_err();
        assert_eq!(error.code, "model_reasoning_unavailable");
        assert_eq!(
            super::turns::read_runtime_turn_queue(handler.turn_queue_path.as_ref())
                .unwrap()
                .len(),
            3
        );
        assert_eq!(store.personal_stand_in(7, "device").unwrap(), saved);
    }
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
}

fn automation() -> Automation {
    serde_json::from_value(json!({"id":"once","version":0,"name":"Review","prompt":"Review progress","schedule":{"type":"one_time","execute_at":"2000-01-01T00:00:00Z"},"taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"}},"taskPayload":{"runtime":"codex"}})).unwrap()
}

fn due(handler: &RuntimeWorkRpcHandler) -> AutomationRun {
    handler.automation_store.create(automation()).unwrap();
    handler
        .automation_store
        .due(chrono::Utc::now())
        .unwrap()
        .pop()
        .unwrap()
        .1
}

fn route_intent(store: &LocalTaskStore, settings: &Value, run_id: &str) {
    store.save_arrangement_snapshot(7, &json!({"id":"snapshot","deviceId":"device","configurationVersion":LocalTaskStore::arrangement_configuration_version(settings),"runs":[{"id":run_id,"userId":7,"roleId":"@primary","automationId":"once","automationVersion":1,"scheduledFor":chrono::Utc::now().to_rfc3339()}]})).unwrap();
    store
        .commit_arrangement_route(
            7,
            "device",
            "snapshot",
            "digest",
            &[json!({"kind":"dispatch_arrangement","eventIds":[run_id]})],
        )
        .unwrap();
}

fn insert_receipt(handler: &RuntimeWorkRpcHandler, run: &AutomationRun, state: CommandState) {
    let task = &run.coordination.as_ref().unwrap().task_id;
    let payload =
        json!({"taskId":task,"commandId":command_id(run),"message":"Original accepted input"});
    let mut request = ExecutionRequest {
        prompt: json!("Original accepted input"),
        subtask_id: "turn".into(),
        ..Default::default()
    };
    request.extra.insert("user_id".into(), json!(7));
    apply_runtime_payload_metadata(&mut request, &payload);
    let turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: task.clone(),
        runtime: "codex".into(),
        request,
        send_payload: Some(payload),
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    };
    let command = RuntimeCommand::from_turn(&turn, state).unwrap().unwrap();
    handler
        .command_journal
        .lock()
        .unwrap()
        .insert(command.key(), command);
}

#[tokio::test]
async fn restart_after_due_write_preserves_the_same_one_time_event_and_identity() {
    let root = tempfile::tempdir().unwrap();
    let first = handler(root.path());
    let run = due(&first);
    assert!(!first.automation_store.get("once").unwrap().enabled);
    drop(first);
    let restored = handler(root.path());
    assert!(restored
        .automation_store
        .due(chrono::Utc::now())
        .unwrap()
        .is_empty());
    let store = LocalTaskStore::open(restored.task_store_path.as_ref()).unwrap();
    let context = restored
        .arrangement_contexts(&store)
        .unwrap()
        .pop()
        .unwrap();
    let snapshot = restored
        .coordination_rpc(
            "runtime.coordination.snapshot",
            json!({"contextId":context["id"],"revision":context["revision"]}),
        )
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["id"], run.id);
    assert_eq!(snapshot["events"][0]["kind"], "schedule_due");
    assert_eq!(snapshot["events"][0]["arrangement"], true);
    assert_eq!(
        restored.automation_store.list_runs(None)[0]
            .coordination
            .as_ref()
            .unwrap()
            .task_id,
        run.coordination.unwrap().task_id
    );
    assert!(restored.store.list_task_summaries(true).is_empty());
}

#[tokio::test]
async fn accepted_command_before_run_update_is_reconciled_even_after_arrangement_deletion() {
    for state in [
        CommandState::Queued,
        CommandState::AwaitingUser,
        CommandState::Settled,
        CommandState::Failed,
        CommandState::Cancelled,
        CommandState::RecoveryRequired,
    ] {
        let root = tempfile::tempdir().unwrap();
        let handler = handler(root.path());
        let run = due(&handler);
        insert_receipt(&handler, &run, state.clone());
        handler.automation_store.delete("once").unwrap();
        assert!(handler.reconcile_arrangement(&run).await.unwrap());
        let expected = match state {
            CommandState::Queued => AutomationRunStatus::Running,
            CommandState::Settled => AutomationRunStatus::Succeeded,
            CommandState::Failed => AutomationRunStatus::Failed,
            CommandState::Cancelled => AutomationRunStatus::Cancelled,
            _ => AutomationRunStatus::NeedsAttention,
        };
        let updated = &handler.automation_store.list_runs(None)[0];
        assert_eq!(updated.status, expected);
        assert_eq!(
            updated.task_id.as_ref(),
            Some(&run.coordination.unwrap().task_id)
        );
        assert_eq!(handler.command_journal.lock().unwrap().len(), 1);
        assert!(handler.store.list_task_summaries(true).is_empty());
    }
}

#[tokio::test]
async fn running_without_a_receipt_never_replays() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler(root.path());
    let run = due(&handler);
    handler
        .automation_store
        .mark_running(&run.id, "original-work".into())
        .unwrap();
    let running = handler.automation_store.list_runs(None).pop().unwrap();
    assert!(handler.reconcile_arrangement(&running).await.unwrap());
    assert_eq!(
        handler.automation_store.list_runs(None)[0].status,
        AutomationRunStatus::NeedsAttention
    );
    assert!(handler.command_journal.lock().unwrap().is_empty());
    assert!(handler.store.list_task_summaries(true).is_empty());
}

#[tokio::test]
async fn terminal_run_with_unfinished_intent_still_has_a_recovery_consumer() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler(root.path());
    let run = due(&handler);
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "device").unwrap();
    route_intent(&store, &settings, &run.id);
    let mut action = store.stand_in_actions(7).unwrap().pop().unwrap();
    action["status"] = json!("sending");
    store.save_stand_in_action(7, &action).unwrap();
    handler
        .settle_arrangement(
            &run,
            AutomationRunStatus::NeedsAttention,
            None,
            Some("Original question".into()),
        )
        .unwrap();
    assert_eq!(
        handler.arrangement_contexts(&store).unwrap()[0]["id"],
        "arrangements:7"
    );
    handler
        .execute_arrangement_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "succeeded");
    assert!(handler.arrangement_contexts(&store).unwrap().is_empty());
    assert_eq!(
        handler.automation_store.list_runs(None)[0].status,
        AutomationRunStatus::NeedsAttention
    );
    assert!(handler.command_journal.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unfinished_intent_for_a_missing_run_is_cancelled_without_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "device").unwrap();
    route_intent(&store, &settings, "removed");
    assert_eq!(
        handler.arrangement_contexts(&store).unwrap()[0]["id"],
        "arrangements:7"
    );
    handler
        .execute_arrangement_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "cancelled");
    assert!(handler.arrangement_contexts(&store).unwrap().is_empty());
    assert!(handler.command_journal.lock().unwrap().is_empty());
}

#[tokio::test]
async fn changed_owner_or_target_cannot_redirect_a_claimed_run() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler(root.path());
    let run = due(&handler);
    let mut changed = handler.automation_store.get("once").unwrap();
    changed.task_request["standInOwner"]["userId"] = json!(8);
    changed.continuation_payload = Some(json!({"taskId":"someone-else"}));
    handler.automation_store.update(changed).unwrap();
    assert!(handler.current_arrangement(&run).is_err());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let context = handler.arrangement_contexts(&store).unwrap().pop().unwrap();
    assert_eq!(context["id"], "arrangements:7");
    handler
        .coordination_rpc(
            "runtime.coordination.snapshot",
            json!({"contextId":context["id"],"revision":context["revision"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        handler.automation_store.list_runs(None)[0].status,
        AutomationRunStatus::NeedsAttention
    );
    assert!(handler.store.list_task_summaries(true).is_empty());
}

#[tokio::test]
async fn manual_calendar_run_routes_immediately_and_reuses_its_original_receipt() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut entry = automation();
    entry.task_request["standInCalendar"] = json!({});
    handler.automation_store.create(entry).unwrap();
    let (_, run) = handler.automation_store.start_manual_run("once").unwrap();
    assert_eq!(run.trigger, "manual");
    let entry = handler.automation_store.get("once").unwrap();
    let prepared = handler
        .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
        .await
        .unwrap();
    assert_eq!(prepared["title"], "Review");
    assert_eq!(prepared["message"], "Review progress");
    assert_eq!(run.status, AutomationRunStatus::Pending);
    assert_eq!(
        handler
            .automation_store
            .start_manual_run("once")
            .unwrap()
            .1
            .status,
        AutomationRunStatus::Skipped
    );
    let contexts = handler.arrangement_contexts(&store).unwrap();
    assert_eq!(contexts.len(), 1);
    assert_eq!(contexts[0]["id"], "arrangements:7");
    assert!(store.stand_in_events(7).unwrap().is_empty());
    let snapshot = handler
        .coordination_rpc(
            "runtime.coordination.snapshot",
            json!({"contextId":contexts[0]["id"],"revision":contexts[0]["revision"]}),
        )
        .await
        .unwrap();
    assert_eq!(snapshot["events"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["events"][0]["id"], run.id);
    assert_eq!(snapshot["events"][0]["kind"], "schedule_due");
    assert_eq!(snapshot["events"][0]["arrangement"], true);
    assert_eq!(snapshot["events"][0]["processingMode"], "immediate");
    assert_eq!(snapshot["events"][0]["notBefore"], json!(run.scheduled_for));
    insert_receipt(&handler, &run, CommandState::Queued);
    let commit = json!({"contextId":contexts[0]["id"],"revision":contexts[0]["revision"],"snapshotId":snapshot["id"],"actions":[{"kind":"dispatch_arrangement","eventIds":[run.id]}]});
    let receipt = handler
        .coordination_rpc("runtime.coordination.commit", commit.clone())
        .await
        .unwrap();
    assert_eq!(
        handler
            .coordination_rpc("runtime.coordination.commit", commit)
            .await
            .unwrap(),
        receipt
    );
    let updated = handler
        .automation_store
        .list_runs(None)
        .into_iter()
        .find(|saved| saved.id == run.id)
        .unwrap();
    assert_eq!(updated.status, AutomationRunStatus::Running);
    assert_eq!(updated.task_id, Some(run.coordination.unwrap().task_id));
    assert_eq!(handler.command_journal.lock().unwrap().len(), 1);
    assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "succeeded");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide model discovery settings.
async fn memory_review_accepts_paused_intake_but_other_arrangements_do_not() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let (handler, _claude_home) = memory_review_handler(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.materialize_implicit_primary(7, "device").unwrap();
    handler.ensure_memory_review_arrangements().unwrap();
    let entry = handler.automation_store.list().pop().unwrap();
    let mut settings = store.personal_stand_in(7, "device").unwrap();
    settings["primary"]["enabled"] = json!(false);
    store.save_personal_stand_in(7, "device", settings).unwrap();
    let prepared = handler
        .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
        .await
        .unwrap();
    assert_eq!(prepared["origin"]["memoryReview"], true);
    assert_eq!(prepared["modelSelection"]["modelName"], "review-default");
    let catalog = handler.runner_catalog().await.unwrap();
    let model = &catalog["models"][0];
    assert_eq!(model["default_reasoning_effort"], "low");
    assert_eq!(model["supported_reasoning_efforts"], json!(["low", "high"]));
    assert_eq!(prepared["modelSelection"]["options"]["reasoning"], "low");
    assert_eq!(
        prepared["executionRequest"]["model_config"]["reasoning"]["effort"],
        "low"
    );
    assert_eq!(
        prepared["executionRequest"]["model_config"]["model_provider"],
        "openai"
    );
    let request: ExecutionRequest =
        serde_json::from_value(prepared["executionRequest"].clone()).unwrap();
    handler
        .validate_stand_in_schedule_start(&request, "unused")
        .unwrap();
    for effort_key in ["reasoning", "reasoningEffort"] {
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"]["modelOptions"] = json!({
            "speed":"fast", "permissionMode":"full-access", "runnerModelProvider":"stale-provider"
        });
        settings["primary"]["modelOptions"][effort_key] = json!("high");
        store.save_personal_stand_in(7, "device", settings).unwrap();
        let explicit = handler
            .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
            .await
            .unwrap();
        assert_eq!(explicit["modelSelection"]["options"]["reasoning"], "high");
        assert_eq!(
            explicit["modelSelection"]["options"]["runnerModelProvider"],
            "openai"
        );
        assert_eq!(explicit["runnerRouting"]["model"]["provider"], "openai");
        assert_eq!(
            explicit["executionRequest"]["model_config"]["model_provider"],
            "openai"
        );
        assert!(explicit["modelSelection"]["options"]
            .get("reasoningEffort")
            .is_none());
        assert_eq!(
            explicit["executionRequest"]["model_config"]["reasoning"]["effort"],
            "high"
        );
        assert_eq!(
            explicit["executionRequest"]["reasoning_config"]["effort"],
            "high"
        );
        assert_eq!(
            explicit["executionRequest"]["model_config"]["service_tier"],
            "fast"
        );
        assert_eq!(
            explicit["executionRequest"]["runtime_permission_profile"],
            ":read-only"
        );
        let mut unsupported = store.personal_stand_in(7, "device").unwrap();
        unsupported["primary"]["modelOptions"] = json!({});
        unsupported["primary"]["modelOptions"][effort_key] = json!("max");
        let saved = store
            .save_personal_stand_in(7, "device", unsupported)
            .unwrap();
        let error = handler
            .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "model_reasoning_unavailable");
        assert!(saved["primary"]["model"].is_null());
        let direct_error = handler
            .prepare_stand_in_execution(json!({"message":"Direct work"}), &saved["primary"])
            .await
            .unwrap_err();
        assert_eq!(direct_error.code, "model_reasoning_unavailable");
        assert_eq!(store.personal_stand_in(7, "device").unwrap(), saved);
    }
    let mut model_list = json!({"data":[{
        "id":"review-default","model":"review-default","isDefault":true,
        "defaultReasoningEffort":"low","supportedReasoningEfforts":[]
    }]});
    fs::write(root.path().join("model_list.json"), model_list.to_string()).unwrap();
    let no_supported_efforts = handler
        .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
        .await
        .unwrap_err();
    assert_eq!(no_supported_efforts.code, "model_reasoning_unavailable");
    model_list["data"][0]
        .as_object_mut()
        .unwrap()
        .remove("supportedReasoningEfforts");
    fs::write(root.path().join("model_list.json"), model_list.to_string()).unwrap();
    let without_capabilities = handler
        .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
        .await
        .unwrap();
    assert_eq!(
        without_capabilities["executionRequest"]["model_config"]["reasoning"]["effort"],
        "max"
    );
    assert!(handler
        .prepare_stand_in_schedule(&automation(), json!({"message":"External work"}))
        .await
        .is_err());
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide model discovery settings.
async fn memory_review_due_skips_empty_history_and_routes_changed_history_independently() {
    let _lock = crate::test_env::lock();
    for changed_history in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (handler, _claude_home) = memory_review_handler(root.path());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store.materialize_implicit_primary(7, "device").unwrap();
        handler.ensure_memory_review_arrangements().unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"]["enabled"] = json!(false);
        store.save_personal_stand_in(7, "device", settings).unwrap();
        let entries = handler.automation_store.list();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(
            entry.task_request["standInCalendar"]["template"],
            "memory_review"
        );
        assert!(matches!(
            entry.conversation_mode,
            ConversationMode::Independent
        ));
        if changed_history {
            handler.upsert_local_task(RuntimeTaskLink {
                local_task_id: "original-user-conversation".into(),
                runtime_handle: json!({
                    "origin":{"type":"stand_in_identity","userId":7,"deviceId":"device","standInId":"@primary"},
                    "executionRequest":{"user_id":7}
                }),
                ..Default::default()
            });
        }
        let run = handler
            .automation_store
            .due(entry.next_run_at.unwrap())
            .unwrap()
            .pop()
            .unwrap()
            .1;
        let contexts = handler.arrangement_contexts(&store).unwrap();
        let events = store.stand_in_events(7).unwrap();
        let saved = handler
            .automation_store
            .list_runs(Some(&entry.id))
            .pop()
            .unwrap();
        if !changed_history {
            assert!(contexts.is_empty());
            assert!(events.is_empty());
            assert_eq!(saved.status, AutomationRunStatus::Succeeded);
            assert!(saved.task_id.is_none());
            assert!(handler.local_task_links(true).is_empty());
            continue;
        }
        assert_eq!(saved.status, AutomationRunStatus::Pending);
        assert!(events.is_empty());
        assert_eq!(contexts.len(), 1);
        let snapshot = handler
            .coordination_rpc(
                "runtime.coordination.snapshot",
                json!({"contextId":contexts[0]["id"],"revision":contexts[0]["revision"]}),
            )
            .await
            .unwrap();
        assert_eq!(snapshot["events"][0]["id"], run.id);
        assert_eq!(snapshot["events"][0]["kind"], "schedule_due");
        assert_eq!(snapshot["events"][0]["arrangement"], true);
        let prepared = handler
            .prepare_stand_in_schedule(entry, json!({"message":entry.prompt}))
            .await
            .unwrap();
        assert_eq!(prepared["origin"]["memoryReview"], true);
        assert_eq!(prepared["origin"]["type"], "stand_in_schedule");
        assert_eq!(prepared["origin"]["automationId"], entry.id);
        assert_eq!(handler.local_task_links(true).len(), 1);
        assert_ne!(
            run.coordination.unwrap().task_id,
            "original-user-conversation"
        );
        handler.arrangement_contexts(&store).unwrap();
        assert!(store.stand_in_events(7).unwrap().is_empty());
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn calendar_due_enters_personal_intake_with_contents_and_saved_route_policy() {
    for immediate in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let handler = handler(root.path());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"","preferences":"","calendar":{"policy":{"automatic":true,"askBeforeAct":true,"immediate":immediate}}});
        store.save_personal_stand_in(7, "device", settings).unwrap();
        let mut entry = automation();
        entry.task_request["standInCalendar"] = json!({});
        handler.automation_store.create(entry).unwrap();
        let run = handler
            .automation_store
            .due(chrono::Utc::now())
            .unwrap()
            .pop()
            .unwrap()
            .1;
        let entry = handler.automation_store.get("once").unwrap();
        let prepared = handler
            .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
            .await
            .unwrap();
        assert_eq!(prepared["title"], "Review");
        assert_eq!(prepared["message"], "Review progress");
        assert!(handler.arrangement_contexts(&store).unwrap().is_empty());
        handler.arrangement_contexts(&store).unwrap();
        let events = store.stand_in_events(7).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["kind"], "calendar");
        assert_eq!(events[0]["message"]["text"], "Review progress");
        assert_eq!(events[0]["runId"], run.id);
        assert!(handler.local_task_links(true).is_empty());
        let contexts = handler
            .coordination_rpc("runtime.coordination.contexts", json!({}))
            .await
            .unwrap();
        let context = contexts["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|context| context["id"] == "personal:7")
            .unwrap();
        let snapshot = handler
            .coordination_rpc(
                "runtime.coordination.snapshot",
                json!({"contextId":"personal:7","revision":context["revision"]}),
            )
            .await
            .unwrap();
        assert_eq!(
            snapshot["events"][0]["processingMode"],
            if immediate { "immediate" } else { "silent" }
        );
        assert_eq!(
            snapshot["events"][0]["dispatch"],
            if immediate {
                json!({"roleId":"@primary"})
            } else {
                Value::Null
            }
        );
        let mut changed = handler.automation_store.get("once").unwrap();
        changed.prompt = "Updated event".into();
        handler.automation_store.update(changed).unwrap();
        let role = json!({"id":"@primary","userId":7});
        assert_eq!(
            handler
                .calendar_intake_run(&role, &events[0])
                .unwrap_err()
                .code,
            "source_removed"
        );
    }
}

#[test]
fn a_calendar_enqueue_failure_does_not_block_other_calendar_runs() {
    let root = tempfile::tempdir().unwrap();
    let handler = handler(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    rusqlite::Connection::open(handler.task_store_path.as_ref()).unwrap().execute_batch(
        "CREATE TRIGGER reject_bad_calendar BEFORE INSERT ON loop_items WHEN NEW.resource_type='stand_in_event' AND json_extract(NEW.metadata,'$.automationId')='bad' BEGIN SELECT RAISE(ABORT,'injected calendar enqueue failure'); END;"
    ).unwrap();
    for id in ["bad", "good"] {
        let mut entry = automation();
        entry.id = id.into();
        entry.task_request["standInCalendar"] = json!({});
        handler.automation_store.create(entry).unwrap();
    }
    handler.automation_store.due(chrono::Utc::now()).unwrap();
    assert!(handler.arrangement_contexts(&store).unwrap().is_empty());
    assert!(handler.arrangement_contexts(&store).unwrap().is_empty());
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["automationId"], "good");
    let runs = handler.automation_store.list_runs(None);
    let bad = runs.iter().find(|run| run.automation_id == "bad").unwrap();
    assert_eq!(bad.status, AutomationRunStatus::NeedsAttention);
    assert!(bad
        .error
        .as_deref()
        .unwrap()
        .contains("injected calendar enqueue failure"));
    assert_eq!(
        runs.iter()
            .find(|run| run.automation_id == "good")
            .unwrap()
            .status,
        AutomationRunStatus::Pending
    );
}
