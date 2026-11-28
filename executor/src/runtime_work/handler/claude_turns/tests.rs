use super::*;
use tokio::sync::broadcast::error::TryRecvError;

#[test]
fn private_discussion_context_follows_claude_source_turn_without_hiding_stream() {
    let (events, mut receiver) = broadcast::channel(6);
    let handler = RuntimeWorkRpcHandler::with_event_sender("device", "unused", events);
    for private in [true, false] {
        let mut request = ExecutionRequest {
            subtask_id: if private { "private" } else { "public" }.into(),
            ..Default::default()
        };
        if private {
            request
                .extra
                .insert("conversationContext".into(), json!("private_discussion"));
        }
        for event in [
            "response.created",
            "response.output_text.delta",
            "response.completed",
        ] {
            let data = json!({"turnId":request.subtask_id,"value":"Original private transcript"});
            handler.emit_claude_runtime_event("same-task", &request, event, data.clone());
            let emitted = receiver.try_recv().unwrap();
            assert_eq!(emitted["payload"]["runtime"], "claude_code");
            assert_eq!(emitted["payload"]["taskId"], "same-task");
            assert_eq!(emitted["payload"]["subtaskId"], request.subtask_id);
            assert_eq!(emitted["payload"]["data"], data);
            if private {
                assert_eq!(
                    emitted["payload"]["conversationContext"],
                    "private_discussion"
                );
            } else {
                assert!(emitted["payload"].get("conversationContext").is_none());
            }
        }
    }
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn cloud_model_selection_fails_closed_without_backend_token() {
    let _lock = crate::test_env::lock();
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "https://wegent.example");
    let mut request = ExecutionRequest {
        extra: serde_json::Map::from_iter([(
            "modelSelection".to_owned(),
            json!({
                "modelName": "public-review-model",
                "modelType": "public",
                "options": {
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "0",
                },
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let error = prepare_claude_cloud_model_route(&mut request, None)
        .expect_err("cloud model must not fall back to local Claude login");

    assert_eq!(error, "Claude Code cloud model backend token is required");
    assert!(request.model_config.as_object().unwrap().is_empty());
}

#[test]
fn cloud_model_selection_rejects_invalid_resource_user_id() {
    let mut request = ExecutionRequest {
        extra: serde_json::Map::from_iter([(
            "modelSelection".to_owned(),
            json!({
                "modelName": "public-review-model",
                "modelType": "public",
                "options": {
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "-1",
                },
            }),
        )]),
        ..ExecutionRequest::default()
    };
    let backend_credentials = BackendSessionCredentials {
        backend_url: "https://wegent.example".to_owned(),
        session_token: "backend-token".to_owned(),
    };

    let error =
        prepare_claude_cloud_model_route(&mut request, Some(&backend_credentials)).unwrap_err();

    assert_eq!(
        error,
        "Claude Code cloud model resource user ID must be a non-negative integer"
    );
}

#[test]
fn local_harness_route_overrides_claude_provider_and_login_environment() {
    let mut model_config = serde_json::Map::from_iter([(
        "env".to_owned(),
        json!({
            "HTTPS_PROXY": "http://proxy.example",
            "ANTHROPIC_API_KEY": "stale-token",
        }),
    )]);
    let proxy_url = "http://127.0.0.1:19090/v1/harness-router/token";

    apply_claude_proxy_environment(&mut model_config, proxy_url);

    assert_eq!(model_config["env"]["HTTPS_PROXY"], "http://proxy.example");
    assert_eq!(model_config["env"]["ANTHROPIC_BASE_URL"], proxy_url);
    assert_eq!(
        model_config["env"]["ANTHROPIC_API_KEY"],
        local_model_proxy::API_KEY
    );
    assert_eq!(
        model_config["env"]["ANTHROPIC_AUTH_TOKEN"],
        local_model_proxy::API_KEY
    );
    assert_eq!(model_config["env"]["CLAUDE_CODE_USE_BEDROCK"], "0");
    assert_eq!(model_config["env"]["CLAUDE_CODE_USE_FOUNDRY"], "0");
    assert_eq!(model_config["env"]["CLAUDE_CODE_USE_VERTEX"], "0");

    let request = ExecutionRequest {
        bot: json!([{
            "shell_type": "ClaudeCode",
            "agent_config": {
                "env": {
                    "ANTHROPIC_API_KEY": "local-api-key",
                    "ANTHROPIC_AUTH_TOKEN": "local-auth-token",
                    "ANTHROPIC_BASE_URL": "https://local-claude.invalid",
                    "CLAUDE_CODE_USE_BEDROCK": "1",
                    "CLAUDE_CODE_USE_FOUNDRY": "1",
                    "CLAUDE_CODE_USE_VERTEX": "1",
                },
            },
        }]),
        model_config: Value::Object(model_config),
        ..ExecutionRequest::default()
    };
    let command = crate::agents::build_claude_command(&request, "claude");

    assert_eq!(command.envs()["ANTHROPIC_BASE_URL"], proxy_url);
    assert_eq!(
        command.envs()["ANTHROPIC_API_KEY"],
        local_model_proxy::API_KEY
    );
    assert_eq!(
        command.envs()["ANTHROPIC_AUTH_TOKEN"],
        local_model_proxy::API_KEY
    );
    assert_eq!(command.envs()["CLAUDE_CODE_USE_BEDROCK"], "0");
    assert_eq!(command.envs()["CLAUDE_CODE_USE_FOUNDRY"], "0");
    assert_eq!(command.envs()["CLAUDE_CODE_USE_VERTEX"], "0");
}

fn block_created_event(id: &str) -> EventEnvelope {
    EventEnvelope {
        event_type: "response.block.created".to_owned(),
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        data: json!({
            "block": {
                "id": id,
                "type": "text",
            },
        }),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: None,
        execution_attempt_id: None,
    }
}

fn isolated_handler() -> (tempfile::TempDir, RuntimeWorkRpcHandler) {
    let directory = tempfile::tempdir().expect("temporary runtime work directory");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    (directory, handler)
}

#[test]
fn claude_transcript_merges_streamed_block_updates() {
    let mut transcript = TurnTranscript::default();
    transcript.record(&EventEnvelope {
        event_type: "response.block.created".to_owned(),
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        data: json!({
            "block": {
                "id": "block-1",
                "type": "tool",
                "status": "running",
            },
        }),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: None,
        execution_attempt_id: None,
    });
    transcript.record(&EventEnvelope {
        event_type: "response.block.updated".to_owned(),
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        data: json!({
            "block_id": "block-1",
            "updates": {
                "status": "completed",
                "output": "done",
            },
        }),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: None,
        execution_attempt_id: None,
    });

    assert_eq!(
        transcript.blocks(),
        vec![json!({
            "id": "block-1",
            "type": "tool",
            "status": "completed",
            "output": "done",
        })]
    );
}

#[tokio::test]
async fn claude_runtime_events_include_monotonic_event_sequence() {
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    let handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    let request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        ..ExecutionRequest::default()
    };

    handler.emit_claude_runtime_event("task-1", &request, "response.created", json!({}));
    handler.emit_claude_runtime_event("task-1", &request, "error", json!({"message": "failed"}));

    let first = event_rx.recv().await.expect("first Claude runtime event");
    let second = event_rx.recv().await.expect("second Claude runtime event");
    let first_sequence = first["payload"]["eventSeq"]
        .as_u64()
        .expect("first event sequence");
    let second_sequence = second["payload"]["eventSeq"]
        .as_u64()
        .expect("second event sequence");

    assert!(first_sequence > 0);
    assert!(second_sequence > first_sequence);
    assert_eq!(first["payload"]["runtime"], "claude_code");
    assert_eq!(second["payload"]["runtime"], "claude_code");
}

#[tokio::test]
async fn claude_event_sink_drops_events_after_cancellation_starts() {
    let directory = tempfile::tempdir().expect("temporary runtime work directory");
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    let (cancel_tx, _cancel_rx) = oneshot::channel();
    let (_stopped_tx, stopped_rx) = oneshot::channel();
    let execution_id =
        handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);
    let transcript = Arc::new(Mutex::new(TurnTranscript::default()));
    let sink = ClaudeRuntimeEventSink {
        handler: handler.clone(),
        local_task_id: "task-1".to_owned(),
        execution_id,
        request: ExecutionRequest {
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            ..ExecutionRequest::default()
        },
        transcript: Arc::clone(&transcript),
    };

    sink.send(block_created_event("before-cancel"))
        .await
        .expect("active event should be accepted");
    event_rx
        .recv()
        .await
        .expect("active event should be emitted");

    {
        let mut active = handler
            .active_local_executions
            .lock()
            .expect("active local execution map lock");
        let control = active.get_mut("task-1").expect("active Claude turn");
        control.stop_requested = true;
    }
    sink.send(block_created_event("after-cancel"))
        .await
        .expect("late event should be ignored without failing the runtime");

    assert!(matches!(event_rx.try_recv(), Err(TryRecvError::Empty)));
    assert_eq!(
        transcript
            .lock()
            .expect("Claude transcript lock")
            .blocks()
            .iter()
            .map(|block| block["id"].as_str())
            .collect::<Vec<_>>(),
        vec![Some("before-cancel")]
    );
}

#[test]
fn claude_goal_uses_native_print_mode_command_and_persists_state() {
    let (_directory, handler) = isolated_handler();
    let link = RuntimeTaskLink::new_pending_with_runtime(
        "claude-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Goal task".to_owned(),
        "claude_code",
    );
    handler.upsert_local_task(link);
    let mut request = ExecutionRequest {
        prompt: Value::String("original visible message".to_owned()),
        ..ExecutionRequest::default()
    };

    handler.prepare_claude_goal(
        "claude-task-1",
        &mut request,
        &json!({
            "initialGoal": {
                "objective": "all focused tests pass",
                "status": "active",
            },
        }),
    );

    assert_eq!(request.prompt, json!("/goal all focused tests pass"));
    assert!(is_claude_goal_invocation(&request));
    let stored = handler
        .local_task_link("claude-task-1")
        .expect("stored Claude task");
    assert_eq!(stored.goal_status.as_deref(), Some("active"));
    assert_eq!(
        stored.runtime_handle["goal"]["objective"],
        "all focused tests pass"
    );
}

#[test]
fn claude_goal_status_update_preserves_objective() {
    let (_directory, handler) = isolated_handler();
    let mut link = RuntimeTaskLink::new_pending_with_runtime(
        "claude-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Goal task".to_owned(),
        "claude_code",
    );
    link.runtime_handle["goal"] = claude_goal_value(
        "claude-task-1",
        &json!({"status": "active"}),
        Some("finish the migration".to_owned()),
    );
    handler.upsert_local_task(link.clone());

    let updated = handler.set_claude_goal(&link, &json!({"status": "paused"}));

    assert_eq!(updated["objective"], "finish the migration");
    assert_eq!(updated["status"], "paused");
    let stored = handler
        .local_task_link("claude-task-1")
        .expect("stored Claude task");
    assert_eq!(stored.goal_status.as_deref(), Some("paused"));
}

#[tokio::test]
async fn claude_completed_and_follow_up_turns_survive_store_restart() {
    let (directory, mut handler) = isolated_handler();
    handler.upsert_local_task(RuntimeTaskLink::new_pending_with_runtime(
        "claude-1".into(),
        "/tmp/project".into(),
        "Task".into(),
        "claude_code",
    ));
    for (turn, outcome) in [
        (
            "first",
            ExecutionOutcome::Completed {
                content: "answer first".into(),
            },
        ),
        (
            "second",
            ExecutionOutcome::Cancelled {
                message: "Stopped".into(),
            },
        ),
    ] {
        let request = ExecutionRequest {
            task_id: "claude-1".into(),
            subtask_id: turn.into(),
            ..Default::default()
        };
        handler.prepare_claude_send("claude-1", "/tmp/project", &request,
            &json!({"message": format!("request {turn}"), "clientUserMessageId": format!("user-{turn}")}));
        let settlement = TurnSettlement::from_outcome(Ok(&outcome)).unwrap();
        handler.store.update_task("claude-1", |link| {
            settlement.project_assistant_message(link, &request,
                vec![json!({"id": format!("tool-{turn}"), "type":"tool", "tool_name":"pwd", "tool_output":"/tmp/project", "status":"done"})]);
        });
    }
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    let response = handler
        .transcript(json!({"taskId":"claude-1"}))
        .await
        .unwrap();
    assert_eq!(response["running"], false);
    assert_eq!(response["historyUnavailable"], false);
    assert_eq!(response["messages"].as_array().unwrap().len(), 4);
    let turns = response["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["id"], "first");
    assert_eq!(turns[0]["status"], "done");
    assert_eq!(turns[1]["id"], "second");
    assert_eq!(turns[1]["status"], "cancelled");
    assert_eq!(
        handler.local_task_link("claude-1").unwrap().status,
        "cancelled"
    );
    assert!(response["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["blocks"][0]["tool_output"] == "/tmp/project"));
}

#[tokio::test(start_paused = true)]
async fn claude_approval_is_single_use_owner_and_turn_scoped() {
    use wegent_claude_harness::permission::ToolApproval;
    let directory = tempfile::tempdir().unwrap();
    let (events, mut rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device", "unused", events);
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    let (cancel, _cancel_rx) = oneshot::channel();
    let (_stopped, stop) = oneshot::channel();
    let execution_id = handler.start_local_task_execution("task".into(), cancel, stop);
    let sink = ClaudeRuntimeEventSink {
        handler: handler.clone(),
        local_task_id: "task".into(),
        execution_id,
        request: ExecutionRequest {
            task_id: "task".into(),
            subtask_id: "turn".into(),
            ..Default::default()
        },
        transcript: Default::default(),
    };
    let decide = sink.decide(
        "request".into(),
        "Write".into(),
        json!({"path":"review.txt"}),
    );
    tokio::pin!(decide);
    let block = loop {
        tokio::select! {
            _ = &mut decide => panic!("Approval settled before owner response"),
            event = rx.recv() => {
                let data = &event.unwrap()["payload"]["data"];
                if let Some(block) = data.get("block"){break block.clone()}
            }
        }
    };
    assert_eq!(
        block["render_payload"]["toolArguments"]["path"],
        "review.txt"
    );
    let mut response = json!({"requestId":"request","interactionScope":"turn","answers":{"__mcp_approval":{"answers":["Allow"]}}});
    assert_eq!(
        handler.respond_to_claude_approval("task", &response, false)["accepted"],
        false
    );
    response["interactionScope"] = json!("other");
    assert_eq!(
        handler.respond_to_claude_approval("task", &response, true)["accepted"],
        false
    );
    response["interactionScope"] = json!("turn");
    assert_eq!(
        handler.respond_to_claude_approval("task", &response, true)["accepted"],
        true
    );
    assert_eq!(
        handler.respond_to_claude_approval("task", &response, true)["accepted"],
        false
    );
    assert!(decide.await);
    assert_eq!(
        sink.transcript.lock().unwrap().blocks()[0]["render_payload"]["interactionStatus"],
        "answered"
    );

    for (id, answers, status) in [
        (
            "decline",
            json!({"__mcp_approval":{"answers":["Decline"]}}),
            "answered",
        ),
        ("dismiss", json!({}), "cancelled"),
    ] {
        let mut decision = sink.decide(id.into(), "Write".into(), json!({}));
        assert!(futures_util::poll!(&mut decision).is_pending());
        response["requestId"] = json!(id);
        response["answers"] = answers.clone();
        assert_eq!(
            handler.respond_to_claude_approval("task", &response, true)["accepted"],
            true
        );
        assert!(!decision.await);
        let blocks = sink.transcript.lock().unwrap().blocks();
        let payload = blocks
            .iter()
            .map(|block| &block["render_payload"])
            .find(|payload| payload["requestId"] == id)
            .unwrap();
        assert_eq!(payload["interactionStatus"], status);
        if status == "answered" {
            assert_eq!(payload["response"]["answers"], answers);
        } else {
            assert!(payload.get("response").is_none());
        }
    }

    let mut expiring = sink.decide("second".into(), "Write".into(), json!({}));
    assert!(futures_util::poll!(&mut expiring).is_pending());
    tokio::time::advance(Duration::from_secs(301)).await;
    assert!(!expiring.await);
    response["requestId"] = json!("second");
    assert_eq!(
        handler.respond_to_claude_approval("task", &response, true)["accepted"],
        false
    );
    assert!(sink
        .transcript
        .lock()
        .unwrap()
        .blocks()
        .iter()
        .any(|block| block["render_payload"]["interactionStatus"] == "expired"));
}

#[tokio::test]
async fn terminal_claude_transcript_closes_approval_before_its_waiter_drops() {
    use wegent_claude_harness::permission::ToolApproval;
    let (_dir, handler) = isolated_handler();
    let task = "approval-task";
    handler.upsert_local_task(RuntimeTaskLink::new_pending_with_runtime(
        task.into(),
        "/tmp".into(),
        "approval".into(),
        "claude_code",
    ));
    let (cancel, _cancel_rx) = oneshot::channel();
    let (_stopped, stop) = oneshot::channel();
    let execution_id = handler.start_local_task_execution(task.into(), cancel, stop);
    let sink = ClaudeRuntimeEventSink {
        handler: handler.clone(),
        local_task_id: task.into(),
        execution_id,
        request: ExecutionRequest {
            task_id: task.into(),
            subtask_id: "turn".into(),
            ..Default::default()
        },
        transcript: Default::default(),
    };
    let mut decision = sink.decide("native".into(), "Edit".into(), json!({"path":"example"}));
    assert!(futures_util::poll!(&mut decision).is_pending());
    assert_eq!(
        handler.pending_claude_approval_message(task).unwrap()["blocks"][0]["render_payload"]
            ["interactionStatus"],
        "pending"
    );
    assert!(handler.request_active_turn_stop(task));
    let blocks = sink.finish_transcript();
    let outcome = ExecutionOutcome::Cancelled {
        message: "cancelled".into(),
    };
    handler
        .finish_claude_outcome(
            &sink,
            &ResponsesEventBuilder::new(task, "turn", ""),
            outcome,
            blocks,
        )
        .await;
    assert!(!handler.is_current_local_task_execution(task, execution_id));
    drop(decision);
    let link = handler.local_task_link(task).unwrap();
    let messages = cached_messages(&link);
    let card = &messages.last().unwrap()["blocks"][0];
    assert_eq!(card["status"], "done");
    assert_eq!(card["render_payload"]["interactionStatus"], "cancelled");
    assert!(handler.pending_claude_approval_message(task).is_none());
    let response = json!({"requestId":"native","interactionScope":"turn","answers":{"__mcp_approval":{"answers":["Allow"]}}});
    assert_eq!(
        handler.respond_to_claude_approval(task, &response, true)["accepted"],
        false
    );
}

async fn settle_project_stage(
    handler: &RuntimeWorkRpcHandler,
    task: &str,
    request: &ExecutionRequest,
    outcome: ExecutionOutcome,
) {
    let (cancel, _cancel_rx) = oneshot::channel();
    let (_stopped, stop) = oneshot::channel();
    let sink = ClaudeRuntimeEventSink {
        handler: handler.clone(),
        local_task_id: task.into(),
        execution_id: handler.start_local_task_execution(task.into(), cancel, stop),
        request: request.clone(),
        transcript: Default::default(),
    };
    handler
        .finish_claude_outcome(
            &sink,
            &ResponsesEventBuilder::new(task, &request.subtask_id, ""),
            outcome,
            vec![],
        )
        .await;
}
#[tokio::test]
async fn project_form_wait_keeps_the_claim_until_answer_or_cancellation() {
    for cancel in [false, true] {
        let (handler, root) = super::super::tests::isolated_runtime_work_handler("project-form");
        {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.settings.max_concurrent_agent_tasks = 0;
            scheduler.settings.max_concurrent_stand_in_tasks = 0;
            scheduler.settings.max_concurrent_tasks = 0;
        }
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Review"})).unwrap())
            .unwrap()
            .id;
        let agent = store
            .create_chat_agent(
                &project,
                serde_json::from_value(json!({
                    "name":"Review","runtime":"claude_code","execution_environment":"local",
                    "execution_mode":"auto","execution_device_id":"device-1","created_by_user_id":0
                }))
                .unwrap(),
            )
            .unwrap()
            .id;
        let bots = json!([{"id":"author","name":"Author","shell_type":"ClaudeCode","contextPassing":"previous_bot"},{"id":"reviewer","name":"Reviewer","shell_type":"ClaudeCode"}]);
        let team = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"QA","leadId":"review","members":{"review":"sign off"}});
        let mut settings = store.personal_stand_in(0, "device-1").unwrap();
        settings["roles"] = json!([{"id":"review","name":"Reviewer","enabled":true,
            "prompt":"","executionDeviceId":"device-1","version":0,"tags":[],
            "migrationSource":"[\"previous-device\",0,\"original\"]",
            "collaboration":{"enabled":false,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]}}]);
        settings["teams"] = json!([team]);
        settings["transferredTeamDefinition"] = json!({"roleId":"review","definition":{
            "name":"Review","runtime":"claude_code","collaboration_model":"pipeline","bot":bots
        }});
        store
            .save_personal_stand_in(0, "device-1", settings)
            .unwrap();
        store
            .adopt_personal_project_team(
                0,
                "device-1",
                &project,
                &team,
                &BTreeMap::from([("review".into(), agent.clone())]),
            )
            .unwrap();
        let group = &store.get_project(&project).unwrap().metadata["collaboration_groups"][0]["id"];
        let issue = if cancel {
            // Direct creation queues the native group without a desktop manager payload.
            store.create_task(&project,serde_json::from_value(json!({
                "title":"Review issue","assignee_group_id":group
            })).unwrap()).unwrap()
        } else {
            let issue = store.create_task(&project,serde_json::from_value(json!({"title":"Review issue"})).unwrap()).unwrap();
            // The desktop assigns an existing Issue with a locally materialized manager request.
            let assignment = json!({"version":issue.version,"assignee_group_id":group,
                "execution_payload":{"managerRuntimeRequest":{"runtime":"claude_code","executionRequest":{"user_id":0}}}});
            store.update_task(&project,&issue.id,serde_json::from_value(assignment).unwrap()).unwrap()
        }.id;
        let claim = store
            .claim_next_execution_for_runtime(Some("device-1"), "test", 300)
            .unwrap()
            .unwrap();
        let task = claim.runtime_task_id.as_deref().unwrap();
        store
            .request_runtime_start(claim.id, "device-1", task, 300)
            .unwrap();
        store
            .confirm_runtime_accepted(claim.id, "device-1", task, 300)
            .unwrap();
        store.mark_runtime_running(task).unwrap();
        let payload = claim.execution_payload.as_ref().unwrap();
        let origin = &payload["origin"];
        let mut request =
            execution_request(payload).expect("The claimed project must materialize a first turn");
        apply_runtime_payload_metadata(&mut request, payload);
        assert_eq!(request.extra["user_id"], 0);
        assert_eq!(request.extra["team_ref"], agent);
        assert_eq!(request.extra["collaboration_model"], "pipeline");
        let mut first = SpawnTurnRequest::new(task.into(), "claude_code".into(), request);
        let mut link = RuntimeTaskLink::new_pending(
            task.into(),
            root.to_string_lossy().into_owned(),
            "Review".into(),
        );
        link.runtime = "claude_code".into();
        link.runtime_handle["origin"] = origin.clone();
        handler.store.upsert_task(link);
        handler.begin_personal_pipeline(&mut first).unwrap();
        handler.store.update_task(task, |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &first.request)
        });
        let wait = ExecutionOutcome::WaitingForUserInput {
            stop_reason: "tool_deferred".into(),
        };
        settle_project_stage(&handler, task, &first.request, wait).await;
        assert_eq!(
            store
                .execution_by_runtime_task_id(task)
                .unwrap()
                .unwrap()
                .status,
            "running"
        );
        handler.resume_personal_handoffs().await;
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
        if cancel {
            handler.cancel_task(json!({"taskId":task})).await.unwrap();
            assert_eq!(
                store.list_executions(&project, None, None, true).unwrap()[0].status,
                "cancelled"
            );
            handler.resume_personal_handoffs().await;
            assert!(handler
                .turn_scheduler
                .lock()
                .unwrap()
                .queued_turns
                .is_empty());
        } else {
            let address = handler.send_message_from_owner(json!({
                "taskId":task,"message":"Use statute 42","executionRequest":{"prompt":"Use statute 42","task_id":task,"subtask_id":"answer"}
            }),true).await.unwrap();
            assert_ne!(address["success"], false, "{address}");
            let mut queued = handler
                .turn_scheduler
                .lock()
                .unwrap()
                .queued_turns
                .pop_front()
                .unwrap();
            handler
                .restore_personal_bot_grants(task, &mut queued.request)
                .unwrap();
            assert_eq!(queued.request.extra["user_id"], 0);
            assert_eq!(queued.request.bot[0]["id"], "author");
            assert_eq!(queued.request.prompt, "Use statute 42");
            settle_project_stage(
                &handler,
                task,
                &queued.request,
                ExecutionOutcome::Completed {
                    content: "Finding 42".into(),
                },
            )
            .await;
            let mut next = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(next) = handler
                        .turn_scheduler
                        .lock()
                        .unwrap()
                        .queued_turns
                        .pop_front()
                    {
                        break next;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "Reviewer handoff failed: {:?}",
                    handler
                        .local_task_link(task)
                        .map(|link| link.runtime_handle["startupFailure"].clone())
                )
            });
            handler
                .restore_personal_bot_grants(task, &mut next.request)
                .unwrap();
            assert_eq!(next.request.bot[0]["id"], "reviewer");
            assert!(next.request.prompt.as_str().unwrap().contains("Finding 42"));
            assert_eq!(
                store
                    .execution_by_runtime_task_id(task)
                    .unwrap()
                    .unwrap()
                    .status,
                "running"
            );
            settle_project_stage(
                &handler,
                task,
                &next.request,
                ExecutionOutcome::Completed {
                    content: "Signed 42".into(),
                },
            )
            .await;
            assert_eq!(
                store.list_executions(&project, None, None, true).unwrap()[0].status,
                "completed"
            );
            let comments = store.list_comments(&project, &issue, 0).unwrap();
            let receipts: Vec<_> = comments
                .iter()
                .filter(|comment| comment.content == "Signed 42")
                .collect();
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].sender_type, "agent");
            assert_eq!(receipts[0].sender_id, agent);
            assert_eq!(receipts[0].metadata["execution_id"], claim.id);
        }
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}
