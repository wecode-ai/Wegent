// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn global_notification_route_preserves_current_async_questions() {
    for (status, turn_id, expected) in [
        ("done", "turn-1", true),
        ("failed", "turn-1", false),
        ("cancelled", "turn-1", false),
        ("done", "previous-turn", false),
    ] {
        let label = format!("global-async-question-{status}-{turn_id}");
        let (mut handler, root) = isolated_runtime_work_handler(&label);
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        link.status = status.into();
        link.runtime_handle = json!({"lastTurnId": "turn-1"});
        handler.upsert_local_task(link);
        handler.register_thread_event_route(
            "thread-1",
            "task-1".into(),
            ExecutionRequest {
                task_id: "task-1".into(),
                subtask_id: "turn-1".into(),
                ..ExecutionRequest::default()
            },
            false,
        );
        let params = json!({
            "threadId": "thread-1", "turnId": turn_id,
            "item": {"id": "question-1", "type": "agentMessage",
                "questions": [{"title": "Continue?", "options": ["Yes", "No"]}]}
        });
        handler.route_codex_notification(json!({"method": "item/started", "params": params}));
        let link = handler.local_task_link("task-1").unwrap();
        assert!(link.interaction_status.is_none());
        handler.route_codex_notification(json!({"method": "item/completed", "params": params}));
        handler.store = RuntimeWorkStore::new(root.join("runtime-work/index.json"));
        let link = handler.local_task_link("task-1").unwrap();
        assert_eq!(
            link.interaction_status.as_deref(),
            expected.then_some(INTERACTION_AWAITING_USER_REPLY),
            "status={status}, turn={turn_id}"
        );
        let _ = fs::remove_dir_all(root);
    }
}

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
    verify_background_terminal_settlement(true, false);
}

#[test]
fn background_terminal_output_survives_before_completion_mapper_drains() {
    verify_background_terminal_settlement(false, false);
}

#[test]
fn background_terminal_output_survives_before_execution_observes_native_completion() {
    verify_background_terminal_settlement(true, true);
    verify_background_terminal_settlement(false, true);
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

fn verify_background_terminal_settlement(persist_before_finish: bool, retain_active_turn: bool) {
    let (mut handler, root) =
        isolated_runtime_work_handler(match (persist_before_finish, retain_active_turn) {
            (true, false) => "background-terminal-settlement",
            (false, false) => "background-terminal-before-persistence",
            (true, true) => "background-terminal-native-completion-persisted",
            (false, true) => "background-terminal-native-completion-pending",
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
    if retain_active_turn {
        handler.route_codex_notification(completion.clone());
        assert!(handler.active_codex_turn("task-1").is_some());
        assert!(event_rx.try_recv().is_err());
    } else {
        handler.clear_active_codex_turn("task-1", execution_id);
    }
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
    assert!(
        event_rx.try_recv().is_err(),
        "output must be emitted only once"
    );
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
async fn background_terminal_output_is_owned_once_while_waiting_for_goal_continuation() {
    verify_background_terminal_goal_handoff(true).await;
}

#[tokio::test]
async fn background_terminal_output_survives_router_missing_completion() {
    verify_background_terminal_goal_handoff(false).await;
}

async fn verify_background_terminal_goal_handoff(router_observed_completion: bool) {
    let (mut handler, root) = isolated_runtime_work_handler(if router_observed_completion {
        "background-terminal-goal-handoff"
    } else {
        "background-terminal-router-missed-completion"
    });
    let (event_tx, mut event_rx) = broadcast::channel(32);
    handler.event_tx = Some(event_tx);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, "task-1");
    let request = ExecutionRequest {
        task_id: "task-1".into(),
        subtask_id: "turn-1".into(),
        ..ExecutionRequest::default()
    };
    handler.register_thread_event_route("thread-1", "task-1".into(), request.clone(), true);
    handler.record_active_codex_turn("task-1", execution_id, "thread-1".into(), "turn-1".into());
    let completion = json!({"method": "turn/completed", "params": {
        "threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed", "items": [{
            "id": "command-1", "type": "commandExecution", "command": "pnpm dev",
            "status": "inProgress", "aggregatedOutput": "ready\n"
        }]}
    }});
    let mut mapper = CodexNotificationEventMapper::default();
    let hook_turn = handler.active_codex_turn("task-1");
    if router_observed_completion {
        handler.route_codex_notification(completion.clone());
    }
    // A lagged router can miss completion and receive output while the native
    // receiver is preempted before its active-turn callback runs.
    handler
        .map_execution_codex_notification(
            "task-1",
            execution_id,
            &request,
            hook_turn.clone(),
            &mut mapper,
            completion,
        )
        .await;
    while event_rx.try_recv().is_ok() {}
    for sequence in [2, 3] {
        let output = CodexNotification::from(
            json!({"method": "item/commandExecution/outputDelta", "params": {
                "threadId": "thread-1", "turnId": "turn-1", "itemId": "command-1", "delta": "tick\n"
            }}),
        );
        if sequence == 2 {
            handler.route_codex_notification(output.clone());
            if router_observed_completion {
                // A stale execution can retire its route while its replacement is active.
                handler.mark_thread_event_route_idle("thread-1");
            }
        }
        handler
            .map_execution_codex_notification(
                "task-1",
                execution_id,
                &request,
                hook_turn.clone(),
                &mut mapper,
                output.clone(),
            )
            .await;
        if sequence == 3 {
            assert!(handler.finish_local_task(
                "task-1",
                execution_id,
                Some("thread-1".into()),
                "done"
            ));
            handler.mark_thread_event_route_idle("thread-1");
            handler.route_codex_notification(output);
        }
        assert_eq!(
            event_rx.try_recv().unwrap()["payload"]["data"]["updates"]["tool_output_delta"],
            "tick\n"
        );
        assert!(event_rx.try_recv().is_err());
    }
    let messages = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(
        messages[0]["blocks"][0]["tool_output"],
        "ready\ntick\ntick\n"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_terminal_concurrent_receivers_preserve_native_output_order() {
    let (mut handler, root) =
        isolated_runtime_work_handler("background-terminal-concurrent-delivery");
    let (event_tx, mut event_rx) = broadcast::channel(256);
    handler.event_tx = Some(event_tx);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, "task-1");
    let request = ExecutionRequest {
        task_id: "task-1".into(),
        subtask_id: "turn-1".into(),
        ..ExecutionRequest::default()
    };
    handler.register_thread_event_route("thread-1", "task-1".into(), request.clone(), true);
    handler.record_active_codex_turn("task-1", execution_id, "thread-1".into(), "turn-1".into());
    let completion = json!({"method": "turn/completed", "params": {
        "threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed", "items": [{
            "id": "command-1", "type": "commandExecution", "command": "pnpm dev",
            "status": "inProgress", "aggregatedOutput": "ready\n"
        }]}
    }});
    handler.persist_completed_codex_turn_from_notification("task-1", &completion);
    handler.route_codex_notification(completion);
    let messages = (1..=100).map(|sequence| CodexNotification::from(json!({
        "method": "item/commandExecution/outputDelta",
        "params": {"threadId":"thread-1", "turnId":"turn-1", "itemId":"command-1", "delta":format!("tick-{sequence}\n")}
    }))).collect::<Vec<_>>();
    let global_handler = handler.clone();
    let global_messages = messages.clone();
    let global = tokio::task::spawn_blocking(move || {
        for message in global_messages {
            global_handler.route_codex_notification(message);
            std::thread::yield_now();
        }
    });
    let execution_handler = handler.clone();
    let execution = tokio::spawn(async move {
        let mut mapper = CodexNotificationEventMapper::default();
        for message in messages {
            execution_handler
                .map_execution_codex_notification(
                    "task-1",
                    execution_id,
                    &request,
                    execution_handler.active_codex_turn("task-1"),
                    &mut mapper,
                    message,
                )
                .await;
            tokio::task::yield_now().await;
        }
    });
    global.await.unwrap();
    execution.await.unwrap();
    let mut output = String::new();
    let mut count = 0;
    while let Ok(event) = event_rx.try_recv() {
        output.push_str(
            event["payload"]["data"]["updates"]["tool_output_delta"]
                .as_str()
                .unwrap(),
        );
        count += 1;
    }
    let expected = (1..=100)
        .map(|index| format!("tick-{index}\n"))
        .collect::<String>();
    assert_eq!(count, 100);
    assert_eq!(output, expected);
    let persisted = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert_eq!(
        persisted[0]["blocks"][0]["tool_output"],
        format!("ready\n{expected}")
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
