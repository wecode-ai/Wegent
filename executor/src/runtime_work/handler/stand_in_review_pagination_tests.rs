//! Exercise review evidence through the existing native transcript protocol fixture.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

#[tokio::test]
async fn stand_in_review_reads_more_than_fifty_messages_through_native_pagination() {
    let (mut handler, root) = isolated_runtime_work_handler("stand-in-review-native-pages");
    let now = chrono::Utc::now().timestamp_millis();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "primary".into(),
        runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7},"executionRequest":{"user_id":7}}),
        ..Default::default()
    });
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".into(),
        thread_id: Some("thread-1".into()),
        workspace_path: "/tmp/project".into(),
        runtime: "codex".into(),
        runtime_handle: json!({"executionRequest":{"user_id":7}}),
        ..Default::default()
    });
    let turns: Vec<Value> = (0..60).map(|index| json!({"id":format!("turn-{index}"),"status":"completed","startedAt":now,
        "items":[{"id":format!("message-{index}"),"type":"agentMessage","phase":"final_answer","text":format!("Evidence {index}"),"createdAt":now}]})).collect();
    install_native_history(
        &mut handler,
        &root,
        turns[10..].to_vec(),
        Some("native-before"),
    );
    let metadata: Vec<_> = turns
        .iter()
        .rev()
        .map(|turn| {
            let mut metadata = turn.clone();
            metadata["items"] = json!([]);
            metadata
        })
        .collect();
    fs::write(
        root.join("thread_turns_list.json"),
        json!({"data":metadata,"nextCursor":null}).to_string(),
    )
    .unwrap();
    let identity = StandInMcpIdentity {
        task_id: "primary".into(),
        user: 7,
        device: "device-1".into(),
        role: None,
        work: None,
        ask_before_act: true,
        coordinator_batch: None,
        project: None,
        review: false,
    };
    let result = async {
        let latest = handler.read_stand_in_review_history(&identity,&json!({"taskId":"task-1"})).await?;
        assert_eq!(latest["hasMoreBefore"],true);
        let mut entries = Vec::new();
        for (index, turn) in turns[..10].iter().enumerate() {
            entries.push(json!({"type":"turnStarted","position":index*3,"turnId":turn["id"]}));
            entries.push(json!({"type":"item","position":index*3+1,"turnId":turn["id"],"item":turn["items"][0]}));
            entries.push(json!({"type":"turnCompleted","position":index*3+2,"turnId":turn["id"],"status":"completed"}));
        }
        fs::write(root.join("thread_timeline_list.json"),json!({"data":entries,"nextCursor":null}).to_string()).unwrap();
        let earlier = handler.read_stand_in_review_history(&identity,&json!({"taskId":"task-1","beforeCursor":latest["beforeCursor"],"windowEnd":latest["windowEnd"]})).await?;
        let ids: std::collections::HashSet<_> = latest["messages"].as_array().unwrap().iter().chain(earlier["messages"].as_array().unwrap()).filter_map(|message| message["id"].as_str()).collect();
        assert_eq!(ids.len(),60);
        assert_eq!(earlier["hasMoreBefore"],false);
        Ok::<_, AppIpcError>(())
    }.await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    result.unwrap();
}
