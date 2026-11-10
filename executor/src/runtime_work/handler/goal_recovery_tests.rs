// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn run_goal_test(test: impl std::future::Future<Output = ()>) {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

fn block_goal_admission(handler: &RuntimeWorkRpcHandler) {
    let mut scheduler = handler.turn_scheduler.lock().unwrap();
    scheduler.settings.max_concurrent_tasks = 1;
    scheduler
        .active_task_ids
        .insert("another-task".into(), RuntimeTaskKind::Personal);
}

#[test]
fn activating_an_owned_goal_does_not_admit_another_continuation() {
    run_goal_test(async {
        for local_owner in [false, true] {
            let (handler, root, request) = setup("native-goal-live-owner");
            handler.store.update_task("task-1", |link| {
                store_runtime_execution_request(&mut link.runtime_handle, &request);
            });
            handler.journal_active_goal_turn("task-1", None);
            let execution = if local_owner {
                Some(start_test_execution(&handler, "task-1"))
            } else {
                handler.route_codex_notification(notification("turn/started", "turn-1"));
                assert!(handler.native_task_holds_capacity("task-1"));
                None
            };
            assert!(!handler.resume_active_goal("task-1").await.unwrap());
            assert!(handler
                .turn_scheduler
                .lock()
                .unwrap()
                .queued_turns
                .is_empty());
            if let Some(execution) = execution {
                handler.finish_local_task_execution("task-1", execution);
            }
            handler.sync_runtime_task_goal_status("task-1", None);
            handler.persist_current_turn_state().await.unwrap();
            let _ = fs::remove_dir_all(root);
        }
    });
}

#[test]
fn concurrent_goal_activations_admit_only_one_owned_resume() {
    run_goal_test(async {
        let (handler, root, request) = setup("native-goal-readmission-race");
        handler.store.update_task("task-1", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.journal_active_goal_turn("task-1", None);
        block_goal_admission(&handler);
        let (first, second) = tokio::join!(
            handler.resume_active_goal("task-1"),
            handler.resume_active_goal("task-1")
        );
        assert_eq!(
            [first.unwrap(), second.unwrap()]
                .into_iter()
                .filter(|value| *value)
                .count(),
            1
        );
        {
            let scheduler = handler.turn_scheduler.lock().unwrap();
            assert_eq!(scheduler.queued_turns.len(), 1);
            assert_eq!(scheduler.queued_turns[0].request.prompt, json!(""));
            assert_eq!(
                scheduler.queued_turns[0].request.extra[RESUME_GOAL_ONLY_MARKER],
                true
            );
        }
        handler.persist_current_turn_state().await.unwrap();
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn failed_goal_readmission_preserves_its_previous_recovery_intent() {
    run_goal_test(async {
        let (mut handler, root, request) = setup("native-goal-readmission-write-failure");
        handler.store.update_task("task-1", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.journal_active_goal_turn("task-1", None);
        handler.persist_current_turn_state().await.unwrap();
        block_goal_admission(&handler);
        let blocked = root.join("blocked-queue-parent");
        fs::write(&blocked, "not a directory").unwrap();
        let previous_queue_path = handler.turn_queue_path.clone();
        handler.turn_queue_path = Arc::new(blocked.join("queue.json"));
        assert_eq!(
            handler.resume_active_goal("task-1").await.unwrap_err().code,
            "runtime_queue_failed"
        );
        assert!(handler
            .active_goal_turns
            .lock()
            .unwrap()
            .contains_key("task-1"));
        assert_eq!(
            handler
                .local_task_link("task-1")
                .unwrap()
                .goal_execution_status
                .as_deref(),
            Some("running")
        );
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
        assert!(turns::read_runtime_turn_state(&previous_queue_path)
            .unwrap()
            .active_goal_turns
            .contains_key("task-1"));
        let operation = handler.turn_queue_operation.lock().await;
        drop(operation);
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn goal_activation_acknowledges_only_durable_recovery_ownership() {
    run_goal_test(async {
        for fail_persistence in [false, true] {
            let (mut handler, root, request) = setup("native-goal-activation-ack");
            block_goal_admission(&handler);
            handler.store.update_task("task-1", |link| {
                link.thread_id = Some("11111111-1111-4111-8111-111111111111".into());
                link.goal_status = Some("paused".into());
                store_runtime_execution_request(&mut link.runtime_handle, &request);
            });
            install_native_history(&mut handler, &root, vec![], None);
            fs::write(
                root.join("thread_goal_set.json"),
                json!({
                    "goal":{"status":"active", "tokensUsed":10}
                })
                .to_string(),
            )
            .unwrap();
            if fail_persistence {
                let blocked = root.join("blocked-queue-parent");
                fs::write(&blocked, "not a directory").unwrap();
                handler.turn_queue_path = Arc::new(blocked.join("queue.json"));
            }
            let result = handler
                .set_task_goal(json!({
                    "taskId":"task-1", "status":"active"
                }))
                .await;
            if fail_persistence {
                assert_eq!(result.unwrap_err().code, "runtime_queue_failed");
                assert!(handler
                    .active_goal_turns
                    .lock()
                    .unwrap()
                    .contains_key("task-1"));
            } else {
                let response = result.unwrap();
                assert_eq!(response["success"], true, "{response}");
                assert_eq!(
                    response["resumed"], true,
                    "An unloaded Goal needs an owned continuation"
                );
                let repeated = handler
                    .set_task_goal(json!({
                        "taskId":"task-1", "status":"active"
                    }))
                    .await
                    .unwrap();
                assert_eq!(repeated["resumed"], false);
                assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.len(), 1);
                assert!(turns::read_runtime_turn_state(&handler.turn_queue_path)
                    .unwrap()
                    .active_goal_turns
                    .contains_key("task-1"));
            }
            handler.codex_app_server.restart().await;
            let operation = handler.turn_queue_operation.lock().await;
            drop(operation);
            let _ = fs::remove_dir_all(root);
        }
    });
}

#[test]
fn passive_goal_metadata_cannot_invent_an_execution_profile() {
    run_goal_test(async {
        let (handler, root, _) = setup("native-unowned-goal-profile");
        handler.route_codex_notification(notification("turn/started", "turn-1"));
        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"active", "tokensUsed":10}
        }}));
        handler.persist_current_turn_state().await.unwrap();
        assert!(turns::read_runtime_turn_state(&handler.turn_queue_path)
            .unwrap()
            .active_goal_turns
            .is_empty());
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn reactivated_native_goal_recovers_without_a_live_local_execution() {
    run_goal_test(async {
        let (handler, root, mut request) = setup("native-reactivated-goal-recovery");
        request.model_config = json!({"model":"retained-model"});
        request
            .extra
            .insert("runtime_command_id".into(), json!("finished-user-command"));
        handler.store.update_task("task-1", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.route_codex_notification(notification("turn/started", "old-turn"));
        handler.route_codex_notification(notification("turn/completed", "old-turn"));
        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"paused", "tokensUsed":10}
        }}));
        assert!(!handler.is_active_local_task("task-1"));
        assert!(handler.active_goal_turns.lock().unwrap().is_empty());

        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"active", "tokensUsed":10}
        }}));
        handler.persist_current_turn_state().await.unwrap();
        let restored = turns::read_runtime_turn_state(&handler.turn_queue_path).unwrap();
        let turn = restored.active_goal_turns.get("task-1").expect(
        "Reactivating a native Goal must restore durable recovery ownership without a user send",
    );
        assert_eq!(turn.resume_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(turn.request.model_config["model"], "retained-model");
        assert_eq!(turn.request.prompt, json!(""));
        assert_eq!(turn.request.extra[RESUME_GOAL_ONLY_MARKER], true);
        assert!(!turn.request.extra.contains_key("runtime_command_id"));
        assert!(restored.queued_turns.is_empty());
        assert!(!handler.is_active_local_task("task-1"));
        handler.sync_runtime_task_goal_status("task-1", Some("paused".into()));
        handler.persist_current_turn_state().await.unwrap();
        assert!(turns::read_runtime_turn_state(&handler.turn_queue_path)
            .unwrap()
            .active_goal_turns
            .is_empty());
        let _ = fs::remove_dir_all(root);
    });
}
