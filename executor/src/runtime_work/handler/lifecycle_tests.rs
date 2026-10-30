// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn request_observer_does_not_wait_for_native_publication() {
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    let (handler, root, request) = setup("independent-request-publication");
    let mut observation = Box::pin(handler.observe_execution_codex_notification(
        "task-1",
        0,
        &request,
        None,
        notification("turn/completed", "turn-1"),
    ));
    let mut context = Context::from_waker(Waker::noop());
    assert!(observation.as_mut().poll(&mut context).is_ready());
    drop(observation);
    let _ = std::fs::remove_dir_all(root);
}

fn notification(method: &str, turn: &str) -> CodexNotification {
    json!({"method": method, "params": {"threadId": "thread-1", "turn": {
        "id": turn, "status": "completed", "agent_path": "/root"
    }}})
    .into()
}

fn setup(label: &str) -> (RuntimeWorkRpcHandler, PathBuf, ExecutionRequest) {
    let (handler, root) = isolated_runtime_work_handler(label);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    link.goal_status = Some("active".into());
    let request = ExecutionRequest {
        task_id: "task-1".into(),
        subtask_id: "request-1".into(),
        ..Default::default()
    };
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread-1", "task-1".into(), request.clone(), false);
    (handler, root, request)
}

#[tokio::test]
async fn queued_goal_recovery_preserves_owned_recovery_without_claiming_a_model_slot() {
    let (handler, root, mut request) = setup("native-goal-recovering-admission");
    request
        .extra
        .insert(RESUME_GOAL_ONLY_MARKER.into(), json!(true));
    handler
        .queue_turn(SpawnTurnRequest {
            local_task_id: "task-1".into(),
            runtime: "codex".into(),
            request,
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: Some("thread-1".into()),
            initial_thread_goal: None,
        })
        .await
        .unwrap();
    let task = handler.get_task(&json!({"taskId":"task-1"})).unwrap();
    assert_eq!(task["task"]["executionState"]["phase"], "recovering");
    assert_eq!(task["task"]["executionState"]["turnId"], Value::Null);
    assert_eq!(task["task"]["goalExecutionStatus"], "recovering");
    assert_eq!(task["task"]["running"], false);
    assert_eq!(task["task"]["status"], "queued");
    assert_eq!(task["task"]["queuePosition"], 1);
    assert!(handler.remove_queued_turn("task-1").await.unwrap());
    assert_eq!(
        json!(handler.local_task_link("task-1").unwrap().execution_state)["phase"],
        "idle"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn queue_admission_and_cancellation_publish_new_versions_without_rewriting_the_last_turn() {
    let (handler, root, request) = setup("native-queue-admission");
    handler.route_codex_notification(notification("turn/started", "old-turn"));
    handler.route_codex_notification(notification("turn/completed", "old-turn"));
    handler.route_codex_notification(
        json!({"method":"thread/goal/cleared", "params":{"threadId":"thread-1"}}),
    );
    let before = handler
        .local_task_link("task-1")
        .unwrap()
        .execution_state
        .unwrap();
    handler
        .queue_turn(SpawnTurnRequest {
            local_task_id: "task-1".into(),
            runtime: "codex".into(),
            request,
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: Some("thread-1".into()),
            initial_thread_goal: None,
        })
        .await
        .unwrap();
    let queued = handler.get_task(&json!({"taskId":"task-1"})).unwrap();
    assert_eq!(queued["task"]["executionState"]["phase"], "queued");
    assert_eq!(queued["task"]["status"], "queued");
    assert_eq!(queued["task"]["running"], false);
    assert_eq!(queued["task"]["completedAt"], Value::Null);
    assert_eq!(queued["task"]["queuePosition"], 1);
    let queued_version = queued["task"]["executionState"]["revision"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert!(queued_version > before.revision.parse::<u64>().unwrap());
    assert!(handler.remove_queued_turn("task-1").await.unwrap());
    let cancelled = handler.local_task_link("task-1").unwrap();
    let state = cancelled.execution_state.unwrap();
    assert_eq!(
        state.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
    );
    assert_eq!(state.latest_turn_id.as_deref(), Some("old-turn"));
    assert_eq!(state.outcome.as_deref(), Some("succeeded"));
    assert_eq!(state.execution_outcome.as_deref(), Some("cancelled"));
    assert!(state.revision.parse::<u64>().unwrap() > queued_version);
    assert!(cancelled.runtime_handle.get("queuePosition").is_none());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn recovered_content_uses_native_turn_identity_before_request_callback_registration() {
    let (mut handler, root, mut request) = setup("native-recovery-content-identity");
    let (sender, mut receiver) = broadcast::channel(32);
    handler.event_tx = Some(sender);
    request.subtask_id = "task-1-context-compact".into();
    handler.register_thread_event_route("thread-1", "task-1".into(), request, false);
    handler.route_codex_notification(notification("turn/started", "recovered-turn"));
    handler.route_codex_notification(json!({"method":"item/started", "params": {
        "threadId":"thread-1", "turnId":"recovered-turn", "item": {
            "id":"recovered-text", "type":"agentMessage", "phase":"final_answer", "text":""
        }
    }}));
    handler.route_codex_notification(json!({"method":"item/agentMessage/delta", "params": {
        "threadId":"thread-1", "turnId":"recovered-turn", "itemId":"recovered-text", "delta":"recovered output"
    }}));
    let delta = std::iter::from_fn(|| receiver.try_recv().ok())
        .find(|event| event["event"] == "response.output_text.delta")
        .unwrap();
    assert_eq!(delta["payload"]["subtaskId"], "recovered-turn");
    assert_eq!(delta["payload"]["data"]["delta"], "recovered output");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn passive_goal_updates_cannot_replace_the_admitted_recovery_request() {
    let (handler, root, request) = setup("native-goal-recovery-request");
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    handler.start_local_task_execution("task-1".into(), cancel, stopped);
    handler
        .active_local_executions
        .lock()
        .unwrap()
        .get_mut("task-1")
        .unwrap()
        .request = Some(request.clone());
    let mut passive_request = request.clone();
    passive_request.subtask_id = "task-1-context-compact".into();
    handler.register_thread_event_route("thread-1", "task-1".into(), passive_request, false);
    handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
        "threadId":"thread-1", "goal":{"status":"active", "tokensUsed":10}
    }}));
    let journal = handler.active_goal_turns.lock().unwrap();
    assert_eq!(journal["task-1"].request.subtask_id, request.subtask_id);
    assert_eq!(
        journal["task-1"].resume_thread_id.as_deref(),
        Some("thread-1")
    );
    drop(journal);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn native_execution_survives_summary_projection_but_is_not_restored_from_disk() {
    let (handler, root, _) = setup("native-summary-projection");
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    let full = handler.local_task_link("task-1").unwrap();
    let summary = handler.store.get_task_summary("task-1").unwrap();
    assert_eq!(full.execution_state, summary.execution_state);
    let response = handler.get_task(&json!({"taskId":"task-1"})).unwrap();
    assert_eq!(
        response["task"]["executionState"],
        json!(full.execution_state)
    );
    assert!(response["task"]["runtimeHandle"]
        .get("executionState")
        .is_none());
    let restored = RuntimeWorkStore::new(handler.store.index_path().to_path_buf());
    assert!(restored
        .get_task("task-1")
        .unwrap()
        .execution_state
        .is_none());
    handler.route_codex_notification(json!({"method":"thread/goal/cleared", "params": {
        "threadId":"thread-1"
    }}));
    let cleared = handler.get_task(&json!({"taskId":"task-1"})).unwrap();
    assert_eq!(cleared["task"].get("goalStatus"), Some(&Value::Null));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn transport_exit_stops_execution_without_rewriting_the_completed_turn_or_goal() {
    let (handler, root, _) = setup("native-transport-exit");
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    handler.settle_native_transport_exit();
    let task = handler.local_task_link("task-1").unwrap();
    let state = task.execution_state.unwrap();
    assert_eq!(
        state.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
    );
    assert_eq!(state.outcome.as_deref(), Some("succeeded"));
    assert_eq!(state.execution_outcome.as_deref(), Some("cancelled"));
    assert_eq!(task.goal_status.as_deref(), Some("active"));
    assert!(!task.running);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn old_request_cleanup_cannot_remove_a_newer_native_transcript() {
    let (handler, root, _) = setup("native-transcript-cleanup");
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    handler.route_codex_notification(notification("turn/started", "turn-2"));
    handler.persist_and_clear_active_codex_transcript("task-1", "completed", Some("turn-1"));
    let active = handler.active_codex_transcript_items.lock().unwrap();
    assert_eq!(active["task-1"].turn_id, "turn-2");
    drop(active);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn native_goal_continuation_survives_rpc_settlement_without_a_goal_updated_event() {
    let (mut handler, root, _request) = setup("native-goal-rpc-handoff");
    let (sender, mut receiver) = broadcast::channel(32);
    handler.event_tx = Some(sender);
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    let execution = handler.start_local_task_execution("task-1".into(), cancel, stopped);
    for message in [
        notification("turn/started", "turn-1"),
        notification("turn/completed", "turn-1"),
    ] {
        handler
            .deliver_native_notification_for_execution(
                "task-1", execution, &_request, None, message,
            )
            .await;
    }
    let between = handler.local_task_link("task-1").unwrap();
    assert!(between.running);
    assert_eq!(json!(between.execution_state)["phase"], "continuing");
    assert!(handler.finish_local_task("task-1", execution, Some("thread-1".into()), "done"));
    assert!(handler.local_task_link("task-1").unwrap().running);
    handler.route_codex_notification(notification("turn/started", "turn-2"));
    let task = handler.local_task_link("task-1").unwrap();
    assert!(task.running);
    assert_eq!(task.completed_at, None);
    assert_eq!(json!(task.execution_state)["turnId"], "turn-2");
    let events = std::iter::from_fn(|| receiver.try_recv().ok()).collect::<Vec<_>>();
    let started = events
        .iter()
        .find(|event| {
            event["event"] == "runtime.turn.updated"
                && event["payload"]["data"]["turnId"] == "turn-2"
        })
        .unwrap();
    assert_eq!(started["payload"]["data"]["task"]["running"], true);
    assert_eq!(
        started["payload"]["data"]["task"]["executionState"],
        json!(task.execution_state)
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn old_native_completion_and_replay_cannot_settle_a_newer_turn() {
    let (handler, root, _) = setup("native-goal-old-completion");
    let first = notification("turn/started", "turn-1");
    let completion = notification("turn/completed", "turn-1");
    let second = notification("turn/started", "turn-2");
    handler.route_codex_notification(first.clone());
    handler.route_codex_notification(second);
    let before = json!(handler.local_task_link("task-1").unwrap().execution_state).clone();
    handler.route_codex_notification(completion);
    handler.route_codex_notification(first);
    assert_eq!(
        json!(handler.local_task_link("task-1").unwrap().execution_state),
        before
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn replacing_a_content_route_for_compaction_preserves_native_lifecycle() {
    let (handler, root, mut request) = setup("native-goal-compaction-route");
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    request.subtask_id = "task-1-context-compact".into();
    handler.register_thread_event_route("thread-1", "task-1".into(), request, false);
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    handler.route_codex_notification(notification("turn/started", "turn-2"));
    let task = handler.local_task_link("task-1").unwrap();
    assert!(task.running);
    assert_eq!(json!(task.execution_state)["turnId"], "turn-2");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn child_turns_and_background_output_do_not_change_root_execution() {
    let (handler, root, _) = setup("native-goal-child-isolation");
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    let before = json!(handler.local_task_link("task-1").unwrap().execution_state).clone();
    handler.route_codex_notification(json!({"method":"turn/started", "params": {
        "threadId":"thread-1", "turn":{"id":"child", "agent_path":"/root/child"}
    }}));
    handler.route_codex_notification(
        json!({"method":"item/commandExecution/outputDelta", "params": {
            "threadId":"thread-1", "turnId":"old", "itemId":"shell", "delta":"late output"
        }}),
    );
    assert_eq!(
        json!(handler.local_task_link("task-1").unwrap().execution_state),
        before
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn completing_goal_between_turns_settles_execution_but_not_an_open_turn() {
    for open in [false, true] {
        let (handler, root, _) = setup(if open {
            "native-goal-open-complete"
        } else {
            "native-goal-gap-complete"
        });
        handler.route_codex_notification(notification("turn/started", "turn-1"));
        if !open {
            handler.route_codex_notification(notification("turn/completed", "turn-1"));
        }
        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"complete"}
        }}));
        let task = handler.local_task_link("task-1").unwrap();
        assert_eq!(task.running, open);
        assert_eq!(task.goal_status.as_deref(), Some("complete"));
        assert_eq!(
            json!(task.execution_state)["phase"],
            if open { "running" } else { "idle" }
        );
        let _ = fs::remove_dir_all(root);
    }
}
