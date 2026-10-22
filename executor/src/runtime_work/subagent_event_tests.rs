// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn shared_thread_child_events_keep_the_announced_subagent_identity() {
    let (tx, mut rx) = broadcast::channel(32);
    let request = ExecutionRequest::default();
    let mut mapper = CodexNotificationEventMapper::default();
    mapper.observe_root_thread_id("thread-root");
    let events = [
        json!({"method": "item/started", "params": {
            "threadId": "thread-root", "turnId": "turn-root", "item": {
                "id": "activity", "type": "subAgentActivity", "kind": "started",
                "agentPath": "/root/worker", "agentThreadId": "child-agent"
            }
        }}),
        json!({"method": "item/started", "params": {
            "threadId": "thread-root", "turnId": "turn-root", "agentPath": "/root/worker",
            "item": {"id": "child-tool", "type": "commandExecution", "command": "echo child"}
        }}),
        json!({"method": "item/agentMessage/delta", "params": {
            "threadId": "thread-root", "turnId": "turn-root", "agentPath": "/root/worker",
            "itemId": "child-text", "delta": "child output"
        }}),
        json!({"method": "turn/completed", "params": {
            "threadId": "thread-root", "agentPath": "/root/worker",
            "turn": {"id": "turn-root", "status": "completed"}
        }}),
    ];
    for event in events {
        mapper.map(&Some(tx.clone()), "device", "task", &request, event);
    }
    let mut emitted = Vec::new();
    while let Ok(event) = rx.try_recv() {
        emitted.push(event);
    }
    let block = &emitted[1]["payload"]["data"]["block"];
    assert_eq!(block["id"], "subagent-child-agent");
    for event in &emitted[2..4] {
        assert_eq!(event["event"], "response.block.created");
        assert_eq!(
            event["payload"]["data"]["block"]["parent_tool_use_id"],
            block["id"]
        );
    }
    assert_eq!(
        emitted[3]["payload"]["data"]["block"]["content"],
        "child output"
    );
    let completion = emitted.last().unwrap();
    assert_eq!(completion["event"], "response.block.updated");
    assert_eq!(completion["payload"]["data"]["block_id"], block["id"]);
    assert_eq!(completion["payload"]["data"]["updates"]["status"], "done");
}
