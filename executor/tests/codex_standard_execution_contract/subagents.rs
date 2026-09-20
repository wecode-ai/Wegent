// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

type Blocks = std::collections::BTreeMap<String, serde_json::Map<String, Value>>;

#[tokio::test]
async fn codex_subagent_uses_standard_lifecycle_and_preserves_child_text() {
    let _lock = env_lock().await;
    let notifications = [
        notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "before", "phase": "commentary", "delta": "我"
            }),
        ),
        notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "before", "phase": "commentary", "delta": "会创建子任务。"
            }),
        ),
        notification(
            "item/completed",
            json!({"item": {
                "id": "spawn", "type": "collabAgentToolCall", "tool": "spawnAgent",
                "prompt": "完成独立写作任务", "status": "completed",
                "receiverThreadIds": ["child"],
                "agentsStates": {"child": {"status": "pendingInit", "message": null}}
            }}),
        ),
        notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "after", "phase": "commentary", "delta": "已经"
            }),
        ),
        notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "after", "phase": "commentary", "delta": "创建，等待结果。"
            }),
        ),
        json!({"method": "item/agentMessage/delta", "params": {
            "threadId": "child", "itemId": "child-text", "delta": "子任务"
        }}),
        json!({"method": "item/agentMessage/delta", "params": {
            "threadId": "child", "itemId": "child-text", "delta": "完整正文🙂"
        }}),
        json!({"method": "item/completed", "params": {"threadId": "child", "item": {
            "id": "child-text", "type": "agentMessage", "phase": "final_answer",
            "text": "子任务完整正文🙂"
        }}}),
        notification(
            "item/completed",
            json!({"item": {
                "id": "wait", "type": "collabAgentToolCall", "tool": "wait",
                "status": "completed", "receiverThreadIds": ["child"],
                "agentsStates": {"child": {"status": "completed", "message": "子任务完整正文🙂"}}
            }}),
        ),
        notification(
            "item/completed",
            json!({"item": {
                "id": "final", "type": "agentMessage", "phase": "final_answer",
                "text": "子任务已完成。"
            }}),
        ),
    ];
    let (_, events) = execute_notifications(&notifications).await;
    let created = events
        .iter()
        .find(|event| {
            event.event_type == "response.block.created"
                && event.data["block"]["type"] == "subagent"
        })
        .expect("subagent card must be created");
    assert_eq!(created.data["block"]["status"], "pending");
    let parent_id = created.data["block"]["id"].as_str().unwrap();
    let mut blocks = Blocks::new();
    for event in &events {
        apply_block_event(&mut blocks, event);
    }
    assert_eq!(blocks[parent_id]["status"], "done");
    assert!(blocks.values().any(|block| {
        block.get("parent_tool_use_id").and_then(Value::as_str) == Some(parent_id)
            && block.get("content").and_then(Value::as_str) == Some("子任务完整正文🙂")
    }));
    for text in ["我会创建子任务。", "已经创建，等待结果。"] {
        assert!(blocks
            .values()
            .any(|block| block.get("content").and_then(Value::as_str) == Some(text)));
    }
    let body: String = events
        .iter()
        .filter(|event| event.event_type == "response.output_text.delta")
        .filter_map(|event| event.data["delta"].as_str())
        .collect();
    assert_eq!(body, "子任务已完成。");
}

#[tokio::test]
async fn three_subagents_stream_independent_progress_before_turn_completion() {
    let _lock = env_lock().await;
    let fixture = Fixture::with_notifications(&parallel_subagent_notifications());
    let request = fixture.request("first");
    let (sink, mut receiver) = event_channel();
    let mut run = fixture
        .engine()
        .run_with_events(request.clone(), sink, builder(&request));
    let mut blocks = Blocks::new();
    let mut progress = Vec::new();
    let mut body = String::new();
    tokio::time::timeout(TIMEOUT, async {
        loop {
            let event = tokio::select! {
                outcome = &mut run => panic!("progress must arrive before turn completion: {outcome:?}"),
                event = receiver.recv() => event.expect("stream sink must remain open"),
            };
            apply_block_event(&mut blocks, &event);
            let agents: Vec<_> = blocks.values()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("subagent"))
                .collect();
            if agents.len() == 3 {
                assert!(agents.iter().all(|block| matches!(
                    block.get("status").and_then(Value::as_str), Some("pending" | "done")
                )));
                let completed = agents.iter().filter(|block| block["status"] == "done").count();
                if progress.last() != Some(&completed) { progress.push(completed); }
            }
            if event.event_type == "response.output_text.delta" {
                assert_eq!(event.data["offset"], body.chars().count());
                body.push_str(event.data["delta"].as_str().unwrap());
                if body == "三个子 agent 都已返回。" { break; }
            }
        }
    }).await.expect("all child progress and output must stream before completion");

    assert_eq!(progress, [0, 1, 2, 3]);
    for index in 1..=3 {
        let parent = format!("subagent-child-{index}");
        let command = &blocks[&format!("command-{index}")];
        assert_eq!(command["parent_tool_use_id"], parent);
        assert_eq!(command["status"], "done");
        assert_eq!(command["tool_output"], format!("child {index} finished"));
        assert!(blocks.values().any(|block| {
            block.get("parent_tool_use_id") == Some(&json!(parent))
                && block.get("content") == Some(&json!(format!("子 agent {index} 已返回。")))
        }));
    }
    for text in ["我会创建三个子 agent。", "3 个子 agent 已创建。"] {
        assert!(blocks
            .values()
            .any(|block| block.get("content") == Some(&json!(text))));
    }
    fs::write(fixture.root.path().join("release"), "complete").unwrap();
    assert_eq!(
        tokio::time::timeout(TIMEOUT, run).await.unwrap(),
        ExecutionOutcome::Completed { content: body }
    );
}

fn apply_block_event(blocks: &mut Blocks, event: &EventEnvelope) {
    if event.event_type == "response.block.created" {
        let block = event.data["block"].as_object().unwrap();
        blocks.insert(block["id"].as_str().unwrap().to_owned(), block.clone());
    } else if event.event_type == "response.block.updated" {
        let updates = event.data["updates"].as_object().unwrap();
        assert!(!updates.contains_key("content_delta"));
        assert!(!updates.contains_key("tool_output_delta"));
        blocks
            .get_mut(event.data["block_id"].as_str().unwrap())
            .unwrap()
            .extend(updates.clone());
    }
}

fn parallel_subagent_notifications() -> Vec<Value> {
    let mut events = Vec::new();
    for delta in ["我", "会创建三个子 agent。"] {
        events.push(notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "before", "phase": "commentary", "delta": delta
            }),
        ));
    }
    for index in 1..=3 {
        let child = format!("child-{index}");
        events.push(notification(
            "item/completed",
            json!({"item": {
                "id": format!("spawn-{index}"), "type": "collabAgentToolCall", "tool": "spawnAgent",
                "status": "completed", "receiverThreadIds": [&child],
                "agentsStates": {child: {"status": "pendingInit", "message": null}}
            }}),
        ));
    }
    for index in 1..=3 {
        events.push(child_notification(
            index,
            "item/started",
            json!({"item": {
                "id": format!("command-{index}"), "type": "commandExecution",
                "command": "sleep 10", "status": "inProgress"
            }}),
        ));
    }
    for delta in ["3", " 个子 agent 已创建。"] {
        events.push(notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "after", "phase": "commentary", "delta": delta
            }),
        ));
    }
    // A wait start must not finish any child; the first response contains only child 2.
    events.push(wait_notification("item/started", &[1, 2, 3]));
    for index in [2, 1, 3] {
        events.push(child_notification(
            index,
            "item/completed",
            json!({"item": {
                "id": format!("command-{index}"), "type": "commandExecution",
                "command": "sleep 10", "status": "completed", "exitCode": 0,
                "aggregatedOutput": format!("child {index} finished")
            }}),
        ));
        for delta in ["子 agent ".to_owned(), format!("{index} 已返回。")] {
            events.push(child_notification(
                index,
                "item/agentMessage/delta",
                json!({
                    "itemId": format!("text-{index}"), "delta": delta
                }),
            ));
        }
        events.push(child_notification(
            index,
            "item/completed",
            json!({"item": {
                "id": format!("text-{index}"), "type": "agentMessage", "phase": "final_answer",
                "text": format!("子 agent {index} 已返回。")
            }}),
        ));
        if index == 2 {
            events.push(wait_notification("item/completed", &[2]));
            events.push(wait_notification("item/started", &[1, 3]));
        }
    }
    events.push(wait_notification("item/completed", &[1, 3]));
    events.push(notification("item/completed", json!({"item": {
        "id": "final", "type": "agentMessage", "phase": "final_answer", "text": "三个子 agent 都已返回。"
    }})));
    events
}

fn child_notification(index: usize, method: &str, mut params: Value) -> Value {
    params["threadId"] = json!(format!("child-{index}"));
    json!({"method": method, "params": params})
}

fn wait_notification(method: &str, indices: &[usize]) -> Value {
    let ids: Vec<_> = indices
        .iter()
        .map(|index| format!("child-{index}"))
        .collect();
    let states: serde_json::Map<_, _> = ids
        .iter()
        .filter(|_| method == "item/completed")
        .map(|id| (id.clone(), json!({"status": "completed"})))
        .collect();
    notification(
        method,
        json!({"item": {
            "id": format!("wait-{}", indices[0]), "type": "collabAgentToolCall", "tool": "wait",
            "status": if method == "item/completed" { "completed" } else { "inProgress" },
            "receiverThreadIds": ids, "agentsStates": states
        }}),
    )
}
