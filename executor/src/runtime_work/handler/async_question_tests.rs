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
            None,
        )
        .await
        .unwrap();
    assert_eq!(result["code"], "stale_request_user_input");
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn synchronous_question_answers_reject_duplicates_and_wrong_request_ids() {
    let (handler, _root) = isolated_runtime_work_handler("im-sync-answer");
    handler.begin_active_codex_transcript("task", "thread", "turn");
    let execution_id = start_test_execution(&handler, "task");
    handler.record_active_codex_turn("task", execution_id, "thread".into(), "turn".into());
    handler.record_active_codex_transcript_item(
        "task",
        "turn",
        &json!({
            "id":42,"method":"item/tool/requestUserInput","params":{
                "threadId":"thread","turnId":"turn","itemId":"question",
                "questions":[{"id":"q","question":"Continue?","options":[]}]}
        }),
    );
    let (sender, mut receiver) = mpsc::channel(1);
    handler.active_request_user_inputs.lock().unwrap().insert(
        "task".into(),
        ActiveRequestUserInput {
            execution_id,
            sender,
        },
    );
    let answer =
        json!({"requestId":42,"interactionScope":"turn","answers":{"q":{"answers":["Yes"]}}});
    let mut wrong = answer.clone();
    wrong["requestId"] = json!(43);
    let rejected = handler
        .send_request_user_input_response("task", wrong, None)
        .await
        .unwrap();
    assert_eq!(rejected["code"], "stale_request_user_input");
    assert!(receiver.try_recv().is_err());
    assert_eq!(
        handler
            .send_request_user_input_response("task", answer.clone(), None)
            .await
            .unwrap()["accepted"],
        true
    );
    assert_eq!(receiver.recv().await.unwrap(), answer);
    assert_eq!(
        handler
            .send_request_user_input_response("task", answer, None)
            .await
            .unwrap()["code"],
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

#[tokio::test]
async fn question_file_download_does_not_block_stop_or_deliver_after_stop() {
    blocking_question_download_race(true).await;
}

#[tokio::test]
async fn question_file_download_cannot_buffer_a_duplicate_for_the_next_question() {
    blocking_question_download_race(false).await;
}

async fn blocking_question_download_race(stop: bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (handler, root) = isolated_runtime_work_handler(if stop {
        "question-download-stop"
    } else {
        "question-download-duplicate"
    });
    handler.begin_active_codex_transcript("task", "thread", "turn");
    let execution_id = start_test_execution(&handler, "task");
    handler.record_active_codex_turn("task", execution_id, "thread".into(), "turn".into());
    handler.record_active_codex_transcript_item(
        "task",
        "turn",
        &json!({
            "id":42,"method":"item/tool/requestUserInput","params":{
                "threadId":"thread","turnId":"turn","itemId":"question",
                "questions":[{"id":"q","question":"Continue?","options":[]}]}
        }),
    );
    let (sender, mut receiver) = mpsc::channel(2);
    handler.active_request_user_inputs.lock().unwrap().insert(
        "task".into(),
        ActiveRequestUserInput {
            execution_id,
            sender,
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (started, download_started) = oneshot::channel();
    let (release, download_release) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        while !headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut buffer = [0; 1024];
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0 && headers.len() < 8192);
            headers.extend_from_slice(&buffer[..count]);
        }
        started.send(()).unwrap();
        download_release.await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nbrief")
            .await
            .unwrap();
    });
    let file = json!({"id":1,"original_filename":"brief.txt"});
    let answer = json!({"requestId":42,"interactionScope":"turn","answers":{"q":{"answers":["Yes"],"attachments":[file.clone()]}}});
    let request = json!({"task_id":"task","subtask_id":"answer","prompt":"","project_workspace_path":root,
        "auth_token":"test-token","backend_url":format!("http://{address}/api/"),"attachments":[file]});
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler.send_message(json!({"taskId":"task","message":"Yes","requestUserInputResponse":answer,"executionRequest":request})).await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), download_started)
        .await
        .unwrap()
        .unwrap();
    if stop {
        let stopped = tokio::time::timeout(
            Duration::from_secs(1),
            handler.cancel_task_with_timeout(json!({"taskId":"task"}), Duration::from_millis(100)),
        )
        .await;
        release.send(()).unwrap();
        assert!(stopped.expect("Stop waited for attachment I/O").unwrap()["success"] == true);
        assert_eq!(
            receiver.try_recv().unwrap(),
            empty_request_user_input_response()
        );
    } else {
        let other = json!({"requestId":42,"interactionScope":"turn","answers":{"q":{"answers":["Other answer"]}}});
        assert_eq!(
            handler
                .send_request_user_input_response("task", other.clone(), None)
                .await
                .unwrap()["accepted"],
            true
        );
        assert_eq!(receiver.try_recv().unwrap(), other);
        handler.record_active_codex_transcript_item(
            "task",
            "turn",
            &json!({
                "id":43,"method":"item/tool/requestUserInput","params":{
                    "threadId":"thread","turnId":"turn","itemId":"next-question",
                    "questions":[{"id":"next","question":"Next?","options":[]}]}
            }),
        );
        release.send(()).unwrap();
    }
    let result = tokio::time::timeout(Duration::from_secs(3), sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_ne!(
        result["accepted"], true,
        "stopped or answered question must not receive prepared files"
    );
    assert!(
        receiver.try_recv().is_err(),
        "a duplicate must not be buffered for the next question"
    );
    handler.finish_local_task_execution("task", execution_id);
    server.await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn async_question_attachment_groups_reach_new_turn_prompt() {
    let (mut handler, root) = isolated_runtime_work_handler("async-question-file-groups");
    install_native_history(
        &mut handler,
        &root,
        vec![json!({
            "id":"turn-1", "status":"completed", "items":[{
                "id":"question", "type":"agentMessage", "questions":[
                    {"title":"First file?"}, {"title":"Second file and details?"}
                ]
            }]
        })],
        None,
    );
    let files = json!([
        {"id":-1,"original_filename":"a.txt","local_path":"/tmp/a.txt","status":"ready"},
        {"id":-2,"original_filename":"b.txt","local_path":"/tmp/b.txt","status":"ready"}
    ]);
    let mut link = RuntimeTaskLink::new_pending(
        "task".into(),
        root.to_string_lossy().into_owned(),
        "Question files".into(),
    );
    link.thread_id = Some("thread-1".into());
    link.runtime_handle["executionRequest"] =
        json!({"task_id":"task","subtask_id":"original","prompt":"Original prompt"});
    handler.upsert_local_task(link);
    let response = json!({"delivery":"async","itemId":"question","interactionScope":"turn-1",
    "answers":{
        "question_1":{"answers":[],"attachments":[{"id":-1}]},
        "question_2":{"answers":["First line\nSecond line"],"attachments":[{"id":-2}]}
    }});
    let mut payload = json!({"taskId":"task","message":"First line\nSecond line", "attachments":files,
        "requestUserInputResponse":response});
    let prepared = handler.prepare_question_reply(&payload).await.unwrap();
    handler
        .apply_prepared_async_question_reply("task", &response, &mut payload, prepared)
        .await
        .unwrap();
    let mut request = execution_request(&payload).unwrap();
    apply_runtime_payload_metadata(&mut request, &payload);
    assert_eq!(request.prompt, payload["message"]);
    let groups: Value = serde_json::from_str(
        request
            .prompt
            .as_str()
            .unwrap()
            .strip_prefix("Question answers:\n")
            .unwrap(),
    )
    .unwrap();
    assert!(groups["question_1"]["answers"]
        .to_string()
        .contains("/tmp/a.txt"));
    assert!(!groups["question_1"].to_string().contains("b.txt"));
    assert_eq!(
        groups["question_2"]["answers"][0],
        "First line\nSecond line"
    );
    assert!(groups["question_2"].to_string().contains("/tmp/b.txt"));
    assert!(!groups["question_2"].to_string().contains("a.txt"));
    assert!(payload.get("requestUserInputResponse").is_none());
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(root);
}
