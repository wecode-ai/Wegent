// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn background_terminal_events_preserve_process_identity_and_input() {
    let (tx, mut rx) = broadcast::channel(16);
    let request = ExecutionRequest {
        task_id: "task-1".into(),
        subtask_id: "turn-1".into(),
        ..Default::default()
    };
    let mut mapper = CodexNotificationEventMapper::default();
    mapper.observe_root_thread_id("thread-1");
    for (method, mut params) in [
        (
            "item/started",
            json!({"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "cwd": "/project", "processId": "42", "status": "inProgress"}}),
        ),
        (
            "item/commandExecution/terminalInteraction",
            json!({"itemId": "command-1", "processId": "42", "stdin": "hello\n"}),
        ),
        (
            "item/completed",
            json!({"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "processId": "42", "status": "failed", "exitCode": 1}}),
        ),
    ] {
        params["threadId"] = json!("thread-1");
        params["turnId"] = json!("turn-1");
        mapper.map(
            &Some(tx.clone()),
            "device-1",
            "task-1",
            &request,
            json!({"method": method, "params": params}),
        );
    }
    let started = rx.try_recv().unwrap();
    assert_eq!(
        started["payload"]["data"]["block"]["render_payload"]["processId"],
        "42"
    );
    assert_eq!(
        started["payload"]["data"]["block"]["render_payload"]["status"],
        "inProgress"
    );
    let input = rx.try_recv().unwrap();
    assert_eq!(input["event"], "response.block.updated");
    assert_eq!(input["payload"]["data"]["block_id"], "command-1");
    assert_eq!(
        input["payload"]["data"]["updates"]["render_payload"]["stdin"],
        "hello\n"
    );
    let completed = rx.try_recv().unwrap();
    assert!(completed["payload"]["data"]["block"]
        .get("parent_tool_use_id")
        .is_none());
    assert_eq!(completed["payload"]["data"]["updates"]["status"], "error");
    assert_eq!(
        completed["payload"]["data"]["updates"]["render_payload"]["exitCode"],
        1
    );
}
