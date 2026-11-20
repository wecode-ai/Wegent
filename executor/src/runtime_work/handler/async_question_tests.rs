// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn unknown_question_ids_cannot_consume_an_empty_native_request_map() {
    let (handler, _root) = isolated_runtime_work_handler("im-unknown-answer");
    handler.begin_active_codex_transcript("task", "thread", "turn");
    let execution_id = start_test_execution(&handler, "task");
    handler.record_active_codex_turn("task", execution_id, "thread".into(), "turn".into());
    let (sender, mut receiver) = mpsc::channel(1);
    handler.active_request_user_inputs.lock().unwrap().insert(
        "task".into(),
        ActiveRequestUserInput {
            execution_id,
            sender,
        },
    );
    let result = handler
        .send_request_user_input_response(
            "task",
            json!({
                "requestId":42,"interactionScope":"turn","answers":{"q":{"answers":["Yes"]}}
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["code"], "stale_request_user_input");
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn stand_in_native_answers_use_the_live_request_and_reject_invalid_replays() {
    let (handler, _root) = isolated_runtime_work_handler("im-sync-answer");
    let task = "stand-in-chat-7-primary";
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: task.into(),
        runtime: "codex".into(),
        thread_id: Some("thread".into()),
        runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7}}),
        ..Default::default()
    });
    handler.begin_active_codex_transcript(task, "thread", "turn");
    let execution_id = start_test_execution(&handler, task);
    handler.record_active_codex_turn(task, execution_id, "thread".into(), "turn".into());
    handler.record_active_codex_transcript_item(
        task,
        "turn",
        &json!({
            "id":42,"method":"item/tool/requestUserInput","params":{
                "threadId":"thread","turnId":"turn","itemId":"question",
                "questions":[{"id":"q","question":"Continue?","options":[]}]}
        }),
    );
    let (sender, mut receiver) = mpsc::channel(1);
    handler.active_request_user_inputs.lock().unwrap().insert(
        task.into(),
        ActiveRequestUserInput {
            execution_id,
            sender,
        },
    );
    let answer =
        json!({"requestId":42,"interactionScope":"turn","answers":{"q":{"answers":["Yes"]}}});
    let reply = |response: Value| {
        handler.handle_runtime_rpc(json!({
            "method":"runtime.tasks.send",
            "payload":{"taskId":task,"message":"Yes","requestUserInputResponse":response}
        }))
    };
    let mut wrong = answer.clone();
    wrong["requestId"] = json!(43);
    let rejected = reply(wrong).await.unwrap();
    assert_eq!(rejected["code"], "stale_request_user_input");
    assert!(receiver.try_recv().is_err());
    assert_eq!(reply(answer.clone()).await.unwrap()["accepted"], true);
    assert_eq!(receiver.recv().await.unwrap(), answer);
    assert_eq!(
        reply(answer).await.unwrap()["code"],
        "stale_request_user_input"
    );
    assert!(receiver.try_recv().is_err());
}

#[test]
fn question_publication_retries_auth_timeout_and_rate_limit_failures() {
    for code in [401, 403, 408, 425, 429, 500, 502, 503, 504] {
        assert!(
            !super::super::async_questions::is_permanent_question_rejection(
                reqwest::StatusCode::from_u16(code).unwrap()
            ),
            "{code} must remain queued"
        );
    }
    for code in [400, 404, 409, 422] {
        assert!(
            super::super::async_questions::is_permanent_question_rejection(
                reqwest::StatusCode::from_u16(code).unwrap()
            )
        );
    }
}

#[test]
fn nested_async_question_does_not_mark_the_parent_waiting() {
    let (handler, root) = isolated_runtime_work_handler("nested-async-question");
    let task_id = "parent-task";
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Parent".to_owned(),
    ));
    handler.register_thread_event_route(
        "child-thread",
        task_id.to_owned(),
        ExecutionRequest::default(),
        false,
    );
    handler
        .thread_event_routing
        .lock()
        .unwrap()
        .routes
        .get_mut("child-thread")
        .unwrap()
        .nested = true;
    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "child-thread", "turnId": "child-turn",
            "item": {
                "id": "child-question", "type": "agentMessage",
                "questions": [{"title": "Continue?", "options": ["Yes", "No"]}]
            }
        }
    }));
    assert!(handler
        .local_task_link(task_id)
        .unwrap()
        .interaction_status
        .is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn globally_routed_async_question_persists_waiting_until_next_send() {
    let index_path = temp_runtime_work_index_path("global-async-question");
    let (event_tx, mut event_rx) = broadcast::channel(16);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let task_id = "async-question-task";
    let mut link = RuntimeTaskLink::new_pending(
        task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Async question".to_owned(),
    );
    link.thread_id = Some("thread-async".to_owned());
    handler.upsert_local_task(link);
    let request = ExecutionRequest {
        task_id: task_id.to_owned(),
        subtask_id: "turn-async".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.register_thread_event_route("thread-async", task_id.to_owned(), request.clone(), false);
    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-async", "turnId": "turn-async",
            "item": {
                "id": "question-async", "type": "agentMessage",
                "questions": [{"title": "Continue?", "options": ["Yes", "No"]}]
            }
        }
    }));
    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events.iter().any(|event| {
            event.pointer("/payload/data/block/render_payload/delivery") == Some(&json!("async"))
        }),
        "the global router must emit the real question card"
    );
    assert_eq!(
        handler
            .local_task_link(task_id)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY),
        "the task list must agree with the emitted question card"
    );
    handler.route_codex_notification(json!({
        "method": "turn/completed",
        "params": {
            "threadId": "thread-async",
            "turn": {"id": "turn-async", "status": "completed", "items": []}
        }
    }));
    handler.store = RuntimeWorkStore::new(index_path.clone());
    assert_eq!(
        handler
            .local_task_link(task_id)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    handler.mark_task_running_for_send(
        task_id,
        "thread-async",
        "/tmp/project",
        &request,
        &json!({"message": "Yes"}),
    );
    assert!(handler
        .local_task_link(task_id)
        .unwrap()
        .interaction_status
        .is_none());
    let _ = fs::remove_file(index_path);
}
