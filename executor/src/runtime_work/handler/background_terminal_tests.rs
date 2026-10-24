// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn background_terminal_prevents_idle_restart_until_native_exit() {
    let (handler, root) = isolated_runtime_work_handler("background-terminal-idle-restart");
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.persist_completed_codex_turn_from_notification("task-1", &json!({
        "method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [{"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "inProgress", "processId": "42"}]
        }}
    }));
    let result = handler
        .restart_codex_app_server_with_expected_models(json!({"ifIdle": true}), Vec::new())
        .await
        .unwrap();
    assert_eq!(result["restarted"], false);
    assert_eq!(result["activeTaskCount"], 0);
    assert_eq!(result["backgroundTerminalCount"], 1);
    handler.record_background_terminal_notification("task-1", &json!({
        "method": "item/completed", "params": {"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "completed", "exitCode": 0}}
    }));
    assert_eq!(handler.background_terminal_count(), 0);
    let result = handler
        .restart_codex_app_server_with_expected_models(json!({"ifIdle": true}), Vec::new())
        .await
        .unwrap();
    assert_eq!(result["restarted"], true);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn background_terminal_output_survives_execution_settlement_gap() {
    verify_background_terminal_settlement(true);
}

#[test]
fn background_terminal_output_survives_before_completion_mapper_drains() {
    verify_background_terminal_settlement(false);
}

#[test]
fn background_terminal_item_snapshot_preserves_output_received_after_initial_yield() {
    let (handler, root) = isolated_runtime_work_handler("background-terminal-item-snapshot");
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    let command = json!({
        "id": "command-1", "type": "commandExecution", "command": "pnpm dev",
        "status": "inProgress", "processId": "42", "aggregatedOutput": "ready\n",
    });
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/started", "params": {"item": command}
        }),
    );
    handler.record_background_terminal_notification(
        "task-1",
        &json!({
            "method": "item/commandExecution/outputDelta",
            "params": {"itemId": "command-1", "delta": "tick-5\n"}
        }),
    );
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/completed", "params": {"item": command}
        }),
    );
    handler.persist_completed_codex_turn_from_notification(
        "task-1",
        &json!({
            "method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
                "id": "turn-1", "status": "completed", "items": [command]
            }}
        }),
    );
    handler.record_background_terminal_notification(
        "task-1",
        &json!({
            "method": "item/commandExecution/outputDelta",
            "params": {"itemId": "command-1", "delta": "tick-6\n"}
        }),
    );

    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(
        messages[0]["blocks"][0]["tool_output"],
        "ready\ntick-5\ntick-6\n"
    );
    let _ = fs::remove_dir_all(root);
}

fn verify_background_terminal_settlement(persist_before_finish: bool) {
    let (mut handler, root) = isolated_runtime_work_handler(if persist_before_finish {
        "background-terminal-settlement"
    } else {
        "background-terminal-before-persistence"
    });
    let (event_tx, mut event_rx) = broadcast::channel(8);
    handler.event_tx = Some(event_tx);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, "task-1");
    handler.register_thread_event_route(
        "thread-1",
        "task-1".into(),
        ExecutionRequest {
            task_id: "task-1".into(),
            subtask_id: "command-turn-1".into(),
            ..ExecutionRequest::default()
        },
        true,
    );
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".into(),
        "command-turn-1".into(),
    );
    handler.begin_active_codex_transcript("task-1", "thread-1", "command-turn-1");
    handler.record_active_codex_transcript_item("task-1", "command-turn-1", &json!({
        "method": "item/started", "params": {"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "inProgress", "processId": "42", "aggregatedOutput": "ready\n"}}
    }));
    let completion = json!({
        "method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
            "id": "command-turn-1", "status": "completed", "items": [{"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "inProgress", "processId": "42", "aggregatedOutput": "ready\n"}]
        }}
    });
    if persist_before_finish {
        handler.persist_completed_codex_turn_from_notification("task-1", &completion);
    }
    handler.clear_active_codex_turn("task-1", execution_id);
    assert!(handler.is_active_local_task("task-1"));
    handler.route_codex_notification(json!({
        "method": "item/commandExecution/outputDelta",
        "params": {"threadId": "thread-1", "turnId": "command-turn-1", "itemId": "command-1", "delta": "tick\n"}
    }));
    let event = event_rx
        .try_recv()
        .expect("background output must not be dropped while the finished execution settles");
    assert_eq!(event["payload"]["subtaskId"], "command-turn-1");
    assert_eq!(
        event["payload"]["data"]["updates"]["tool_output_delta"],
        "tick\n"
    );
    if !persist_before_finish {
        handler.persist_completed_codex_turn_from_notification("task-1", &completion);
    }
    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(messages[0]["blocks"][0]["tool_output"], "ready\ntick\n");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn background_terminal_started_turn_does_not_route_before_execution_mapper_is_ready() {
    let (mut handler, root) = isolated_runtime_work_handler("background-terminal-startup");
    let (event_tx, mut event_rx) = broadcast::channel(8);
    handler.event_tx = Some(event_tx);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");
    handler.register_thread_event_route(
        "thread-1",
        "task-1".into(),
        ExecutionRequest::default(),
        true,
    );
    handler.route_codex_notification(json!({
        "method": "item/commandExecution/outputDelta",
        "params": {"threadId": "thread-1", "turnId": "new-turn-1", "itemId": "command-1", "delta": "tick\n"}
    }));
    assert!(
        event_rx.try_recv().is_err(),
        "a new turn must remain owned by its execution mapper"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn background_terminal_old_turn_output_is_recorded_once_during_a_new_turn() {
    let (mut handler, root) = isolated_runtime_work_handler("background-terminal-new-turn");
    let (event_tx, mut event_rx) = broadcast::channel(8);
    handler.event_tx = Some(event_tx);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.persist_completed_codex_turn_from_notification("task-1", &json!({
        "method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
            "id": "old-turn-1", "status": "completed", "items": [{"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "inProgress", "aggregatedOutput": "ready\n"}]
        }}
    }));
    let execution_id = start_test_execution(&handler, "task-1");
    let request = ExecutionRequest {
        task_id: "task-1".into(),
        subtask_id: "new-turn-1".into(),
        ..ExecutionRequest::default()
    };
    handler.register_thread_event_route("thread-1", "task-1".into(), request.clone(), true);
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".into(),
        "new-turn-1".into(),
    );
    let message = CodexNotification::from(
        json!({"method": "item/commandExecution/outputDelta", "params": {
            "threadId": "thread-1", "turnId": "old-turn-1", "itemId": "command-1", "delta": "tick\n"
        }}),
    );
    handler.route_codex_notification(message.clone());
    handler
        .map_execution_codex_notification(
            "task-1",
            execution_id,
            &request,
            handler.active_codex_turn("task-1"),
            &mut CodexNotificationEventMapper::default(),
            message,
        )
        .await;
    assert_eq!(
        event_rx.try_recv().unwrap()["payload"]["subtaskId"],
        "old-turn-1"
    );
    assert!(event_rx.try_recv().is_err());
    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(messages[0]["blocks"][0]["tool_output"], "ready\ntick\n");
    assert_eq!(
        messages[0]["runtimeItems"][0]["block"]["tool_output"],
        "ready\ntick\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn background_terminal_notifications_keep_the_command_turn_after_compaction_route() {
    let (mut handler, root) = isolated_runtime_work_handler("background-terminal-route");
    let (event_tx, mut event_rx) = broadcast::channel(8);
    handler.event_tx = Some(event_tx);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.register_thread_event_route(
        "thread-1",
        "task-1".into(),
        ExecutionRequest {
            task_id: "task-1".into(),
            subtask_id: "task-1-context-compact".into(),
            ..ExecutionRequest::default()
        },
        false,
    );
    for (method, params) in [
        (
            "item/commandExecution/outputDelta",
            json!({"itemId": "command-1", "delta": "tick\n"}),
        ),
        (
            "item/commandExecution/terminalInteraction",
            json!({"itemId": "command-1", "processId": "42", "stdin": ""}),
        ),
        (
            "item/completed",
            json!({"item": {"id": "command-1", "type": "commandExecution", "status": "completed", "exitCode": 0, "command": "pnpm dev"}}),
        ),
    ] {
        let mut params = params;
        params["threadId"] = json!("thread-1");
        params["turnId"] = json!("command-turn-1");
        handler.route_codex_notification(json!({"method": method, "params": params}));
        let event = event_rx.try_recv().expect("command update must be emitted");
        assert_eq!(event["event"], "response.block.updated");
        assert_eq!(event["payload"]["subtaskId"], "command-turn-1");
        assert_eq!(event["payload"]["data"]["block_id"], "command-1");
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn background_terminal_completion_preserves_streamed_command_items() {
    let (handler, root) = isolated_runtime_work_handler("background-terminal-completion");
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item("task-1", "turn-1", &json!({
        "method": "item/started",
        "params": {"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "cwd": "/project", "status": "inProgress", "processId": "42"}}
    }));
    handler.record_background_terminal_notification("task-1", &json!({
        "method": "item/commandExecution/outputDelta", "params": {"itemId": "command-1", "delta": "ready\n"}
    }));
    handler.persist_completed_codex_turn_from_notification("task-1", &json!({
        "method": "turn/completed",
        "params": {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed", "items": [{"id": "final-1", "type": "agentMessage", "phase": "final_answer", "text": "Started"}]}}
    }));
    let link = handler.local_task_link("task-1").unwrap();
    let messages = completed_transcript_messages(&link);
    let command = messages
        .iter()
        .flat_map(|message| message["blocks"].as_array().into_iter().flatten())
        .find(|block| block["id"] == "command-1")
        .expect("streamed command must survive compact completion");
    assert_eq!(command["render_payload"]["status"], "inProgress");
    assert_eq!(command["render_payload"]["processId"], "42");
    assert_eq!(command["tool_output"], "ready\n");
    assert!(messages.iter().all(|message| message["status"] == "done"));
    handler.record_background_terminal_notification("task-1", &json!({
        "method": "item/commandExecution/outputDelta", "params": {"itemId": "command-1", "delta": "tick\n"}
    }));
    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(messages[0]["blocks"][0]["tool_output"], "ready\ntick\n");
    handler.record_background_terminal_notification("task-1", &json!({
        "method": "item/completed", "params": {"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "completed", "processId": "42", "exitCode": 0, "aggregatedOutput": "ready\ntick\nfinished\n"}}
    }));
    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(messages[0]["blocks"][0]["status"], "done");
    assert_eq!(messages[0]["blocks"][0]["render_payload"]["exitCode"], 0);
    handler.record_background_terminal_notification("task-1", &json!({
        "method": "item/completed", "params": {"item": {"id": "command-1", "type": "commandExecution", "command": "pnpm dev", "status": "completed", "processId": "42", "exitCode": 0, "aggregatedOutput": null}}
    }));
    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(
        messages[0]["blocks"][0]["tool_output"],
        "ready\ntick\nfinished\n"
    );
    assert_eq!(
        messages[0]["runtimeItems"][0]["block"]["tool_output"],
        "ready\ntick\nfinished\n"
    );
    let _ = fs::remove_dir_all(root);
}
