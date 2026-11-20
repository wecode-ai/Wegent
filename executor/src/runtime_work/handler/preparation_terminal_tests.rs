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
        assert_eq!(
            wire["runtimeHandle"]["startupFailure"]["failedAt"],
            wire["completedAt"],
        );
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

#[tokio::test]
async fn preparation_failure_survives_refresh_and_replaces_a_previous_success() {
    let (mut handler, root) = isolated_runtime_work_handler("preparation-failure-refresh");
    handler.store.upsert_task(RuntimeTaskLink::new_pending(
        "task".into(),
        "/workspace".into(),
        "Task".into(),
    ));
    let request = ExecutionRequest {
        task_id: "task".into(),
        subtask_id: "prepare".into(),
        ..Default::default()
    };
    handler.store.update_task("task", |link| {
        link.runtime_handle["startupFailure"] = json!({"detail":"keep"});
        link.status = "failed".into();
    });
    let error = "Agent Skills directory contains unmanaged entries";
    handler.persist_failed_assistant_message("task", &request, error);
    handler.store = RuntimeWorkStore::new(handler.store.index_path().to_path_buf());
    let mut response = handler.transcript(json!({"taskId":"task"})).await.unwrap();
    assert_eq!(response["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        response["turns"][0]["errorType"],
        "skills_unmanaged_entries"
    );
    assert_eq!(
        response["turns"][0]["errorInfo"]["retry_policy"],
        "after_change"
    );
    let restored = handler.store.get_task("task").unwrap();
    assert!(restored.runtime_handle["messages"].is_null());
    assert_eq!(restored.runtime_handle["startupFailure"]["detail"], "keep");
    append_preparation_failure(&mut response, &restored);
    assert_eq!(response["messages"].as_array().unwrap().len(), 1);
    let context = handler
        .transcript(json!({"taskId":"task","conversationContextOnly":true}))
        .await
        .unwrap();
    assert!(context["messages"].as_array().unwrap().is_empty());

    handler
        .store
        .update_task("task", |link| link.thread_id = Some("thread".into()));
    for method in ["turn/started", "turn/completed"] {
        handler.apply_native_lifecycle(
            "task",
            &request,
            &json!({"method":method,"params":{"threadId":"thread",
                "turn":{"id":"native-success","status":"completed"}}})
            .into(),
        );
        assert!(handler.store.get_task("task").unwrap().runtime_handle["startupFailure"].is_null());
    }
    let retry = ExecutionRequest {
        subtask_id: "prepare-again".into(),
        ..request
    };
    handler
        .store
        .update_task("task", |link| link.status = "failed".into());
    handler.persist_failed_assistant_message("task", &retry, error);
    let restored = RuntimeWorkStore::new(handler.store.index_path().to_path_buf())
        .get_task("task")
        .unwrap();
    assert_eq!(restored.runtime_handle["lastTurnId"], "native-success");
    assert_eq!(
        restored.runtime_handle["startupFailure"]["subtaskId"],
        "prepare-again"
    );
    let history = json!({"id":"native-success","status":"done",
        "items":[{"id":"native-answer","type":"assistant_text","content":"Actual history"}]});
    let mut response =
        json!({"threadId":"thread","messages":[],"turns":[history.clone()],"hasMoreAfter":false});
    append_preparation_failure(&mut response, &restored);
    assert_eq!(response["turns"][0], history);
    assert_eq!(response["turns"][1]["id"], "prepare-again");
    assert_eq!(response["turns"][1]["errorInfo"]["stage"], "prepare");
    let mut older_page = json!({"threadId":"thread","messages":[],"turns":[],"hasMoreAfter":true});
    append_preparation_failure(&mut older_page, &restored);
    assert!(older_page["messages"].as_array().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}
