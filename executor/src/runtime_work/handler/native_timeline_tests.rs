// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

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
                }}
            ]
        })]);
    });
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["messages"].as_array().unwrap().len(), 2);
    let runtime = &response["runtimeTurns"];
    assert_eq!(runtime.as_array().unwrap().len(), 1);
    assert_eq!(runtime[0]["id"], "current");
    assert_eq!(runtime[0]["status"], "done");
    assert_eq!(runtime[0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(runtime[0]["items"][0]["id"], "running-command");
    assert_eq!(
        runtime[0]["items"][0]["block"]["tool_output"],
        "ready\ntick\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_timeline_keeps_inflight_items_separate_from_historical_page_order() {
    let (mut handler, root) = native_handler("native-runtime-inflight");
    handler.active_codex_transcript_items.lock().unwrap().insert("task-1".into(), ActiveCodexTranscriptItems {
        thread_id: "thread-1".into(), turn_id: "current".into(), items: vec![
            json!({"id":"old-cached","type":"agentMessage","text":"Old cache","lifecycleCompleted":true}),
            json!({"id":"current-text","type":"agentMessage","text":"Stale cache","lifecycleCompleted":true}),
            json!({"id":"live","type":"agentMessage","text":"Still streaming","lifecycleCompleted":false})
        ]
    });
    let link = handler.local_task_link("task-1").unwrap();
    let runtime = handler.runtime_codex_turns(&link, true);
    assert_eq!(runtime[0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(runtime[0]["items"][0]["id"], "live");
    assert_eq!(runtime[0]["status"], "streaming");
    let response = read_and_stop(&mut handler).await.unwrap();
    assert_eq!(response["turns"][1]["items"].as_array().unwrap().len(), 1);
    assert_eq!(response["turns"][1]["items"][0]["content"], "Current");
    fs::remove_dir_all(root).unwrap();
}
