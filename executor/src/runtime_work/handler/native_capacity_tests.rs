use super::*;

#[tokio::test]
async fn native_continuation_retains_capacity_after_local_control_finishes() {
    for clear_during_turn in [false, true] {
        let (handler, root, mut request) = setup("native-capacity-after-local-control");
        handler
            .turn_scheduler
            .lock()
            .unwrap()
            .active_task_ids
            .insert("task-1".into(), RuntimeTaskKind::Personal);
        let execution = start_test_execution(&handler, "task-1");
        handler.route_codex_notification(notification("turn/started", "turn-1"));
        if !clear_during_turn {
            handler.route_codex_notification(notification("turn/completed", "turn-1"));
        }
        assert!(handler.finish_local_task_execution("task-1", execution));
        handler.finish_scheduled_turn("task-1").await;
        assert!(handler.native_task_holds_capacity("task-1"));
        assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
        assert!(!handler.is_active_local_task("task-1"));
        request
            .extra
            .insert("wegent_resume_goal_only".into(), json!(true));
        for payload in [
            json!({"taskId":"task-1", "message":"duplicate recovery"}),
            json!({"taskId":"task-1", "message":"resume", "executionRequest":request}),
        ] {
            let duplicate = handler.send_message(payload).await.unwrap();
            assert_eq!(duplicate["success"], false);
            assert_eq!(duplicate["code"], "bad_request");
            assert_eq!(duplicate["error"], "runtime task is already running");
            assert_eq!(handler.queued_local_task_position("task-1"), None);
        }

        handler.route_codex_notification(json!({"method":"thread/goal/cleared",
            "params":{"threadId":"thread-1"}}));
        if clear_during_turn {
            assert!(handler.native_task_holds_capacity("task-1"));
        } else {
            // A new native turn can overtake asynchronous release of the old one.
            handler.store.update_task(
                "task-1",
                crate::runtime_work::lifecycle::begin_native_request,
            );
            tokio::task::yield_now().await;
            assert_eq!(handler.get_runtime_capacity().await.unwrap()["active"], 1);
            handler.route_codex_notification(notification("turn/started", "turn-2"));
        }
        handler.route_codex_notification(notification(
            "turn/completed",
            if clear_during_turn {
                "turn-1"
            } else {
                "turn-2"
            },
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
        let _ = fs::remove_dir_all(root);
    }
}

#[tokio::test]
async fn terminal_native_capacity_release_survives_pending_question_metadata() {
    let (handler, root, _) = setup("native-capacity-question-metadata");
    handler
        .store
        .update_task("task-1", |link| link.goal_status = Some("blocked".into()));
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .active_task_ids
        .insert("task-1".into(), RuntimeTaskKind::Personal);
    let operation = handler.turn_queue_operation.lock().await;
    handler.route_codex_notification(notification("turn/started", "turn-1"));
    handler.route_codex_notification(notification("turn/completed", "turn-1"));
    let before = handler
        .local_task_link("task-1")
        .unwrap()
        .execution_state
        .unwrap();
    assert_eq!(
        before.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
    );
    handler.store.update_task("task-1", |link| {
        link.interaction_status = Some(INTERACTION_AWAITING_USER_REPLY.into());
    });
    let after = handler
        .local_task_link("task-1")
        .unwrap()
        .execution_state
        .unwrap();
    assert_ne!(before.revision, after.revision);
    assert_eq!(before.native_sequence, after.native_sequence);
    drop(operation);
    tokio::time::timeout(Duration::from_secs(2), async {
        while handler.get_runtime_capacity().await.unwrap()["active"] != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("A pending question must not retain a completed native turn's worker slot");
    let operation = handler.turn_queue_operation.lock().await;
    drop(operation);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn committed_admission_retains_capacity_before_local_worker_starts() {
    let (handler, root, mut request) = setup("native-capacity-new-admission");
    handler
        .store
        .update_task("task-1", |link| link.goal_status = None);
    handler
        .turn_scheduler
        .lock()
        .unwrap()
        .active_task_ids
        .insert("task-1".into(), RuntimeTaskKind::Personal);
    let operation = handler.turn_queue_operation.lock().await;
    handler.route_codex_notification(notification("turn/started", "old-turn"));
    handler.route_codex_notification(notification("turn/completed", "old-turn"));
    tokio::task::yield_now().await;
    request.subtask_id = "new-request".into();
    handler
        .persist_turn_queue(
            VecDeque::new(),
            None,
            &[SpawnTurnRequest {
                platform_command: None,
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
            }],
        )
        .await
        .unwrap();
    let admitted = handler
        .local_task_link("task-1")
        .unwrap()
        .execution_state
        .unwrap();
    assert_eq!(
        admitted.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Starting
    );
    assert!(!handler.is_active_local_task("task-1"));
    handler.route_codex_notification(notification("turn/completed", "old-turn"));
    assert_eq!(
        handler
            .local_task_link("task-1")
            .unwrap()
            .execution_state
            .unwrap()
            .phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Starting,
        "A delayed completion for the previous turn must not settle a committed admission"
    );
    drop(operation);
    let operation = handler.turn_queue_operation.lock().await;
    assert!(
        handler
            .turn_scheduler
            .lock()
            .unwrap()
            .active_task_ids
            .contains_key("task-1"),
        "Old native cleanup must not free the newly admitted worker's reservation"
    );
    drop(operation);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn previous_turn_completion_cannot_overwrite_failed_admission() {
    let (handler, root, _) = setup("native-failed-admission-old-completion");
    handler
        .store
        .update_task("task-1", |link| link.goal_status = None);
    handler.route_codex_notification(notification("turn/started", "old-turn"));
    handler.route_codex_notification(notification("turn/completed", "old-turn"));
    handler.store.update_task("task-1", |link| {
        crate::runtime_work::lifecycle::begin_native_request(link);
        apply_local_task_failure(
            link,
            &AppIpcError::new("preparation_failed", "Setup failed"),
        );
    });
    handler.route_codex_notification(notification("turn/completed", "old-turn"));
    let task = handler.local_task_link("task-1").unwrap();
    let state = task.execution_state.as_ref().unwrap();
    assert_eq!(
        state.phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Idle
    );
    assert_eq!(state.execution_outcome.as_deref(), Some("failed"));
    assert_eq!(
        crate::runtime_work::response::local_task_json(task)["status"],
        "failed"
    );
    fs::remove_dir_all(root).unwrap();
}
