// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn goal_activation_acknowledges_only_durable_recovery_ownership() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for fail_persistence in [false, true] {
                let isolated_home = tempfile::tempdir().unwrap();
                let _home = ScalarEnv::set(
                    "WEGENT_EXECUTOR_HOME",
                    isolated_home.path().to_str().unwrap(),
                );
                let (mut handler, root, request) = setup("native-goal-activation-ack");
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

#[tokio::test]
async fn passive_goal_metadata_cannot_invent_an_execution_profile() {
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
}

#[tokio::test]
async fn reactivated_native_goal_recovers_without_a_live_local_execution() {
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
}
