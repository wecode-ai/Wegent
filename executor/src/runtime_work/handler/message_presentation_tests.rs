use super::*;

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
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-next");
    let mut mapper = CodexNotificationEventMapper::default();
    handler.map_execution_codex_notification(
        "task-1", execution_id, &request, Some(active.clone()), &mut mapper,
        json!({"method": "item/started", "params": {
            "threadId": "thread-1", "turnId": "turn-next",
            "item": {"id": "message-next", "type": "agentMessage", "phase": "final_answer", "text": ""},
        }}),
    ).await;
    handler
        .map_execution_codex_notification(
            "task-1",
            execution_id,
            &request,
            Some(active.clone()),
            &mut mapper,
            json!({"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-1", "turnId": "turn-next", "itemId": "message-next",
                "delta": "Continuation output",
            }}),
        )
        .await;
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
