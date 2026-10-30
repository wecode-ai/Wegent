use super::*;

#[tokio::test]
async fn global_router_persists_async_question_after_execution_settles() {
    let root = tempfile::tempdir().unwrap();
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    let index = root.path().join("runtime.json");
    handler.store = RuntimeWorkStore::new(index.clone());
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread".into());
    link.runtime_handle = json!({"lastTurnId":"turn"});
    handler.upsert_local_task(link);
    let execution = start_test_execution(&handler, "task");
    assert!(handler.finish_local_task("task", execution, None, "done"));
    handler.register_thread_event_route(
        "thread",
        "task".into(),
        ExecutionRequest {
            task_id: "task".into(),
            subtask_id: "turn".into(),
            ..Default::default()
        },
        false,
    );
    let question = CodexNotification::from(json!({
        "method":"item/completed", "params":{"threadId":"thread", "turnId":"turn",
        "item":{"id":"question", "type":"agentMessage", "questions":[{"title":"Continue?","options":["Yes","No"]}]}}
    }));
    handler.route_codex_notification(question.clone());
    handler.route_codex_notification(question.clone());
    handler
        .map_execution_codex_notification(
            "task",
            execution,
            &ExecutionRequest {
                task_id: "task".into(),
                subtask_id: "turn".into(),
                ..Default::default()
            },
            None,
            &mut CodexNotificationEventMapper::default(),
            question,
        )
        .await;
    let mut cards = 0;
    while let Ok(event) = event_rx.try_recv() {
        if event["event"] == "response.block.created" {
            assert_eq!(
                event["payload"]["data"]["block"]["render_payload"]["delivery"],
                "async"
            );
            cards += 1;
        }
    }
    assert_eq!(
        cards, 1,
        "The global receiver must publish the question exactly once"
    );
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    let restored = RuntimeWorkStore::new(index);
    assert_eq!(
        restored
            .get_task("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
}

#[tokio::test]
async fn execution_receiver_persists_async_question_for_identified_active_root_turn() {
    let root = tempfile::tempdir().unwrap();
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread".into());
    link.runtime_handle = json!({"lastTurnId":"turn"});
    handler.upsert_local_task(link);
    let execution = start_test_execution(&handler, "task");
    handler.record_active_codex_turn("task", execution, "thread".into(), "turn".into());
    let request = ExecutionRequest {
        task_id: "task".into(),
        subtask_id: "turn".into(),
        ..Default::default()
    };
    handler.register_thread_event_route("thread", "task".into(), request.clone(), true);
    let question = CodexNotification::from(json!({
        "method":"item/completed", "params":{"threadId":"thread", "turnId":"turn",
        "item":{"id":"question", "type":"agentMessage", "questions":[{"title":"Continue?","options":["Yes","No"]}]}}
    }));
    handler.route_codex_notification(question.clone());
    handler
        .map_execution_codex_notification(
            "task",
            execution,
            &request,
            handler.active_codex_turn("task"),
            &mut CodexNotificationEventMapper::default(),
            question.clone(),
        )
        .await;
    handler.route_codex_notification(question);
    assert!(handler.finish_local_task("task", execution, None, "done"));
    assert_eq!(
        handler
            .local_task_link("task")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    let mut cards = 0;
    while let Ok(event) = event_rx.try_recv() {
        if event["event"] == "response.block.created" {
            cards += 1;
        }
    }
    assert_eq!(cards, 1);
}

#[test]
fn async_question_delivery_ignores_foreign_stale_and_terminal_notifications() {
    let root = tempfile::tempdir().unwrap();
    for (index, (status, thread, turn, interaction, executing, active_turn)) in [
        ("done", "child-thread", "turn", None, false, None),
        ("done", "thread", "old-turn", None, false, None),
        ("failed", "thread", "turn", None, false, None),
        ("cancelled", "thread", "turn", None, false, None),
        ("archived", "thread", "turn", None, false, None),
        (
            "running",
            "thread",
            "turn",
            Some(INTERACTION_WAITING_FOR_USER_INPUT),
            true,
            Some("turn"),
        ),
        ("running", "thread", "turn", None, true, Some("next-turn")),
        ("running", "thread", "turn", None, true, None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(root.path().join(format!("runtime-{index}.json")));
        let mut link =
            RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
        link.thread_id = Some("thread".into());
        link.status = status.into();
        link.runtime_handle = json!({"lastTurnId":"turn"});
        link.interaction_status = interaction.map(str::to_owned);
        handler.upsert_local_task(link);
        if executing {
            let execution = start_test_execution(&handler, "task");
            if let Some(active_turn) = active_turn {
                handler.record_active_codex_turn(
                    "task",
                    execution,
                    "thread".into(),
                    active_turn.into(),
                );
            }
        }
        handler.persist_async_question_interaction("task", &json!({
            "method":"item/completed", "params":{"threadId":thread,"turnId":turn,
            "item":{"id":"question","type":"agentMessage","questions":[{"title":"Continue?","options":["Yes","No"]}]}}
        }));
        assert_eq!(
            handler
                .local_task_link("task")
                .unwrap()
                .interaction_status
                .as_deref(),
            interaction,
            "Rejected question case {index} must preserve interaction state"
        );
    }
}
