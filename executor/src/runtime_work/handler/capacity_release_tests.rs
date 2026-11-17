// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn failed_native_release_survives_follow_up_model_selection() {
    with_stopped_runtime(async {
        let (handler, root, request) =
            retained_failed_execution("failed-native-release-follow-up").await;
        let admission = handler.turn_queue_operation.lock().await;
        let mut terminal = notification("turn/completed", "turn-1");
        terminal["params"]["turn"]["status"] = json!("failed");
        handler.route_codex_notification(terminal);
        let terminal_state = handler
            .local_task_link("task-1")
            .unwrap()
            .execution_state
            .unwrap();
        assert_eq!(
            terminal_state.phase,
            crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
        );
        assert_eq!(terminal_state.outcome.as_deref(), Some("failed"));

        // An edited follow-up updates model metadata before admission. This
        // versions the task snapshot without changing the completed native turn.
        handler.mark_task_running_for_send(
            "task-1",
            "thread-1",
            "/project",
            &request,
            &json!({"modelSelection": {"modelName": "gpt-5.5", "modelType": "official"}}),
        );
        let retry_state = handler
            .local_task_link("task-1")
            .unwrap()
            .execution_state
            .unwrap();
        assert_ne!(retry_state.revision, terminal_state.revision);
        assert_eq!(retry_state.native_sequence, terminal_state.native_sequence);
        assert_eq!(
            retry_state.process_generation,
            terminal_state.process_generation
        );
        assert_eq!(retry_state.phase, terminal_state.phase);
        drop(admission);

        // Await the exact release worker, including its admission-lock recheck.
        handler
            .finish_settled_native_execution("task-1", &terminal_state)
            .await;
        assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 0);
        vec![root]
    });
}

#[test]
fn settled_native_release_drains_a_queued_retry_after_model_selection() {
    with_stopped_runtime(async {
        let (handler, root, mut request) =
            retained_failed_execution("failed-native-release-queued").await;
        let _startup = block_continuation_startup(&handler, &mut request).await;
        let admission = handler.turn_queue_operation.lock().await;
        let mut terminal = notification("turn/completed", "turn-1");
        terminal["params"]["turn"]["status"] = json!("failed");
        handler.route_codex_notification(terminal);
        let terminal_state = handler
            .local_task_link("task-1")
            .unwrap()
            .execution_state
            .unwrap();
        handler.mark_task_running_for_send(
            "task-1",
            "thread-1",
            "/project",
            &request,
            &json!({"modelSelection": {"modelName": "gpt-5.5", "modelType": "official"}}),
        );
        // Persist the follow-up while the old native reservation still owns admission.
        let (previous, queued) = {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            let previous = scheduler.clone();
            assert!(scheduler.enqueue(continuation(request)).is_none());
            (previous, scheduler.queued_turns.clone())
        };
        handler
            .persist_turn_queue(queued, Some(&previous), &[])
            .await
            .unwrap();
        assert_eq!(handler.queued_local_task_position("task-1"), Some(0));
        assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
        let projected = handler.get_task(&json!({"taskId": "task-1"})).unwrap();
        assert_eq!(projected["task"]["executionState"]["phase"], "queued");
        // Queue presentation must not replace the settled native reservation owner.
        assert_eq!(
            handler
                .local_task_link("task-1")
                .unwrap()
                .execution_state
                .unwrap()
                .phase,
            crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
        );
        drop(admission);

        handler
            .finish_settled_native_execution("task-1", &terminal_state)
            .await;
        assert_eq!(handler.queued_local_task_position("task-1"), None);
        assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
        // A duplicate completion worker cannot free the newly admitted reservation.
        handler
            .finish_settled_native_execution("task-1", &terminal_state)
            .await;
        assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
        vec![root]
    });
}

#[test]
fn old_native_completion_cannot_release_a_new_execution_owner() {
    with_stopped_runtime(async {
        let mut roots = Vec::new();
        for replacement in [
            "local",
            "native-starting",
            "native-running",
            "admitted",
            "generation",
            "sequence",
            "turn",
            "epoch",
            "preparation",
        ] {
            let (handler, root, request) = retained_failed_execution(replacement).await;
            let admission = handler.turn_queue_operation.lock().await;
            let mut terminal = notification("turn/completed", "turn-1");
            terminal["params"]["turn"]["status"] = json!("failed");
            handler.route_codex_notification(terminal);
            let terminal_state = handler
                .local_task_link("task-1")
                .unwrap()
                .execution_state
                .unwrap();
            replace_execution_owner(&handler, request, replacement).await;
            let replacement_state = handler.local_task_link("task-1").unwrap().execution_state;
            drop(admission);

            handler
                .finish_settled_native_execution("task-1", &terminal_state)
                .await;
            assert_eq!(
                handler.get_runtime_capacity().await.unwrap()["active"],
                1,
                "{replacement}"
            );
            assert_eq!(
                handler.local_task_link("task-1").unwrap().execution_state,
                replacement_state,
                "{replacement}"
            );
            roots.push(root);
        }
        roots
    });
}

#[test]
fn admitted_preparation_failure_or_cancellation_settles_native_state() {
    with_stopped_runtime(async {
        let mut roots = Vec::new();
        for cancelled in [false, true] {
            let (handler, root, request) = setup(if cancelled {
                "native-admission-preparation-cancelled"
            } else {
                "native-admission-preparation-failed"
            });
            let mut turn = continuation(request);
            // Invalid configuration fails before any workspace or process is created.
            turn.request
                .extra
                .insert(project_preparation::DEFERRED_ENVIRONMENT.into(), json!({}));
            let (previous, turn) = {
                let mut scheduler = handler.turn_scheduler.lock().unwrap();
                let previous = scheduler.clone();
                (previous, scheduler.enqueue_forced(turn))
            };
            handler
                .persist_turn_queue(
                    VecDeque::new(),
                    Some(&previous),
                    std::slice::from_ref(&turn),
                )
                .await
                .unwrap();
            handler.reserve_turn_preparation(&turn);
            if cancelled {
                assert!(handler.cancel_preparing_turn("task-1"));
            }
            let result = handler.prepare_and_start_reserved_turn(turn).await;
            assert_eq!(result.is_ok(), cancelled);
            assert!(!handler.has_local_execution_owner("task-1"));
            assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 0);
            let projected = handler.get_task(&json!({"taskId": "task-1"})).unwrap();
            assert_eq!(
                projected["task"]["status"],
                if cancelled { "cancelled" } else { "failed" }
            );
            assert_eq!(projected["task"]["running"], false);
            assert_eq!(projected["task"]["executionState"]["phase"], "idle");
            roots.push(root);
        }
        roots
    });
}

fn with_stopped_runtime(work: impl std::future::Future<Output = Vec<PathBuf>>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let roots = runtime.block_on(work);
    // Stop queued startup and completion workers before removing their files.
    drop(runtime);
    for root in roots {
        fs::remove_dir_all(root).unwrap();
    }
}

async fn replace_execution_owner(
    handler: &RuntimeWorkRpcHandler,
    request: ExecutionRequest,
    kind: &str,
) {
    match kind {
        "local" => {
            start_test_execution(handler, "task-1");
        }
        "native-starting" => {
            handler.store.update_task(
                "task-1",
                crate::runtime_work::lifecycle::begin_native_request,
            );
        }
        "native-running" => {
            handler.route_codex_notification(notification("turn/started", "turn-2"))
        }
        "admitted" => {
            let (previous, turn) = {
                let mut scheduler = handler.turn_scheduler.lock().unwrap();
                let previous = scheduler.clone();
                (previous, scheduler.enqueue_forced(continuation(request)))
            };
            handler
                .persist_turn_queue(VecDeque::new(), Some(&previous), &[turn])
                .await
                .unwrap();
            assert_eq!(
                handler
                    .local_task_link("task-1")
                    .unwrap()
                    .execution_state
                    .unwrap()
                    .phase,
                crate::runtime_work::lifecycle::NativeExecutionPhase::Starting
            );
            assert!(!handler.is_active_local_task("task-1"));
        }
        "preparation" => {
            let mut turn = continuation(request);
            turn.request
                .extra
                .insert(quota_recovery::MARKER.into(), json!({}));
            handler.reserve_turn_preparation(&turn);
        }
        _ => {
            handler.store.update_task("task-1", |link| {
                let state = link.execution_state.as_mut().unwrap();
                state.revision = next_runtime_event_sequence().to_string();
                match kind {
                    "generation" => state.process_generation = Some(42),
                    "sequence" => state.native_sequence += 1,
                    "turn" => state.latest_turn_id = Some("turn-2".into()),
                    "epoch" => state.epoch = "replacement-epoch".into(),
                    _ => unreachable!(),
                }
            });
        }
    }
}

async fn retained_failed_execution(
    label: &str,
) -> (RuntimeWorkRpcHandler, PathBuf, ExecutionRequest) {
    let (handler, root, request) = setup(label);
    handler
        .store
        .update_task("task-1", |link| link.goal_status = None);
    let execution = start_test_execution(&handler, "task-1");
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .active_task_ids
        .insert("task-1".into(), RuntimeTaskKind::Personal);
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    // A nonretryable error can finish the local request before native completion.
    assert!(handler.finish_local_task("task-1", execution, Some("thread-1".into()), "failed"));
    handler
        .finish_command_execution("task-1", execution, None, None)
        .await;
    assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
    (handler, root, request)
}

async fn block_continuation_startup(
    handler: &RuntimeWorkRpcHandler,
    request: &mut ExecutionRequest,
) -> tokio::sync::OwnedSemaphorePermit {
    request
        .extra
        .insert(RESTORED_TURN_MARKER.into(), json!(true));
    // Exercise admission and draining without starting a provider request.
    Arc::clone(&handler.restore_startup_semaphore)
        .acquire_many_owned(handler.restore_startup_semaphore.available_permits() as u32)
        .await
        .unwrap()
}

fn continuation(request: ExecutionRequest) -> SpawnTurnRequest {
    SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-1".into(),
        runtime: "codex".into(),
        request,
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: Some("thread-1".into()),
        initial_thread_goal: None,
    }
}
