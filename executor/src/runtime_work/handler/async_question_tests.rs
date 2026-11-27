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

#[cfg(unix)]
#[test]
fn stand_in_async_answers_use_the_saved_execution_profile() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _environment: Vec<_> = [
        "HOME",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_WORKBENCH_HOME",
        "WEGENT_CAPABILITIES_HOME",
        "CODEX_SQLITE_HOME",
    ]
    .into_iter()
    .map(|key| {
        let directory = home.path().join(key);
        fs::create_dir_all(&directory).unwrap();
        ScalarEnv::set(key, directory.to_str().unwrap())
    })
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for role in [None, Some("role-1")] {
                let (mut handler, root) = isolated_runtime_work_handler("stand-in-async-answer");
                install_native_history(
                    &mut handler,
                    &root,
                    vec![json!({
                        "id":"turn-1", "status":"completed", "items":[{
                            "id":"question", "type":"agentMessage",
                            "questions":[{"title":"question-1", "options":["answer-1", "answer-2"]}]
                        }]
                    })],
                    None,
                );
                // Hold admission capacity so the exact accepted continuation can
                // be inspected before a native turn consumes it.
                handler.turn_scheduler.lock().unwrap().settings = RuntimeSettings::uniform(0);
                let task = super::super::stand_in_conversations::conversation_task_id(7, role);
                let origin = json!({"type":"stand_in_identity","userId":7,
                    "standInId":role,"deviceId":"device-1","runtimeTaskId":task});
                let mut link = RuntimeTaskLink::new_pending(
                    task.clone(),
                    root.to_string_lossy().into_owned(),
                    "task-1".into(),
                );
                link.thread_id = Some("thread-1".into());
                link.status = "done".into();
                link.running = false;
                link.interaction_status = Some(INTERACTION_AWAITING_USER_REPLY.into());
                let saved = serde_json::from_value(json!({
                    "user_id":7,"origin":origin,"model_config":{"model_id":"model-1"}
                }))
                .unwrap();
                link.runtime_handle["origin"] = origin;
                store_runtime_execution_request(&mut link.runtime_handle, &saved);
                handler.upsert_local_task(link);

                let payload = json!({"method":"runtime.tasks.send", "payload":{
                    "taskId":task,"message":"answer-1","clientUserMessageId":"answer",
                    "requestUserInputResponse":{"delivery":"async","itemId":"question",
                        "interactionScope":"turn-1","answers":{"question_1":{"answers":["answer-1"]}}}
                }});
                let result = handler.handle_runtime_rpc(payload.clone()).await.unwrap();
                assert_eq!(result["accepted"], true, "{result}");
                assert_eq!(result["status"], "queued");
                {
                    let scheduler = handler.turn_scheduler.lock().unwrap();
                    assert_eq!(scheduler.queued_turns.len(), 1);
                    let turn = &scheduler.queued_turns[0];
                    assert_eq!(turn.local_task_id, task);
                    assert_eq!(turn.request.prompt, "answer-1");
                    assert_eq!(turn.request.model_config["model_id"], "model-1");
                    assert_eq!(turn.request.extra["origin"]["standInId"], json!(role));
                    assert!(turn.request.extra["runtime_command_id"]
                        .as_str()
                        .unwrap()
                        .starts_with("stand-in-owner-input:"));
                }
                let rejected = handler.handle_runtime_rpc(payload).await.unwrap_err();
                assert_eq!(rejected.code, "stale_request_user_input");
                assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.len(), 1);
                handler
                    .codex_app_server
                    .request("test/stop", json!({}))
                    .await
                    .unwrap();
                let _ = fs::remove_dir_all(root);
            }
        });
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

#[test]
fn question_file_download_does_not_block_stop_or_deliver_after_stop() {
    run_blocking_question_download_race(true);
}

#[test]
fn question_file_download_cannot_buffer_a_duplicate_for_the_next_question() {
    run_blocking_question_download_race(false);
}

fn run_blocking_question_download_race(stop: bool) {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(blocking_question_download_race(stop));
}

async fn blocking_question_download_race(stop: bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (handler, root) = isolated_runtime_work_handler(if stop {
        "question-download-stop"
    } else {
        "question-download-duplicate"
    });
    let _workspace = ScalarEnv::set("WORKSPACE_ROOT", root.join("workspace").to_str().unwrap());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task".into(),
        root.to_string_lossy().into_owned(),
        "Question download".into(),
    ));
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
        assert!(String::from_utf8_lossy(&headers).contains("Bearer test-token"));
        started.send(()).unwrap();
        download_release.await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nbrief")
            .await
            .unwrap();
    });
    let download_id = uuid::Uuid::new_v4().to_string();
    let download_dir = crate::attachments::device_runtime_attachment_dir("task", &download_id);
    let file = json!({"id":1,"original_filename":"brief.txt","subtask_id":download_id});
    let answer = json!({"requestId":42,"interactionScope":"turn","answers":{"q":{"answers":["Yes"],"attachments":[file.clone()]}}});
    *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
        backend_url: format!("http://{address}/api/"),
        auth_token: "test-token".into(),
        ..ConnectionConfig::default()
    });
    assert!(handler
        .store
        .update_task("task", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &ExecutionRequest::default());
        })
        .is_some());
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler.send_message(json!({"taskId":"task","message":"Yes","requestUserInputResponse":answer,"attachments":[file]})).await
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
    fs::remove_dir_all(download_dir).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn async_question_attachment_groups_reach_new_turn_prompt() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(assert_async_question_attachment_groups());
}

#[cfg(unix)]
async fn assert_async_question_attachment_groups() {
    let (mut handler, root) = isolated_runtime_work_handler("async-question-file-groups");
    let _workspace = ScalarEnv::set("WORKSPACE_ROOT", root.join("workspace").to_str().unwrap());
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
        backend_url: format!("http://{address}/api/"),
        auth_token: "async-download-token".into(),
        ..ConnectionConfig::default()
    });
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        while !headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut buffer = [0; 1024];
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0 && headers.len() < 8192);
            headers.extend_from_slice(&buffer[..count]);
        }
        assert!(String::from_utf8_lossy(&headers).contains("Bearer async-download-token"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nfirst")
            .await
            .unwrap();
    });
    let files = json!([
        {"id":1,"original_filename":"a.txt"},
        {"id":-2,"original_filename":"b.txt","local_path":"/tmp/b.txt","status":"ready"}
    ]);
    let mut link = RuntimeTaskLink::new_pending(
        "task".into(),
        root.to_string_lossy().into_owned(),
        "Question files".into(),
    );
    link.thread_id = Some("thread-1".into());
    store_runtime_execution_request(&mut link.runtime_handle, &ExecutionRequest::default());
    handler.upsert_local_task(link);
    let response = json!({"delivery":"async","itemId":"question","interactionScope":"turn-1",
    "answers":{
        "question_1":{"answers":[],"attachments":[{"id":1}]},
        "question_2":{"answers":["First line\nSecond line"],"attachments":[{"id":-2}]}
    }});
    let mut payload = json!({"taskId":"task","clientUserMessageId":"queued-answer", "message":"First line\nSecond line", "attachments":files,
        "requestUserInputResponse":response});
    let prepared = handler.prepare_question_reply(&payload).await.unwrap();
    handler
        .apply_prepared_async_question_reply("task", &response, &mut payload, prepared)
        .await
        .unwrap();
    let mut request = execution_request(&payload).unwrap();
    apply_runtime_payload_metadata(&mut request, &payload);
    assert_eq!(payload["clientUserMessageId"], "queued-answer");
    assert_eq!(payload["clientGuidanceId"], "queued-answer");
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
    let downloaded_path = request.extra["attachments"][0]["local_path"]
        .as_str()
        .unwrap();
    assert_eq!(fs::read_to_string(downloaded_path).unwrap(), "first");
    fs::remove_dir_all(Path::new(downloaded_path).parent().unwrap()).unwrap();
    assert!(groups["question_1"]["answers"]
        .to_string()
        .contains(downloaded_path));
    assert_eq!(request.task_id, "task");
    assert!(!request.subtask_id.is_empty());
    assert_eq!(request.extra["runtimeLocalTaskId"], "task");
    server.await.unwrap();
    let saved = handler.local_task_link("task").unwrap().runtime_handle["executionRequest"].clone();
    assert!(saved["auth_token"].is_null());
    assert!(saved["backend_url"].is_null());
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
