use super::super::tests::isolated_runtime_work_handler;
use super::*;

fn assert_preparation_terminal_state(cancelled: bool) {
    let (handler, root) = isolated_runtime_work_handler("preparation-terminal-state");
    handler.store.upsert_task(RuntimeTaskLink::new_pending(
        "task".into(),
        "/workspace".into(),
        "Task".into(),
    ));
    handler
        .store
        .update_task("task", crate::runtime_work::lifecycle::begin_native_request);
    if cancelled {
        handler.mark_deferred_worktree_cancelled("task");
    } else {
        let turn = SpawnTurnRequest {
            task_kind: None,
            local_task_id: "task".into(),
            runtime: "codex".into(),
            request: ExecutionRequest {
                task_id: "task".into(),
                subtask_id: "prepare".into(),
                ..Default::default()
            },
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        };
        handler.mark_deferred_worktree_failed(
            &turn,
            &AppIpcError::new("preparation_failed", "Setup failed"),
        );
    }
    let task = handler.store.get_task("task").unwrap();
    let state = task.execution_state.as_ref().unwrap();
    let outcome = if cancelled { "cancelled" } else { "failed" };
    assert_eq!(
        state.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
    );
    assert_eq!(state.execution_outcome.as_deref(), Some(outcome));
    let wire = crate::runtime_work::response::local_task_json(task);
    assert_eq!(wire["running"], false);
    assert_eq!(wire["status"], outcome);
    if !cancelled {
        assert_eq!(wire["runtimeHandle"]["lastErrorCode"], "preparation_failed");
    }
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn failed_preparation_settles_committed_native_admission() {
    assert_preparation_terminal_state(false);
}

#[tokio::test]
async fn cancelled_preparation_settles_committed_native_admission() {
    assert_preparation_terminal_state(true);
}
