// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::tasks::{mark_runtime_model_switch, runtime_model_selection_changed};
use super::*;

#[test]
fn defaults_to_ten_parallel_runtime_tasks() {
    assert_eq!(
        RuntimeSettings::default().max_concurrent_tasks,
        DEFAULT_MAX_CONCURRENT_TASKS
    );
    assert_eq!(DEFAULT_MAX_CONCURRENT_TASKS, 10);
}

#[test]
fn deferred_worktree_preparation_can_be_cancelled_before_runtime_start() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let mut turn = SpawnTurnRequest {
        local_task_id: "task-1".to_owned(),
        runtime: "codex".to_owned(),
        request: ExecutionRequest::default(),
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_name: None,
        initial_thread_goal: None,
    };
    turn.request.extra.insert(
        "deferred_worktree_source_path".to_owned(),
        Value::String("/tmp/source".to_owned()),
    );

    handler.reserve_worktree_preparation(&turn);

    assert!(handler.cancel_preparing_worktree_turn("task-1"));
    assert_eq!(
        handler
            .preparing_worktree_turns
            .lock()
            .expect("preparing worktree turn map lock should not be poisoned")
            .get("task-1"),
        Some(&PreparingWorktreeTurn {
            cancellation_requested: true
        })
    );
}

fn start_test_execution(handler: &RuntimeWorkRpcHandler, local_task_id: &str) -> u64 {
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    handler.start_local_task_execution(local_task_id.to_owned(), cancel, stopped)
}

#[test]
fn applies_backend_connection_from_the_shared_snapshot() {
    let snapshot: Arc<Mutex<Option<ConnectionConfig>>> =
        Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: "https://backend.example.com".to_owned(),
            socket_url: "wss://socket.example.com".to_owned(),
            auth_token: "wg-token".to_owned(),
            runtime_auth_token: "runtime-wg-token".to_owned(),
        })));
    let handler =
        RuntimeWorkRpcHandler::new("device-1", "/bin/false").with_backend_connection(snapshot);

    let mut request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.apply_backend_connection(&mut request);

    assert_eq!(
        request.backend_url.as_deref(),
        Some("https://backend.example.com")
    );
    assert_eq!(request.auth_token.as_deref(), Some("wg-token"));
    assert_eq!(
        request.runtime_auth_token.as_deref(),
        Some("runtime-wg-token")
    );
}

#[test]
fn keeps_payload_backend_credentials_over_the_snapshot() {
    let snapshot: Arc<Mutex<Option<ConnectionConfig>>> =
        Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: "https://backend.example.com".to_owned(),
            socket_url: String::new(),
            auth_token: "wg-token".to_owned(),
            runtime_auth_token: String::new(),
        })));
    let handler =
        RuntimeWorkRpcHandler::new("device-1", "/bin/false").with_backend_connection(snapshot);

    let mut request = ExecutionRequest {
        backend_url: Some("https://payload.example.com".to_owned()),
        auth_token: Some("payload-token".to_owned()),
        ..ExecutionRequest::default()
    };
    handler.apply_backend_connection(&mut request);

    assert_eq!(
        request.backend_url.as_deref(),
        Some("https://payload.example.com")
    );
    assert_eq!(request.auth_token.as_deref(), Some("payload-token"));
}

#[test]
fn skips_backend_connection_without_a_configured_connection() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let mut request = ExecutionRequest::default();
    handler.apply_backend_connection(&mut request);

    assert!(request.backend_url.is_none());
    assert!(request.auth_token.is_none());
    assert!(request.runtime_auth_token.is_none());
}

#[test]
fn codex_cached_transcripts_never_expose_offset_pagination() {
    let pagination = transcript_pagination(
        "codex",
        Some(25),
        Some("offset:25".to_owned()),
        Some("offset:50".to_owned()),
    );

    assert!(matches!(
        pagination,
        TranscriptPagination::Opaque {
            before_cursor: None,
            after_cursor: None
        }
    ));
}

#[test]
fn active_codex_items_replace_stale_paginated_items() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "turn-1");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/started",
            "params": {
                "turnId": "turn-1",
                "startedAtMs": 1_780_000_001_250_i64,
                "item": {
                    "id": "change-1",
                    "type": "fileChange",
                    "status": "inProgress",
                    "changes": []
                }
            }
        }),
    );
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-1",
                "completedAtMs": 1_780_000_004_750_i64,
                "item": {
                    "id": "change-1",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{"path": "/tmp/result.txt", "diff": "created\n"}]
                }
            }
        }),
    );
    let mut thread = json!({
        "turns": [{
            "id": "turn-1",
            "itemsView": "full",
            "status": "inProgress",
            "items": [{
                "id": "change-1",
                "type": "fileChange",
                "status": "inProgress",
                "changes": []
            }]
        }]
    });

    handler.merge_active_codex_transcript("task-1", &mut thread);

    assert_eq!(thread["turns"][0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        thread["turns"][0]["items"][0]["status"],
        Value::String("completed".to_owned())
    );
    assert_eq!(
        thread["turns"][0]["items"][0]["changes"][0]["path"],
        Value::String("/tmp/result.txt".to_owned())
    );
    assert_eq!(
        thread["turns"][0]["items"][0]["createdAt"],
        1_780_000_001_250_i64
    );
    assert_eq!(
        thread["turns"][0]["items"][0]["completedAt"],
        1_780_000_004_750_i64
    );
    let messages = transcript_messages(&thread, "device-1");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["status"], "streaming");
    assert_eq!(messages[0]["blocks"][0]["type"], "file_changes");
}

#[test]
fn late_codex_items_do_not_recreate_cleared_active_transcript() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "turn-1");
    handler.clear_active_codex_transcript("task-1");

    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-1",
                "item": {
                    "id": "message-1",
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": "Late answer"
                }
            }
        }),
    );

    assert!(!handler
        .active_codex_transcript_items
        .lock()
        .unwrap()
        .contains_key("task-1"));
}

#[test]
fn active_codex_items_restore_a_turn_missing_from_paginated_storage() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "turn-live");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-live",
        &json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-live",
                "item": {
                    "id": "message-live",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "Still working"
                }
            }
        }),
    );
    let mut thread = json!({"turns": []});

    handler.merge_active_codex_transcript("task-1", &mut thread);

    assert_eq!(thread["turns"][0]["id"], "turn-live");
    assert_eq!(thread["turns"][0]["status"], "inProgress");
    assert_eq!(thread["turns"][0]["items"][0]["id"], "message-live");
}

#[tokio::test]
async fn fork_resolves_the_requested_turn_even_when_the_source_is_running() {
    for (case, persisted_running, active_in_memory) in
        [("persisted", true, false), ("active", false, true)]
    {
        let index_path = temp_runtime_work_index_path(&format!("fork-running-{case}"));
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        link.running = persisted_running;
        handler.upsert_local_task(link);
        if active_in_memory {
            start_test_execution(&handler, "task-1");
        }

        let response = handler
            .fork_task_at_turn(json!({
                "taskId": "task-1",
                "lastTurnId": "missing-turn",
            }))
            .await
            .expect("running task fork should continue to turn resolution");

        assert_eq!(response["accepted"], false, "{case}");
        assert_eq!(response["code"], "bad_request", "{case}");
        assert_eq!(response["error"], "fork turn was not found", "{case}");

        let _ = fs::remove_file(index_path);
    }
}

#[test]
fn finishing_an_active_goal_updates_metadata_without_persisting_execution_state() {
    let index_path = temp_runtime_work_index_path("finish-active-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.goal_status = Some("active".to_owned());
    handler.upsert_local_task(link);

    let execution_id = start_test_execution(&handler, "task-1");
    handler.finish_local_task("task-1", execution_id, Some("thread-1".to_owned()), "done");

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.status, "active");
    assert!(!task.running);
    assert_eq!(task.goal_status.as_deref(), Some("active"));
    assert_eq!(task.thread_id.as_deref(), Some("thread-1"));
    assert!(task.completed_at.is_some());

    let _ = fs::remove_file(index_path);
}

#[test]
fn turn_result_persists_observed_goal_status_before_settling_task() {
    let index_path = temp_runtime_work_index_path("finish-observed-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.goal_status = Some("active".to_owned());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, "task-1");

    handler.handle_turn_result(
        "task-1",
        execution_id,
        &ExecutionRequest::default(),
        Some(&ActiveCodexTurn {
            execution_id,
            thread_id: "thread-1".to_owned(),
            turn_id: "turn-1".to_owned(),
        }),
        Ok(crate::agents::CodexAppServerTurn {
            thread_id: "thread-1".to_owned(),
            outcome: ExecutionOutcome::Completed {
                content: "done".to_owned(),
            },
            response_item_id: Some("assistant-1".to_owned()),
            goal_status: Some("complete".to_owned()),
            goal_status_observed: true,
        }),
    );

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.status, "active");
    assert!(!task.running);
    assert_eq!(task.goal_status.as_deref(), Some("complete"));
    assert!(!handler.is_active_local_task("task-1"));

    let _ = fs::remove_file(index_path);
}

#[test]
fn stale_execution_cannot_finish_its_replacement() {
    let index_path = temp_runtime_work_index_path("stale-execution-finish");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));

    let stale_execution_id = start_test_execution(&handler, "task-1");
    let current_execution_id = start_test_execution(&handler, "task-1");

    handler.finish_local_task(
        "task-1",
        stale_execution_id,
        Some("stale-thread".to_owned()),
        "done",
    );

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert!(handler.is_active_local_task("task-1"));
    assert_eq!(task.status, "running");
    assert!(task.running);
    assert_eq!(task.thread_id, None);
    assert_eq!(task.completed_at, None);

    handler.finish_local_task(
        "task-1",
        current_execution_id,
        Some("current-thread".to_owned()),
        "done",
    );

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert!(!handler.is_active_local_task("task-1"));
    assert_eq!(task.status, "active");
    assert!(!task.running);
    assert_eq!(task.thread_id.as_deref(), Some("current-thread"));
    assert!(task.completed_at.is_some());

    let _ = fs::remove_file(index_path);
}

#[test]
fn claude_execution_persists_running_and_settled_state() {
    let index_path = temp_runtime_work_index_path("claude-execution-state");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending_with_runtime(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
        "claude_code",
    ));

    let execution_id = start_test_execution(&handler, "task-1");
    let running_task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(running_task.status, "running");
    assert!(running_task.running);
    assert_eq!(running_task.thread_status, "active");
    assert_eq!(running_task.turn_status.as_deref(), Some("inProgress"));

    handler.finish_local_task(
        "task-1",
        execution_id,
        Some("claude-session-1".to_owned()),
        "done",
    );

    let settled_task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(settled_task.status, "active");
    assert!(!settled_task.running);
    assert_eq!(settled_task.thread_status, "idle");
    assert_eq!(settled_task.turn_status.as_deref(), Some("completed"));
    assert_eq!(settled_task.thread_id.as_deref(), Some("claude-session-1"));
    assert!(settled_task.completed_at.is_some());

    let _ = fs::remove_file(index_path);
}

#[test]
fn provider_turn_registers_when_execution_control_settles_first() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let execution_id = start_test_execution(&handler, "task-1");

    assert!(handler.finish_local_task_execution("task-1", execution_id));
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".to_owned(),
        "turn-1".to_owned(),
    );

    assert!(handler.is_active_local_task("task-1"));

    handler.clear_active_codex_turn("task-1", execution_id);
    assert!(!handler.is_active_local_task("task-1"));
}

#[test]
fn stale_provider_turn_cannot_replace_the_current_execution() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let stale_execution_id = start_test_execution(&handler, "task-1");
    assert!(handler.finish_local_task_execution("task-1", stale_execution_id));
    let current_execution_id = start_test_execution(&handler, "task-1");

    handler.record_active_codex_turn(
        "task-1",
        stale_execution_id,
        "stale-thread".to_owned(),
        "stale-turn".to_owned(),
    );
    assert!(handler.active_codex_turn("task-1").is_none());

    handler.record_active_codex_turn(
        "task-1",
        current_execution_id,
        "current-thread".to_owned(),
        "current-turn".to_owned(),
    );
    let current_turn = handler
        .active_codex_turn("task-1")
        .expect("current execution should register its provider turn");
    assert_eq!(current_turn.execution_id, current_execution_id);
    assert_eq!(current_turn.thread_id, "current-thread");
    assert_eq!(current_turn.turn_id, "current-turn");
}

#[test]
fn unlinked_failed_codex_turn_persists_assistant_error_in_runtime_handle() {
    let index_path = temp_runtime_work_index_path("persist-failed-assistant");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    handler.upsert_local_task(link);
    let request = ExecutionRequest {
        subtask_id: "turn-1".to_owned(),
        ..ExecutionRequest::default()
    };

    handler.persist_failed_assistant_message("task-1", &request, "Codex failure");

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    let messages = cached_messages(&task);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(messages[0]["status"], "failed");
    assert_eq!(messages[0]["error"], "Codex failure");
    assert_eq!(messages[0]["errorType"], "response.failed");
    assert_eq!(messages[0]["subtaskId"], "turn-1");

    let _ = fs::remove_file(index_path);
}

#[test]
fn recording_provider_thread_removes_cached_messages_but_keeps_presentations() {
    let index_path = temp_runtime_work_index_path("provider-thread-clears-messages");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    set_runtime_handle_messages(
        &mut link.runtime_handle,
        vec![json!({"id": "cached-user", "role": "user", "content": "pending"})],
    );
    append_runtime_handle_user_message_presentation(
        &mut link.runtime_handle,
        json!({
            "clientUserMessageId": "runtime-local-pane-1",
            "references": [{
                "token": "$plugin:skill",
                "href": "/tmp/plugin/skill/SKILL.md"
            }]
        }),
    );
    handler.upsert_local_task(link);

    handler.record_local_task_thread("task-1", "thread-1");

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.thread_id.as_deref(), Some("thread-1"));
    assert!(cached_messages(&task).is_empty());
    assert!(task.runtime_handle.get("messages").is_none());
    assert_eq!(user_message_presentations(&task).len(), 1);

    let _ = fs::remove_file(index_path);
}

#[test]
fn linked_failed_codex_turn_does_not_create_cached_transcript() {
    let index_path = temp_runtime_work_index_path("linked-failure-provider-source");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    handler.upsert_local_task(link);

    handler.persist_failed_assistant_message(
        "task-1",
        &ExecutionRequest {
            subtask_id: "turn-1".to_owned(),
            ..ExecutionRequest::default()
        },
        "Codex failure",
    );

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert!(cached_messages(&task).is_empty());

    let _ = fs::remove_file(index_path);
}

#[test]
fn retry_supersedes_the_previous_transcript_turn() {
    let index_path = temp_runtime_work_index_path("retry-supersedes-transcript");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));

    handler.record_superseded_runtime_transcript_turn("task-1", "failed-turn");

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    let mut messages = vec![
        json!({
            "id": "failed-user",
            "role": "user",
            "turnId": "failed-turn",
            "content": "Retry me",
        }),
        json!({
            "id": "failed-assistant",
            "role": "assistant",
            "turnId": "failed-turn",
            "status": "failed",
            "content": "",
        }),
        json!({
            "id": "retry-user",
            "role": "user",
            "turnId": "retry-turn",
            "content": "Retry me",
        }),
        json!({
            "id": "retry-assistant",
            "role": "assistant",
            "turnId": "retry-turn",
            "status": "done",
            "content": "Completed",
        }),
    ];

    remove_superseded_transcript_turns(&mut messages, &task.runtime_handle);

    assert_eq!(messages.len(), 2);
    assert!(messages
        .iter()
        .all(|message| message["turnId"] == "retry-turn"));
    assert_eq!(
        task.runtime_handle["supersededTranscriptTurnIds"],
        json!(["failed-turn"])
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn syncing_an_active_goal_does_not_start_an_idle_task() {
    let index_path = temp_runtime_work_index_path("sync-active-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.status = "done".to_owned();
    link.running = false;
    handler.upsert_local_task(link);

    handler.sync_runtime_task_goal_status("task-1", Some("active".to_owned()));

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.status, "done");
    assert!(!task.running);
    assert_eq!(task.goal_status.as_deref(), Some("active"));

    let _ = fs::remove_file(index_path);
}

#[test]
fn hydrating_goal_status_does_not_update_task_activity_time() {
    let index_path = temp_runtime_work_index_path("hydrate-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.updated_at = 1_780_000_000_000;
    handler.upsert_local_task(link);

    handler.hydrate_runtime_task_goal_status("task-1", Some("active".to_owned()));

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.goal_status.as_deref(), Some("active"));
    assert_eq!(task.updated_at, 1_780_000_000_000);

    let _ = fs::remove_file(index_path);
}

#[test]
fn hydrating_unchanged_goal_status_does_not_update_task_activity_time() {
    let index_path = temp_runtime_work_index_path("hydrate-unchanged-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.goal_status = Some("active".to_owned());
    link.updated_at = 1_780_000_000_000;
    handler.upsert_local_task(link);

    handler.hydrate_runtime_task_goal_status("task-1", Some("active".to_owned()));

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.goal_status.as_deref(), Some("active"));
    assert_eq!(task.updated_at, 1_780_000_000_000);

    let _ = fs::remove_file(index_path);
}

#[test]
fn syncing_changed_goal_status_updates_task_activity_time() {
    let index_path = temp_runtime_work_index_path("sync-changed-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.goal_status = Some("pending".to_owned());
    link.updated_at = 1_780_000_000_000;
    handler.upsert_local_task(link);

    handler.sync_runtime_task_goal_status("task-1", Some("active".to_owned()));

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.goal_status.as_deref(), Some("active"));
    assert!(task.updated_at > 1_780_000_000_000);

    let _ = fs::remove_file(index_path);
}

#[test]
fn current_codex_model_provider_reads_configured_provider_name() {
    let provider = current_codex_model_provider_from_config(&json!({
        "config": {
            "model_provider": "wecode-openai",
            "model_providers": {
                "wecode-openai": {
                    "name": "wecode openai"
                },
                "wecode-ark": {
                    "name": "wecode ark"
                }
            }
        }
    }));

    assert_eq!(provider.id, "wecode-openai");
    assert_eq!(provider.display_name, "wecode openai");
    assert_eq!(provider.kind, "provider");
    assert!(provider.current);
}

#[test]
fn current_codex_model_provider_defaults_to_official() {
    let provider = current_codex_model_provider_from_config(&json!({"config": {}}));

    assert_eq!(provider.id, "openai");
    assert_eq!(provider.display_name, "CodeX");
    assert_eq!(provider.kind, "official");
    assert!(provider.current);
}

#[test]
fn current_codex_model_provider_hides_internal_catalog_provider() {
    let provider = current_codex_model_provider_from_config(&json!({
        "config": {
            "model_provider": "wework-catalog",
            "model_providers": {
                "wework-catalog": {"name": "Wework model catalog"}
            }
        }
    }));

    assert_eq!(provider.id, "openai");
    assert_eq!(provider.display_name, "CodeX");
    assert_eq!(provider.kind, "official");
}

#[test]
fn runtime_session_ids_only_accept_codex_uuid_thread_ids() {
    assert!(is_codex_thread_id("019f4c0d-b036-78f3-b879-7e5ed203ad61"));
    assert!(is_codex_thread_id(
        "urn:uuid:019f4c0d-b036-78f3-b879-7e5ed203ad61"
    ));
    assert!(!is_codex_thread_id("runtime-481327491"));
    assert!(!is_codex_thread_id("thread-1"));

    let mut link = RuntimeTaskLink::new_pending(
        "runtime-481327491".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some(link.local_task_id.clone());
    assert_eq!(
        runtime_session_id_from_link(&link).as_deref(),
        Some("runtime-481327491")
    );
    assert_eq!(codex_thread_id_from_link(&link), None);
}

#[test]
fn imported_runtime_task_ids_are_unique() {
    let first = fork_transfer::next_imported_task_id();
    let second = fork_transfer::next_imported_task_id();

    assert_ne!(first, second);
    assert!(first.starts_with("runtime-fork-"));
    assert!(second.starts_with("runtime-fork-"));
}

#[test]
fn runtime_turn_ids_are_persisted_by_subtask() {
    let index_path = temp_runtime_work_index_path("runtime-turn-id");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));

    let codex_turn_id = "019f933f-bf0d-72e3-b366-a6539ab00bcf";
    handler.record_runtime_turn_id("task-1", "subtask-1", codex_turn_id);

    let link = handler
        .local_task_link("task-1")
        .expect("task should exist");
    assert_eq!(
        link.runtime_handle["lastTurnId"].as_str(),
        Some(codex_turn_id)
    );
    assert_eq!(
        tasks::resolve_codex_turn_id(&link, "subtask-1").as_deref(),
        Some(codex_turn_id)
    );
    assert_eq!(
        tasks::resolve_codex_turn_id(&link, codex_turn_id).as_deref(),
        Some(codex_turn_id)
    );
    assert_eq!(
        tasks::resolve_codex_turn_id(&link, &format!("{codex_turn_id}-1")).as_deref(),
        Some(codex_turn_id)
    );
    assert_eq!(tasks::resolve_codex_turn_id(&link, "turn-1-1"), None);
    assert_eq!(tasks::resolve_codex_turn_id(&link, "missing-turn"), None);
    let _ = fs::remove_file(index_path);
}

#[test]
fn completed_responses_use_the_active_codex_turn_id() {
    for (case, outcome, response_item_id) in [
        (
            "completed",
            ExecutionOutcome::Completed {
                content: "Done".to_owned(),
            },
            Some("assistant-item-1".to_owned()),
        ),
        (
            "waiting",
            ExecutionOutcome::WaitingForUserInput {
                stop_reason: "Need input".to_owned(),
            },
            None,
        ),
    ] {
        let (event_tx, mut event_rx) = broadcast::channel(1);
        let index_path = temp_runtime_work_index_path(&format!("completed-turn-id-{case}"));
        let mut handler =
            RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let local_task_id = format!("task-{case}");
        let request = ExecutionRequest {
            task_id: local_task_id.clone(),
            subtask_id: format!("subtask-{case}"),
            ..ExecutionRequest::default()
        };
        handler.upsert_local_task(RuntimeTaskLink::new_pending(
            local_task_id.clone(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        ));
        let execution_id = start_test_execution(&handler, &local_task_id);
        handler.handle_turn_result(
            &local_task_id,
            execution_id,
            &request,
            Some(&ActiveCodexTurn {
                execution_id,
                thread_id: format!("thread-{case}"),
                turn_id: "turn-1".to_owned(),
            }),
            Ok(crate::agents::CodexAppServerTurn {
                thread_id: format!("thread-{case}"),
                outcome,
                response_item_id: response_item_id.clone(),
                goal_status: None,
                goal_status_observed: false,
            }),
        );

        let event = event_rx
            .try_recv()
            .expect("completed response should be emitted");
        assert_eq!(event["event"], "response.completed", "{case}");
        assert_eq!(event["payload"]["subtaskId"], "turn-1", "{case}");
        assert_eq!(event["payload"]["data"]["turnId"], "turn-1", "{case}");
        assert_eq!(
            event["payload"]["data"]["itemId"],
            response_item_id.map(Value::String).unwrap_or(Value::Null),
            "{case}"
        );

        let _ = fs::remove_file(index_path);
    }
}

#[tokio::test]
async fn archived_delete_falls_back_inline_when_enqueue_fails() {
    let index_path = temp_runtime_work_index_path("delete-enqueue-fallback");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let (archived_delete_tx, archived_delete_rx) = mpsc::unbounded_channel();
    drop(archived_delete_rx);
    handler.archived_delete_tx = archived_delete_tx;
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/runtime-work-delete-enqueue-fallback".to_owned(),
        "Task".to_owned(),
    );
    handler.upsert_local_task(link.clone());

    let response = handler.delete_archived_link(link).await;

    assert_eq!(response["deleted"], true);
    assert_eq!(response["cleanup"]["background"], false);
    assert!(handler.local_task_link("task-1").is_none());
    let _ = fs::remove_file(index_path);
}

#[test]
fn plugin_app_server_method_allowlist_covers_wework_plugin_runtime_surface() {
    for method in [
        "marketplace/add",
        "marketplace/remove",
        "marketplace/upgrade",
        "plugin/list",
        "plugin/installed",
        "plugin/read",
        "plugin/skill/read",
        "plugin/install",
        "plugin/uninstall",
        "config/value/write",
        "skills/list",
        "skills/config/write",
        "app/list",
    ] {
        assert!(
            is_allowed_plugin_app_server_method(method),
            "{method} should be allowed"
        );
    }

    assert!(!is_allowed_plugin_app_server_method("thread/new"));
    assert!(!is_allowed_plugin_app_server_method("plugin/share/save"));
}

#[test]
fn cached_user_message_uses_explicit_payload_text() {
    let request = ExecutionRequest {
        subtask_id: "42".to_owned(),
        prompt: json!([
            {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"},
            {"type": "input_text", "text": "visible user text"}
        ]),
        ..ExecutionRequest::default()
    };

    let message = cached_user_message(
        "local-task",
        &request,
        &json!({
            "message": "visible user text",
            "clientUserMessageId": "runtime-local-pane-1"
        }),
    )
    .expect("payload message should create a cached user message");

    assert_eq!(message["content"], "visible user text");
    assert_eq!(message["clientUserMessageId"], "runtime-local-pane-1");

    let content_message = cached_user_message(
        "local-task",
        &request,
        &json!({"content": "visible content text"}),
    )
    .expect("payload content should create a cached user message");

    assert_eq!(content_message["content"], "visible content text");
}

#[test]
fn cached_user_message_does_not_fallback_to_prompt() {
    let request = ExecutionRequest {
        subtask_id: "42".to_owned(),
        prompt: json!([
            {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"}
        ]),
        ..ExecutionRequest::default()
    };

    assert!(cached_user_message("local-task", &request, &json!({})).is_none());
}

#[test]
fn user_message_presentation_preserves_visible_content_and_references() {
    let presentation = user_message_presentation(&json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "createdAt": 42,
        "message": "Use [$plugin:skill](/tmp/plugin/skill/SKILL.md) with [$OpenAI Developers](plugin://openai-developers@openai-curated)"
    }))
    .expect("rich references should produce presentation metadata");

    assert_eq!(presentation["clientUserMessageId"], "runtime-local-pane-1");
    assert_eq!(
        presentation["content"],
        "Use [$plugin:skill](/tmp/plugin/skill/SKILL.md) with [$OpenAI Developers](plugin://openai-developers@openai-curated)"
    );
    assert_eq!(presentation["createdAt"], 42_000);
    assert_eq!(presentation["ensureVisible"], true);
    assert_eq!(
        presentation["references"],
        json!([
            {
                "token": "$plugin:skill",
                "href": "/tmp/plugin/skill/SKILL.md"
            },
            {
                "token": "@OpenAI Developers",
                "href": "plugin://openai-developers@openai-curated"
            }
        ])
    );
}

#[test]
fn user_message_presentation_requires_a_stable_client_user_message_id() {
    assert!(user_message_presentation(&json!({
        "message": "Use [$plugin:skill](/tmp/plugin/skill/SKILL.md)"
    }))
    .is_none());
}

#[test]
fn user_message_presentation_preserves_plain_visible_content() {
    let presentation = user_message_presentation(&json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "message": "合并到main"
    }))
    .expect("plain user content should remain available when Codex filters internal context");

    assert_eq!(presentation["content"], "合并到main");
    assert_eq!(presentation["ensureVisible"], true);
    assert_eq!(presentation["references"], json!([]));
}

#[test]
fn legacy_thread_preview_restores_filtered_initial_user_message() {
    let thread = json!({
        "id": "thread-1",
        "historyMode": "legacy",
        "preview": "Initial task request",
        "createdAt": 100,
        "turns": [{
            "id": "turn-1",
            "startedAt": 110,
            "items": []
        }]
    });
    let mut messages = vec![json!({
        "id": "assistant-1",
        "turnId": "turn-1",
        "role": "assistant",
        "content": "Working",
        "createdAt": 120
    })];

    attach_legacy_thread_preview(&mut messages, &thread, false);

    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "Initial task request");
    assert_eq!(messages[0]["turnId"], "turn-1");
    assert_eq!(messages[1]["role"], "assistant");
}

#[test]
fn legacy_thread_preview_waits_until_the_oldest_page() {
    let thread = json!({
        "historyMode": "legacy",
        "preview": "Initial task request"
    });
    let mut messages = vec![json!({
        "id": "assistant-1",
        "role": "assistant",
        "content": "Working"
    })];

    attach_legacy_thread_preview(&mut messages, &thread, true);

    assert_eq!(messages.len(), 1);
}

#[test]
fn legacy_thread_preview_does_not_duplicate_provider_user_message() {
    let thread = json!({
        "historyMode": "legacy",
        "preview": "Initial task request",
        "turns": [{
            "id": "turn-1"
        }]
    });
    let mut messages = vec![json!({
        "id": "provider-user",
        "turnId": "turn-1",
        "role": "user",
        "content": "Initial task request with attachment metadata"
    })];

    attach_legacy_thread_preview(&mut messages, &thread, false);

    assert_eq!(messages.len(), 1);
}

#[test]
fn transcript_combines_provider_content_with_local_presentations_by_client_user_message_id() {
    let mut provider_messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "runtime-local-pane-1",
        "role": "user",
        "content": "请用 $plugin:skill 和 @OpenAI Developers 制作教程"
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "references": [
            {
                "token": "$plugin:skill",
                "href": "/tmp/plugin/skill/SKILL.md"
            },
            {
                "token": "@OpenAI Developers",
                "href": "plugin://openai-developers@openai-curated"
            }
        ]
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    assert_eq!(
        provider_messages[0]["content"],
        "请用 $plugin:skill 和 @OpenAI Developers 制作教程"
    );
    assert_eq!(
        provider_messages[0]["presentationReferences"],
        json!([
            {
                "start": 3,
                "end": 16,
                "href": "/tmp/plugin/skill/SKILL.md"
            },
            {
                "start": 19,
                "end": 37,
                "href": "plugin://openai-developers@openai-curated"
            }
        ])
    );
}

#[test]
fn transcript_does_not_attach_presentation_to_an_unmatched_client_user_message_id() {
    let mut provider_messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "provider-client-id",
        "role": "user",
        "content": "$plugin:skill"
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "cached-client-id",
        "references": [{
            "token": "$plugin:skill",
            "href": "/tmp/plugin/skill/SKILL.md"
        }]
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    assert!(provider_messages[0].get("presentationReferences").is_none());
}

#[test]
fn transcript_restores_a_missing_supervisor_generated_user_message() {
    let mut provider_messages = vec![json!({
        "id": "assistant-1",
        "turnId": "turn-1",
        "role": "assistant",
        "content": "Corrected",
        "createdAt": 200
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "supervisor-correction-1",
        "content": "Use Japanese",
        "createdAt": 100,
        "ensureVisible": true,
        "references": [],
        "source": {
            "source": "supervisor",
            "channel_type": "task_supervisor"
        }
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    assert_eq!(provider_messages[0]["role"], "user");
    assert_eq!(provider_messages[0]["content"], "Use Japanese");
    assert_eq!(provider_messages[0]["turnId"], "turn-1");
    assert_eq!(provider_messages[0]["subtaskId"], "turn-1");
    assert_eq!(provider_messages[1]["role"], "assistant");

    let turns =
        transcript_canonical_turns(&provider_messages, TranscriptTurnItemSource::CodexItems);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["items"][0]["type"], "user_message");
    assert_eq!(turns[0]["items"][0]["message"]["content"], "Use Japanese");
}

#[test]
fn transcript_restores_a_missing_user_message_before_an_equal_timestamp_response() {
    let mut provider_messages = vec![json!({
        "id": "assistant-1",
        "turnId": "turn-1",
        "role": "assistant",
        "content": "Done",
        "createdAt": 1_780_000_000_000_i64
    })];
    let presentations = vec![
        json!({
            "clientUserMessageId": "client-user-1",
            "content": "First instruction",
            "createdAt": 1_780_000_000_000_i64,
            "ensureVisible": true,
            "references": []
        }),
        json!({
            "clientUserMessageId": "client-user-2",
            "content": "Second instruction",
            "createdAt": 1_780_000_000_000_i64,
            "ensureVisible": true,
            "references": []
        }),
    ];

    attach_user_message_presentations(&mut provider_messages, presentations);

    assert_eq!(provider_messages[0]["role"], "user");
    assert_eq!(provider_messages[0]["content"], "First instruction");
    assert_eq!(provider_messages[0]["turnId"], "turn-1");
    assert_eq!(provider_messages[0]["subtaskId"], "turn-1");
    assert_eq!(provider_messages[1]["role"], "user");
    assert_eq!(provider_messages[1]["content"], "Second instruction");
    assert_eq!(provider_messages[2]["role"], "assistant");

    let turns =
        transcript_canonical_turns(&provider_messages, TranscriptTurnItemSource::CodexItems);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["items"][0]["type"], "user_message");
    assert_eq!(
        turns[0]["items"][0]["message"]["content"],
        "First instruction"
    );
    assert_eq!(turns[0]["items"][1]["type"], "user_message");
    assert_eq!(
        turns[0]["items"][1]["message"]["content"],
        "Second instruction"
    );
}

#[test]
fn paginated_transcript_does_not_restore_a_presentation_from_a_newer_page() {
    let page_messages = vec![json!({
        "id": "assistant-old",
        "turnId": "turn-old",
        "role": "assistant",
        "content": "Old response",
        "createdAt": 100
    })];
    let mut provider_messages = page_messages.clone();
    let presentations = vec![json!({
        "clientUserMessageId": "client-user-new",
        "content": "New instruction",
        "createdAt": 300,
        "ensureVisible": true,
        "references": []
    })];

    attach_user_message_presentations_for_page(
        &mut provider_messages,
        presentations,
        &page_messages,
        false,
        true,
    );

    assert_eq!(provider_messages, page_messages);
}

#[test]
fn paginated_transcript_restores_a_missing_presentation_inside_the_current_page() {
    let page_messages = vec![
        json!({
            "id": "assistant-first",
            "turnId": "turn-first",
            "role": "assistant",
            "content": "First response",
            "createdAt": 100
        }),
        json!({
            "id": "assistant-last",
            "turnId": "turn-last",
            "role": "assistant",
            "content": "Last response",
            "createdAt": 300
        }),
    ];
    let mut provider_messages = page_messages.clone();
    let presentations = vec![json!({
        "clientUserMessageId": "client-user-middle",
        "content": "Middle instruction",
        "createdAt": 200,
        "ensureVisible": true,
        "references": []
    })];

    attach_user_message_presentations_for_page(
        &mut provider_messages,
        presentations,
        &page_messages,
        true,
        true,
    );

    assert_eq!(provider_messages.len(), 3);
    assert_eq!(provider_messages[1]["content"], "Middle instruction");
    assert_eq!(provider_messages[1]["turnId"], "turn-last");
}

#[test]
fn transcript_only_adds_presentations_missing_from_provider_content() {
    let provider_content = "[$first](/tmp/first/SKILL.md) and $second";
    let mut provider_messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "runtime-local-pane-1",
        "role": "user",
        "content": provider_content
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "references": [
            {
                "token": "$first",
                "href": "/tmp/first/SKILL.md"
            },
            {
                "token": "$second",
                "href": "/tmp/second/SKILL.md"
            }
        ]
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    let second_start = provider_content
        .find("$second")
        .expect("second skill token");
    assert_eq!(
        provider_messages[0]["presentationReferences"],
        json!([{
            "start": second_start,
            "end": second_start + "$second".len(),
            "href": "/tmp/second/SKILL.md"
        }])
    );
}

#[test]
fn transcript_presentation_matches_a_complete_reference_token() {
    let provider_content = "Use $skill-advanced before $skill.";
    let mut provider_messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "runtime-local-pane-1",
        "role": "user",
        "content": provider_content
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "references": [{
            "token": "$skill",
            "href": "/tmp/skill/SKILL.md"
        }]
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    let expected_start = provider_content
        .rfind("$skill")
        .expect("complete skill token");
    assert_eq!(
        provider_messages[0]["presentationReferences"],
        json!([{
            "start": expected_start,
            "end": expected_start + "$skill".len(),
            "href": "/tmp/skill/SKILL.md"
        }])
    );
}

#[test]
fn transcript_navigation_uses_client_user_message_id_for_live_message_matching() {
    let navigation = transcript_turn_navigation(
        &[json!({
            "id": "provider-user",
            "clientUserMessageId": "runtime-local-pane-1",
            "role": "user",
            "content": "# Files mentioned by the user:\n\n## image.png: /tmp/image.png\n\n## My request for Codex:\n<application_context>\n[wework.terminal.current]\nterminal state\n</application_context>\n\nFix the sidebar"
        })],
        false,
    );

    assert_eq!(navigation.len(), 1);
    assert_eq!(navigation[0]["id"], "runtime-local-pane-1");
    assert_eq!(navigation[0]["promptPreview"], "Fix the sidebar");
}

#[test]
fn transcript_canonical_turns_preserve_provider_turn_and_item_order() {
    let turns = transcript_canonical_turns(
        &[
            json!({
                "id": "provider-user-1",
                "messageIndex": 8,
                "turnId": "turn-1",
                "clientUserMessageId": "client-user-1",
                "role": "user",
                "content": "First prompt"
            }),
            json!({
                "id": "provider-assistant-1",
                "messageIndex": 9,
                "turnId": "turn-1",
                "role": "assistant",
                "content": "First response",
                "blocks": [{
                    "id": "tool-call-1",
                    "type": "tool",
                    "title": "Read file"
                }],
                "runtimeItems": [
                    {
                        "id": "assistant-item-1",
                        "type": "assistant_text",
                        "content": "First response"
                    },
                    {
                        "id": "tool-call-1",
                        "type": "block",
                        "block": {
                            "id": "tool-call-1",
                            "type": "tool",
                            "title": "Read file"
                        }
                    }
                ],
                "status": "done"
            }),
            json!({
                "id": "provider-user-2",
                "messageIndex": 10,
                "turnId": "turn-2",
                "clientUserMessageId": "client-user-2",
                "role": "user",
                "content": "Second prompt"
            }),
        ],
        TranscriptTurnItemSource::CodexItems,
    );

    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["id"], "turn-1");
    assert_eq!(turns[1]["id"], "turn-2");
    assert_eq!(turns[0]["messageIndex"], 8);
    assert_eq!(turns[1]["messageIndex"], 10);
    assert_eq!(turns[0]["items"][0]["id"], "client-user-1");
    assert_eq!(turns[0]["items"][1]["id"], "assistant-item-1");
    assert_eq!(turns[0]["items"][2]["id"], "tool-call-1");
    assert_eq!(turns[1]["items"][0]["id"], "client-user-2");
}

#[test]
fn transcript_canonical_turns_accept_snake_case_message_indexes() {
    let turns = transcript_canonical_turns(
        &[json!({
            "id": "provider-user-1",
            "message_index": 8,
            "turn_id": "turn-1",
            "client_user_message_id": "client-user-1",
            "role": "user",
            "content": "First prompt"
        })],
        TranscriptTurnItemSource::CodexItems,
    );

    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["messageIndex"], 8);
}

#[test]
fn transcript_canonical_turns_preserve_status_from_user_only_turns() {
    let turns = transcript_canonical_turns(
        &[json!({
            "id": "provider-user-1",
            "turnId": "turn-1",
            "clientUserMessageId": "client-user-1",
            "role": "user",
            "content": "Pending prompt",
            "status": "streaming",
            "runtimeStatus": "running"
        })],
        TranscriptTurnItemSource::CodexItems,
    );

    assert_eq!(turns[0]["status"], "streaming");
    assert_eq!(turns[0]["runtimeStatus"], "running");
}

#[test]
fn transcript_canonical_turns_do_not_infer_missing_provider_items() {
    let turns = transcript_canonical_turns(
        &[json!({
            "id": "provider-assistant-1",
            "turnId": "turn-1",
            "role": "assistant",
            "content": "Not a provider item",
            "blocks": [{
                "id": "tool-call-1",
                "type": "tool",
                "title": "Not a provider item"
            }],
            "status": "done"
        })],
        TranscriptTurnItemSource::CodexItems,
    );

    assert_eq!(turns[0]["items"], json!([]));
}

#[test]
fn transcript_canonical_turns_convert_runtime_messages_deterministically() {
    let turns = transcript_canonical_turns(
        &[json!({
            "id": "assistant-1",
            "turnId": "turn-1",
            "role": "assistant",
            "content": "Completed",
            "createdAt": "2026-07-30T00:00:00.000Z",
            "blocks": [
                {"id": "tool-later", "createdAt": 2000},
                {"id": "tool-earlier", "createdAt": 1000}
            ],
            "status": "done"
        })],
        TranscriptTurnItemSource::CachedMessages,
    );

    assert_eq!(turns[0]["items"][0]["id"], "assistant-1");
    assert_eq!(turns[0]["items"][0]["type"], "assistant_text");
    assert_eq!(turns[0]["items"][0]["content"], "Completed");
    assert_eq!(turns[0]["items"][1]["id"], "tool-earlier");
    assert_eq!(turns[0]["items"][2]["id"], "tool-later");
}

#[tokio::test]
async fn codex_stream_debug_rpc_toggles_runtime_flag() {
    set_codex_stream_debug_enabled(false);
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let initial = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.stream_debug.get",
            "payload": {}
        }))
        .await
        .expect("debug state should return");
    assert_eq!(initial["enabled"], false);

    let updated = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.stream_debug.set",
            "payload": {"enabled": true}
        }))
        .await
        .expect("debug state should update");
    assert_eq!(updated["enabled"], true);
    assert!(codex_stream_debug_enabled());

    set_codex_stream_debug_enabled(false);
}

#[tokio::test]
async fn codex_app_server_restart_rpc_returns_success() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "unused-codex-binary");

    let result = handler
        .restart_codex_app_server_with_expected_models(json!({"ifIdle": true}), Vec::new())
        .await
        .expect("restart should return success");

    assert_eq!(result["restarted"], true);
    assert_eq!(result["requiresConfirmation"], false);
    assert_eq!(result["activeTaskCount"], 0);
}

#[tokio::test]
async fn codex_app_server_restart_requires_confirmation_for_active_turns() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler
        .active_codex_turns
        .lock()
        .expect("active Codex turn registry should not be poisoned")
        .insert(
            "thread-1".to_owned(),
            ActiveCodexTurn {
                execution_id: 1,
                thread_id: "thread-1".to_owned(),
                turn_id: "turn-1".to_owned(),
            },
        );

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.app_server.restart",
            "payload": {"ifIdle": true}
        }))
        .await
        .expect("active restart check should return success");

    assert_eq!(result["restarted"], false);
    assert_eq!(result["requiresConfirmation"], true);
    assert_eq!(result["activeTaskCount"], 1);
}

#[tokio::test]
async fn codex_instructions_write_rejects_non_string_payload() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.instructions.write",
            "payload": {"instructions": 1}
        }))
        .await;

    let error = result.expect_err("non-string instructions should be rejected");
    assert_eq!(error.code, "invalid_request");
}

#[tokio::test]
async fn codex_personality_write_rejects_unsupported_value() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.personality.write",
            "payload": {"personality": "default"}
        }))
        .await;

    let error = result.expect_err("unsupported personality should be rejected");
    assert_eq!(error.code, "invalid_request");
}

#[tokio::test]
async fn transcript_without_runtime_link_returns_empty_local_transcript() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "optimistic-local-task",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("missing runtime link should not read provider session");

    assert_eq!(result["success"], true);
    assert_eq!(result["taskId"], "optimistic-local-task");
    assert_eq!(result["workspacePath"], "/tmp/project");
    assert_eq!(result["messages"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn transcript_rejects_conflicting_cursors_before_task_lookup() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "missing-task",
                "refresh": true,
                "beforeCursor": "before-opaque",
                "afterCursor": "after-opaque"
            }
        }))
        .await;

    let error = result.expect_err("conflicting cursors should be rejected");
    assert_eq!(error.code, "bad_request");
    assert_eq!(
        error.message,
        "Codex transcript pagination accepts only one cursor at a time"
    );
}

#[test]
fn first_message_search_result_returns_bounded_snippet() {
    let link = RuntimeTaskLink::new_pending(
        "local-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Long message task".to_owned(),
    );
    let content = format!("{}needle{}", "a".repeat(300), "b".repeat(300));

    let result = first_message_search_result(
        &link,
        "device-1",
        vec![json!({
            "id": "message-1",
            "role": "user",
            "content": content,
            "createdAt": 1780000000,
        })],
        "needle",
    )
    .expect("long matching message should produce a result");
    let snippet = result["snippet"].as_str().unwrap();
    let match_start = result["matchStart"].as_u64().unwrap() as usize;
    let match_end = result["matchEnd"].as_u64().unwrap() as usize;

    assert!(snippet.len() < 300);
    assert!(snippet.contains("needle"));
    assert_eq!(&snippet[match_start..match_end], "needle");
}

#[test]
fn pending_thread_event_route_promotes_on_thread_started() {
    let index_path = temp_runtime_work_index_path("pending-thread-event-route");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "local-task-1".to_owned();
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        subtask_id: "42".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        local_task_id.clone(),
        "/tmp/project".to_owned(),
        "Pending route".to_owned(),
    ));

    handler.register_pending_thread_event_route(local_task_id.clone(), request);

    assert!(!handler.thread_event_route_exists("thread-1"));
    assert!(handler.promote_pending_thread_event_route("thread-1"));
    assert!(handler.thread_event_route_exists("thread-1"));
    let link = handler
        .local_task_link(&local_task_id)
        .expect("local task should be stored");
    assert_eq!(link.thread_id.as_deref(), Some("thread-1"));

    let _ = fs::remove_file(index_path);
}

#[test]
fn cached_codex_link_stays_visible_until_provider_thread_is_discovered() {
    let mut link = RuntimeTaskLink::new_pending(
        "local-task-1".to_owned(),
        "/Users/test/Documents/Codex/2026-07-07/hi".to_owned(),
        "hi".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    link.running = false;
    link.status = "active".to_owned();

    assert!(!is_cached_codex_link_hidden(&link, &HashSet::new()));

    let discovered_thread_ids = HashSet::from(["thread-1".to_owned()]);
    assert!(is_cached_codex_link_hidden(&link, &discovered_thread_ids));
}

#[tokio::test]
async fn create_task_stores_model_selection_in_runtime_handle() {
    let index_path = temp_runtime_work_index_path("create-task-model-selection");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());

    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-1",
                "workspacePath": "/tmp/project",
                "title": "Use mimo",
                "modelId": "local-model:mimo",
                "modelType": "runtime",
                "modelOptions": {
                    "collaborationMode": "plan"
                },
                "modelSelection": {
                    "modelName": "shared-model",
                    "modelType": "user",
                    "options": {
                        "collaborationMode": "plan",
                        "reasoningEffort": "high"
                    }
                },
                "initialSupervisor": {
                    "mode": "auto",
                    "instructions": "Keep the task focused",
                    "modelSelection": {
                        "modelName": "supervisor-model",
                        "modelType": "public",
                        "options": {
                            "weworkCloudModelNamespace": "default",
                            "weworkCloudModelResourceUserId": "0"
                        }
                    },
                    "intervalSeconds": 10
                },
                "executionRequest": serde_json::to_value(ExecutionRequest::default()).unwrap()
            }
        }))
        .await
        .expect("runtime task should be created");
    assert_eq!(
        response["runtimeHandle"]["modelSelection"],
        json!({
            "modelName": "shared-model",
            "modelType": "user",
            "options": {
                "collaborationMode": "plan",
                "reasoningEffort": "high"
            }
        })
    );

    let link = handler
        .local_task_link("local-task-1")
        .expect("created task should be stored");
    assert_eq!(
        link.runtime_handle["modelSelection"],
        json!({
            "modelName": "shared-model",
            "modelType": "user",
            "options": {
                "collaborationMode": "plan",
                "reasoningEffort": "high"
            }
        })
    );
    let supervisor = link
        .supervisor
        .expect("initial supervisor should be stored with the task");
    assert_eq!(supervisor.mode, "auto");
    assert_eq!(supervisor.instructions, "Keep the task focused");
    assert_eq!(
        supervisor.model_selection,
        Some(json!({
            "modelName": "supervisor-model",
            "modelType": "public",
            "options": {
                "weworkCloudModelNamespace": "default",
                "weworkCloudModelResourceUserId": "0"
            }
        }))
    );
    assert_eq!(supervisor.interval_seconds, 10);
    assert_eq!(supervisor.status, "active");
    assert!(supervisor.last_error.is_none());

    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn create_task_keeps_board_comment_session_persistent_across_store_reload() {
    let index_path = temp_runtime_work_index_path("create-board-comment-task");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "board-comment-task-1",
                "workspacePath": "/tmp/project",
                "title": "Board task",
                "cloudProjectId": "project-1",
                "origin": {
                    "type": "board_comment",
                    "cloudProjectId": "project-1",
                    "loopItemId": "item-1",
                    "rootCommentId": "comment-1"
                },
                "executionRequest": serde_json::to_value(ExecutionRequest::default()).unwrap()
            }
        }))
        .await
        .expect("board comment runtime task should be created");

    let reloaded = RuntimeWorkStore::new(index_path.clone())
        .get_task("board-comment-task-1")
        .expect("board comment runtime task should survive store reload");
    assert!(!reloaded.ephemeral);
    assert_eq!(
        reloaded.runtime_handle["origin"],
        json!({
            "type": "board_comment",
            "cloudProjectId": "project-1",
            "loopItemId": "item-1",
            "rootCommentId": "comment-1"
        })
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn model_selection_falls_back_to_execution_model_for_legacy_requests() {
    let mut runtime_handle = json!({});

    set_runtime_handle_model_selection(
        &mut runtime_handle,
        &json!({
            "modelId": "legacy-model",
            "modelType": "runtime",
            "modelOptions": {"reasoningEffort": "medium"}
        }),
    );

    assert_eq!(
        runtime_handle["modelSelection"],
        json!({
            "modelName": "legacy-model",
            "modelType": "runtime",
            "options": {"reasoningEffort": "medium"}
        })
    );
}

#[test]
fn runtime_model_selection_change_detects_model_and_provider_type_boundaries() {
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.runtime_handle["modelSelection"] = json!({
        "modelName": "gpt-5.6-sol",
        "modelType": "runtime",
        "options": {"reasoningEffort": "high"}
    });

    assert!(!runtime_model_selection_changed(
        &link,
        &json!({
            "modelSelection": {
                "modelName": "gpt-5.6-sol",
                "modelType": "runtime",
                "options": {"reasoningEffort": "medium"}
            }
        })
    ));
    assert!(runtime_model_selection_changed(
        &link,
        &json!({
            "modelSelection": {
                "modelName": "gpt-5.6-sol",
                "modelType": "public",
                "options": {}
            }
        })
    ));
    assert!(runtime_model_selection_changed(
        &link,
        &json!({
            "modelSelection": {
                "modelName": "kimi-k3",
                "modelType": "runtime",
                "options": {}
            }
        })
    ));
}

#[test]
fn runtime_model_switch_marker_is_only_added_when_the_selection_changes() {
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.runtime_handle = json!({
        "modelSelection": {
            "modelName": "gpt-5.6-luna",
            "modelType": "codex"
        }
    });
    let unchanged_payload = json!({
        "modelSelection": {
            "modelName": "gpt-5.6-luna",
            "modelType": "codex"
        }
    });
    let switched_payload = json!({
        "modelSelection": {
            "modelName": "kimi-k3",
            "modelType": "custom"
        }
    });
    let mut request = ExecutionRequest::default();

    mark_runtime_model_switch(&mut request, &link, &unchanged_payload);
    assert!(request.extra.get("wework_model_switched").is_none());

    mark_runtime_model_switch(&mut request, &link, &switched_payload);
    assert_eq!(
        request.extra.get("wework_model_switched"),
        Some(&Value::Bool(true))
    );
}

#[test]
fn task_list_running_state_uses_local_execution_or_provider_turn() {
    let index_path = temp_runtime_work_index_path("authoritative-running-state");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let provider_running_thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "status": {"type": "active"},
        "turns": [{"status": "inProgress"}]
    });
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/tmp/project".to_owned(),
        goal_status: Some("active".to_owned()),
        ..RuntimeTaskLink::default()
    });

    let provider_running_link = handler
        .link_from_thread(&provider_running_thread)
        .expect("active Codex thread should produce a task link");

    assert!(provider_running_link.running);
    assert_eq!(provider_running_link.goal_status.as_deref(), Some("active"));
    assert_eq!(provider_running_link.status, "running");
    assert_eq!(provider_running_link.thread_status, "active");
    assert_eq!(
        provider_running_link.turn_status.as_deref(),
        Some("inProgress")
    );

    let thread_status_only = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "status": {"type": "active"},
        "turns": [{"status": "completed"}]
    });
    let idle_link = handler
        .link_from_thread(&thread_status_only)
        .expect("idle Codex thread should produce a task link");

    assert!(!idle_link.running);
    assert_eq!(idle_link.status, "active");
    assert_eq!(idle_link.thread_status, "idle");
    assert_eq!(idle_link.turn_status.as_deref(), Some("completed"));

    start_test_execution(&handler, "task-1");

    let local_running_link = handler
        .link_from_thread(&thread_status_only)
        .expect("executor-owned task should produce a task link");

    assert!(local_running_link.running);
    assert_eq!(local_running_link.status, "running");
    assert_eq!(local_running_link.thread_status, "active");
    assert_eq!(
        local_running_link.turn_status.as_deref(),
        Some("inProgress")
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn active_local_task_routes_only_notifications_from_other_turns_globally() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("active-local-task-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "runtime-subtask-1".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    link.updated_at = 1_780_000_000_000;
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.register_thread_event_route("thread-1", local_task_id.to_owned(), request, true);
    handler.record_active_codex_turn(
        local_task_id,
        execution_id,
        "thread-1".to_owned(),
        "turn-current".to_owned(),
    );

    assert_eq!(
        handler
            .store
            .get_task(local_task_id)
            .expect("registered task should remain stored")
            .updated_at,
        1_780_000_000_000
    );

    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "Hi",
            "itemId": "msg-1",
            "threadId": "thread-1",
            "turnId": "turn-current"
        }
    }));

    assert!(event_rx.try_recv().is_err());

    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "Earlier",
            "itemId": "msg-earlier",
            "threadId": "thread-1",
            "turnId": "turn-earlier"
        }
    }));

    let event = event_rx
        .try_recv()
        .expect("a non-active turn should still be routed by its own identity");
    assert_eq!(event["event"], "response.block.created");
    assert_eq!(event["payload"]["taskId"], local_task_id);
    assert_eq!(event["payload"]["subtaskId"], "turn-earlier");
    assert_eq!(event["payload"]["data"]["block"]["type"], "text");
    assert_eq!(event["payload"]["data"]["block"]["content"], "Earlier");
    assert_eq!(
        event["payload"]["data"]["block"]["process_item_id"],
        "msg-earlier"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn thread_read_repairs_legacy_activity_time_pollution() {
    let index_path = temp_runtime_work_index_path("repair-legacy-activity-time");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.status = "done".to_owned();
    link.running = false;
    link.updated_at = 1_790_000_000_000;
    link.completed_at = None;
    handler.upsert_local_task(link);

    handler.repair_legacy_task_activity_time(local_task_id, &json!({"updatedAt": 1_780_000_000}));

    let repaired = handler
        .store
        .get_task(local_task_id)
        .expect("repaired task should remain stored");
    assert_eq!(repaired.updated_at, 1_780_000_000_000);
    assert_eq!(repaired.completed_at, Some(1_780_000_000_000));
    let _ = fs::remove_file(index_path);
}

#[test]
fn archived_cleanup_targets_include_managed_worktree_and_local_attachment() {
    let root =
        temp_runtime_work_index_path("archived-cleanup-managed-root").with_extension("directory");
    let managed_root = root.join("workspace/worktrees");
    let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let worktree_path = managed_root.join("task-1/Wegent");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        worktree_path.display().to_string(),
        "Task".to_owned(),
    );
    link.runtime_handle = json!({
        "messages": [
            {
                "attachments": [
                    {
                        "local_path": "/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png"
                    }
                ]
            }
        ]
    });

    let targets = cleanup_targets_for_task(&manager, &link);
    let target_paths = targets
        .iter()
        .map(|target| target.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(target_paths.contains(&worktree_path.display().to_string()));
    assert!(target_paths.contains(
        &"/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png".to_owned()
    ));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn guidance_inputs_include_only_local_images() {
    let attachments = json!([
        {
            "mime_type": "image/png",
            "local_path": "/tmp/screenshot.png"
        },
        {
            "mime_type": "text/plain",
            "local_path": "/tmp/notes.txt"
        },
        {
            "mime_type": "image/jpeg"
        }
    ]);

    assert_eq!(
        guidance_image_inputs(Some(&attachments)),
        vec![json!({
            "type": "localImage",
            "path": "/tmp/screenshot.png"
        })]
    );
    assert_eq!(
        guidance_input_items("", Some(&attachments)),
        vec![json!({
            "type": "localImage",
            "path": "/tmp/screenshot.png"
        })]
    );
    assert!(guidance_input_items("", None).is_empty());
}

#[test]
fn codex_guidance_turn_races_are_reported_as_no_active_turn() {
    assert_eq!(
        codex_guidance_failure_code("no active turn to steer"),
        "no_active_turn"
    );
    assert_eq!(
        codex_guidance_failure_code("expected active turn id `turn-1` but found `turn-2`"),
        "no_active_turn"
    );
    assert_eq!(
        codex_guidance_failure_code("turn/steer response missing turnId"),
        "guidance_failed"
    );
}

#[test]
fn codex_guidance_turn_mismatch_exposes_the_actual_turn_id() {
    assert_eq!(
        active_turn_id_from_steer_mismatch(
            "expected active turn id `turn-expected` but found `turn-actual`"
        ),
        Some("turn-actual".to_owned())
    );
    assert_eq!(
        active_turn_id_from_steer_mismatch("no active turn to steer"),
        None
    );
}

#[test]
fn archived_cleanup_targets_do_not_delete_regular_project_root() {
    let root =
        temp_runtime_work_index_path("archived-cleanup-regular-root").with_extension("directory");
    let manager = WorktreeManager::new(root.join("runtime-work/worktrees.json"));
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/Users/me/project".to_owned(),
        "Task".to_owned(),
    );

    let targets = cleanup_targets_for_task(&manager, &link);
    let target_paths = targets
        .iter()
        .map(|target| target.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(!target_paths.contains(&"/Users/me/project".to_owned()));
    assert!(target_paths.contains(&"/Users/me/project/.wegent/attachments/task-1".to_owned()));
    assert!(target_paths.contains(&"/Users/me/project/task-1:executor:attachments".to_owned()));
    let _ = fs::remove_dir_all(root);
}

fn temp_runtime_work_index_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-runtime-work-{label}-{}-{}.json",
        std::process::id(),
        now_ms()
    ))
}
