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
