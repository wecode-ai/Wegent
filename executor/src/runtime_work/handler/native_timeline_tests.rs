// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use base64::Engine;

#[tokio::test]
async fn archived_history_reads_canonical_rollout_without_reactivating_the_thread() {
    for (label, options) in [
        ("conversation", json!({"conversationContextOnly":true})),
        ("bounded", json!({"transcriptProtocolVersion":2})),
        ("navigation", json!({"navigationOnly":true})),
    ] {
        let (handler, root) = native_handler(&format!("archived-rollout-{label}"));
        handler.store.update_task("task-1", |link| {
            link.status = "archived".into();
            link.running = false;
            link.continuable = false;
        });
        let rollout = root.join("archived-history.jsonl");
        let records = [
            json!({"type":"task_started","turn_id":"current","started_at":1780000000}),
            json!({"type":"item_completed","turn_id":"current","item":{
                "id":"user","type":"userMessage","content":[{"type":"text","text":"Question"}]
            }}),
            json!({"type":"item_completed","turn_id":"current","item":{
                "id":"reply","type":"agentMessage","text":"Archived result"
            }}),
            json!({"type":"task_complete","turn_id":"current","completed_at":1780000001}),
        ];
        fs::write(
            &rollout,
            records
                .iter()
                .map(|payload| json!({"type":"event_msg","payload":payload}).to_string())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        fs::write(
            root.join("thread_read.json"),
            json!({"thread":{
                "id":"thread-1","cwd":"/tmp/project","historyMode":"paginated","path":rollout
            }})
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("thread_timeline_list.error-once.json"),
            json!({"code":-32600,"message":"thread thread-1 is archived"}).to_string(),
        )
        .unwrap();
        let mut payload = options;
        payload["taskId"] = json!("task-1");
        let result = handler
            .handle_runtime_rpc(json!({
                "method":"runtime.tasks.transcript","payload":payload
            }))
            .await;
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        let mut response = result.unwrap();
        if label == "bounded" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(response["transfer"]["payload"].as_str().unwrap())
                .unwrap();
            let mut packed: Value =
                serde_json::from_reader(flate2::read::GzDecoder::new(bytes.as_slice())).unwrap();
            response = packed["transcript"].take();
        }
        if label == "navigation" {
            assert_eq!(response["turnNavigation"][0]["turnId"], "current");
        } else {
            assert!(response["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["role"] == "assistant" && message["content"] == "Archived result"
                }));
        }
        assert_eq!(
            handler.local_task_link("task-1").unwrap().status,
            "archived"
        );
        let requests = fs::read_to_string(root.join("requests.jsonl")).unwrap();
        for forbidden in ["thread/timeline/list", "thread/resume", "thread/unarchive"] {
            assert!(
                !requests.contains(forbidden),
                "Archived reads must not invoke {forbidden}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}

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

#[cfg(unix)]
#[tokio::test]
async fn native_history_uses_an_immutable_executable_with_isolated_quoted_data_paths() {
    let (mut handler, root) = native_handler("native-static-fixture ' root");
    let binary = root.join("native-history.sh");
    assert!(fs::symlink_metadata(&binary)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_link(&binary).unwrap(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native-history.sh")
    );
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["messages"][0]["content"], "Superseded");
    assert!(root.join("requests.jsonl").is_file());
    fs::remove_dir_all(root).unwrap();
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
async fn protocol_two_rejects_a_provider_page_that_ignores_the_requested_item_limit() {
    let (handler, root) = native_handler("native-oversized-provider-page");
    handler.store.update_task("task-1", |link| {
        link.runtime_handle["lastTurnId"] = json!("current");
    });
    let entries = (0..101)
        .map(|position| json!({"type":"realtime","position":position}))
        .collect::<Vec<_>>();
    fs::write(
        root.join("thread_timeline_list.json"),
        json!({"data":entries,"nextCursor":null}).to_string(),
    )
    .unwrap();
    let response = handler
        .handle_runtime_rpc(json!({"method":"runtime.tasks.transcript","payload":{
            "taskId":"task-1","transcriptProtocolVersion":2
        }}))
        .await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let error = response.unwrap_err();
    assert_eq!(error.code, "codex_error");
    assert!(error.message.contains("item budget"));
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
async fn bounded_native_history_never_copies_unrelated_cached_bodies() {
    use base64::Engine;
    let (handler, root) = native_handler("bounded-native-cache-snapshot");
    let large = "unrelated historical tool output".repeat(200_000);
    handler.store.update_task("task-1", |link| {
        link.runtime_handle["lastTurnId"] = json!("current");
        link.runtime_handle["origin"] = json!({"type":"test-origin"});
        link.runtime_handle["messages"] = json!([{"content":large}]);
        set_transcript_snapshot_messages(&mut link.runtime_handle, "thread-1", vec![json!({
            "id":"snapshot","turnId":"current","content":large
        })], None, None);
        append_runtime_handle_user_message_presentation(&mut link.runtime_handle, json!({
            "clientUserMessageId":"client-user","turnId":"current","ensureVisible":true,
            "content":"Original prompt","createdAt":1780000000000_i64
        }));
        append_runtime_handle_user_message_presentation(&mut link.runtime_handle, json!({
            "clientUserMessageId":"other-user","turnId":"unrelated","content":large
        }));
        append_runtime_handle_user_message_presentation(&mut link.runtime_handle, json!({
            "clientUserMessageId":"not-accepted","content":"Optimistic send without a native turn"
        }));
        append_completed_transcript_messages(&mut link.runtime_handle, "thread-1", vec![json!({
            "id":"cached-current","turnId":"current","role":"assistant","status":"done",
            "content":large,"blocks":[{"tool_output":large}],"runtimeItems":[
                {"id":"unrelated-output","type":"assistant_text","content":large},
                {"id":"running-command","type":"block","block":{
                    "id":"running-command","type":"tool","status":"pending","tool_name":"bash",
                    "tool_output":"live output","render_payload":{"kind":"command_execution","status":"inProgress"}
                }},
                {"id":"approval","type":"block","block":{
                    "id":"approval","type":"tool","status":"done","tool_name":"auto_approval_review",
                    "tool_output":"Approved read"
                }},
                {"id":"current-text","type":"assistant_text","content":large}
            ]
        })]);
    });
    let reads = handler.store.full_task_read_count();
    let (metadata, bounded) = handler.transcript_read_link("task-1", true);
    assert!(bounded);
    let metadata = metadata.unwrap();
    assert!(metadata.runtime_handle.get("messages").is_none());
    assert!(metadata
        .runtime_handle
        .get("completedTranscriptMessages")
        .is_none());
    assert!(metadata
        .runtime_handle
        .get("transcriptSnapshotMessages")
        .is_none());
    assert!(metadata
        .runtime_handle
        .get("userMessagePresentations")
        .is_none());
    let page = handler.native_transcript_page_link("task-1", &json!({"turns":[
                {"id":"current","ownsUserPresentation":true,"items":[{"id":"current-text","type":"agentMessage","text":"Current"}]}
    ]}), &super::super::super::transcript_work::Cancellation::new()).unwrap().unwrap();
    let encoded_page = serde_json::to_string(&page.runtime_handle).unwrap();
    assert!(encoded_page.len() < 10_000);
    assert!(!encoded_page.contains("unrelated historical tool output"));
    assert_eq!(
        page.runtime_handle["userMessagePresentations"][0]["content"],
        "Original prompt"
    );
    assert_eq!(
        page.runtime_handle["completedTranscriptMessages"][0]["runtimeItems"][2],
        json!({"id":"current-text"})
    );
    let result = handler
        .transcript(json!({
        "taskId":"task-1","transcriptProtocolVersion":2,
        "reconcileClientUserMessageIds":["client-user","other-user","not-accepted"]
        }))
        .await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let response = result.unwrap();
    assert_eq!(handler.store.full_task_read_count(), reads);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(response["transfer"]["payload"].as_str().unwrap())
        .unwrap();
    let packed: Value =
        serde_json::from_reader(flate2::read::GzDecoder::new(bytes.as_slice())).unwrap();
    assert!(!packed
        .to_string()
        .contains("unrelated historical tool output"));
    let transcript = &packed["transcript"];
    assert_eq!(
        transcript["acceptedClientUserMessageIds"],
        json!(["client-user", "other-user"])
    );
    assert_eq!(
        handler.accepted_reconciliation_ids(
            "task-1",
            &json!({"threadId":"another-thread"}),
            &["client-user".to_owned()]
        ),
        None
    );
    assert_eq!(transcript["origin"]["type"], "test-origin");
    assert!(transcript["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| { message["role"] == "user" && message["content"] == "Original prompt" }));
    let overlays = transcript["runtimeTurns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    assert!(overlays.iter().any(
        |item| item["id"] == "running-command" && item["block"]["tool_output"] == "live output"
    ));
    assert!(overlays
        .iter()
        .any(|item| item["id"] == "approval" && item["block"]["tool_output"] == "Approved read"));
    assert!(overlays
        .iter()
        .any(|item| item["id"] == "current-text" && item["content"] == "Current"));
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

#[tokio::test]
async fn native_timeline_running_identity_survives_before_transcript_buffer_initializes() {
    for completed in [false, true] {
        let (mut handler, root) = native_handler(if completed {
            "running-boundary"
        } else {
            "running-before-buffer"
        });
        let execution_id = start_test_execution(&handler, "task-1");
        handler.record_active_codex_turn(
            "task-1",
            execution_id,
            "thread-1".into(),
            "current".into(),
        );
        handler.apply_native_lifecycle("task-1", &ExecutionRequest::default(), &json!({
            "method":"turn/started", "params":{"threadId":"thread-1", "turn":{"id":"current","status":"inProgress"}}
        }).into());
        assert_eq!(
            handler
                .local_task_link("task-1")
                .unwrap()
                .execution_state
                .unwrap()
                .phase,
            crate::runtime_work::lifecycle::NativeExecutionPhase::Running
        );
        assert!(handler
            .active_codex_transcript_items
            .lock()
            .unwrap()
            .is_empty());
        fs::write(
            root.join("thread_turns_list.json"),
            json!({"data":[
                {"id":"current","status":"interrupted","items":[]}
            ]})
            .to_string(),
        )
        .unwrap();
        let mut events = vec![
            json!({"type":"turnStarted","position":1,"turnId":"current"}),
            json!({"type":"item","position":2,"turnId":"current","item":{
                "id":"user","type":"userMessage","content":[{"type":"text","text":"Question"}]
            }}),
        ];
        if completed {
            events.push(json!({"type":"turnCompleted","position":3,"turnId":"current","status":"interrupted"}));
        }
        fs::write(
            root.join("thread_timeline_list.json"),
            json!({"data":events,"nextCursor":null}).to_string(),
        )
        .unwrap();
        let response = read_and_stop(&mut handler).await.unwrap();
        assert_eq!(
            response["turns"][0]["status"],
            if completed { "cancelled" } else { "streaming" }
        );
        if !completed {
            assert_eq!(response["running"], true);
            assert!(response["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|message| message["stoppedNotice"] != true));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
