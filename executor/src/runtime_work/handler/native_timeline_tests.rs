// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn native_timeline_keeps_an_active_open_turn_running_without_unpersisted_items() {
    for completed_item in [false, true] {
        let (mut handler, root) = native_handler(if completed_item {
            "native-open-persisted-item"
        } else {
            "native-open-empty-buffer"
        });
        fs::write(
            root.join("thread_turns_list.json"),
            json!({"data":[
                {"id":"current","status":"interrupted","items":[]}
            ]})
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("thread_timeline_list.json"),
            json!({"data":[
            {"type":"turnStarted","position":1,"turnId":"current"},
            {"type":"item","position":2,"turnId":"current","item":{
                "id":"user","type":"userMessage","content":[{"type":"text","text":"Question"}]
            }}
        ],"nextCursor":null})
            .to_string(),
        )
        .unwrap();
        handler.begin_active_codex_transcript("task-1", "thread-1", "current");
        if completed_item {
            handler.record_active_codex_transcript_item("task-1", "current", &json!({
                "method":"item/completed","params":{"item":{
                    "id":"user","type":"userMessage","content":[{"type":"text","text":"Question"}]
                }}
            }));
        }
        let response = read_and_stop(&mut handler).await.unwrap();
        assert_eq!(response["turns"][0]["status"], "streaming");
        assert_eq!(response["running"], true);
        assert!(response["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message["stoppedNotice"] != true));
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn native_timeline_completion_boundary_wins_over_the_active_execution_buffer() {
    for (native_status, status) in [("completed", "done"), ("interrupted", "cancelled")] {
        let (mut handler, root) = native_handler(&format!("native-terminal-{status}"));
        fs::write(
            root.join("thread_timeline_list.json"),
            json!({"data":[
            {"type":"turnStarted","position":1,"turnId":"current"},
            {"type":"item","position":2,"turnId":"current","item":{
                "id":"user","type":"userMessage","content":[{"type":"text","text":"Question"}]
            }},
            {"type":"turnCompleted","position":3,"turnId":"current","status":native_status}
        ],"nextCursor":null})
            .to_string(),
        )
        .unwrap();
        handler.begin_active_codex_transcript("task-1", "thread-1", "current");
        let response = read_and_stop(&mut handler).await.unwrap();
        assert_eq!(response["turns"][0]["status"], status);
        fs::remove_dir_all(root).unwrap();
    }
}

fn native_handler(label: &str) -> (RuntimeWorkRpcHandler, PathBuf) {
    let (mut handler, root) = isolated_runtime_work_handler(label);
    let mut link =
        RuntimeTaskLink::new_pending("task-1".into(), "/tmp/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    install_native_history(
        &mut handler,
        &root,
        vec![
            json!({"id":"old","status":"completed","items":[
                {"id":"old-text","type":"agentMessage","phase":"final_answer","text":"Superseded"}
            ]}),
            json!({"id":"current","status":"completed","items":[
                {"id":"current-text","type":"agentMessage","phase":"final_answer","text":"Current"}
            ]}),
        ],
        None,
    );
    (handler, root)
}

async fn read_and_stop(handler: &mut RuntimeWorkRpcHandler) -> Result<Value, AppIpcError> {
    let result = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.transcript", "payload":{"taskId":"task-1"}
        }))
        .await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    result
}

#[tokio::test]
async fn native_timeline_excludes_superseded_turns_from_both_projections() {
    let (mut handler, root) = native_handler("native-superseded");
    handler.record_superseded_runtime_transcript_turn("task-1", "old");
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["turns"].as_array().unwrap().len(), 1);
    assert_eq!(response["turns"][0]["id"], "current");
    assert_eq!(response["messages"].as_array().unwrap().len(), 1);
    assert_eq!(response["messages"][0]["turnId"], "current");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_retries_pending_metadata() {
    let (mut handler, root) = native_handler("native-pending-metadata");
    let error_file = root.join("thread_turns_list.error-once.json");
    fs::write(
        &error_file,
        json!({"code":-32603,"message":"list_turns is not supported yet"}).to_string(),
    )
    .unwrap();
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["turns"].as_array().unwrap().len(), 2);
    assert!(!error_file.exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_does_not_retry_permanent_metadata_errors() {
    let (mut handler, root) = native_handler("native-permanent-error");
    fs::write(
        root.join("thread_turns_list.error-once.json"),
        json!({"code":-32603,"message":"permission denied"}).to_string(),
    )
    .unwrap();
    let error = read_and_stop(&mut handler).await.unwrap_err();
    assert!(error.message.contains("permission denied"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_only_restores_user_presentations_on_their_own_page() {
    let (handler, root) = native_handler("native-presentation-page");
    handler.store.update_task("task-1", |link| {
        append_runtime_handle_user_message_presentation(
            &mut link.runtime_handle,
            json!({
                "clientUserMessageId":"client-user", "turnId":"current", "ensureVisible":true,
                "content":"Original prompt", "createdAt":1780000000000_i64
            }),
        );
    });
    let mut latest_entries = (10..509)
        .map(|position| json!({"type":"realtime","position":position}))
        .collect::<Vec<_>>();
    latest_entries.push(
        json!({"type":"item","position":509,"turnId":"current","item":{
            "id":"current-text","type":"agentMessage","phase":"final_answer","text":"Current"
        }}),
    );
    fs::write(
        root.join("thread_timeline_list.json"),
        json!({"data":latest_entries,"nextCursor":"native-before"}).to_string(),
    )
    .unwrap();
    let responses = async {
        let latest = handler
            .handle_runtime_rpc(
                json!({"method":"runtime.tasks.transcript","payload":{"taskId":"task-1"}}),
            )
            .await?;
        fs::write(
            root.join("thread_timeline_list.json"),
            json!({"data":[
            {"type":"turnStarted","position":0,"turnId":"current"},
            {"type":"item","position":1,"turnId":"current","item":{
                "id":"native-user","clientId":"client-user","type":"userMessage",
                "content":[{"type":"inputText","text":"Original prompt"}]
            }}
        ],"nextCursor":null})
            .to_string(),
        )
        .unwrap();
        let earlier = handler
            .handle_runtime_rpc(json!({"method":"runtime.tasks.transcript","payload":{
                "taskId":"task-1","beforeCursor":latest["beforeCursor"]
            }}))
            .await?;
        Ok::<_, AppIpcError>((latest, earlier))
    }
    .await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let (latest, earlier) = responses.unwrap();
    assert_eq!(latest["turns"][0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(latest["turns"][0]["items"][0]["type"], "assistant_text");
    assert!(latest["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["role"] != "user"));
    assert_eq!(earlier["turns"][0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(earlier["turns"][0]["items"][0]["type"], "user_message");
    assert_eq!(earlier["messages"][0]["content"], "Original prompt");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_restores_only_runtime_commands_outside_durable_history() {
    let (mut handler, root) = native_handler("native-runtime-commands");
    handler.store.update_task("task-1", |link| {
        append_completed_transcript_messages(&mut link.runtime_handle, "thread-1", vec![json!({
            "id":"cached-current", "turnId":"current", "role":"assistant", "status":"done",
            "content":"Stale cached answer", "runtimeItems":[
                {"id":"cached-text","type":"assistant_text","content":"Stale cached answer"},
                {"id":"running-command","type":"block","block":{
                    "id":"running-command","type":"tool","status":"pending","tool_name":"bash",
                    "tool_output":"ready\ntick\n", "render_payload":{"kind":"command_execution","status":"inProgress"}
                }},
                {"id":"finished-command","type":"block","block":{
                    "id":"finished-command","type":"tool","status":"done",
                    "render_payload":{"kind":"command_execution","status":"completed"}
                }},
                {"id":"current-text","type":"assistant_text","content":"Stale cached anchor"}
            ]
        })]);
    });
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["messages"].as_array().unwrap().len(), 2);
    let runtime = &response["runtimeTurns"];
    assert_eq!(runtime.as_array().unwrap().len(), 1);
    assert_eq!(runtime[0]["id"], "current");
    assert_eq!(runtime[0]["status"], "done");
    assert_eq!(runtime[0]["items"].as_array().unwrap().len(), 2);
    assert_eq!(runtime[0]["items"][0]["id"], "running-command");
    assert_eq!(
        runtime[0]["items"][0]["block"]["tool_output"],
        "ready\ntick\n"
    );
    assert_eq!(runtime[0]["items"][1]["id"], "current-text");
    assert_eq!(runtime[0]["items"][1]["content"], "Current");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_keeps_inflight_items_separate_from_historical_page_order() {
    let (mut handler, root) = native_handler("native-runtime-inflight");
    handler.active_codex_transcript_items.lock().unwrap().insert("task-1".into(), ActiveCodexTranscriptItems {
        user_input_requests: HashMap::new(),
        thread_id: "thread-1".into(), turn_id: "current".into(), items: vec![
            json!({"id":"old-cached","type":"agentMessage","text":"Old cache","lifecycleCompleted":true}),
            json!({"id":"current-text","type":"agentMessage","text":"Stale cache","lifecycleCompleted":true}),
            json!({"id":"live","type":"agentMessage","text":"Still streaming","lifecycleCompleted":false})
        ]
    });
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["turns"][1]["items"].as_array().unwrap().len(), 2);
    assert_eq!(response["turns"][1]["items"][0]["content"], "Current");
    assert_eq!(
        response["turns"][1]["items"][1]["content"],
        "Still streaming"
    );
    assert!(response["turns"][1]["items"][1].get("position").is_none());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_binds_plain_execution_identity_without_synthesizing_a_prompt() {
    let (mut handler, root) = native_handler("native-plain-user-binding");
    handler.store.update_task("task-1", |link| {
        bind_runtime_handle_user_message_presentation_to_turn(
            &mut link.runtime_handle,
            "client-user",
            "current",
        );
    });
    fs::write(root.join("thread_timeline_list.json"), json!({"data":[
        {"type":"turnStarted","position":0,"turnId":"current"},
        {"type":"item","position":1,"turnId":"current","item":{
            "id":"native-user","type":"userMessage","content":[{"type":"inputText","text":"Original prompt"}]
        }},
        {"type":"item","position":2,"turnId":"current","item":{
            "id":"current-text","type":"agentMessage","phase":"final_answer","text":"Current"
        }}
    ],"nextCursor":null}).to_string()).unwrap();
    let response = read_and_stop(&mut handler).await.unwrap();
    let user = &response["turns"][0]["items"][0];
    assert_eq!(user["id"], "native-user");
    assert_eq!(user["message"]["clientUserMessageId"], "client-user");
    assert_eq!(user["message"]["content"], "Original prompt");
    assert_eq!(
        response["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_restores_completed_approval_evidence_with_native_history() {
    let (mut handler, root) = native_handler("native-approval-evidence");
    fs::write(
        root.join("thread_timeline_list.json"),
        json!({"data":[
        {"type":"turnStarted", "position":1, "turnId":"current"},
        {"type":"item", "position":2, "turnId":"current", "item":{
            "id":"current-text", "type":"agentMessage", "phase":"final_answer", "text":"Current"
        }},
        {"type":"turnCompleted", "position":3, "turnId":"current", "status":"completed"}
    ], "nextCursor":null})
        .to_string(),
    )
    .unwrap();
    handler.begin_active_codex_transcript("task-1", "thread-1", "current");
    for (id, status, rationale) in [
        ("allow", "completed", "Read authorized work context"),
        (
            "deny",
            "failed",
            "Private data is outside the assigned task",
        ),
    ] {
        handler.record_active_codex_transcript_item("task-1", "current", &json!({
            "method":"item/completed", "params":{"threadId":"thread-1", "turnId":"current", "item":{
                "id":id,"type":"autoApprovalReview","name":"auto_approval_review",
                "status":status,"arguments":{"type":"command"},"output":{"rationale":rationale}
            }}
        }));
    }
    handler.persist_and_clear_active_codex_transcript("task-1", "completed", None);
    let response = read_and_stop(&mut handler).await.unwrap();
    let reviews = response["runtimeTurns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .map(|item| &item["block"])
        .filter(|block| block["tool_name"] == "auto_approval_review")
        .collect::<Vec<_>>();
    assert_eq!(reviews.len(), 2);
    assert!(reviews.iter().any(|block| block["status"] == "done"));
    assert!(reviews.iter().any(|block| block["status"] == "error"));
    assert!(reviews
        .iter()
        .any(|block| block["tool_output"]["rationale"]
            == "Private data is outside the assigned task"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_approval_expiry_clears_only_its_waiter_and_updates_the_visible_card() {
    let (mut handler, root) = native_handler("native-approval-expiry");
    let (event_tx, mut events) = broadcast::channel(16);
    handler.event_tx = Some(event_tx);
    handler.begin_active_codex_transcript("task-1", "thread-1", "current");
    let request = ExecutionRequest {
        subtask_id: "current".into(),
        ..ExecutionRequest::default()
    };
    let mut mapper = CodexNotificationEventMapper::default();
    for (id, method) in [
        (71, "item/commandExecution/requestApproval"),
        (72, "item/fileChange/requestApproval"),
    ] {
        let message = json!({"id":id,"method":method,"params":{"threadId":"thread-1","turnId":"current","itemId":format!("item-{id}"),"interactionStatus":"pending","expiresAtUnixMs":1}});
        handler.record_active_codex_transcript_item("task-1", "current", &message);
        mapper.map(
            &handler.event_tx,
            &handler.device_id,
            "task-1",
            &request,
            message,
        );
    }
    handler.refresh_pending_user_input_status("task-1");
    assert_eq!(
        handler
            .local_task_link("task-1")
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_WAITING_FOR_USER_INPUT)
    );
    for (id, method) in [
        (71, "item/commandExecution/requestApproval"),
        (72, "item/fileChange/requestApproval"),
    ] {
        let message = json!({"id":id,"method":crate::runtime_work::codex_user_input::APPROVAL_SETTLED_METHOD,"params":{"threadId":"thread-1","turnId":"current","itemId":format!("item-{id}"),"approvalMethod":method,"interactionStatus":"expired","expiresAtUnixMs":1,"settledAtUnixMs":2}});
        handler.record_active_codex_transcript_item("task-1", "current", &message);
        handler.refresh_pending_user_input_status("task-1");
        mapper.map(
            &handler.event_tx,
            &handler.device_id,
            "task-1",
            &request,
            message,
        );
        assert_eq!(
            handler
                .local_task_link("task-1")
                .unwrap()
                .interaction_status
                .is_some(),
            id == 71
        );
    }
    let updates: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|event| event["event"] == "response.block.updated")
        .collect();
    // Event envelopes expose the update payload independently of their transport name.
    let active = handler.active_codex_transcript_items.lock().unwrap();
    let items = &active["task-1"].items;
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .all(|item| item["renderPayload"]["interactionStatus"] == "expired"));
    drop(active);
    assert_eq!(updates.len(), 2);
    assert!(updates.iter().all(
        |event| event["payload"]["data"]["updates"]["status"] == "done"
            && event["payload"]["data"]["updates"]["render_payload"]["interactionStatus"]
                == "expired"
    ));
    fs::remove_dir_all(root).unwrap();
}
