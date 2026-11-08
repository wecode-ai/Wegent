//! Exercise review evidence through the existing native transcript protocol fixture.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

#[tokio::test]
async fn stand_in_review_reads_more_than_fifty_messages_through_native_pagination() {
    let (mut handler, root) = isolated_runtime_work_handler("stand-in-review-native-pages");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "device-1").unwrap();
    store
        .save_personal_stand_in(7, "device-1", settings)
        .unwrap();
    let now = (chrono::Utc::now() - chrono::Duration::seconds(1)).timestamp_millis();
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
        "items":[{"id":format!("message-{index}"),"type":"agentMessage","phase":"final_answer","text":if index==59 { "x".repeat(20000) } else { format!("Evidence {index}") },"createdAt":now}]})).collect();
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
    let automation = handler
        .automation_store
        .create(
            crate::runtime_work::automations::weekly_review(7, "device-1", "09:00", "en").unwrap(),
        )
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&automation.id)
        .unwrap();
    let actor_id = run.coordination.as_ref().unwrap().task_id.clone();
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:actor_id.clone(),runtime_handle:json!({"origin":{"type":"stand_in_schedule","weeklyReview":true,"userId":7,"deviceId":"device-1","standInId":"@primary","automationId":automation.id},"executionRequest":{"user_id":7,"standInSchedule":{"id":automation.id,"version":automation.version,"runId":run.id}}}),..Default::default()});
    let identity = StandInMcpIdentity {
        task_id: actor_id,
        user: 7,
        device: "device-1".into(),
        role: Some("@primary".into()),
        work: None,
        ask_before_act: true,
        coordinator_batch: None,
        project: None,
        review: true,
        memory_review: false,
        readonly_worker: false,
    };
    let result = async {
        let latest = handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1"})).await?;
        assert_eq!(latest["hasMoreBefore"],true);
        assert!(latest.get("runtimeItems").is_none());
        let message=latest["messages"].as_array().unwrap().iter().find(|message|message["turnId"]=="turn-59").unwrap();
        assert_eq!(message["contentComplete"],false);
        let saved_cursor=message["messageContentCursor"].clone();
        let mut cursor=saved_cursor.clone();
        let mut text=message["content"].as_str().unwrap().to_owned();
        while cursor.is_string() {
            let chunk=handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","messageContentCursor":cursor})).await?;
            text.push_str(chunk["content"].as_str().unwrap());
            cursor=chunk["messageContentCursor"].clone();
        }
        assert_eq!(text,"x".repeat(20000));
        let mut entries = Vec::new();
        for (index, turn) in turns[..10].iter().enumerate() {
            entries.push(json!({"type":"turnStarted","position":index*3,"turnId":turn["id"]}));
            entries.push(json!({"type":"item","position":index*3+1,"turnId":turn["id"],"item":turn["items"][0]}));
            entries.push(json!({"type":"turnCompleted","position":index*3+2,"turnId":turn["id"],"status":"completed"}));
        }
        fs::write(root.join("thread_timeline_list.json"),json!({"data":entries,"nextCursor":null}).to_string()).unwrap();
        let earlier = handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","beforeCursor":latest["beforeCursor"]})).await?;
        let ids: std::collections::HashSet<_> = latest["messages"].as_array().unwrap().iter().chain(earlier["messages"].as_array().unwrap()).filter_map(|message| message["id"].as_str()).collect();
        assert_eq!(ids.len(),60);
        assert_eq!(earlier["hasMoreBefore"],false);
        assert_eq!(handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","since":"2000-01-01T00:00:00Z"})).await.unwrap_err().code,"permission_denied");
        handler.automation_store.update(automation.clone()).unwrap();
        assert_eq!(handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","messageContentCursor":saved_cursor})).await.unwrap_err().code,"permission_denied");
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

#[tokio::test]
async fn stand_in_general_read_task_uses_native_backward_pages_and_optional_time_bounds() {
    let (mut handler, root) = isolated_runtime_work_handler("stand-in-general-native-pages");
    let now = chrono::Utc::now().timestamp_millis();
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"role".into(),runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"device-1","standInId":"default"},"executionRequest":{"user_id":7}}),..Default::default()});
    let store =
        crate::task_runtime::LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "device-1").unwrap();
    store
        .save_personal_stand_in(7, "device-1", settings)
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".into(),
        thread_id: Some("thread-1".into()),
        workspace_path: "/tmp/project".into(),
        runtime: "codex".into(),
        runtime_handle: json!({"executionRequest":{"user_id":7}}),
        ..Default::default()
    });
    let turns:Vec<Value>=(0..60).map(|index|json!({"id":format!("turn-{index}"),"status":"completed","startedAt":now+index*1000,
        "items":[{"id":format!("message-{index}"),"type":"agentMessage","phase":"final_answer","text":if index == 0 {"x".repeat(20000)} else {format!("Evidence {index}")},"createdAt":now+index*1000}]})).collect();
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
            let mut row = turn.clone();
            row["items"] = json!([]);
            row
        })
        .collect();
    fs::write(
        root.join("thread_turns_list.json"),
        json!({"data":metadata,"nextCursor":null}).to_string(),
    )
    .unwrap();
    let identity = StandInMcpIdentity {
        task_id: "role".into(),
        user: 7,
        device: "device-1".into(),
        role: Some("default".into()),
        work: None,
        ask_before_act: true,
        coordinator_batch: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
    };
    let result=async {
        let unfiltered=handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1"})).await?;
        assert_eq!(unfiltered["messages"].as_array().unwrap().len(),50);
        let since=chrono::DateTime::from_timestamp_millis(now+20_000).unwrap().to_rfc3339();
        let until=chrono::DateTime::from_timestamp_millis(now+40_000).unwrap().to_rfc3339();
        let latest=handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","since":since,"until":until})).await?;
        assert_eq!(latest["messages"].as_array().unwrap().len(),20);
        assert_eq!(latest["hasMoreBefore"],true);
        let timeline=|rows:&[Value]|rows.iter().enumerate().flat_map(|(index,turn)|[
            json!({"type":"turnStarted","position":index*3,"turnId":turn["id"]}),
            json!({"type":"item","position":index*3+1,"turnId":turn["id"],"item":turn["items"][0]}),
            json!({"type":"turnCompleted","position":index*3+2,"turnId":turn["id"],"status":"completed"})]).collect::<Vec<_>>();
        fs::write(root.join("thread_timeline_list.json"),json!({"data":timeline(&turns[..10]),"nextCursor":null}).to_string()).unwrap();
        let filtered_earlier=handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","beforeCursor":latest["beforeCursor"]})).await?;
        assert!(filtered_earlier["messages"].as_array().unwrap().is_empty());
        assert_eq!(filtered_earlier["hasMoreBefore"],false);
        let earlier=handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","beforeCursor":unfiltered["beforeCursor"]})).await?;
        assert_eq!(earlier["messages"].as_array().unwrap().len(),10);
        assert_eq!(earlier["hasMoreBefore"],false);
        assert!(earlier["afterCursor"].is_null());
        assert_eq!(earlier["sourceContentMayBeIncomplete"],false);
        let mut long=earlier["messages"].as_array().unwrap().iter().find(|message|message["turnId"]=="turn-0").unwrap()["content"].as_str().unwrap().to_owned();
        let mut cursor=earlier["messages"].as_array().unwrap().iter().find(|message|message["turnId"]=="turn-0").unwrap()["messageContentCursor"].clone();
        while cursor.is_string() {
            let chunk=handler.read_stand_in_conversations(&identity,"read_task",&json!({"taskId":"task-1","messageContentCursor":cursor})).await?;
            long.push_str(chunk["content"].as_str().unwrap());
            cursor=chunk["messageContentCursor"].clone();
        }
        assert_eq!(long,"x".repeat(20000));
        let ids:std::collections::HashSet<_>=unfiltered["messages"].as_array().unwrap().iter()
            .chain(earlier["messages"].as_array().unwrap()).map(|message|message["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(),60);
        assert!(latest.get("turns").is_none());
        let requests:Vec<Value>=fs::read_to_string(root.join("requests.jsonl")).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).filter(|request: &Value|request["method"]=="thread/timeline/list").collect();
        assert_eq!(requests.len(),4);
        assert_eq!(requests.iter().map(|request|request["params"]["cursor"].clone()).collect::<Vec<_>>(),vec![Value::Null,Value::Null,json!("native-before"),json!("native-before")]);
        Ok::<_,AppIpcError>(())
    }.await;
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    result.unwrap();
}
