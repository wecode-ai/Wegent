use super::*;

async fn check_replacement_is_not_cancelled(with_execution: bool) {
    let (handler, root) =
        super::super::tests::isolated_runtime_work_handler("preparation-cancel-generation");
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task".into(),
        "/tmp/project".into(),
        "Task".into(),
    ));
    handler.preparing_turns.lock().unwrap().insert(
        "task".into(),
        PreparingTurn {
            owner_request: None,
            cancellation_requested: false,
        },
    );
    let (cancel, mut cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    let original =
        with_execution.then(|| handler.start_local_task_execution("task".into(), cancel, stopped));
    let gate = handler.task_send_gate("task");
    let owned_gate = gate.lock().await;
    let queue_operation = handler.turn_queue_operation.lock().await;
    let competing_send = gate.lock();
    tokio::pin!(competing_send);
    assert!(futures_util::poll!(competing_send.as_mut()).is_pending());
    let first = handler.cancel_task(json!({"taskId":"task"}));
    let repeated = handler.cancel_task(json!({"taskId":"task"}));
    tokio::pin!(first, repeated);
    let std::task::Poll::Ready(response) = futures_util::poll!(first.as_mut()) else {
        panic!("Cancellation must acknowledge before either send gate owner can release");
    };
    assert_eq!(response.unwrap()["accepted"], true);
    if with_execution {
        assert_eq!(cancelled.try_recv(), Ok(()));
    }
    let std::task::Poll::Ready(response) = futures_util::poll!(repeated.as_mut()) else {
        panic!("Repeated preparation cancellation must acknowledge without waiting");
    };
    assert_eq!(response.unwrap()["accepted"], true);
    assert!(handler.preparing_turns.lock().unwrap()["task"].cancellation_requested);

    if let Some(original) = original {
        handler.finish_local_task_execution("task", original);
    }
    drop(owned_gate);
    let competing_owner = tokio::time::timeout(Duration::from_secs(1), competing_send.as_mut())
        .await
        .unwrap();
    handler.preparing_turns.lock().unwrap().insert(
        "task".into(),
        PreparingTurn {
            owner_request: None,
            cancellation_requested: false,
        },
    );
    let (cancel, mut replacement_cancelled) = oneshot::channel();
    let (_replacement_stopped, stopped) = oneshot::channel();
    let replacement = handler.start_local_task_execution("task".into(), cancel, stopped);
    assert!(handler.is_local_task_execution_accepting_notifications("task", replacement));
    assert!(!handler.preparing_turns.lock().unwrap()["task"].cancellation_requested);
    assert!(matches!(
        replacement_cancelled.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    drop(competing_owner);
    drop(queue_operation);
    handler.finish_local_task_execution("task", replacement);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn captured_worktree_cancellation_acknowledges_before_a_competing_send() {
    check_replacement_is_not_cancelled(false).await;
}

#[tokio::test]
async fn captured_quota_cancellation_acknowledges_before_a_competing_send() {
    check_replacement_is_not_cancelled(true).await;
}

fn owner_preparation(owner: &Value) -> SpawnTurnRequest {
    let mut request = ExecutionRequest::default();
    request
        .extra
        .insert(stand_in_proposal_continuations::OWNER.into(), owner.clone());
    request.extra.insert(
        "deferred_worktree_source_path".into(),
        json!("/tmp/project"),
    );
    SpawnTurnRequest::new("task".into(), "codex".into(), request)
}

async fn check_owner_invalidation(replacement_admitted: bool) {
    let (handler, root) =
        super::super::tests::isolated_runtime_work_handler("preparation-owner-cancellation");
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task".into(),
        "/tmp/project".into(),
        "Task".into(),
    ));
    let original = json!({
        "id":"original-owner", "revision":1, "taskId":"task", "userId":1,
        "deviceId":"device-1", "roleId":"assistant", "cancelled":false
    });
    let replacement = json!({
        "id":"replacement-owner", "revision":2, "taskId":"task", "userId":1,
        "deviceId":"device-1", "roleId":"assistant", "cancelled":false
    });
    handler.record_stand_in_owner_admission("task", &original);
    handler.reserve_turn_preparation(&owner_preparation(&original));
    if replacement_admitted {
        handler.record_stand_in_owner_admission("task", &replacement);
    }
    assert_eq!(
        handler.cancel_task(json!({"taskId":"task"})).await.unwrap()["accepted"],
        true
    );
    let owner = handler.local_task_link("task").unwrap().runtime_handle
        [stand_in_proposal_continuations::OWNER]
        .clone();
    if replacement_admitted {
        assert_eq!(owner, replacement);
    } else {
        assert_eq!(owner["cancelled"], true);
        let mut expected = original.clone();
        expected["cancelled"] = json!(true);
        assert_eq!(owner, expected);
    }
    assert_eq!(
        handler.cancel_task(json!({"taskId":"task"})).await.unwrap()["accepted"],
        true
    );
    assert_eq!(
        handler.local_task_link("task").unwrap().runtime_handle
            [stand_in_proposal_continuations::OWNER],
        owner
    );
    assert!(handler.preparing_turns.lock().unwrap()["task"].cancellation_requested);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn cancelling_preparation_invalidates_its_still_current_owner_request() {
    check_owner_invalidation(false).await;
}

#[tokio::test]
async fn cancelling_old_preparation_preserves_an_already_admitted_replacement_owner() {
    check_owner_invalidation(true).await;
}

async fn check_owner_persistence_failure(preparing: bool) {
    let (mut handler, root) =
        super::super::tests::isolated_runtime_work_handler("owner-cancellation-persistence");
    let owner = json!({
        "id":"original-owner", "revision":1, "taskId":"task", "userId":1,
        "deviceId":"device-1", "roleId":"assistant", "cancelled":false
    });
    let mut link =
        RuntimeTaskLink::new_pending("task".into(), "/tmp/project".into(), "Task".into());
    link.runtime_handle["origin"] = json!({"userId":1,"standInId":"assistant"});
    handler.upsert_local_task(link);
    handler.record_stand_in_owner_admission("task", &owner);
    if preparing {
        handler.reserve_turn_preparation(&owner_preparation(&owner));
    }
    let (cancel, mut cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    let execution = handler.start_local_task_execution("task".into(), cancel, stopped);
    let gate = handler.task_send_gate("task");
    let guard = if preparing {
        Some(gate.lock().await)
    } else {
        None
    };
    // The valid index remains readable, but the atomic writer's additional
    // temporary-file suffix exceeds the filesystem's component length limit.
    let index = root.join("runtime-work").join("i".repeat(250));
    fs::copy(root.join("runtime-work/index.json"), &index).unwrap();
    handler.store = RuntimeWorkStore::new(index.clone());

    let result = handler.cancel_task(json!({"taskId":"task"}));
    tokio::pin!(result);
    let std::task::Poll::Ready(result) = futures_util::poll!(result.as_mut()) else {
        panic!("Persistence failure must not wait on provider I/O or its send gate");
    };
    assert_eq!(result.unwrap_err().code, "owner_request_persistence_failed");
    assert_eq!(cancelled.try_recv(), Ok(()));
    assert_eq!(
        handler.local_task_link("task").unwrap().runtime_handle
            [stand_in_proposal_continuations::OWNER],
        owner
    );
    assert_eq!(
        RuntimeWorkStore::new(index)
            .get_task("task")
            .unwrap()
            .runtime_handle[stand_in_proposal_continuations::OWNER],
        owner
    );
    if preparing {
        assert!(handler.preparing_turns.lock().unwrap()["task"].cancellation_requested);
    }
    drop(guard);
    handler.finish_local_task_execution("task", execution);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn preparation_stop_is_signalled_when_owner_persistence_fails() {
    check_owner_persistence_failure(true).await;
}

#[tokio::test]
async fn active_stop_is_signalled_when_owner_persistence_fails() {
    check_owner_persistence_failure(false).await;
}
