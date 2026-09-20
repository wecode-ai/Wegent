// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn codex_raw_reasoning_streams_before_completion_for_root_and_child() {
    let _lock = env_lock().await;
    for thread_id in ["thread-1", "child"] {
        let fixture = Fixture::with_notifications(&raw_reasoning_notifications(thread_id));
        let request = fixture.request("first");
        let (sink, mut receiver) = event_channel();
        let mut run = fixture
            .engine()
            .run_with_events(request.clone(), sink, builder(&request));
        let events = tokio::time::timeout(TIMEOUT, async {
            let mut events = Vec::new();
            loop {
                let event = tokio::select! {
                    outcome = &mut run => panic!("reasoning must stream before completion: {outcome:?}"),
                    event = receiver.recv() => event.expect("stream must remain open"),
                };
                let complete = event.data["updates"]["status"] == "done"
                    && event.data["updates"]["content"] == "先分析🙂，再处理";
                events.push(event);
                if complete { break events; }
            }
        }).await.expect("raw reasoning must stream while the turn is still running");

        let thinking: Vec<_> = events
            .iter()
            .filter(|event| event.data["block"]["type"] == "thinking")
            .collect();
        assert_eq!(
            thinking.len(),
            1,
            "completion must update the existing block"
        );
        let block = &thinking[0].data["block"];
        assert_eq!(block["content"], "先");
        assert_eq!(block["status"], "streaming");
        if thread_id == "child" {
            assert_eq!(block["parent_tool_use_id"], "subagent-child");
        } else {
            assert!(block.get("parent_tool_use_id").is_none());
        }
        let snapshots: Vec<_> = events
            .iter()
            .filter(|event| event.data["block_id"] == block["id"])
            .map(|event| {
                assert!(event.data["updates"].get("content_delta").is_none());
                event.data["updates"]["content"].as_str().unwrap()
            })
            .collect();
        // Callback compaction may combine adjacent snapshots without losing text.
        assert_eq!(snapshots.last().copied(), Some("先分析🙂，再处理"));
        assert!(snapshots
            .iter()
            .all(|text| "先分析🙂，再处理".starts_with(text)));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "response.output_text.delta"));
        fs::write(fixture.root.path().join("release"), "complete").unwrap();
        assert_completed(tokio::time::timeout(TIMEOUT, run).await.unwrap());
    }
}

fn raw_reasoning_notifications(thread_id: &str) -> Vec<Value> {
    let mut events = Vec::new();
    if thread_id == "child" {
        events.push(notification(
            "item/completed",
            json!({"item": {
                "id": "spawn", "type": "collabAgentToolCall", "tool": "spawnAgent",
                "prompt": "检查执行路径", "status": "completed",
                "receiverThreadIds": ["child"],
                "agentsStates": {"child": {"status": "running", "message": null}}
            }}),
        ));
    }
    for delta in ["先", "分析🙂"] {
        events.push(json!({"method": "item/reasoning/textDelta", "params": {
            "threadId": thread_id, "turnId": "turn-1", "itemId": "reasoning",
            "contentIndex": 0, "delta": delta
        }}));
    }
    events.push(json!({"method": "item/completed", "params": {
        "threadId": thread_id, "turnId": "turn-1", "item": {
            "id": "reasoning", "type": "reasoning",
            "summary": [], "content": ["先分析🙂，再处理"]
        }
    }}));
    events.push(notification(
        "item/agentMessage/delta",
        json!({
            "itemId": "final", "phase": "finalAnswer", "delta": "done"
        }),
    ));
    events
}

#[tokio::test]
async fn codex_empty_raw_reasoning_does_not_create_a_thinking_block() {
    let _lock = env_lock().await;
    let notifications = [
        notification(
            "item/reasoning/textDelta",
            json!({
                "itemId": "reasoning", "contentIndex": 0, "delta": ""
            }),
        ),
        notification(
            "item/completed",
            json!({"item": {
                "id": "reasoning", "type": "reasoning", "summary": [], "content": [],
                "encrypted_content": "opaque-test-value"
            }}),
        ),
        notification(
            "item/agentMessage/delta",
            json!({
                "itemId": "final", "phase": "finalAnswer", "delta": "done"
            }),
        ),
    ];
    let (outcome, events) = execute_notifications(&notifications).await;
    assert_completed(outcome);
    assert!(!events
        .iter()
        .any(|event| event.data["block"]["type"] == "thinking"));
}

#[tokio::test]
async fn codex_forwards_web_model_reasoning_to_thread_and_turn() {
    let _lock = env_lock().await;
    for (web_reasoning, runtime_reasoning, effort, summary) in [
        (json!({"summary": "detailed"}), None, "medium", "detailed"),
        (
            json!({"summary": "detailed"}),
            Some(json!({"reasoning": {"summary": "detailed"}})),
            "medium",
            "detailed",
        ),
        (
            json!({"effort": "high", "summary": "detailed"}),
            Some(json!({"reasoning": {"effort": "high", "summary": "detailed"}})),
            "high",
            "detailed",
        ),
        (
            json!({"effort": "high", "summary": "detailed"}),
            None,
            "high",
            "detailed",
        ),
        (
            json!({"effort": "high", "summary": "detailed"}),
            Some(json!({"effort": "low", "summary": "concise"})),
            "low",
            "concise",
        ),
    ] {
        let fixture = Fixture::new("stream");
        let mut request = fixture.request("first");
        request.model_config["think_config"] = json!({"reasoning": web_reasoning});
        if let Some(reasoning) = runtime_reasoning {
            request.model_config["reasoning"] = reasoning;
        }
        fs::write(fixture.root.path().join("release"), "complete").unwrap();
        let (outcome, _) = execute(&fixture.engine(), request).await;
        assert_completed(outcome);
        let messages = fixture.messages();
        let thread = messages
            .iter()
            .find(|message| message["method"] == "thread/start")
            .unwrap();
        let turn = messages
            .iter()
            .find(|message| message["method"] == "turn/start")
            .unwrap();
        assert_eq!(
            thread["params"]["config"]["model_reasoning_summary"],
            summary
        );
        assert_eq!(thread["params"]["config"]["model_reasoning_effort"], effort);
        assert_eq!(turn["params"]["summary"], summary);
        assert_eq!(turn["params"]["effort"], effort);
    }
}
