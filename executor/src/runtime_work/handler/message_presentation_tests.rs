use super::*;

#[tokio::test]
async fn stopped_active_goal_does_not_emit_a_terminal_result_or_discard_its_status() {
    for error in [
        crate::agents::CODEX_APP_SERVER_EXECUTOR_SHUTDOWN,
        crate::agents::CODEX_APP_SERVER_ACTIVE_GOAL_INTERRUPTED,
    ] {
        let (mut handler, root) = isolated_runtime_work_handler("stopped-goal-result");
        let (event_tx, mut event_rx) = broadcast::channel(32);
        handler.event_tx = Some(event_tx);
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".into(),
            "/tmp/project".into(),
            "Active Goal".into(),
        );
        link.goal_status = Some("active".into());
        handler.upsert_local_task(link);
        let execution_id = start_test_execution(&handler, "task-1");
        let before = handler.local_task_link("task-1").unwrap();
        handler.handle_turn_result(
            "task-1",
            execution_id,
            &ExecutionRequest::default(),
            None,
            Err(error.into()),
        );
        let after = handler.local_task_link("task-1").unwrap();
        assert_eq!(after.goal_status.as_deref(), Some("active"));
        assert_eq!(after.status, before.status);
        assert_eq!(after.completed_at, before.completed_at);
        assert!(event_rx.try_recv().is_err());
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn active_codex_text_without_phase_stays_process_text_until_completion() {
    let (handler, root) = isolated_runtime_work_handler("unphased-live-text");
    let mut link =
        RuntimeTaskLink::new_pending("task-1".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &json!({
        "method": "item/agentMessage/delta", "params": {"itemId": "message-1", "delta": "Live answer"}
    }));
    let live = handler.active_codex_transcript_messages("task-1");
    assert_eq!(live[0]["content"], "");
    assert_eq!(live[0]["blocks"][0]["content"], "Live answer");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/completed", "params": {"item": {
                "id": "message-1", "type": "agentMessage", "text": "Live answer"
            }}
        }),
    );
    handler.persist_and_clear_active_codex_transcript("task-1", "completed", None);
    let completed = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(completed[0]["content"], "Live answer");
    assert!(completed[0]["blocks"].as_array().unwrap().is_empty());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn recovered_goal_failure_before_active_turn_has_no_old_user_identity() {
    let (mut handler, root) = isolated_runtime_work_handler("goal-startup-terminal-identity");
    let (event_tx, mut event_rx) = broadcast::channel(32);
    handler.event_tx = Some(event_tx);
    let mut link =
        RuntimeTaskLink::new_pending("task-1".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, "task-1");
    let request = ExecutionRequest {
        task_id: "task-1".into(),
        subtask_id: "original-subtask".into(),
        extra: serde_json::from_value(json!({
            "wegent_resume_goal_only": true,
            "client_user_message_id": "original-user",
            "clientUserMessageId": "original-user",
            "runtime_generated_user_message": true
        }))
        .unwrap(),
        ..ExecutionRequest::default()
    };
    handler.handle_turn_result(
        "task-1",
        execution_id,
        &request,
        None,
        Err("startup failed".into()),
    );
    let mut terminal = None;
    while let Ok(event) = event_rx.try_recv() {
        if event["event"] == "response.failed" {
            terminal = Some(event);
        }
    }
    let event = terminal.expect("startup failure should emit its terminal event");
    assert!(event["payload"].get("clientUserMessageId").is_none());
    assert!(event["payload"]
        .get("runtimeGeneratedUserMessage")
        .is_none());
    assert_eq!(request.extra["client_user_message_id"], "original-user");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn active_codex_text_deltas_survive_interruption() {
    let (handler, root) = isolated_runtime_work_handler("interrupted-text-deltas");
    let mut link =
        RuntimeTaskLink::new_pending("task-1".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/started", "params": {"item": {
                "id": "message-1", "type": "agentMessage", "phase": "final_answer", "text": ""
            }}
        }),
    );
    for delta in ["Partial ", "answer"] {
        handler.record_active_codex_transcript_item("task-1", "turn-1", &json!({
            "method": "item/agentMessage/delta", "params": {"itemId": "message-1", "delta": delta}
        }));
    }
    let mut thread = json!({"turns": []});
    handler.merge_active_codex_transcript("task-1", &mut thread);
    assert_eq!(thread["turns"][0]["items"][0]["text"], "Partial answer");
    assert_eq!(thread["turns"][0]["items"][0]["phase"], "final_answer");

    handler.persist_and_clear_active_codex_transcript("task-1", "cancelled", None);
    let link = handler.local_task_link("task-1").unwrap();
    let messages = completed_transcript_messages(&link);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "Partial answer");
    assert_eq!(messages[0]["runtimeItems"][0]["id"], "message-1");
    assert_eq!(messages[0]["runtimeItems"][0]["type"], "assistant_text");
    assert_eq!(messages[0]["runtimeItems"][0]["content"], "Partial answer");
    assert_eq!(messages[0]["status"], "cancelled");
    assert!(handler
        .active_codex_transcript_messages("task-1")
        .is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn active_codex_text_completion_does_not_duplicate_deltas() {
    let (handler, root) = isolated_runtime_work_handler("completed-text-deltas");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &json!({
        "method": "item/agentMessage/delta", "params": {"itemId": "message-1", "delta": "Answer"}
    }));
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/completed", "params": {"item": {
                "id": "message-1", "type": "agentMessage", "phase": "final_answer", "text": "Answer"
            }}
        }),
    );
    let mut thread = json!({"turns": []});
    handler.merge_active_codex_transcript("task-1", &mut thread);
    assert_eq!(thread["turns"][0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(thread["turns"][0]["items"][0]["text"], "Answer");
    handler.clear_active_codex_transcript("task-1");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/agentMessage/delta", "params": {"itemId": "message-1", "delta": "Late"}
        }),
    );
    assert!(handler
        .active_codex_transcript_messages("task-1")
        .is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn overload_recovery_transcript_preserves_user_and_tools_without_terminal_failure() {
    let handle = json!({"overloadRecoveryTurnIds": ["overloaded-turn"]});
    let mut thread = json!({"turns": [
        {"id": "overloaded-turn", "status": "failed", "error": {
            "message": "Selected model is at capacity.",
            "codexErrorInfo": "serverOverloaded"
        }, "items": [
            {"id": "user-1", "type": "userMessage", "content": [
                {"type": "text", "text": "Original task"}
            ]},
            {"id": "tool-1", "type": "commandExecution", "command": "echo done",
                "status": "completed", "aggregatedOutput": "done"}
        ]},
        {"id": "unrelated-failure", "status": "failed", "error": {
            "message": "Permission denied"
        }, "items": []}
    ]});
    let items = thread["turns"][0]["items"].clone();
    normalize_overload_recovery_thread(&mut thread, &handle);
    assert_eq!(thread["turns"][0]["status"], "completed");
    assert!(thread["turns"][0].get("error").is_none());
    assert_eq!(thread["turns"][0]["items"], items);
    assert_eq!(thread["turns"][1]["status"], "failed");
    assert_eq!(thread["turns"][1]["error"]["message"], "Permission denied");
    let messages = transcript_messages(&thread, "device-1");
    assert!(messages.iter().any(|message| message["role"] == "user"));
    assert!(serde_json::to_string(&messages).unwrap().contains("tool-1"));
    assert!(!messages.iter().any(|message| {
        message["turnId"] == "overloaded-turn" && message["status"] == "failed"
    }));

    let mut cached = vec![
        json!({"turnId": "overloaded-turn", "role": "user", "content": "Original task"}),
        json!({"turnId": "overloaded-turn", "role": "assistant", "status": "failed",
        "error": "Selected model is at capacity.", "blocks": [
            {"type": "tool", "tool_output": "done"}
        ]}),
        json!({"turnId": "unrelated-failure", "role": "assistant", "status": "failed",
            "error": "Permission denied"}),
    ];
    normalize_overload_recovery_messages(&mut cached, &handle);
    assert_eq!(cached.len(), 3);
    assert_eq!(cached[0]["content"], "Original task");
    assert_eq!(cached[1]["status"], "done");
    assert_eq!(cached[1]["blocks"][0]["tool_output"], "done");
    assert!(cached[1].get("error").is_none());
    assert_eq!(cached[2]["status"], "failed");
}

#[test]
fn overload_recovery_turn_identity_survives_store_reload_without_duplicates() {
    let index_path = temp_runtime_work_index_path("overload-recovery-store");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    handler.record_overload_recovery_turn("task-1", "failed-turn");
    handler.record_overload_recovery_turn("task-1", "failed-turn");
    let reloaded = RuntimeWorkStore::new(index_path.clone());
    assert_eq!(
        reloaded.get_task("task-1").unwrap().runtime_handle["overloadRecoveryTurnIds"],
        json!(["failed-turn"])
    );
    let _ = fs::remove_file(index_path);
}

#[test]
fn transcript_restores_native_references_from_saved_user_content() {
    for (original, provider) in [
        (
            "[$GitHub](app://connector_account_specific_id) 查看项目列表",
            "$GitHub 查看项目列表",
        ),
        (
            "[$GitHub](plugin://github@openai-curated-remote) 查看项目列表",
            "GitHub (gh) 查看项目列表",
        ),
        (
            "[$甲乙.pdf](file://%2Ftmp%2F甲乙.pdf) 请阅读",
            "/tmp/甲乙.pdf 请阅读",
        ),
        (
            "查看 [$abc def](folder://%2Ftmp%2Fabc%20def)",
            "查看 \"/tmp/abc def\"",
        ),
        (
            "[$abc.md](file://%2Ftmp%2Fabc.md)[$abc.md](file://%2Ftmp%2Fabc.md)继续",
            "/tmp/abc.md/tmp/abc.md继续",
        ),
        (
            "[$xyz](/tmp/xyz/SKILL.md) 查看 [$甲乙.pdf](file://%2Ftmp%2F甲乙.pdf)",
            "$xyz 查看 /tmp/甲乙.pdf",
        ),
    ] {
        let mut presentation = user_message_presentation(&json!({
            "clientUserMessageId": "client-user",
            "message": original
        }))
        .expect("saved user presentation");
        // Previously saved messages may lack native reference descriptors.
        presentation["references"] = json!([]);
        let mut messages = vec![json!({
            "id": "provider-user",
            "clientUserMessageId": "client-user",
            "role": "user",
            "content": provider
        })];

        attach_user_message_presentations(&mut messages, vec![presentation]);

        assert_eq!(messages[0]["content"], original);
        assert!(messages[0].get("presentationReferences").is_none());
    }
}

#[test]
fn transcript_keeps_plain_provider_paths_without_an_explicit_saved_reference() {
    let mut messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "client-user",
        "role": "user",
        "content": "/tmp/abc.pdf provider content"
    })];
    let presentation = user_message_presentation(&json!({
        "clientUserMessageId": "client-user",
        "message": "/tmp/abc.pdf original content"
    }))
    .expect("saved plain message");

    attach_user_message_presentations(&mut messages, vec![presentation]);

    assert_eq!(messages[0]["content"], "/tmp/abc.pdf provider content");
    assert!(messages[0].get("presentationReferences").is_none());
}

#[test]
fn transcript_does_not_apply_provider_ranges_after_restoring_attachment_content() {
    let original = "[$xyz](/tmp/xyz/SKILL.md) 查看附件";
    let presentation = user_message_presentation(&json!({
        "clientUserMessageId": "client-user",
        "message": original,
        "attachments": [{
            "id": -1,
            "filename": "abc.pdf",
            "local_path": "/tmp/abc.pdf"
        }]
    }))
    .expect("saved attachment message");
    let mut messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "client-user",
        "role": "user",
        "content": "$xyz 查看附件"
    })];

    attach_user_message_presentations(&mut messages, vec![presentation]);

    assert_eq!(messages[0]["content"], original);
    assert!(messages[0].get("presentationReferences").is_none());
    assert_eq!(messages[0]["attachments"][0]["filename"], "abc.pdf");
}

#[tokio::test]
async fn goal_continuation_events_do_not_reuse_initial_user_presentation() {
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let index_path = temp_runtime_work_index_path("goal-continuation-event-presentation");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let execution_id = start_test_execution(&handler, "task-1");
    handler.record_runtime_turn_id("task-1", "subtask-1", "turn-initial", Some("client-1"));
    handler.record_runtime_turn_id("task-1", "turn-next", "turn-next", None);
    let request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        subtask_id: "subtask-1".to_owned(),
        extra: serde_json::from_value(json!({
            "client_user_message_id": "client-1",
            "clientUserMessageId": "client-1",
            "runtime_generated_user_message": true,
        }))
        .unwrap(),
        ..ExecutionRequest::default()
    };
    let active = ActiveCodexTurn {
        execution_id,
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-next".to_owned(),
    };
    handler
        .store
        .update_task("task-1", |link| link.thread_id = Some("thread-1".into()));
    handler.register_thread_event_route("thread-1", "task-1".into(), request.clone(), true);
    handler.route_codex_notification(json!({"method": "turn/started", "params": {
        "threadId": "thread-1", "turn": {"id": "turn-next", "status": "inProgress"}
    }}));
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-next");
    handler.deliver_native_notification_for_execution(
        "task-1", execution_id, &request, Some(active.clone()),
        json!({"method": "item/started", "params": {
            "threadId": "thread-1", "turnId": "turn-next",
            "item": {"id": "message-next", "type": "agentMessage", "phase": "final_answer", "text": ""},
        }}),
    ).await;
    handler
        .deliver_native_notification_for_execution(
            "task-1",
            execution_id,
            &request,
            Some(active.clone()),
            json!({"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-next", "itemId": "message-next",
                "delta": "Continuation output",
            }}),
        )
        .await;
    handler.route_codex_notification(json!({"method": "turn/completed", "params": {
        "threadId": "thread-1", "turn": {"id": "turn-next", "status": "completed", "items": []}
    }}));
    handler.handle_turn_result(
        "task-1",
        execution_id,
        &request,
        Some(&active),
        Ok(crate::agents::CodexAppServerTurn {
            thread_id: "thread-1".to_owned(),
            outcome: ExecutionOutcome::Completed {
                content: "Continuation output".to_owned(),
            },
            response_item_id: Some("message-next".to_owned()),
            response_value_origin: crate::agents::CodexResponseValueOrigin::Final,
            goal_status: None,
            goal_status_observed: false,
            started_at_ms: None,
            completed_at_ms: None,
            duration_ms: None,
        }),
    );
    let mut events = Vec::new();
    while let Ok(event) = event_rx.try_recv() {
        events.push(event);
    }
    assert!(events
        .iter()
        .any(|event| event["event"] == "response.completed"));
    assert!(events
        .iter()
        .any(|event| event["event"] == "response.output_text.delta"));
    for event in events {
        assert_eq!(event["payload"]["subtaskId"], "turn-next");
        assert!(event["payload"].get("clientUserMessageId").is_none());
        assert!(event["payload"]
            .get("runtimeGeneratedUserMessage")
            .is_none());
    }
    let _ = fs::remove_file(index_path);
}
