// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn reconciled_native_completion_releases_its_retained_capacity_without_a_notification() {
    let (handler, root, execution) = running_execution("reconciled-native-capacity");
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .active_task_ids
        .insert("task-1".into(), RuntimeTaskKind::Personal);
    handler.store.update_task("task-1", |link| {
        link.execution_state.as_mut().unwrap().process_generation = Some(0);
    });
    assert!(handler.finish_local_task_execution("task-1", execution));
    handler.finish_scheduled_turn("task-1").await;
    assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
    let expected = handler
        .local_execution_reconciliation_guard("task-1")
        .unwrap();
    assert!(handler.reconcile_terminal_local_execution(
        "task-1",
        "thread-1",
        "done",
        "confirmed-provider-completion",
        &expected,
        "turn-1",
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        while handler.get_runtime_capacity().await.unwrap()["active"] != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let operation = handler.turn_queue_operation.lock().await;
    drop(operation);
    fs::remove_dir_all(root).unwrap();
}

fn running_execution(label: &str) -> (RuntimeWorkRpcHandler, PathBuf, u64) {
    let (mut handler, root) = isolated_runtime_work_handler(label);
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    handler.upsert_local_task(link);
    let execution = start_test_execution(&handler, "task-1");
    set_native_turn(&handler, "turn-1");
    handler.record_active_codex_turn("task-1", execution, "thread-1".into(), "turn-1".into());
    (handler, root, execution)
}

fn set_native_turn(handler: &RuntimeWorkRpcHandler, turn_id: &str) {
    handler
        .store
        .update_task_without_snapshot("task-1", |link| {
            let mut state = crate::runtime_work::lifecycle::native_execution_state(link).unwrap();
            state.revision = crate::runtime_work::events::next_runtime_event_sequence().to_string();
            state.turn_id = Some(turn_id.into());
            state.latest_turn_id = Some(turn_id.into());
            state.phase = crate::runtime_work::lifecycle::NativeExecutionPhase::Running;
            crate::runtime_work::lifecycle::project_native_execution(link, &state);
        });
}

#[tokio::test]
async fn confirmed_completed_execution_retains_its_successful_native_outcome() {
    let (handler, root, _) = running_execution("confirmed-native-completion");
    let expected = handler
        .local_execution_reconciliation_guard("task-1")
        .unwrap();

    assert!(handler.reconcile_terminal_local_execution(
        "task-1",
        "thread-1",
        "done",
        "confirmed-provider-completion",
        &expected,
        "turn-1",
    ));

    let link = handler.store.get_task_summary("task-1").unwrap();
    let state = crate::runtime_work::lifecycle::native_execution_state(&link).unwrap();
    assert_eq!(state.outcome.as_deref(), Some("succeeded"));
    assert_eq!(state.execution_outcome.as_deref(), Some("succeeded"));
    assert_eq!(link.status, "done");
    assert!(!link.running);
    assert!(!handler.is_active_local_task("task-1"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn stale_provider_completion_cannot_settle_a_newer_execution_or_native_boundary() {
    for replacement in [
        "execution",
        "callback-turn",
        "native-boundary",
        "provider-turn",
    ] {
        let (handler, root, execution) = running_execution(&format!("stale-control-{replacement}"));
        let expected = handler
            .local_execution_reconciliation_guard("task-1")
            .unwrap();
        let current = match replacement {
            "execution" => start_test_execution(&handler, "task-1"),
            "callback-turn" => {
                handler.record_active_codex_turn(
                    "task-1",
                    execution,
                    "thread-1".into(),
                    "newer".into(),
                );
                execution
            }
            "provider-turn" => execution,
            _ => {
                set_native_turn(&handler, "newer");
                execution
            }
        };
        let before = handler.store.get_task_summary("task-1").unwrap();

        assert!(
            !handler.reconcile_terminal_local_execution(
                "task-1",
                "thread-1",
                "done",
                "stale-provider-completion",
                &expected,
                if replacement == "provider-turn" {
                    "older"
                } else {
                    "turn-1"
                },
            ),
            "{replacement}"
        );

        assert!(handler.is_current_local_task_execution("task-1", current));
        assert_eq!(
            handler
                .store
                .get_task_summary("task-1")
                .unwrap()
                .execution_state,
            before.execution_state
        );
        assert!(handler.store.get_task_summary("task-1").unwrap().running);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn explicit_force_completion_uses_the_same_success_outcome() {
    let (handler, root, _) = running_execution("force-native-completion");
    assert!(handler.force_settle_local_task_execution(
        "task-1",
        Some("thread-1".into()),
        "done",
        "provider-completion",
    ));
    let state = handler
        .store
        .get_task_summary("task-1")
        .unwrap()
        .execution_state
        .unwrap();
    assert_eq!(state.execution_outcome.as_deref(), Some("succeeded"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn persisted_running_state_can_settle_without_a_handle_but_cannot_take_a_new_handle() {
    for newer_execution in [false, true] {
        let (handler, root, old) =
            running_execution(&format!("handleless-reconcile-{newer_execution}"));
        assert!(handler.finish_local_task_execution("task-1", old));
        let expected = handler
            .local_execution_reconciliation_guard("task-1")
            .unwrap();
        let newer = newer_execution.then(|| start_test_execution(&handler, "task-1"));

        let settled = handler.reconcile_terminal_local_execution(
            "task-1",
            "thread-1",
            "done",
            "confirmed-provider-completion",
            &expected,
            "turn-1",
        );

        assert_eq!(settled, !newer_execution);
        let link = handler.store.get_task_summary("task-1").unwrap();
        if let Some(execution) = newer {
            assert!(handler.is_current_local_task_execution("task-1", execution));
            assert!(link.running);
            assert_ne!(
                link.execution_state.unwrap().execution_outcome.as_deref(),
                Some("succeeded")
            );
        } else {
            assert!(!link.running);
            assert_eq!(
                link.execution_state.unwrap().execution_outcome.as_deref(),
                Some("succeeded")
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn lagging_provider_metadata_cannot_overwrite_a_newer_terminal_native_outcome() {
    let (handler, root, execution) = running_execution("newer-native-terminal-boundary");
    set_native_turn(&handler, "newer-failed-turn");
    handler
        .store
        .update_task_without_snapshot("task-1", |link| {
            crate::runtime_work::lifecycle::settle_native_execution(link, "failed");
        });
    assert!(handler.finish_local_task_execution("task-1", execution));
    let expected = handler
        .local_execution_reconciliation_guard("task-1")
        .unwrap();
    let before = handler.store.get_task_summary("task-1").unwrap();
    assert!(before.execution_state.as_ref().unwrap().turn_id.is_none());

    assert!(!handler.reconcile_terminal_local_execution(
        "task-1",
        "thread-1",
        "done",
        "lagging-provider-completion",
        &expected,
        "older-turn",
    ));

    let after = handler.store.get_task_summary("task-1").unwrap();
    assert_eq!(after.execution_state, before.execution_state);
    assert_eq!(after.status, "failed");
    assert_eq!(
        after.execution_state.unwrap().execution_outcome.as_deref(),
        Some("failed")
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn provider_turn_completion_preserves_terminal_execution_facts_and_published_status() {
    for (outcome, expected_status) in [
        ("succeeded", "done"),
        ("failed", "failed"),
        ("cancelled", "cancelled"),
    ] {
        for (has_handle, stale_legacy_status) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let label = format!("native-authority-{outcome}-{has_handle}-{stale_legacy_status}");
            let (handler, root, execution) = running_execution(&label);
            handler
                .store
                .update_task_without_snapshot("task-1", |link| {
                    crate::runtime_work::lifecycle::settle_native_execution(link, outcome);
                    if stale_legacy_status {
                        link.running = true;
                        link.status = "running".into();
                    }
                });
            if !has_handle {
                assert!(handler.finish_local_task_execution("task-1", execution));
            }
            let before = handler
                .store
                .get_task_summary("task-1")
                .unwrap()
                .execution_state
                .unwrap();
            let expected = handler
                .local_execution_reconciliation_guard("task-1")
                .unwrap();

            assert!(
                handler.reconcile_terminal_local_execution(
                    "task-1",
                    "thread-1",
                    "done",
                    "provider-completed-turn",
                    &expected,
                    "turn-1",
                ),
                "{label}"
            );

            let published = handler.get_task(&json!({"taskId":"task-1"})).unwrap();
            assert_eq!(
                published["task"]["executionState"]["executionOutcome"], outcome,
                "{label}"
            );
            assert_eq!(
                published["task"]["executionState"]["outcome"],
                before.outcome.unwrap(),
                "{label}"
            );
            assert_eq!(published["task"]["status"], expected_status, "{label}");
            assert_eq!(published["task"]["running"], false, "{label}");
            assert_eq!(
                published["task"]["executionState"]["completedAt"],
                before.completed_at.unwrap(),
                "{label}"
            );
            assert!(!handler.is_active_local_task("task-1"));
            fs::remove_dir_all(root).unwrap();
        }
    }
}
