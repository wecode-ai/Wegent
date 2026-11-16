// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::tasks::runtime_model_selection_changed;
use super::turns::{read_runtime_turn_queue, write_runtime_turn_queue};
use super::*;

#[path = "tests/im_callback_routing.rs"]
mod im_callback_routing;

#[path = "superseded_turn_tests.rs"]
mod superseded_turn_tests;

#[cfg(unix)]
#[path = "codex_startup_tests.rs"]
mod codex_startup_tests;

#[test]
fn connection_mcp_transport_and_discovery_never_resume_persisted_model_turns() {
    for method in [
        "runtime.connections.mcp",
        "runtime.connections.cli",
        "runtime.connections.host",
        "runtime.connections.catalog",
        "runtime.connections.resources",
        "runtime.connections.dependencies.inventory",
        "runtime.python.has_demand",
    ] {
        assert!(
            !should_resume_persisted_turns_before_rpc(method),
            "{method}"
        );
    }
    assert!(should_resume_persisted_turns_before_rpc(
        "runtime.tasks.start"
    ));
}

#[path = "native_history_test_support.rs"]
pub(super) mod native_history_test_support;
pub(super) use native_history_test_support::install_native_history;

#[path = "command_recovery_tests.rs"]
mod command_recovery_tests;

#[path = "native_timeline_tests.rs"]
mod native_timeline_tests;

#[path = "stand_in_review_pagination_tests.rs"]
mod stand_in_review_pagination_tests;

#[path = "runtime_rpc_tests.rs"]
mod runtime_rpc_tests;

#[path = "text_generation_tests.rs"]
mod text_generation_tests;

#[path = "default_work_item_projection_tests.rs"]
mod default_work_item_projection_tests;

#[path = "local_history_tests.rs"]
mod local_history_tests;
#[path = "workspace_identity_tests.rs"]
mod workspace_identity_tests;

#[path = "mcp_elicitation_tests.rs"]
mod mcp_elicitation_tests;

#[path = "async_question_tests.rs"]
mod async_question_tests;

#[path = "issue_question_hint_tests.rs"]
mod issue_question_hint_tests;

#[path = "inventory_read_tests.rs"]
mod inventory_read_tests;

#[path = "execution_timestamp_tests.rs"]
mod execution_timestamp_tests;

#[path = "task_title_tests.rs"]
mod task_title_tests;

#[path = "task_lookup_tests.rs"]
mod task_lookup_tests;

#[path = "task_rename_tests.rs"]
mod task_rename_tests;
#[path = "transcript_turn_status_tests.rs"]
mod transcript_turn_status_tests;

#[path = "async_question_delivery_tests.rs"]
mod async_question_delivery_tests;

/// Restores one environment variable when a test finishes.
pub(in crate::runtime_work) struct ScalarEnv {
    key: &'static str,
    previous: Option<String>,
}

impl ScalarEnv {
    pub(in crate::runtime_work) fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for ScalarEnv {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}
#[path = "task_project_move_tests.rs"]
mod task_project_move_tests;

#[path = "message_presentation_tests.rs"]
mod message_presentation_tests;

#[path = "project_preparation_tests.rs"]
mod project_preparation_tests;

#[test]
fn runtime_proxy_configuration_precedes_persisted_turn_recovery() {
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.codex.runtime_config.update"
    ));
    assert!(should_resume_persisted_turns_before_rpc(
        "runtime.codex.ensure_started"
    ));
    assert!(should_resume_persisted_turns_before_rpc(
        "runtime.codex.models.list"
    ));
}

#[test]
fn runtime_proxy_configuration_releases_deferred_startup_recovery() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (event_tx, _) = broadcast::channel(1);
            let handler = RuntimeWorkRpcHandler::with_event_sender_deferred_startup_recovery(
                "device-1",
                "/bin/false",
                event_tx,
                None,
                None,
            );
            assert!(handler.startup_recovery_deferred.load(Ordering::Acquire));

            handler
                .dispatch(
                    "runtime.codex.runtime_config.update",
                    json!({"proxyUrl": "http://127.0.0.1:7890"}),
                )
                .await
                .expect("runtime proxy configuration should succeed before recovery");

            let config = handler.codex_runtime_proxy_config.lock().await;
            assert!(config.initialized);
            assert_eq!(config.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
            drop(config);
            assert!(
                handler.worktree_reconciliation_state.lock().await.completed,
                "successful runtime proxy configuration should release deferred recovery"
            );
            assert!(!handler.startup_recovery_deferred.load(Ordering::Acquire));
        });
}

#[test]
fn defaults_to_ten_parallel_runtime_tasks() {
    assert_eq!(
        RuntimeSettings::default().max_concurrent_tasks,
        DEFAULT_MAX_CONCURRENT_TASKS
    );
    assert_eq!(DEFAULT_MAX_CONCURRENT_TASKS, 10);
}

#[test]
fn restore_startup_concurrency_defaults_to_two_without_reducing_runtime_capacity() {
    assert_eq!(normalized_restore_startup_concurrency(None, 10), 2);
    assert_eq!(normalized_restore_startup_concurrency(Some(8), 10), 8);
    assert_eq!(normalized_restore_startup_concurrency(Some(20), 10), 10);
    assert_eq!(normalized_restore_startup_concurrency(Some(0), 10), 1);
}

#[test]
fn running_task_count_uses_process_local_execution_state() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let (first_cancel, _first_cancel_rx) = oneshot::channel();
    let (_first_stopped, first_stopped_rx) = oneshot::channel();
    let first_execution =
        handler.start_local_task_execution("task-1".to_owned(), first_cancel, first_stopped_rx);
    let (second_cancel, _second_cancel_rx) = oneshot::channel();
    let (_second_stopped, second_stopped_rx) = oneshot::channel();
    handler.start_local_task_execution("task-2".to_owned(), second_cancel, second_stopped_rx);

    assert_eq!(handler.running_task_count()["runningCount"], 2);
    assert!(handler.finish_local_task_execution("task-1", first_execution));
    assert_eq!(handler.running_task_count()["runningCount"], 1);
}

#[tokio::test]
async fn runtime_capacity_rpc_reports_scheduler_truth() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    {
        let mut scheduler = handler
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned");
        scheduler.settings = RuntimeSettings::uniform(4);
        scheduler.active_task_ids = HashMap::from([
            ("active-1".to_owned(), RuntimeTaskKind::Personal),
            ("active-2".to_owned(), RuntimeTaskKind::Personal),
        ]);
        scheduler.queued_turns = VecDeque::from([SpawnTurnRequest {
            task_kind: None,
            local_task_id: "queued-1".to_owned(),
            runtime: "codex".to_owned(),
            request: ExecutionRequest::default(),
            send_payload: None,
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        }]);
    }

    let capacity = handler
        .get_runtime_capacity()
        .await
        .expect("capacity should be available");

    assert_eq!(capacity["limit"], 12);
    assert_eq!(capacity["active"], 2);
    assert_eq!(capacity["queued"], 1);
    let active_task_ids = capacity["active_task_ids"]
        .as_array()
        .expect("active task ids should be an array")
        .iter()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    assert_eq!(active_task_ids, HashSet::from(["active-1", "active-2"]));
}

#[tokio::test]
async fn create_task_persists_collaboration_member_runtime_profiles() {
    let (handler, root) = isolated_runtime_work_handler("collaboration-member-profiles");
    {
        let mut scheduler = handler
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned");
        scheduler.settings = RuntimeSettings::uniform(1);
        scheduler
            .active_task_ids
            .insert("busy".into(), RuntimeTaskKind::Personal);
    }
    let profiles = json!([{
        "memberIds": ["agent-2"],
        "runtimePayload": {
            "taskId": "member-template",
            "runtime": "codex"
        }
    }]);
    let request = ExecutionRequest {
        task_id: "manager-task-1".to_owned(),
        subtask_id: "manager-task-1-initial".to_owned(),
        prompt: Value::String("Manage the Issue".to_owned()),
        project_workspace_path: Some("/tmp/project".to_owned()),
        ..ExecutionRequest::default()
    };

    let response = handler
        .create_task(json!({
            "schemaVersion": 1,
            "taskId": "manager-task-1",
            "runtime": "codex",
            "title": "Issue manager",
            "workspacePath": "/tmp/project",
            "executionRequest": request,
            "runtimeHandle": {
                "collaborationManagerContext": "Issue context",
                "collaborationDispatchTaskId": "dispatch-task-1",
                "collaborationMemberRuntimeProfiles": profiles,
            }
        }))
        .await
        .expect("manager task should be accepted");

    assert_eq!(response["accepted"], true);
    assert_eq!(
        handler
            .local_task_link("manager-task-1")
            .expect("manager task should be persisted")
            .runtime_handle["collaborationMemberRuntimeProfiles"],
        profiles
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn deferred_worktree_preparation_can_be_cancelled_before_runtime_start() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let mut turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-1".to_owned(),
        runtime: "codex".to_owned(),
        request: ExecutionRequest::default(),
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    };
    turn.request.extra.insert(
        "deferred_worktree_source_path".to_owned(),
        Value::String("/tmp/source".to_owned()),
    );

    handler.reserve_turn_preparation(&turn);

    assert!(handler.cancel_preparing_turn("task-1"));
    assert_eq!(
        handler
            .preparing_turns
            .lock()
            .expect("preparing turn map lock should not be poisoned")
            .get("task-1"),
        Some(&PreparingTurn {
            cancellation_requested: true
        })
    );
}

#[tokio::test]
async fn archive_stop_waits_for_worktree_preparation_ack() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let mut turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-1".to_owned(),
        runtime: "codex".to_owned(),
        request: ExecutionRequest::default(),
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    };
    turn.request.extra.insert(
        "deferred_worktree_source_path".to_owned(),
        Value::String("/tmp/source".to_owned()),
    );
    handler.reserve_turn_preparation(&turn);

    let waiter = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .wait_for_worktree_preparation_to_finish("task-1")
                .await
        })
    };
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());

    handler
        .preparing_turns
        .lock()
        .expect("preparing turn map lock should not be poisoned")
        .remove("task-1");

    assert!(waiter.await.expect("preparation waiter should finish"));
}

#[tokio::test]
async fn cancelled_deferred_worktree_is_removed_before_runtime_start() {
    let root =
        temp_runtime_work_index_path("cancelled-worktree-cleanup").with_extension("directory");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    initialize_test_repository(&source);
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.worktrees = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let plan = handler.worktrees.plan(&source, "task-1", None).unwrap();
    let mut request = ExecutionRequest {
        project_workspace_path: Some(source.display().to_string()),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "deferred_worktree_source_path".to_owned(),
        Value::String(source.display().to_string()),
    );
    request.extra.insert(
        "deferred_worktree_path".to_owned(),
        Value::String(plan.path.display().to_string()),
    );
    let turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-1".to_owned(),
        runtime: "codex".to_owned(),
        request,
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    };
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        plan.path.display().to_string(),
        "Task".to_owned(),
    ));
    handler.reserve_turn_preparation(&turn);
    assert!(handler.cancel_preparing_turn("task-1"));

    handler
        .prepare_and_start_reserved_turn(turn)
        .await
        .expect("cancelled preparation should clean up without starting a runtime");

    assert!(!plan.path.exists());
    assert!(
        !plan.path.parent().unwrap().exists(),
        "cancelled preparation must remove the empty task container"
    );
    assert!(!handler.is_active_local_task("task-1"));
    let task = handler
        .store
        .get_task("task-1")
        .expect("cancelled task should remain diagnosable");
    assert_eq!(task.status, "cancelled");
    let listed = handler
        .worktrees
        .list(&handler.store.list_task_summaries(true))
        .unwrap();
    assert!(
        listed.is_empty(),
        "terminal cleanup must not retain a Worktree tombstone"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn archive_waits_for_runtime_stopped_ack_before_marking_task_archived() {
    let root = temp_runtime_work_index_path("archive-stopped-ack").with_extension("directory");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (stopped_tx, stopped_rx) = oneshot::channel();
    handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);

    let archive = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .archive_task(json!({
                    "taskId": "task-1",
                    "workspacePath": "/tmp/project"
                }))
                .await
        })
    };

    tokio::time::timeout(Duration::from_secs(1), cancel_rx)
        .await
        .expect("archive should request runtime cancellation")
        .expect("runtime cancellation channel should remain open");
    tokio::task::yield_now().await;
    assert!(!archive.is_finished());
    assert_ne!(handler.store.get_task("task-1").unwrap().status, "archived");

    stopped_tx
        .send(())
        .expect("runtime stopped acknowledgement should be delivered");
    let response = archive
        .await
        .expect("archive task should finish")
        .expect("archive should succeed after stopped acknowledgement");

    assert_eq!(response["accepted"], true);
    assert_eq!(handler.store.get_task("task-1").unwrap().status, "archived");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn terminal_completion_after_stop_timeout_unblocks_archive_retry() {
    let root =
        temp_runtime_work_index_path("archive-stop-timeout-retry").with_extension("directory");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    initialize_test_repository(&source);
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.worktrees = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let worktree = handler
        .worktrees
        .prepare(&source, "task-1", None, false)
        .unwrap();
    let worktree_path = worktree.path.clone();
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        worktree.path.clone(),
        "Task".to_owned(),
    );
    link.status = "active".to_owned();
    handler.upsert_local_task(link);
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (stopped_tx, stopped_rx) = oneshot::channel();
    let execution_id =
        handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);

    assert!(
        !handler
            .abort_active_turn_with_timeout("task-1", Duration::from_millis(20))
            .await,
        "the first stop attempt must time out while the runtime withholds its acknowledgement"
    );
    tokio::time::timeout(Duration::from_secs(1), cancel_rx)
        .await
        .expect("the first stop attempt should send cancellation")
        .expect("the runtime cancellation receiver should remain available");
    assert!(handler.is_active_local_task("task-1"));
    assert!(Path::new(&worktree.path).exists());
    assert!(
        handler.finish_local_task_execution("task-1", execution_id),
        "a terminal runtime result must settle the execution when stop acknowledgement is lost"
    );
    let retry = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .archive_task(json!({
                    "taskId": "task-1",
                    "workspacePath": worktree_path,
                }))
                .await
        })
    };
    let response = tokio::time::timeout(Duration::from_secs(1), retry)
        .await
        .expect("archive retry should finish after terminal completion")
        .expect("archive retry task should not panic")
        .expect("archive retry should return an IPC response");
    drop(stopped_tx);

    assert_eq!(response["accepted"], true);
    assert_eq!(handler.store.get_task("task-1").unwrap().status, "archived");
    assert!(!handler.is_active_local_task("task-1"));
    handler
        .worktrees
        .delete(Path::new(&worktree.path), true)
        .expect("snapshot-preserving cleanup should succeed");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn closed_stopped_channel_does_not_count_as_a_stop_acknowledgement() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (stopped_tx, stopped_rx) = oneshot::channel();
    handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);
    drop(stopped_tx);

    assert!(
        !handler
            .abort_active_turn_with_timeout("task-1", Duration::from_millis(20))
            .await,
        "a closed stopped channel must fail closed instead of impersonating an acknowledgement"
    );
    tokio::time::timeout(Duration::from_secs(1), cancel_rx)
        .await
        .expect("the stop attempt should still send cancellation")
        .expect("the runtime cancellation receiver should remain available");
    assert!(
        handler.is_active_local_task("task-1"),
        "retry state must remain active when no explicit stopped acknowledgement was received"
    );
}

#[tokio::test]
async fn cancel_timeout_force_settles_task_and_returns_success() {
    let (handler, root) = isolated_runtime_work_handler("cancel-timeout-force-settle");
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (stopped_tx, stopped_rx) = oneshot::channel();
    handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);

    let response = handler
        .cancel_task_with_timeout(
            json!({
                "taskId": "task-1",
                "workspacePath": "/tmp/project",
            }),
            Duration::from_millis(20),
        )
        .await
        .expect("cancel should return a successful IPC response");

    assert_eq!(response["accepted"], true);
    assert_eq!(response["cleanupPending"], true);
    assert!(!handler.is_active_local_task("task-1"));
    let task = handler
        .local_task_link("task-1")
        .expect("cancelled task should remain stored");
    assert_eq!(task.status, "cancelled");
    assert!(!task.running);
    tokio::time::timeout(Duration::from_secs(1), cancel_rx)
        .await
        .expect("cancel should be sent before forced settlement")
        .expect("cancel receiver should remain available");
    drop(stopped_tx);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn stopped_turn_guard_acknowledges_scope_exit() {
    let (stopped_tx, stopped_rx) = oneshot::channel();

    {
        let _guard = StoppedTurnGuard::new(stopped_tx);
    }

    stopped_rx
        .await
        .expect("dropping the turn scope should acknowledge the stop");
}

#[tokio::test]
async fn runtime_terminal_cancellation_settles_execution_after_stop_request_times_out() {
    let root =
        temp_runtime_work_index_path("stopped-turn-final-consistency").with_extension("directory");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    initialize_test_repository(&source);
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.worktrees = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let worktree = handler
        .worktrees
        .prepare(&source, "task-1", None, false)
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        worktree.path.clone(),
        "Task".to_owned(),
    ));
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (stopped_tx, stopped_rx) = oneshot::channel();
    let execution_id =
        handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);
    let _stopped_sender = stopped_tx;

    assert!(
        !handler
            .abort_active_turn_with_timeout("task-1", Duration::from_millis(20))
            .await,
        "the stop request should time out while the turn scope remains active"
    );
    tokio::time::timeout(Duration::from_secs(1), cancel_rx)
        .await
        .expect("the stop attempt should send cancellation")
        .expect("the runtime cancellation receiver should remain available");
    assert!(handler.is_active_local_task("task-1"));

    handler.settle_cancelled_local_task_execution("task-1", execution_id);

    assert!(
        !handler.is_active_local_task("task-1"),
        "the runtime terminal result must settle stale active state without another stop request"
    );
    let task = handler
        .store
        .get_task("task-1")
        .expect("the stopped task should remain persisted");
    assert_eq!(task.status, "cancelled");
    assert!(!task.running);
    assert!(task.completed_at.is_some());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn unarchive_restores_managed_worktree_before_reactivating_task() {
    let root =
        temp_runtime_work_index_path("unarchive-worktree-restore").with_extension("directory");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    initialize_test_repository(&source);
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.worktrees = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let worktree = handler
        .worktrees
        .prepare(&source, "task-1", None, false)
        .unwrap();
    handler
        .worktrees
        .delete(Path::new(&worktree.path), true)
        .unwrap();
    assert!(!Path::new(&worktree.path).exists());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        worktree.path.clone(),
        "Task".to_owned(),
    );
    link.status = "archived".to_owned();
    handler.upsert_local_task(link);

    let response = handler
        .unarchive_task(json!({
            "taskId": "task-1",
            "workspacePath": worktree.path,
        }))
        .await
        .expect("unarchive should return an IPC response");

    assert_eq!(response["accepted"], true);
    assert!(Path::new(response["workspacePath"].as_str().unwrap()).exists());
    assert_eq!(handler.store.get_task("task-1").unwrap().status, "active");
    let listed = handler
        .worktrees
        .list(&handler.store.list_task_summaries(true))
        .unwrap();
    assert_eq!(listed[0].0.state, "active");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn unarchive_restore_failure_is_an_action_failure_and_keeps_task_archived() {
    let root =
        temp_runtime_work_index_path("unarchive-worktree-failure").with_extension("directory");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    let worktree_state_path = root.join("runtime-work").join("worktrees.json");
    initialize_test_repository(&source);
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.worktrees = WorktreeManager::new(worktree_state_path.clone());
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let worktree = handler
        .worktrees
        .prepare(&source, "task-1", None, false)
        .unwrap();
    handler
        .worktrees
        .delete(Path::new(&worktree.path), true)
        .unwrap();
    let mut worktree_state: Value =
        serde_json::from_str(&fs::read_to_string(&worktree_state_path).unwrap()).unwrap();
    let persisted_record = worktree_state["records"]
        .as_object_mut()
        .and_then(|records| records.values_mut().next())
        .expect("snapshot deletion should persist a restorable Worktree");
    persisted_record["snapshotRef"] = Value::Null;
    fs::write(
        &worktree_state_path,
        serde_json::to_vec_pretty(&worktree_state).unwrap(),
    )
    .unwrap();
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        worktree.path.clone(),
        "Task".to_owned(),
    );
    link.status = "archived".to_owned();
    handler.upsert_local_task(link);

    let response = handler
        .unarchive_task(json!({
            "taskId": "task-1",
            "workspacePath": worktree.path,
        }))
        .await
        .expect("restore failure should remain an action response");

    assert_eq!(response["accepted"], false);
    assert!(response["error"]
        .as_str()
        .unwrap()
        .contains("Worktree snapshot is unavailable"));
    assert!(!Path::new(response["workspacePath"].as_str().unwrap()).exists());
    assert_eq!(handler.store.get_task("task-1").unwrap().status, "archived");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn blocking_worktree_restore_join_failure_is_diagnostic() {
    let error = super::archives::run_worktree_restore_blocking(|| {
        panic!("simulated worktree restore panic");
        #[allow(unreachable_code)]
        Ok(false)
    })
    .await
    .expect_err("a blocking restore panic should become a diagnostic error");

    assert!(error.contains("Worktree restore task failed"));
    assert!(error.contains("simulated worktree restore panic"));
}

#[test]
fn worktree_restore_helper_keeps_the_async_runtime_responsive() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let runtime_progressed = Arc::new(AtomicBool::new(false));
    let restore_progress = Arc::clone(&runtime_progressed);
    let timeout_release = Arc::clone(&runtime_progressed);
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async move {
            let async_progress = Arc::clone(&restore_progress);
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                async_progress.store(true, Ordering::SeqCst);
            });
            super::archives::run_worktree_restore_blocking(move || {
                while !restore_progress.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
                Ok(true)
            })
            .await
        });
        result_tx.send(result).unwrap();
    });

    let result = match result_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result,
        Err(error) => {
            timeout_release.store(true, Ordering::SeqCst);
            worker.join().unwrap();
            panic!("blocking restore starved the async runtime: {error}");
        }
    };
    worker.join().unwrap();

    assert!(result.unwrap());
}

#[tokio::test]
async fn automatic_prune_removes_old_archived_worktree_and_preserves_snapshot() {
    let root = temp_runtime_work_index_path("automatic-worktree-prune").with_extension("directory");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    initialize_test_repository(&source);
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(root.join("runtime-work").join("index.json"));
    handler.worktrees = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            auto_cleanup_enabled: Some(true),
            keep_count: Some(1),
        })
        .unwrap();
    let old = handler
        .worktrees
        .prepare(&source, "task-old", None, false)
        .unwrap();
    std::thread::sleep(Duration::from_millis(2));
    let newest = handler
        .worktrees
        .prepare(&source, "task-new", None, false)
        .unwrap();
    for (task_id, path) in [
        ("task-old", old.path.as_str()),
        ("task-new", newest.path.as_str()),
    ] {
        let mut link =
            RuntimeTaskLink::new_pending(task_id.to_owned(), path.to_owned(), task_id.to_owned());
        link.status = "archived".to_owned();
        link.updated_at = 1;
        handler.upsert_local_task(link);
    }

    let batch = handler
        .worktrees
        .prune_auto_batch(&handler.store.list_task_summaries(true))
        .expect("automatic prune batch should succeed");

    assert_eq!(batch.removed.len(), 1);
    assert_eq!(batch.removed[0].path, old.path);
    assert_eq!(batch.removed[0].state, "restorable");
    assert!(batch.removed[0].snapshot_ref.is_some());
    assert!(!Path::new(&old.path).exists());
    assert!(Path::new(&newest.path).exists());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn restart_reconciliation_fails_interrupted_task_without_starting_runtime() {
    let (handler, root) = isolated_runtime_work_handler("restart-worktree-reconciliation");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    let state_path = root.join("runtime-work").join("worktrees.json");
    initialize_test_repository(&source);
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let record = handler
        .worktrees
        .prepare(&source, "task-1", None, false)
        .unwrap();
    let mut state = serde_json::from_slice::<Value>(&fs::read(&state_path).unwrap()).unwrap();
    state["records"]
        .as_object_mut()
        .unwrap()
        .get_mut(&record.path.replace('\\', "/"))
        .expect("prepared record should be persisted")["state"] = json!("preparing");
    fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
    let mut link =
        RuntimeTaskLink::new_pending("task-1".to_owned(), record.path.clone(), "Task".to_owned());
    link.status = "running".to_owned();
    link.running = true;
    handler.upsert_local_task(link);

    handler.reconcile_worktrees_once().await;

    let task = handler
        .store
        .get_task("task-1")
        .expect("interrupted task should remain stored");
    assert_eq!(task.status, "failed");
    assert_eq!(task.thread_status, "failed");
    assert_eq!(task.turn_status.as_deref(), Some("failed"));
    assert!(!task.running);
    assert!(task.runtime_handle["lastError"]
        .as_str()
        .unwrap()
        .contains("runtime was not resumed"));
    assert!(!handler.is_active_local_task("task-1"));
    let listed = handler
        .worktrees
        .list(&handler.store.list_task_summaries(true))
        .unwrap();
    assert_eq!(listed[0].0.state, "active");
    assert!(listed[0]
        .0
        .last_error
        .as_deref()
        .unwrap()
        .contains("runtime was not resumed"));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn restart_reconciliation_leaves_active_history_unchanged() {
    let (mut handler, root) = isolated_runtime_work_handler("restart-active-worktree");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    initialize_test_repository(&source);
    let index_path = root.join("runtime-work").join("index.json");
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let record = handler
        .worktrees
        .prepare(&source, "task-active", None, false)
        .unwrap();
    let mut link = RuntimeTaskLink::new_pending(
        "task-active".to_owned(),
        record.path.clone(),
        "Active Worktree".to_owned(),
    );
    link.status = "running".to_owned();
    link.running = true;
    link.updated_at = 1_780_000_000_000;
    link.completed_at = Some(1_780_000_000_000);
    handler.upsert_local_task(link);

    handler.store = RuntimeWorkStore::new(index_path);
    assert!(handler.reconcile_worktrees_once().await);

    let task = handler
        .store
        .get_task("task-active")
        .expect("historical Worktree task should remain available");
    assert_eq!(task.status, "active");
    assert!(!task.running);
    assert_eq!(task.updated_at, 1_780_000_000_000);
    assert_eq!(task.completed_at, None);
    assert!(task.runtime_handle.get("lastError").is_none());
    assert!(Path::new(&record.path).exists());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn restart_reconciliation_leaves_queued_worktree_idle_without_failure() {
    let (mut handler, root) = isolated_runtime_work_handler("restart-queued-worktree");
    let source = root.join("source");
    let managed_root = root.join("workspace").join("worktrees");
    let index_path = root.join("runtime-work").join("index.json");
    let queue_path = root.join("runtime-work").join("turn-queue.json");
    initialize_test_repository(&source);
    handler
        .worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let plan = handler
        .worktrees
        .plan(&source, "task-queued", None)
        .unwrap();
    let mut link = RuntimeTaskLink::new_pending(
        "task-queued".to_owned(),
        plan.path.display().to_string(),
        "Queued Worktree".to_owned(),
    );
    link.updated_at = 1_780_000_000_000;
    link.runtime_handle = json!({"queuePosition": 1});
    handler.upsert_local_task(link);

    let mut request = ExecutionRequest {
        project_workspace_path: Some(plan.path.display().to_string()),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "deferred_worktree_source_path".to_owned(),
        Value::String(source.display().to_string()),
    );
    request.extra.insert(
        "deferred_worktree_path".to_owned(),
        Value::String(plan.path.display().to_string()),
    );
    let interrupted = VecDeque::from([SpawnTurnRequest {
        task_kind: None,
        local_task_id: "task-queued".to_owned(),
        runtime: "codex".to_owned(),
        request,
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    }]);
    write_runtime_turn_queue(&queue_path, &interrupted).unwrap();
    handler.store = RuntimeWorkStore::new(index_path);
    assert!(handler.reconcile_worktrees_once().await);

    let task = handler
        .store
        .get_task("task-queued")
        .expect("queued task should remain available");
    assert_eq!(task.status, "active");
    assert!(!task.running);
    assert_eq!(task.updated_at, 1_780_000_000_000);
    assert_eq!(task.completed_at, None);
    assert!(task.runtime_handle.get("queuePosition").is_none());
    assert!(task.runtime_handle.get("lastError").is_none());
    assert!(!handler.is_active_local_task("task-queued"));
    assert!(!plan.path.exists());
    assert!(
        read_runtime_turn_queue(&queue_path)
            .expect("reconciled queue should remain readable")
            .is_empty(),
        "interrupted Worktree turn must be removed from the persisted queue"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn failed_worktree_reconciliation_remains_retryable() {
    let (mut handler, root) = isolated_runtime_work_handler("restart-reconciliation-retry");
    fs::create_dir_all(&root).unwrap();
    let blocked_parent = root.join("blocked");
    fs::write(&blocked_parent, "not a directory").unwrap();
    handler.worktrees = WorktreeManager::new(blocked_parent.join("worktrees.json"));

    assert!(!handler.reconcile_worktrees_once().await);
    fs::remove_file(&blocked_parent).unwrap();
    fs::create_dir_all(&blocked_parent).unwrap();
    assert!(
        !handler.reconcile_worktrees_once().await,
        "an immediate retry should be throttled after a persistent failure"
    );
    {
        let mut reconciliation = handler.worktree_reconciliation_state.lock().await;
        assert!(!reconciliation.completed);
        reconciliation.last_attempt = Some(Instant::now() - WORKTREE_RECONCILIATION_RETRY_INTERVAL);
    }
    assert!(
        handler.reconcile_worktrees_once().await,
        "a transient reconciliation failure must remain retryable"
    );

    let _ = fs::remove_dir_all(root);
}

fn start_test_execution(handler: &RuntimeWorkRpcHandler, local_task_id: &str) -> u64 {
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped) = oneshot::channel();
    handler.start_local_task_execution(local_task_id.to_owned(), cancel, stopped)
}

fn finish_test_native_turn(handler: &RuntimeWorkRpcHandler, task_id: &str, thread_id: &str) {
    for method in ["turn/started", "turn/completed"] {
        let status = if method == "turn/started" {
            "inProgress"
        } else {
            "completed"
        };
        handler.apply_native_lifecycle(
            task_id,
            &ExecutionRequest::default(),
            &json!({"method": method, "params": {"threadId": thread_id,
                "turn": {"id": "test-native-turn", "status": status}}})
            .into(),
        );
    }
}

pub(super) fn isolated_runtime_work_handler(label: &str) -> (RuntimeWorkRpcHandler, PathBuf) {
    let root = temp_runtime_work_index_path(label).with_extension("directory");
    let runtime_work_dir = root.join("runtime-work");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.transcript_test_workers = Some(Arc::new(tokio::sync::Semaphore::new(2)));
    handler.store = RuntimeWorkStore::new(runtime_work_dir.join("index.json"));
    handler.worktrees = WorktreeManager::new(runtime_work_dir.join("worktrees.json"));
    handler.turn_queue_path = Arc::new(runtime_work_dir.join("turn-queue.json"));
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.automation_store =
        crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
    handler
        .turn_scheduler
        .lock()
        .expect("runtime turn scheduler lock should not be poisoned")
        .queued_turns
        .clear();
    (handler, root)
}

fn next_content_event(
    receiver: &mut broadcast::Receiver<Value>,
) -> Result<Value, broadcast::error::TryRecvError> {
    loop {
        let event = receiver.try_recv()?;
        if event["event"] != "runtime.turn.updated" {
            return Ok(event);
        }
        assert!(event["payload"]["data"]["task"]["executionState"]["revision"].is_string());
        assert_eq!(
            event["payload"]["data"]["task"]["taskId"],
            event["payload"]["taskId"]
        );
    }
}

#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

#[path = "pre_admission_transcript_tests.rs"]
mod pre_admission_transcript_tests;

#[path = "active_transcript_responsiveness_tests.rs"]
mod active_transcript_responsiveness_tests;

#[path = "control_metadata_tests.rs"]
mod control_metadata_tests;

#[path = "execution_control_tests.rs"]
mod execution_control_tests;

impl RuntimeWorkRpcHandler {
    // Test the same route/publication/hook handoff used by the two real subscriptions.
    async fn deliver_native_notification_for_execution(
        &self,
        task_id: &str,
        execution_id: u64,
        request: &ExecutionRequest,
        active: Option<ActiveCodexTurn>,
        message: impl Into<CodexNotification>,
    ) {
        let mut message = message.into();
        if let Some(turn) = &active {
            self.record_active_codex_turn(
                task_id,
                execution_id,
                turn.thread_id.clone(),
                turn.turn_id.clone(),
            );
            if codex_notification_turn_id(&message).is_none() {
                message["params"]["turnId"] = json!(turn.turn_id);
            }
        }
        if let Some(thread) = active
            .as_ref()
            .map(|turn| turn.thread_id.clone())
            .or_else(|| codex_notification_thread_id(&message))
            .or_else(|| {
                self.local_task_link(task_id)
                    .and_then(|link| link.thread_id)
            })
        {
            if codex_notification_thread_id(&message).is_none() {
                message["params"]["threadId"] = json!(thread);
            }
            if !self.thread_event_route_exists(&thread) {
                self.record_local_task_thread(task_id, &thread);
                if !self.thread_event_route_exists(&thread) {
                    self.register_thread_event_route(
                        &thread,
                        task_id.into(),
                        request.clone(),
                        true,
                    );
                }
            }
        }
        self.route_codex_notification(message.clone());
        self.observe_execution_codex_notification(task_id, execution_id, request, active, message)
            .await;
    }
}

#[path = "background_terminal_tests.rs"]
mod background_terminal_tests;

#[path = "streaming_transcript_tests.rs"]
mod streaming_transcript_tests;

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

#[tokio::test]
async fn running_codex_older_page_bypasses_live_cache() {
    let (handler, root) = isolated_runtime_work_handler("running-older-page");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    set_transcript_snapshot_messages(
        &mut link.runtime_handle,
        "thread-1",
        vec![json!({
            "id": "latest", "role": "assistant", "content": "Cached output"
        })],
        Some("native-before".to_owned()),
        None,
    );
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");
    let result = handler.handle_runtime_rpc(json!({
        "method": "runtime.tasks.transcript",
        "payload": {"taskId": "task-1", "workspacePath": "/tmp/project", "beforeCursor": "native-before"}
    })).await;
    // /bin/false cannot provide older records: returning cached latest records
    // would incorrectly hide this provider read failure.
    assert!(
        result.is_err(),
        "older pages must be read from native history"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn active_codex_items_replace_stale_paginated_items() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
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
fn live_codex_items_do_not_mark_partial_history_complete() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/completed",
            "params": {"turnId": "turn-1", "item": {
                "id": "latest", "type": "agentMessage", "text": "Latest output"
            }}
        }),
    );
    for view in ["summary", "notLoaded", "full"] {
        let mut thread = json!({"turns": [{
            "id": "turn-1", "itemsView": view, "items": []
        }]});
        handler.merge_active_codex_transcript("task-1", &mut thread);
        assert_eq!(thread["turns"][0]["itemsView"], view);
        assert_eq!(thread["turns"][0]["items"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn active_codex_plan_deltas_restore_complete_streaming_content() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/plan/delta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "plan-1",
                "delta": "# Plan\n"
            }
        }),
    );
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/plan/delta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "plan-1",
                "delta": "\n- Inspect the repo."
            }
        }),
    );

    let messages = handler.active_codex_transcript_messages("task-1");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["status"], "streaming");
    assert_eq!(messages[0]["blocks"][0]["id"], "plan-plan-1");
    assert_eq!(messages[0]["blocks"][0]["type"], "plan");
    assert_eq!(
        messages[0]["blocks"][0]["content"],
        "# Plan\n\n- Inspect the repo."
    );
    assert_eq!(messages[0]["blocks"][0]["status"], "streaming");
}

#[test]
fn late_codex_items_do_not_recreate_cleared_active_transcript() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
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
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-live");
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
async fn running_codex_transcript_reads_native_order_with_provisional_live_output() {
    let (mut handler, root) = isolated_runtime_work_handler("running-live-cache");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    set_transcript_snapshot_messages(
        &mut link.runtime_handle,
        "thread-1",
        vec![
            json!({
                "id": "historical-user",
                "role": "user",
                "content": "Explain the approach",
                "createdAt": 1_779_999_999_000_i64,
            }),
            json!({
                "id": "historical-assistant",
                "role": "assistant",
                "content": "Use divide and conquer",
                "createdAt": 1_779_999_999_500_i64,
            }),
        ],
        Some("native-before".to_owned()),
        None,
    );
    set_runtime_handle_messages(
        &mut link.runtime_handle,
        vec![json!({
            "id": "user-1",
            "role": "user",
            "content": "Implement quicksort",
            "createdAt": 1_780_000_000_000_i64,
        })],
    );
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-completed");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-completed",
        &json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-completed",
                "item": {
                    "id": "message-completed",
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": "Initial implementation complete"
                }
            }
        }),
    );
    handler.persist_and_clear_active_codex_transcript("task-1", "completed", None);
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-live");
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
                    "text": "Writing quicksort"
                }
            }
        }),
    );
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-live",
        &json!({
            "method": "item/plan/delta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-live",
                "itemId": "plan-live",
                "delta": "# Quicksort plan\n"
            }
        }),
    );
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-live",
        &json!({
            "method": "item/plan/delta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-live",
                "itemId": "plan-live",
                "delta": "\n- Partition the input."
            }
        }),
    );

    install_native_history(
        &mut handler,
        &root,
        vec![
            json!({"id":"historical-turn","status":"completed","items":[
              {"id":"historical-user","type":"userMessage","content":[{"type":"inputText","text":"Explain the approach"}]},
              {"id":"historical-assistant","type":"agentMessage","phase":"final_answer","text":"Use divide and conquer"}
            ]}),
            json!({"id":"turn-completed","status":"completed","items":[
              {"id":"user-1","type":"userMessage","content":[{"type":"inputText","text":"Implement quicksort"}]},
              {"id":"message-completed","type":"agentMessage","phase":"final_answer","text":"Initial implementation complete"}
            ]}),
            json!({"id":"turn-live","status":"inProgress","items":[
              {"id":"message-live","type":"agentMessage","phase":"commentary","text":"Writing quicksort"}
            ]}),
        ],
        Some("native-before"),
    );
    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "task-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("running transcript should use the live cache");

    assert_eq!(transcript["running"], true);
    assert_eq!(transcript["hasMoreBefore"], true);
    assert!(transcript["beforeCursor"]
        .as_str()
        .unwrap()
        .starts_with("wework-codex-timeline:"));
    assert!(transcript["beforeCursor"]
        .as_str()
        .unwrap()
        .contains("native-before"));
    assert_eq!(transcript["messages"].as_array().unwrap().len(), 5);
    assert_eq!(transcript["messages"][0]["content"], "Explain the approach");
    assert_eq!(
        transcript["messages"][1]["content"],
        "Use divide and conquer"
    );
    assert_eq!(transcript["messages"][2]["content"], "Implement quicksort");
    assert_eq!(
        transcript["messages"][3]["content"],
        "Initial implementation complete"
    );
    assert_eq!(
        transcript["messages"][4]["blocks"][0]["content"],
        "Writing quicksort"
    );
    let plan = transcript["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["blocks"].as_array().into_iter().flatten())
        .find(|block| block["id"] == "plan-plan-live")
        .expect("the live view should retain its active plan without replaying cached history");
    assert_eq!(plan["type"], "plan");
    assert_eq!(
        plan["content"],
        "# Quicksort plan\n\n- Partition the input."
    );
    assert_eq!(plan["status"], "streaming");
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn running_codex_transcript_deduplicates_cached_and_live_user_aliases() {
    let (mut handler, root) = isolated_runtime_work_handler("running-user-alias");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    // Native history was loaded before the subsequent notification-only updates.
    set_transcript_snapshot_messages(&mut link.runtime_handle, "thread-1", Vec::new(), None, None);
    set_runtime_handle_messages(
        &mut link.runtime_handle,
        vec![json!({
            "id": "cached-user",
            "clientUserMessageId": "client-user-1",
            "role": "user",
            "content": "Create the verification file",
            "createdAt": 1_780_000_000_000_i64,
        })],
    );
    append_runtime_handle_user_message_presentation(
        &mut link.runtime_handle,
        json!({
            "clientUserMessageId": "client-user-1",
            "content": "Create the verification file",
            "createdAt": 1_780_000_000_000_i64,
            "ensureVisible": true,
        }),
    );
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");
    handler.record_runtime_turn_id("task-1", "subtask-1", "turn-1", Some("client-user-1"));
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-1",
        &json!({
            "method": "item/started",
            "params": {
                "turnId": "turn-1",
                "item": {
                    "id": "provider-user",
                    "clientId": "client-user-1",
                    "type": "userMessage",
                    "content": [{
                        "type": "inputText",
                        "text": "Create the verification file"
                    }]
                }
            }
        }),
    );

    install_native_history(
        &mut handler,
        &root,
        vec![json!({"id":"turn-1","status":"inProgress","items":[
          {"id":"provider-user","clientId":"client-user-1","type":"userMessage","content":[{"type":"inputText","text":"Create the verification file"}]}
        ]})],
        None,
    );
    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "task-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("running transcript should merge the cached and provider user aliases");

    let user_messages = transcript["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(user_messages.len(), 1);
    assert_eq!(user_messages[0]["id"], "provider-user");
    assert_eq!(user_messages[0]["clientUserMessageId"], "client-user-1");
    assert_eq!(user_messages[0]["turnId"], "turn-1");
    assert_eq!(transcript["turns"][0]["items"].as_array().unwrap().len(), 1);
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn running_codex_transcript_binds_same_second_presentations_to_provider_turns() {
    const PROVIDER_SECOND: i64 = 1_780_000_000;
    const PRESENTATION_MS: i64 = PROVIDER_SECOND * 1_000 + 900;

    let (mut handler, root) = isolated_runtime_work_handler("same-second-presentations");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    // Native history was loaded before the subsequent notification-only updates.
    set_transcript_snapshot_messages(&mut link.runtime_handle, "thread-1", Vec::new(), None, None);
    for (index, content) in [
        "First instruction",
        "Second instruction",
        "Third instruction",
    ]
    .into_iter()
    .enumerate()
    {
        append_runtime_handle_user_message_presentation(
            &mut link.runtime_handle,
            json!({
                "clientUserMessageId": format!("client-user-{}", index + 1),
                "content": content,
                "createdAt": PRESENTATION_MS,
                "ensureVisible": true,
                "references": [],
            }),
        );
    }
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");

    for index in 0..3 {
        let turn_id = format!("turn-{}", index + 1);
        let client_user_message_id = format!("client-user-{}", index + 1);
        handler.record_runtime_turn_id(
            "task-1",
            &format!("subtask-{}", index + 1),
            &turn_id,
            Some(&client_user_message_id),
        );
        if index < 2 {
            handler.persist_completed_codex_turn_from_notification(
                "task-1",
                &json!({
                    "method": "turn/completed",
                    "params": {
                        "threadId": "thread-1",
                        "turn": {
                            "id": turn_id,
                            "status": "completed",
                            "startedAt": PROVIDER_SECOND,
                            "completedAt": PROVIDER_SECOND + 1,
                            "items": [{
                                "id": format!("assistant-{}", index + 1),
                                "type": "agentMessage",
                                "phase": "final_answer",
                                "text": format!("Response {}", index + 1),
                            }],
                        }
                    }
                }),
            );
        } else {
            handler.begin_active_codex_transcript("task-1", "thread-1", &turn_id);
            handler.record_active_codex_transcript_item(
                "task-1",
                &turn_id,
                &json!({
                    "method": "item/completed",
                    "params": {
                        "turnId": turn_id,
                        "item": {
                            "id": "assistant-3",
                            "type": "agentMessage",
                            "phase": "commentary",
                            "createdAt": PROVIDER_SECOND,
                            "text": "Response 3",
                        }
                    }
                }),
            );
        }
    }

    install_native_history(&mut handler, &root, (0..3).map(|index| json!({
      "id":format!("turn-{}",index+1),"status":if index<2 {"completed"} else {"inProgress"},"startedAt":PROVIDER_SECOND,
      "items":[{"id":format!("assistant-{}",index+1),"type":"agentMessage","text":format!("Response {}",index+1),"phase":if index<2 {"final_answer"} else {"commentary"}}]
    })).collect(), None);
    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "task-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("running transcript should use turn-bound presentations");

    assert_eq!(transcript["running"], true);
    let messages = transcript["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 6);
    let turns = transcript["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 3);
    for index in 0..3 {
        let turn_id = format!("turn-{}", index + 1);
        assert_eq!(messages[index * 2]["role"], "user");
        assert_eq!(
            messages[index * 2]["clientUserMessageId"],
            format!("client-user-{}", index + 1)
        );
        assert_eq!(messages[index * 2]["turnId"], turn_id);
        assert_eq!(messages[index * 2 + 1]["role"], "assistant");
        assert_eq!(messages[index * 2 + 1]["turnId"], turn_id);
        assert_eq!(turns[index]["id"], turn_id);
        assert_eq!(turns[index]["items"].as_array().unwrap().len(), 2);
        assert_eq!(turns[index]["items"][0]["type"], "user_message");
        assert_eq!(
            turns[index]["items"][1]["type"],
            if index < 2 { "assistant_text" } else { "block" }
        );
    }
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn completed_codex_turn_is_cached_before_automatic_continuation_finishes() {
    let (mut handler, root) = isolated_runtime_work_handler("automatic-continuation-cache");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    // Native history was loaded before the subsequent notification-only updates.
    set_transcript_snapshot_messages(&mut link.runtime_handle, "thread-1", Vec::new(), None, None);
    set_runtime_handle_messages(
        &mut link.runtime_handle,
        vec![json!({
            "id": "user-1",
            "role": "user",
            "content": "Keep the goal active",
            "createdAt": 1_780_000_000_000_i64,
        })],
    );
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-initial");
    handler.persist_completed_codex_turn_from_notification(
        "task-1",
        &json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-initial",
                    "status": "completed",
                    "completedAt": 1_780_000_001,
                    "items": [{
                        "id": "message-initial",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "Initial goal turn complete"
                    }]
                }
            }
        }),
    );
    handler.record_active_codex_transcript_item(
        "task-1",
        "turn-continuation",
        &json!({
            "method": "item/completed",
            "params": {
                "turnId": "turn-continuation",
                "item": {
                    "id": "message-continuation",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "Automatic continuation running"
                }
            }
        }),
    );

    let cached = completed_transcript_messages(&handler.local_task_link("task-1").unwrap());
    assert!(cached
        .iter()
        .any(|message| message["content"] == "Initial goal turn complete"));
    install_native_history(
        &mut handler,
        &root,
        vec![
            json!({"id":"turn-initial","status":"completed","items":[
                {"id":"user-1","type":"userMessage","content":[{"type":"inputText","text":"Keep the goal active"}]},
                {"id":"message-initial","type":"agentMessage","phase":"final_answer","text":"Initial goal turn complete"}
            ]}),
            json!({"id":"turn-continuation","status":"inProgress","items":[
                {"id":"message-continuation","type":"agentMessage","phase":"commentary","text":"Automatic continuation running"}
            ]}),
        ],
        None,
    );
    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "task-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("running transcript should retain the completed goal turn");

    assert_eq!(transcript["running"], true);
    assert_eq!(transcript["messages"].as_array().unwrap().len(), 3);
    assert_eq!(transcript["messages"][0]["content"], "Keep the goal active");
    assert_eq!(
        transcript["messages"][1]["content"],
        "Initial goal turn complete"
    );
    assert_eq!(
        transcript["messages"][2]["blocks"][0]["content"],
        "Automatic continuation running"
    );
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recording_a_new_provider_thread_clears_completed_transcript_cache() {
    let index_path = temp_runtime_work_index_path("completed-transcript-thread-switch");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    append_completed_transcript_messages(
        &mut link.runtime_handle,
        "thread-1",
        vec![json!({"id": "message-1", "role": "assistant"})],
    );
    set_transcript_snapshot_messages(
        &mut link.runtime_handle,
        "thread-1",
        vec![json!({"id": "snapshot-message-1", "role": "assistant"})],
        Some("native-before".to_owned()),
        None,
    );
    handler.upsert_local_task(link);

    handler.record_local_task_thread("task-1", "thread-2");

    let link = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(link.thread_id.as_deref(), Some("thread-2"));
    assert!(completed_transcript_messages(&link).is_empty());
    assert!(link
        .runtime_handle
        .get("completedTranscriptMessages")
        .is_none());
    assert!(link
        .runtime_handle
        .get("completedTranscriptThreadId")
        .is_none());
    assert!(link
        .runtime_handle
        .get("transcriptSnapshotMessages")
        .is_none());
    assert!(link
        .runtime_handle
        .get("transcriptSnapshotThreadId")
        .is_none());

    let _ = fs::remove_file(index_path);
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
fn finishing_a_goal_request_updates_metadata_without_settling_native_admission() {
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
    assert_eq!(task.status, "running");
    assert!(task.running);
    assert_eq!(task.goal_status.as_deref(), Some("active"));
    assert_eq!(task.thread_id.as_deref(), Some("thread-1"));
    assert!(task.completed_at.is_none());
    assert!(!handler.is_active_local_task("task-1"));
    assert_eq!(
        task.execution_state.unwrap().phase,
        crate::runtime_work::lifecycle::NativeExecutionPhase::Starting
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn turn_result_persists_goal_status_before_native_execution_settles() {
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
            quota_recovery: None,
            thread_id: "thread-1".to_owned(),
            outcome: ExecutionOutcome::Completed {
                content: "done".to_owned(),
            },
            response_item_id: Some("assistant-1".to_owned()),
            response_value_origin: crate::agents::CodexResponseValueOrigin::Final,
            goal_status: Some("complete".to_owned()),
            goal_status_observed: true,
            started_at_ms: None,
            completed_at_ms: None,
            duration_ms: None,
        }),
    );

    assert!(handler.local_task_link("task-1").unwrap().running);
    assert!(!handler.is_active_local_task("task-1"));
    finish_test_native_turn(&handler, "task-1", "thread-1");
    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.status, "done");
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

    assert!(handler.local_task_link("task-1").unwrap().running);
    assert!(!handler.is_active_local_task("task-1"));
    finish_test_native_turn(&handler, "task-1", "current-thread");

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert!(!handler.is_active_local_task("task-1"));
    assert_eq!(task.status, "done");
    assert!(!task.running);
    assert_eq!(task.thread_id.as_deref(), Some("current-thread"));
    assert!(task.completed_at.is_some());

    let _ = fs::remove_file(index_path);
}

#[test]
fn stale_terminal_result_cannot_emit_or_finish_replacement_execution() {
    let (event_tx, mut event_rx) = broadcast::channel(4);
    let index_path = temp_runtime_work_index_path("stale-terminal-event");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let stale_execution_id = start_test_execution(&handler, "task-1");
    assert!(handler.force_settle_local_task_execution(
        "task-1",
        Some("thread-stale".to_owned()),
        "cancelled",
        "test_force_stop",
    ));
    let current_execution_id = start_test_execution(&handler, "task-1");

    handler.handle_turn_result(
        "task-1",
        stale_execution_id,
        &ExecutionRequest::default(),
        Some(&ActiveCodexTurn {
            execution_id: stale_execution_id,
            thread_id: "thread-stale".to_owned(),
            turn_id: "turn-stale".to_owned(),
        }),
        Ok(crate::agents::CodexAppServerTurn {
            quota_recovery: None,
            thread_id: "thread-stale".to_owned(),
            outcome: ExecutionOutcome::Completed {
                content: "stale".to_owned(),
            },
            response_item_id: Some("assistant-stale".to_owned()),
            response_value_origin: crate::agents::CodexResponseValueOrigin::Final,
            goal_status: None,
            goal_status_observed: false,
            started_at_ms: None,
            completed_at_ms: None,
            duration_ms: None,
        }),
    );

    assert!(
        event_rx.try_recv().is_err(),
        "a stale execution must not emit a terminal event"
    );
    assert!(handler.is_current_local_task_execution("task-1", current_execution_id));
    let task = handler
        .local_task_link("task-1")
        .expect("replacement task should remain stored");
    assert_eq!(task.status, "running");
    assert!(task.running);
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
    assert_eq!(settled_task.status, "done");
    assert!(!settled_task.running);
    assert_eq!(settled_task.thread_status, "idle");
    assert_eq!(settled_task.turn_status.as_deref(), Some("completed"));
    assert_eq!(settled_task.thread_id.as_deref(), Some("claude-session-1"));
    assert!(settled_task.completed_at.is_some());

    let _ = fs::remove_file(index_path);
}

#[test]
fn provider_turn_cannot_restore_running_state_after_execution_settles() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let execution_id = start_test_execution(&handler, "task-1");

    assert!(handler.finish_local_task_execution("task-1", execution_id));
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".to_owned(),
        "turn-1".to_owned(),
    );

    assert!(!handler.is_active_local_task("task-1"));
    assert!(handler.active_codex_turn("task-1").is_none());
}

#[test]
fn finishing_execution_removes_its_codex_turn_context() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let execution_id = start_test_execution(&handler, "task-1");
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".to_owned(),
        "turn-1".to_owned(),
    );

    assert!(handler.active_codex_turn("task-1").is_some());
    assert!(handler.finish_local_task_execution("task-1", execution_id));

    assert!(!handler.is_active_local_task("task-1"));
    assert!(handler.active_codex_turn("task-1").is_none());
}

#[test]
fn side_source_waits_for_the_running_source_turn_before_forking() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _executor_home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let _workbench_home = ScalarEnv::set("WEGENT_WORKBENCH_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
            // Keep the source index private even when other handlers use default storage.
            handler.store = RuntimeWorkStore::new(root.path().join("source").join("index.json"));
            let mut source = RuntimeTaskLink::new_pending(
                "source-task".to_owned(),
                root.path().join("project").to_string_lossy().into_owned(),
                "Source task".to_owned(),
            );
            source.thread_id = Some("source-thread".to_owned());
            handler.upsert_local_task(source);
            let execution_id = start_test_execution(&handler, "source-task");
            let wait = handler.wait_for_running_side_source_turn("source-thread");
            tokio::pin!(wait);

            // Poll the wait itself so the assertion cannot pass before it starts.
            assert!(futures_util::poll!(wait.as_mut()).is_pending());
            handler.record_active_codex_turn(
                "source-task",
                execution_id,
                "source-thread".to_owned(),
                "source-turn".to_owned(),
            );

            tokio::time::timeout(Duration::from_secs(1), wait)
                .await
                .expect("side source readiness should unblock after turn/start");
        });
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
fn codex_terminal_status_only_accepts_provider_terminal_facts() {
    assert_eq!(
        codex_thread_terminal_task_status(&json!({
            "turns": [{"status": "completed"}],
        })),
        Some("done")
    );
    assert_eq!(
        codex_thread_terminal_task_status(&json!({
            "turns": [{"status": "interrupted"}],
        })),
        Some("cancelled")
    );
    assert_eq!(
        codex_thread_terminal_task_status(&json!({
            "turns": [{"status": "failed"}],
        })),
        Some("failed")
    );
    assert_eq!(
        codex_thread_terminal_task_status(&json!({
            "turns": [{"status": "inProgress"}],
        })),
        None
    );
    assert_eq!(
        codex_thread_terminal_task_status(&json!({
            "turns": [{"status": "futureProviderStatus"}],
        })),
        None
    );
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
fn runtime_turn_ids_are_persisted_by_subtask() {
    let index_path = temp_runtime_work_index_path("runtime-turn-id");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    append_runtime_handle_user_message_presentation(
        &mut link.runtime_handle,
        json!({
            "clientUserMessageId": "client-user-1",
            "content": "Implement quicksort",
        }),
    );
    handler.upsert_local_task(link);

    let codex_turn_id = "019f933f-bf0d-72e3-b366-a6539ab00bcf";
    handler.record_runtime_turn_id("task-1", "subtask-1", codex_turn_id, Some("client-user-1"));

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
        link.runtime_handle["userMessagePresentations"][0]["turnId"].as_str(),
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
fn failed_responses_emit_runtime_turn_duration() {
    let (event_tx, mut event_rx) = broadcast::channel(1);
    let index_path = temp_runtime_work_index_path("failed-turn-duration");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "task-failed-duration";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "subtask-failed-duration".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let execution_id = start_test_execution(&handler, local_task_id);

    handler.handle_turn_result(
        local_task_id,
        execution_id,
        &request,
        Some(&ActiveCodexTurn {
            execution_id,
            thread_id: "thread-failed-duration".to_owned(),
            turn_id: "turn-failed-duration".to_owned(),
        }),
        Ok(crate::agents::CodexAppServerTurn {
            quota_recovery: None,
            thread_id: "thread-failed-duration".to_owned(),
            outcome: ExecutionOutcome::Failed {
                message: "upstream failed".to_owned(),
            },
            response_item_id: None,
            response_value_origin: crate::agents::CodexResponseValueOrigin::Empty,
            goal_status: None,
            goal_status_observed: false,
            started_at_ms: Some(1_780_000_000_000),
            completed_at_ms: Some(1_780_000_002_500),
            duration_ms: Some(2_500),
        }),
    );

    let event = event_rx
        .try_recv()
        .expect("failed response should be emitted");
    assert_eq!(event["event"], "response.failed");
    assert_eq!(event["payload"]["subtaskId"], "turn-failed-duration");
    assert_eq!(event["payload"]["data"]["startedAt"], 1_780_000_000_000_i64);
    assert_eq!(event["payload"]["data"]["durationMs"], 2_500);

    let _ = fs::remove_file(index_path);
}

#[test]
fn archived_cleanup_failure_preserves_task_and_snapshot_for_retry() {
    async fn cleanup_event(receiver: &mut broadcast::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event["payload"]["data"]["archiveCleanup"].is_object() {
                    return event;
                }
            }
        })
        .await
        .expect("archive cleanup must publish its result")
    }

    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let source = root.path().join("source");
            initialize_test_repository(&source);
            let (event_tx, mut event_rx) = broadcast::channel(16);
            let mut handler = RuntimeWorkRpcHandler::with_event_sender_deferred_startup_recovery(
                "device-1",
                "/bin/false",
                event_tx.clone(),
                None,
                None,
            );
            handler.store = RuntimeWorkStore::new(root.path().join("fixture-runtime/index.json"));
            handler.worktrees =
                WorktreeManager::new(root.path().join("fixture-runtime/worktrees.json"));
            handler
                .worktrees
                .update_settings(WorktreeSettingsPatch {
                    worktree_root: Some(root.path().join("managed").display().to_string()),
                    ..WorktreeSettingsPatch::default()
                })
                .unwrap();
            let record = handler
                .worktrees
                .prepare(&source, "task-1", None, false)
                .unwrap();
            let path = Path::new(&record.path);
            handler.worktrees.delete(path, true).unwrap();
            handler.worktrees.restore(path).unwrap();
            let marker = fs::read(path.join(".git")).unwrap();
            fs::write(path.join(".git"), "gitdir: /missing/git/worktrees/task-1\n").unwrap();
            let mut link = RuntimeTaskLink::new_pending(
                "task-1".to_owned(),
                record.path.clone(),
                "Task".to_owned(),
            );
            link.status = "archived".to_owned();
            handler.upsert_local_task(link.clone());
            handler.mark_archived_link_deleted(&link).unwrap();
            event_tx
                .send(json!({"event": "runtime.work.changed", "payload": {"taskId": "unrelated"}}))
                .unwrap();

            handler
                .delete_archived_link_background(link.clone(), false)
                .await;

            assert!(path.exists());
            assert!(handler.local_task_link("task-1").is_some());
            assert!(!handler.archived_link_is_deleted(&link));
            assert!(handler.worktrees.snapshot_source_for(path).is_some());
            let event = cleanup_event(&mut event_rx).await;
            assert_eq!(event["event"], "runtime.work.changed");
            assert_eq!(event["payload"]["deviceId"], "device-1");
            assert!(!event["payload"]["data"]["archiveCleanup"]["errors"]
                .as_array()
                .unwrap()
                .is_empty());

            fs::write(path.join(".git"), marker).unwrap();
            handler.delete_archived_link_background(link, false).await;
            assert!(!path.exists());
            assert!(handler.local_task_link("task-1").is_none());
            assert!(handler.worktrees.snapshot_source_for(path).is_none());
            let event = cleanup_event(&mut event_rx).await;
            assert_eq!(
                event["payload"]["data"]["archiveCleanup"]["errors"],
                json!([])
            );
        });
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
        "config/read",
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
fn user_message_presentation_requires_a_stable_client_user_message_id() {
    assert!(user_message_presentation(&json!({
        "message": "Use [$plugin:skill](/tmp/plugin/skill/SKILL.md)"
    }))
    .is_none());
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
fn transcript_restores_attachment_presentation_over_internal_provider_context() {
    let mut provider_messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "runtime-local-pane-1",
        "role": "user",
        "content": "<attachment>\nAvailable attachments:\n- pasted-feedback.zip\n</attachment>"
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "content": "",
        "attachments": [{
            "id": -1,
            "filename": "pasted-feedback.zip",
            "file_size": 18,
            "mime_type": "application/zip",
            "status": "ready",
            "local_path": "/tmp/pasted-feedback.zip"
        }]
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    assert_eq!(provider_messages[0]["content"], "");
    assert_eq!(
        provider_messages[0]["attachments"][0]["filename"],
        "pasted-feedback.zip"
    );
}

#[test]
fn transcript_repairs_persisted_blob_preview_when_local_path_is_available() {
    let mut provider_messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "runtime-local-pane-1",
        "role": "user",
        "content": "Inspect this image"
    })];
    let presentations = vec![json!({
        "clientUserMessageId": "runtime-local-pane-1",
        "content": "Inspect this image",
        "attachments": [{
            "id": -1,
            "filename": "image.png",
            "file_size": 18,
            "mime_type": "image/png",
            "file_extension": ".png",
            "status": "ready",
            "local_path": "/tmp/image.png",
            "local_preview_url": "blob:http://127.0.0.1:53328/revoked"
        }]
    })];

    attach_user_message_presentations(&mut provider_messages, presentations);

    assert_eq!(
        provider_messages[0]["attachments"][0]["local_preview_url"],
        "/tmp/image.png"
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
fn transcript_restores_missing_historical_turns_in_chronological_order() {
    let mut messages = vec![json!({
        "id": "latest-answer", "turnId": "latest-turn", "role": "assistant",
        "content": "Latest response", "createdAt": 300
    })];
    let presentations = vec![
        json!({
            "clientUserMessageId": "old-user-2", "turnId": "old-turn-2",
            "content": "Second historical instruction", "createdAt": 200,
            "ensureVisible": true
        }),
        json!({
            "clientUserMessageId": "old-user-1", "turnId": "old-turn-1",
            "content": "First historical instruction", "createdAt": 100,
            "ensureVisible": true
        }),
    ];
    attach_user_message_presentations(&mut messages, presentations.clone());
    assert_eq!(
        messages
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["old-user-1", "old-user-2", "latest-answer"]
    );
    assert_eq!(messages[0]["turnId"], "old-turn-1");
    assert_eq!(messages[1]["turnId"], "old-turn-2");
    let before = messages.clone();
    attach_user_message_presentations(&mut messages, presentations);
    assert_eq!(messages, before);
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
        &[],
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
        &[],
        true,
        true,
    );

    assert_eq!(provider_messages.len(), 3);
    assert_eq!(provider_messages[1]["content"], "Middle instruction");
    assert_eq!(provider_messages[1]["turnId"], "turn-last");
}

#[test]
fn paginated_transcript_restores_a_presentation_for_an_empty_turn_on_the_current_page() {
    let mut provider_messages = Vec::new();
    let presentations = vec![json!({
        "clientUserMessageId": "client-user-interrupted",
        "content": "Instruction archived before the provider stored its user item",
        "createdAt": 200,
        "ensureVisible": true,
        "references": [],
        "turnId": "turn-interrupted"
    })];

    attach_user_message_presentations_for_page(
        &mut provider_messages,
        presentations,
        &[],
        &["turn-interrupted".to_owned()],
        false,
        true,
    );

    assert_eq!(provider_messages.len(), 1);
    assert_eq!(provider_messages[0]["role"], "user");
    assert_eq!(provider_messages[0]["turnId"], "turn-interrupted");
    assert_eq!(
        provider_messages[0]["content"],
        "Instruction archived before the provider stored its user item"
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
fn transcript_navigation_is_not_limited_to_the_visible_message_page() {
    let messages = vec![
        json!({
            "id": "user-old",
            "turnId": "turn-old",
            "role": "user",
            "content": "old prompt",
        }),
        json!({
            "id": "assistant-old",
            "turnId": "turn-old",
            "role": "assistant",
            "content": "old answer",
        }),
        json!({
            "id": "user-new",
            "turnId": "turn-new",
            "role": "user",
            "content": "new prompt",
        }),
        json!({
            "id": "assistant-new",
            "turnId": "turn-new",
            "role": "assistant",
            "content": "new answer",
        }),
    ];
    let turn_navigation = transcript_turn_navigation(&messages);

    let response = transcript_response(TranscriptResponseInput {
        canonical_turns: None,
        local_task_id: "task-1".to_owned(),
        workspace_path: "/tmp/project".to_owned(),
        runtime: "claude_code".to_owned(),
        messages,
        context_usage: None,
        running: false,
        pagination: TranscriptPagination::Offset {
            limit: Some(2),
            before_cursor: None,
            after_cursor: None,
        },
        full_content: false,
        conversation_context_only: false,
        turn_item_source: TranscriptTurnItemSource::CachedMessages,
        turn_navigation,
    });

    assert_eq!(response["messages"].as_array().unwrap().len(), 2);
    assert_eq!(response["messages"][0]["content"], "new prompt");
    assert_eq!(response["turnNavigation"].as_array().unwrap().len(), 2);
    assert_eq!(response["turnNavigation"][0]["promptPreview"], "old prompt");
    assert_eq!(response["turnNavigation"][1]["promptPreview"], "new prompt");
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
async fn codex_app_server_restart_waits_for_process_wide_gate() {
    let handler = RuntimeWorkRpcHandler::new("device-2", "unused-codex-binary");
    let restart_guard = codex_app_server_restart_gate().lock().await;
    let pending_restart = tokio::spawn(async move {
        handler
            .restart_codex_app_server_with_expected_models(json!({"ifIdle": true}), Vec::new())
            .await
    });

    tokio::task::yield_now().await;
    assert!(!pending_restart.is_finished());

    drop(restart_guard);
    let result = pending_restart
        .await
        .expect("restart task should finish")
        .expect("restart should return success");
    assert_eq!(result["restarted"], true);
}

#[tokio::test]
async fn codex_app_server_restart_requires_confirmation_for_active_turns() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let execution_id = start_test_execution(&handler, "task-1");
    handler.record_active_codex_turn(
        "task-1",
        execution_id,
        "thread-1".to_owned(),
        "turn-1".to_owned(),
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
async fn codex_model_discovery_waits_for_app_server_restart() {
    let (handler, root) = isolated_runtime_work_handler("catalog-restart-serialization");
    let restart_guard = codex_app_server_restart_gate().lock().await;
    {
        let discovery = handler.list_codex_models(json!({"includeHidden": true}));
        tokio::pin!(discovery);
        let waiting = tokio::time::timeout(Duration::from_millis(100), &mut discovery).await;
        assert!(
            waiting.is_err(),
            "model discovery bypassed the restart gate"
        );
    }

    drop(restart_guard);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide Codex authentication paths.
async fn codex_account_switch_waits_for_model_discovery() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_CODEX_HOME", home.path().to_str().unwrap());
    let (handler, root) = isolated_runtime_work_handler("catalog-account-serialization");
    let discovery_guard = codex_app_server_restart_gate().lock().await;
    let switching = handler.switch_codex_account(json!({"accountId": "next-account"}));
    tokio::pin!(switching);
    let waiting = tokio::time::timeout(Duration::from_millis(100), &mut switching).await;
    assert!(waiting.is_err(), "account switch bypassed model discovery");

    drop(discovery_guard);
    let error = tokio::time::timeout(Duration::from_secs(1), &mut switching)
        .await
        .expect("account switch did not resume after model discovery")
        .unwrap_err();
    assert_eq!(error.code, "codex_account_switch_failed");
    assert_eq!(error.message, "Codex account was not found");
    assert!(fs::read_dir(home.path()).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
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
async fn codex_login_cancel_requires_a_login_id() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.auth.login.cancel",
            "payload": {}
        }))
        .await;

    let error = result.expect_err("missing login id should be rejected");
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
async fn transcript_without_session_preserves_known_terminal_state() {
    let index_path = temp_runtime_work_index_path("transcript-terminal-without-session");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "failed-before-session".to_owned(),
        "/tmp/project".to_owned(),
        "Failed task".to_owned(),
    );
    link.status = "failed".to_owned();
    link.running = false;
    link.completed_at = Some(1_780_000_000_000);
    handler.upsert_local_task(link);

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": { "taskId": "failed-before-session", "workspacePath": "/tmp/project" }
        }))
        .await
        .expect("terminal task without a session should return its known state");

    assert_eq!(result["running"], false);
    assert_eq!(result["messages"], json!([]));
    let _ = std::fs::remove_file(index_path);
}

#[tokio::test]
async fn native_transcript_reports_provider_failure_without_serving_an_unordered_cache() {
    let index_path = temp_runtime_work_index_path("completed-transcript-provider-not-ready");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "completed-task".to_owned(),
        "/tmp/project".to_owned(),
        "Completed task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    link.status = "done".to_owned();
    link.running = false;
    link.completed_at = Some(1_780_000_000_000);
    append_completed_transcript_messages(
        &mut link.runtime_handle,
        "thread-1",
        vec![json!({
            "id": "assistant-turn-1",
            "role": "assistant",
            "content": "Persisted final answer",
            "status": "done",
            "turnId": "turn-1",
            "subtaskId": "turn-1",
        })],
    );
    handler.upsert_local_task(link);

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "completed-task",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect_err("native history must not be replaced by an unordered cache");
    assert_eq!(result.code, "codex_error");
    let saved = completed_transcript_messages(&handler.local_task_link("completed-task").unwrap());
    assert_eq!(saved[0]["content"], "Persisted final answer");
    let _ = std::fs::remove_file(index_path);
}

#[test]
fn transcript_sync_requires_restore_before_native_thread_exists() {
    let index_path = temp_runtime_work_index_path("transcript-sync-pending-thread");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "local-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Synced task".to_owned(),
    );
    link.runtime_handle["cloudTranscript"] = json!({
        "transcriptId": "cloud-transcript-1",
        "importedThrough": 3,
    });
    handler.upsert_local_task(link);

    let result = handler
        .transcript_sync_status(json!({
            "taskId": "local-task-1",
            "transcriptId": "cloud-transcript-1",
        }))
        .expect("pending native thread should require native restore");

    assert_eq!(result["available"], true);
    assert_eq!(result["importedThrough"], 0);
    assert_eq!(result["reason"], "restore_required");
    let _ = fs::remove_file(index_path);
}

#[test]
fn transcript_sync_rekeys_the_local_task_when_a_conflicting_turn_forks() {
    let index_path = temp_runtime_work_index_path("transcript-sync-fork");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "parent-transcript".to_owned(),
        "/tmp/project".to_owned(),
        "Local conflicting branch".to_owned(),
    );
    link.thread_id = Some("local-thread".to_owned());
    link.runtime_handle["cloudTranscript"] = json!({
        "transcriptId": "parent-transcript",
        "importedThrough": 3,
        "rolloutBytes": 120,
    });
    handler.upsert_local_task(link);

    let result = handler
        .acknowledge_transcript_turn(json!({
            "taskId": "parent-transcript",
            "transcriptId": "fork-transcript",
            "parentTranscriptId": "parent-transcript",
            "sequence": 1,
            "rolloutEnd": 240,
        }))
        .expect("fork acknowledgement should move the local task");

    assert_eq!(result["taskId"], "fork-transcript");
    assert_eq!(result["available"], true);
    assert!(handler.local_task_link("parent-transcript").is_none());
    let branch = handler
        .local_task_link("fork-transcript")
        .expect("forked local task should use the branch transcript ID");
    assert_eq!(branch.thread_id.as_deref(), Some("local-thread"));
    assert_eq!(
        branch.runtime_handle["cloudTranscript"]["transcriptId"],
        "fork-transcript"
    );
    assert_eq!(
        branch.runtime_handle["cloudTranscript"]["importedThrough"],
        1
    );
    assert_eq!(
        branch.runtime_handle["cloudTranscript"]["requiresSnapshot"],
        false
    );
    let _ = fs::remove_file(index_path);
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
fn spawned_child_thread_inherits_parent_event_route_and_mapper() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("spawned-child-thread-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "turn-root".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-root".to_owned());
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread-root", local_task_id.to_owned(), request, false);

    handler.route_codex_notification(json!({
        "method": "thread/started",
        "params": {
            "thread": {"id": "thread-root"},
            "threadId": "thread-root"
        }
    }));
    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-root",
            "turnId": "turn-root",
            "item": {
                "id": "spawn-call",
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "prompt": "Inspect the child route",
                "receiverThreadIds": ["thread-child"],
                "agentsStates": {
                    "thread-child": {
                        "status": "pendingInit",
                        "message": null
                    }
                },
                "status": "completed"
            }
        }
    }));

    assert!(handler.thread_event_route_exists("thread-child"));
    assert_eq!(
        event_rx.try_recv().unwrap()["event"],
        "response.subagent.activity"
    );
    assert_eq!(
        event_rx.try_recv().unwrap()["event"],
        "response.block.created"
    );

    handler.route_codex_notification(json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "item": {
                "id": "child-message",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": ""
            }
        }
    }));
    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "itemId": "child-message",
            "delta": "child output"
        }
    }));

    let child_event = event_rx
        .try_recv()
        .expect("child output should use the inherited route");
    assert_eq!(child_event["event"], "response.block.created");
    assert_eq!(child_event["payload"]["taskId"], local_task_id);
    assert_eq!(child_event["payload"]["subtaskId"], "turn-root");
    assert_eq!(
        child_event["payload"]["data"]["block"]["parent_tool_use_id"],
        "subagent-thread-child"
    );
    assert_eq!(
        child_event["payload"]["data"]["block"]["content"],
        "child output"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn spawned_child_notifications_wait_for_parent_route_registration() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("pending-spawned-child-thread-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "turn-root".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-root".to_owned());
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread-root", local_task_id.to_owned(), request, false);

    handler.route_codex_notification(json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "item": {
                "id": "child-message",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": ""
            }
        }
    }));
    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "itemId": "child-message",
            "delta": "child output before parent spawn completion"
        }
    }));

    assert!(!handler.thread_event_route_exists("thread-child"));
    assert!(event_rx.try_recv().is_err());

    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-root",
            "turnId": "turn-root",
            "item": {
                "id": "spawn-call",
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "prompt": "Inspect the child route",
                "receiverThreadIds": ["thread-child"],
                "agentsStates": {
                    "thread-child": {
                        "status": "pendingInit",
                        "message": null
                    }
                },
                "status": "completed"
            }
        }
    }));

    assert!(handler.thread_event_route_exists("thread-child"));
    assert_eq!(
        event_rx.try_recv().unwrap()["event"],
        "response.subagent.activity"
    );
    assert_eq!(
        event_rx.try_recv().unwrap()["event"],
        "response.block.created"
    );
    let child_event = event_rx
        .try_recv()
        .expect("pending child output should replay through the inherited route");
    assert_eq!(child_event["event"], "response.block.created");
    assert_eq!(child_event["payload"]["taskId"], local_task_id);
    assert_eq!(child_event["payload"]["subtaskId"], "turn-root");
    assert_eq!(
        child_event["payload"]["data"]["block"]["parent_tool_use_id"],
        "subagent-thread-child"
    );
    assert_eq!(
        child_event["payload"]["data"]["block"]["content"],
        "child output before parent spawn completion"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn subagent_activity_routes_pending_native_child_notifications() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("pending-native-child-thread-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "turn-root".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-root".to_owned());
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread-root", local_task_id.to_owned(), request, false);

    handler.route_codex_notification(json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "item": {
                "id": "child-message",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": ""
            }
        }
    }));
    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "itemId": "child-message",
            "delta": "native child output"
        }
    }));

    assert!(!handler.thread_event_route_exists("thread-child"));
    assert!(event_rx.try_recv().is_err());

    handler.route_codex_notification(json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-root",
            "turnId": "turn-root",
            "item": {
                "type": "subAgentActivity",
                "agentPath": "/root/native-child",
                "agentThreadId": "thread-child",
                "kind": "started"
            }
        }
    }));

    assert!(handler.thread_event_route_exists("thread-child"));
    assert_eq!(
        event_rx.try_recv().unwrap()["event"],
        "response.subagent.activity"
    );
    assert_eq!(
        event_rx.try_recv().unwrap()["event"],
        "response.block.created"
    );
    let child_event = event_rx
        .try_recv()
        .expect("pending native child output should replay through the inherited route");
    assert_eq!(child_event["event"], "response.block.created");
    assert_eq!(child_event["payload"]["taskId"], local_task_id);
    assert_eq!(child_event["payload"]["subtaskId"], "turn-root");
    assert_eq!(
        child_event["payload"]["data"]["block"]["parent_tool_use_id"],
        "subagent-thread-child"
    );
    assert_eq!(
        child_event["payload"]["data"]["block"]["content"],
        "native child output"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn child_notifications_remain_ordered_while_pending_notifications_replay() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("replaying-spawned-child-thread-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "turn-root".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-root".to_owned());
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread-root", local_task_id.to_owned(), request, false);
    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-root",
            "turnId": "turn-root",
            "item": {
                "id": "spawn-call",
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "receiverThreadIds": ["thread-child"],
                "status": "completed"
            }
        }
    }));
    while event_rx.try_recv().is_ok() {}

    let child_started = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "item": {
                "id": "child-message",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": ""
            }
        }
    });
    let pending_replay = {
        let mut routing = handler
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        let generation = routing
            .routes
            .get("thread-child")
            .expect("child route should exist")
            .generation;
        assert!(routing
            .replaying_route_generations
            .insert("thread-child".to_owned(), generation)
            .is_none());
        Some(PendingCodexNotificationReplay {
            route_generations: HashMap::from([("thread-child".to_owned(), generation)]),
            notifications: vec![PendingCodexNotification {
                thread_id: "thread-child".to_owned(),
                message: child_started.into(),
            }],
        })
    };

    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "itemId": "child-message",
            "delta": "ordered child output"
        }
    }));
    assert!(event_rx.try_recv().is_err());

    handler.replay_codex_notifications(pending_replay);

    let child_event = event_rx
        .try_recv()
        .expect("child delta should follow its pending start notification");
    assert_eq!(child_event["event"], "response.block.created");
    assert_eq!(
        child_event["payload"]["data"]["block"]["content"],
        "ordered child output"
    );
    assert!(event_rx.try_recv().is_err());

    let _ = fs::remove_file(index_path);
}

#[test]
fn pending_notifications_do_not_cross_thread_route_generations() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("replaced-child-thread-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let old_task_id = "runtime-task-old";
    let new_task_id = "runtime-task-new";
    for local_task_id in [old_task_id, new_task_id] {
        let mut link = RuntimeTaskLink::new_pending(
            local_task_id.to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.thread_id = Some("thread-child".to_owned());
        handler.upsert_local_task(link);
    }
    handler.register_thread_event_route(
        "thread-child",
        old_task_id.to_owned(),
        ExecutionRequest {
            task_id: old_task_id.to_owned(),
            subtask_id: "turn-old".to_owned(),
            ..ExecutionRequest::default()
        },
        false,
    );

    let old_replay = {
        let mut routing = handler
            .thread_event_routing
            .lock()
            .expect("thread event routing lock should not be poisoned");
        let generation = routing
            .routes
            .get("thread-child")
            .expect("old route should exist")
            .generation;
        routing
            .replaying_route_generations
            .insert("thread-child".to_owned(), generation);
        Some(PendingCodexNotificationReplay {
            route_generations: HashMap::from([("thread-child".to_owned(), generation)]),
            notifications: vec![PendingCodexNotification {
                thread_id: "thread-child".to_owned(),
                message: json!({
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": "thread-child",
                        "turnId": "turn-old",
                        "itemId": "child-message",
                        "delta": "stale child output"
                    }
                })
                .into(),
            }],
        })
    };

    handler.register_thread_event_route(
        "thread-child",
        new_task_id.to_owned(),
        ExecutionRequest {
            task_id: new_task_id.to_owned(),
            subtask_id: "turn-new".to_owned(),
            ..ExecutionRequest::default()
        },
        false,
    );
    handler.replay_codex_notifications(old_replay);

    assert!(
        event_rx.try_recv().is_err(),
        "old replay must not reach the replacement route"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn native_router_publishes_parent_and_registers_child_route() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("active-spawned-child-thread-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "turn-root".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-root".to_owned());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.register_thread_event_route(
        "thread-root",
        local_task_id.to_owned(),
        ExecutionRequest {
            task_id: local_task_id.to_owned(),
            subtask_id: format!("{local_task_id}-context-compact"),
            ..ExecutionRequest::default()
        },
        false,
    );
    handler.register_thread_event_route("thread-root", local_task_id.to_owned(), request, true);
    handler.register_thread_event_route(
        "thread-root",
        local_task_id.to_owned(),
        ExecutionRequest {
            task_id: local_task_id.to_owned(),
            subtask_id: format!("{local_task_id}-context-compact"),
            ..ExecutionRequest::default()
        },
        false,
    );
    handler.record_active_codex_turn(
        local_task_id,
        execution_id,
        "thread-root".to_owned(),
        "turn-root".to_owned(),
    );

    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-root",
            "turnId": "turn-root",
            "item": {
                "id": "spawn-call",
                "type": "collabAgentToolCall",
                "tool": "spawnAgent",
                "prompt": "Inspect the child route",
                "receiverThreadIds": ["thread-child"],
                "status": "completed"
            }
        }
    }));

    assert!(handler.thread_event_route_exists("thread-child"));
    let parent = event_rx
        .try_recv()
        .expect("parent activity must be published by the thread router");
    assert_eq!(parent["event"], "response.subagent.activity");
    assert_eq!(parent["payload"]["subtaskId"], "turn-root");
    let spawned = event_rx
        .try_recv()
        .expect("the parent spawn must create its agent block");
    assert_eq!(spawned["event"], "response.block.created");
    assert_eq!(
        spawned["payload"]["data"]["block"]["id"],
        "subagent-thread-child"
    );

    handler.route_codex_notification(json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "item": {
                "id": "child-message",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": ""
            }
        }
    }));
    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": "thread-child",
            "turnId": "turn-child",
            "itemId": "child-message",
            "delta": "child output"
        }
    }));

    let child_event = event_rx
        .try_recv()
        .expect("active child output should use the inherited route");
    assert_eq!(child_event["event"], "response.block.created");
    assert_eq!(child_event["payload"]["subtaskId"], "turn-root");
    assert_eq!(
        child_event["payload"]["data"]["block"]["parent_tool_use_id"],
        "subagent-thread-child"
    );
    assert_eq!(
        child_event["payload"]["data"]["block"]["content"],
        "child output"
    );

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

#[cfg(unix)]
#[tokio::test]
async fn pending_inventory_does_not_spawn_codex_but_sidebar_bootstrap_still_does() {
    use std::os::unix::fs::PermissionsExt;

    let (mut handler, root) = isolated_runtime_work_handler("pending-inventory-spawn");
    fs::create_dir_all(&root).unwrap();
    let binary = root.join("codex-launch-probe");
    fs::write(
        &binary,
        "#!/bin/sh\nprintf launched > \"$0.launched\"\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    handler.codex_app_server =
        CodexAppServerClient::isolated_for_test(binary.display().to_string(), root.join("codex"));
    let (events, mut receiver) = broadcast::channel(16);
    handler.event_tx = Some(events);
    let project_index = CodexGlobalProjectIndex::from_test_payload(&Map::new());
    handler
        .list_tasks_with_project_index(
            &json!({"preferCached":true,"pendingOnly":true}),
            &project_index,
            Instant::now(),
        )
        .await
        .unwrap();
    let reconciliation = tokio::time::timeout(Duration::from_secs(5), receiver.recv()).await;
    assert!(
        reconciliation.is_err(),
        "Pending inventory unexpectedly reconciled provider threads: {reconciliation:?}"
    );
    assert!(!binary.with_extension("launched").exists());
    handler
        .list_tasks_with_project_index(
            &json!({"preferCached":true}),
            &project_index,
            Instant::now(),
        )
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["payload"]["taskId"], "runtime-work-bootstrap");
    assert!(binary.with_extension("launched").exists());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn create_task_keeps_board_comment_session_persistent_across_store_reload() {
    let (handler, root) = isolated_runtime_work_handler("create-board-comment-task");
    let index_path = handler.store.index_path().to_path_buf();

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

    let _ = fs::remove_dir_all(root);
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
fn task_list_keeps_the_persisted_workspace_when_provider_cwd_changes() {
    let index_path = temp_runtime_work_index_path("authoritative-task-workspace");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/tmp/task-workspace".to_owned(),
        ..RuntimeTaskLink::default()
    });
    let provider_thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/current-project",
        "status": {"type": "idle"},
        "turns": [{"status": "completed"}]
    });

    let link = handler
        .link_from_thread(&provider_thread)
        .expect("persisted task should produce a task link");

    assert_eq!(link.workspace_path, "/tmp/task-workspace");
    assert_eq!(
        handler
            .local_task_link("task-1")
            .expect("task should remain stored")
            .workspace_path,
        "/tmp/task-workspace"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn native_router_publishes_current_and_historical_turns_by_their_own_identity() {
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
    let started_at = handler.store.get_task(local_task_id).unwrap().updated_at;
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
        started_at
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

    let current = event_rx
        .try_recv()
        .expect("the active turn must be published by the thread router");
    assert_eq!(current["event"], "response.block.created");
    assert_eq!(current["payload"]["subtaskId"], "turn-current");
    assert_eq!(current["payload"]["data"]["block"]["content"], "Hi");

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

#[tokio::test]
async fn execution_mapper_does_not_rebind_queued_notification_to_new_active_turn() {
    assert_queued_notification_routing(false, false).await;
}

#[tokio::test]
async fn execution_mapper_keeps_notification_when_router_observed_previous_active_turn() {
    assert_queued_notification_routing(true, false).await;
}

#[tokio::test]
async fn execution_mapper_delivers_before_lagged_global_router_exactly_once() {
    assert_queued_notification_routing(false, true).await;
}

async fn assert_queued_notification_routing(
    router_before_continuation: bool,
    execution_before_router: bool,
) {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("execution-mapper-turn-race");
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
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.register_thread_event_route(
        "thread-1",
        local_task_id.to_owned(),
        request.clone(),
        true,
    );
    handler.record_active_codex_turn(
        local_task_id,
        execution_id,
        "thread-1".to_owned(),
        "turn-continuation".to_owned(),
    );
    handler.begin_active_codex_transcript(local_task_id, "thread-1", "turn-continuation");
    let active_turn = handler
        .active_codex_turn(local_task_id)
        .expect("continuation turn should be active");
    let message = CodexNotification::from(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-initial",
            "item": {
                "id": "message-initial",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": "Initial goal turn complete"
            }
        }
    }));

    if router_before_continuation {
        handler.record_active_codex_turn(
            local_task_id,
            execution_id,
            "thread-1".to_owned(),
            "turn-initial".to_owned(),
        );
    }
    if !execution_before_router {
        handler.route_codex_notification(message.clone());
    }
    handler.record_active_codex_turn(
        local_task_id,
        execution_id,
        "thread-1".to_owned(),
        "turn-continuation".to_owned(),
    );
    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            Some(active_turn),
            message.clone(),
        )
        .await;
    if execution_before_router {
        handler.route_codex_notification(message);
    }

    let event = event_rx
        .try_recv()
        .expect("one notification path must emit the historical turn");
    assert_eq!(event["event"], "response.output_text.done");
    assert_eq!(event["payload"]["subtaskId"], "turn-initial");
    assert_eq!(
        event["payload"]["data"]["text"],
        "Initial goal turn complete"
    );
    assert!(
        event_rx.try_recv().is_err(),
        "the execution mapper must not emit the historical item under the continuation turn"
    );
    assert!(
        handler
            .active_codex_transcript_messages(local_task_id)
            .is_empty(),
        "the historical item must not pollute the continuation transcript"
    );

    let continuation_message = CodexNotification::from(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-continuation",
            "item": {
                "id": "message-continuation",
                "type": "agentMessage",
                "text": "Automatic continuation running"
            }
        }
    }));
    handler.route_codex_notification(continuation_message.clone());
    let active_turn = handler
        .active_codex_turn(local_task_id)
        .expect("continuation turn should remain active");
    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            Some(active_turn),
            continuation_message,
        )
        .await;

    let event = event_rx
        .try_recv()
        .expect("the execution mapper should emit the active continuation once");
    assert_eq!(event["event"], "response.block.created");
    assert_eq!(event["payload"]["subtaskId"], "turn-continuation");
    assert_eq!(
        event["payload"]["data"]["block"]["content"],
        "Automatic continuation running"
    );
    assert!(
        event_rx.try_recv().is_err(),
        "the active continuation must still be emitted exactly once"
    );
    let active_messages = handler.active_codex_transcript_messages(local_task_id);
    assert_eq!(active_messages.len(), 1);
    assert_eq!(active_messages[0]["subtaskId"], "turn-continuation");
    assert_eq!(active_messages[0]["content"], "");
    assert_eq!(active_messages[0]["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(active_messages[0]["blocks"][0]["type"], "text");
    assert_eq!(
        active_messages[0]["blocks"][0]["id"],
        "message-continuation"
    );
    assert_eq!(
        active_messages[0]["blocks"][0]["content"],
        "Automatic continuation running"
    );

    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn execution_mapper_persists_request_user_input_without_settling_execution() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("execution-mapper-request-user-input");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-waiting";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "runtime-subtask-waiting".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Waiting task".to_owned(),
    );
    link.thread_id = Some("thread-waiting".to_owned());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.record_active_codex_turn(
        local_task_id,
        execution_id,
        "thread-waiting".to_owned(),
        "turn-waiting".to_owned(),
    );
    let active_turn = handler
        .active_codex_turn(local_task_id)
        .expect("request user input turn should be active");
    handler.begin_active_codex_transcript(local_task_id, "thread-waiting", "turn-waiting");
    let message = json!({
        "id": 42,
        "method": "item/tool/requestUserInput",
        "params": {
            "threadId": "thread-waiting",
            "turnId": "turn-waiting",
            "itemId": "question-1",
            "questions": [{
                "id": "choice",
                "question": "Continue?",
                "options": [{"label": "Yes", "description": "Continue"}]
            }]
        }
    });

    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            Some(active_turn),
            message,
        )
        .await;

    let link = handler
        .local_task_link(local_task_id)
        .expect("waiting task should remain persisted");
    assert_eq!(
        link.interaction_status.as_deref(),
        Some(INTERACTION_WAITING_FOR_USER_INPUT)
    );
    assert!(
        handler.is_active_local_task(local_task_id),
        "waiting for input must not settle the active execution"
    );

    let events = std::iter::from_fn(|| event_rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| {
        event["event"] == "response.block.created"
            && event["payload"]["data"]["block"]["tool_name"] == "request_user_input"
    }));
    assert!(events
        .iter()
        .any(|event| event["event"] == "runtime.work.changed"));

    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn execution_mapper_drops_notifications_after_stop_is_requested() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("execution-mapper-cancel-race");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "runtime-subtask-1".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.begin_active_codex_transcript(local_task_id, "thread-1", "turn-1");
    assert!(handler.request_active_turn_stop(local_task_id));
    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            Some(ActiveCodexTurn {
                execution_id,
                thread_id: "thread-1".to_owned(),
                turn_id: "turn-1".to_owned(),
            }),
            json!({
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "id": "late-message",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "late completion"
                    }
                }
            }),
        )
        .await;

    assert!(
        event_rx.try_recv().is_err(),
        "notifications arriving after cancellation must not be emitted"
    );
    assert!(
        handler
            .active_codex_transcript_messages(local_task_id)
            .is_empty(),
        "notifications arriving after cancellation must not enter the transcript"
    );

    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn async_question_state_survives_completion_and_clears_on_next_send() {
    let index_path = temp_runtime_work_index_path("async-question-interaction");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "async-question-task";
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Async question".to_owned(),
    );
    link.thread_id = Some("thread-async".to_owned());
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, local_task_id);
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "turn-async".to_owned(),
        ..ExecutionRequest::default()
    };
    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            None,
            json!({
                "method": "item/completed",
                "params": {"item": {
                    "id": "question-async", "type": "agentMessage",
                    "questions": [{"title": "Continue?", "options": ["Yes", "No"]}]
                }}
            }),
        )
        .await;
    assert_eq!(
        handler
            .local_task_link(local_task_id)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    assert!(handler.finish_local_task(local_task_id, execution_id, None, "done"));
    handler.store = RuntimeWorkStore::new(index_path.clone());
    assert_eq!(
        handler
            .local_task_link(local_task_id)
            .unwrap()
            .interaction_status
            .as_deref(),
        Some(INTERACTION_AWAITING_USER_REPLY)
    );
    assert!(!handler.is_active_local_task(local_task_id));
    handler.mark_task_running_for_send(
        local_task_id,
        "thread-async",
        "/tmp/project",
        &request,
        &json!({"message": "Yes"}),
    );
    assert!(handler
        .local_task_link(local_task_id)
        .unwrap()
        .interaction_status
        .is_none());
    let _ = fs::remove_file(index_path);
}

#[test]
fn unsuccessful_execution_clears_pending_async_question() {
    for status in ["failed", "cancelled"] {
        let index_path = temp_runtime_work_index_path(status);
        let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        handler.store = RuntimeWorkStore::new(index_path.clone());
        let mut link = RuntimeTaskLink::new_pending(
            "async-failed-task".to_owned(),
            "/tmp/project".to_owned(),
            "Async question".to_owned(),
        );
        link.interaction_status = Some(INTERACTION_AWAITING_USER_REPLY.to_owned());
        handler.upsert_local_task(link);
        let execution_id = start_test_execution(&handler, "async-failed-task");
        assert!(handler.finish_local_task("async-failed-task", execution_id, None, status));
        assert!(handler
            .local_task_link("async-failed-task")
            .unwrap()
            .interaction_status
            .is_none());
        let _ = fs::remove_file(index_path);
    }
}

#[tokio::test]
async fn execution_mapper_keeps_same_turn_subagent_text_out_of_root_conversation() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("execution-mapper-subagent-text");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "runtime-subtask-1".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.begin_active_codex_transcript(local_task_id, "thread-root", "turn-1");
    let active_turn = ActiveCodexTurn {
        execution_id,
        thread_id: "thread-root".to_owned(),
        turn_id: "turn-1".to_owned(),
    };

    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            Some(active_turn),
            json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "thread-child",
                    "turnId": "turn-1",
                    "itemId": "message-child",
                    "delta": "Child agent output"
                }
            }),
        )
        .await;

    let event = event_rx
        .try_recv()
        .expect("the child message should be emitted as a nested block");
    assert_eq!(event["event"], "response.block.created");
    assert_eq!(
        event["payload"]["data"]["block"]["parent_tool_use_id"],
        "subagent-thread-child"
    );
    assert_eq!(
        event["payload"]["data"]["block"]["content"],
        "Child agent output"
    );
    assert!(event_rx.try_recv().is_err());

    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn execution_mapper_persists_historical_completion_without_remapping_it() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("execution-mapper-completion-race");
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
    handler.upsert_local_task(link);
    let execution_id = start_test_execution(&handler, local_task_id);
    handler.begin_active_codex_transcript(local_task_id, "thread-1", "turn-continuation");
    handler.route_codex_notification(json!({"method":"turn/started", "params":{"threadId":"thread-1", "turn":{"id":"turn-continuation"}}}));
    assert!(next_content_event(&mut event_rx).is_err());
    let active_turn = ActiveCodexTurn {
        execution_id,
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-continuation".to_owned(),
    };

    handler
        .deliver_native_notification_for_execution(
            local_task_id,
            execution_id,
            &request,
            Some(active_turn),
            json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-initial",
                        "status": "completed",
                        "completedAt": 1_780_000_001,
                        "items": [{
                            "id": "message-initial",
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": "Initial goal turn complete"
                        }]
                    }
                }
            }),
        )
        .await;

    assert!(
        event_rx.try_recv().is_err(),
        "historical completion must not be remapped to the active continuation"
    );
    let link = handler
        .local_task_link(local_task_id)
        .expect("task should remain stored");
    let completed = completed_transcript_messages(&link);
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0]["subtaskId"], "turn-initial");
    assert_eq!(completed[0]["content"], "Initial goal turn complete");
    assert!(
        handler
            .active_codex_transcript_messages(local_task_id)
            .is_empty(),
        "persisting the historical completion must not pollute the continuation transcript"
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn context_compaction_notifications_use_the_native_turn_identity() {
    let (event_tx, mut event_rx) = broadcast::channel(4);
    let index_path = temp_runtime_work_index_path("context-compaction-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: format!("{local_task_id}-context-compact"),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    handler.upsert_local_task(link);
    handler.register_thread_event_route("thread-1", local_task_id.to_owned(), request, true);

    handler.route_codex_notification(json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-1",
            "turnId": "compact-turn-1",
            "item": {
                "id": "context-compaction-1",
                "type": "contextCompaction"
            }
        }
    }));

    let event = event_rx
        .try_recv()
        .expect("compaction event should be emitted");
    assert_eq!(event["event"], "response.block.created");
    assert_eq!(event["payload"]["subtaskId"], "compact-turn-1");
    assert_eq!(
        event["payload"]["data"]["block"]["tool_name"],
        "context_compaction"
    );

    handler.route_codex_notification(json!({
        "method": "turn/completed",
        "params": {
            "threadId": "thread-1",
            "turn": {
                "id": "compact-turn-1",
                "status": "completed",
                "items": []
            }
        }
    }));
    assert!(
        next_content_event(&mut event_rx).is_err(),
        "turn completion must not duplicate an emitted compaction block"
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
    let managed_root = root.join("workspace").join("worktrees");
    let manager = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..WorktreeSettingsPatch::default()
        })
        .unwrap();
    let worktree_path = managed_root.join("task-1").join("Wegent");
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

    let targets = cleanup_targets_for_task(&manager, &link, true);
    let target_paths = targets
        .iter()
        .map(|target| target.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(target_paths.contains(&worktree_path.display().to_string()));
    assert!(target_paths.contains(&normalize_workspace_path(
        "/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png"
    )));
    let _ = fs::remove_dir_all(root);
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
    let _lock = crate::test_env::lock();
    let temp = tempfile::tempdir().unwrap();
    let _workspace = ScalarEnv::set(
        "WORKSPACE_ROOT",
        temp.path().join("workspace").to_str().unwrap(),
    );
    let _home = ScalarEnv::set(
        "WEGENT_EXECUTOR_HOME",
        temp.path().join("executor").to_str().unwrap(),
    );
    let root =
        temp_runtime_work_index_path("archived-cleanup-regular-root").with_extension("directory");
    let manager = WorktreeManager::new(root.join("runtime-work").join("worktrees.json"));
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/Users/me/project".to_owned(),
        "Task".to_owned(),
    );

    let targets = cleanup_targets_for_task(&manager, &link, true);
    let target_paths = targets
        .iter()
        .map(|target| target.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(!target_paths.contains(&"/Users/me/project".to_owned()));
    assert!(target_paths.contains(
        &temp
            .path()
            .join("workspace")
            .join("task-1")
            .join("attachments")
            .to_string_lossy()
            .to_string()
    ));
    assert!(target_paths.iter().any(|path| {
        path.ends_with("/workspace/attachments/runtime/task-1")
            || path.ends_with("\\workspace\\attachments\\runtime\\task-1")
    }));
    let project = PathBuf::from(normalize_workspace_path("/Users/me/project"));
    assert!(target_paths
        .iter()
        .any(|path| normalize_workspace_path(path)
            == normalize_workspace_path(
                &project
                    .join(".wegent")
                    .join("attachments")
                    .join("task-1")
                    .to_string_lossy()
            )));
    assert!(target_paths.contains(
        &project
            .join("task-1:executor:attachments")
            .to_string_lossy()
            .to_string()
    ));
    let _ = fs::remove_dir_all(root);
}

fn temp_runtime_work_index_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-runtime-work-{label}-{}-{}.json",
        std::process::id(),
        now_ms()
    ))
}

fn initialize_test_repository(path: &Path) {
    fs::create_dir_all(path).unwrap();
    for args in [
        &["init"][..],
        &["config", "user.name", "Wegent Test"],
        &["config", "user.email", "test@wegent.local"],
    ] {
        run_test_git(path, args);
    }
    fs::write(path.join("tracked.txt"), "base\n").unwrap();
    run_test_git(path, &["add", "."]);
    run_test_git(path, &["commit", "-m", "base"]);
}

fn run_test_git(path: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git -C {} {} failed: {}",
        path.display(),
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn local_project_execution_never_inherits_backend_credentials() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false").with_backend_connection(
        Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: "https://backend.example.com".into(),
            socket_url: String::new(),
            auth_token: "cloud-token".into(),
            runtime_auth_token: "runtime-token".into(),
        }))),
    );
    let mut request = ExecutionRequest {
        backend_url: Some("https://stale-backend.example.com".into()),
        auth_token: Some("stale-token".into()),
        runtime_auth_token: Some("stale-runtime-token".into()),
        skill_identity_token: Some("stale-skill-token".into()),
        ..Default::default()
    };
    request
        .extra
        .insert("origin".into(), json!({"projectStore":"local"}));
    handler.apply_backend_connection(&mut request);
    assert!(request.backend_url.is_none());
    assert!(request.auth_token.is_none());
    assert!(request.runtime_auth_token.is_none());
    assert!(request.skill_identity_token.is_none());
}

#[test]
fn context_compaction_cache_preserves_started_and_completed_outcomes() {
    for completed in [false, true] {
        let (handler, root) = isolated_runtime_work_handler("context-compaction-cache");
        let mut link = RuntimeTaskLink::new_pending(
            "task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Task".to_owned(),
        );
        link.thread_id = Some("thread-1".to_owned());
        handler.upsert_local_task(link);
        handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
        for method in if completed {
            vec!["item/started", "item/completed"]
        } else {
            vec!["item/started"]
        } {
            handler.record_active_codex_transcript_item(
                "task-1",
                "turn-1",
                &json!({
                    "method": method,
                    "params": {"item": {"id": "compact-1", "type": "contextCompaction"}}
                }),
            );
        }
        let active = handler.active_codex_transcript_messages("task-1");
        assert_eq!(
            active[0]["blocks"][0]["status"],
            if completed { "done" } else { "pending" }
        );

        handler.persist_and_clear_active_codex_transcript("task-1", "interrupted", None);
        let link = handler.local_task_link("task-1").unwrap();
        let persisted = completed_transcript_messages(&link);
        assert_eq!(persisted[0]["status"], "cancelled");
        assert_eq!(
            persisted[0]["blocks"][0]["status"],
            if completed { "done" } else { "error" }
        );
        assert!(handler
            .active_codex_transcript_messages("task-1")
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

fn decision_proxy_handler() -> RuntimeWorkRpcHandler {
    let (event_tx, _) = broadcast::channel(1);
    RuntimeWorkRpcHandler::with_event_sender_deferred_startup_recovery(
        "device-1",
        "/bin/false",
        event_tx,
        None,
        None,
    )
}

#[tokio::test]
async fn decision_proxy_register_requires_a_scope() {
    let handler = decision_proxy_handler();
    for payload in [json!({}), json!({"scope": "   "}), json!({"scope": 7})] {
        let error = handler
            .dispatch("runtime.decision_proxy.register", payload.clone())
            .await
            .expect_err("scope must be required");
        assert_eq!(error.code, "invalid_request", "payload={payload}");
    }
}

#[tokio::test]
async fn decision_proxy_register_needs_no_environment_model_configuration() {
    let handler = decision_proxy_handler();
    let launch = handler
        .register_decision_proxy_at(
            json!({"scope": "smart-app:install-1:abc"}),
            "http://127.0.0.1:4567",
        )
        .expect("catalog configuration is resolved at request time");
    let token = launch["token"].as_str().expect("token");
    crate::server::local_decision_proxy::unregister(token);
}

#[tokio::test]
async fn decision_proxy_register_rejects_client_supplied_configuration() {
    let handler = decision_proxy_handler();
    for field in [
        "upstream",
        "upstreamUrl",
        "apiKey",
        "models",
        "allowedModels",
        "defaultModel",
        "credential",
    ] {
        let mut payload = serde_json::Map::new();
        payload.insert("scope".to_owned(), json!("smart-app:install-1:abc"));
        payload.insert(field.to_owned(), json!("attacker value"));
        let error = handler
            .register_decision_proxy_at(Value::Object(payload), "http://127.0.0.1:4567")
            .expect_err("client supplied configuration must be rejected");
        assert_eq!(error.code, "invalid_request", "field={field}");
    }
}

#[tokio::test]
async fn decision_proxy_register_returns_a_loopback_launch() {
    let handler = decision_proxy_handler();
    let launch = handler
        .register_decision_proxy_at(
            json!({"scope": "smart-app:install-2:launch"}),
            "http://127.0.0.1:4567",
        )
        .expect("registration should succeed");
    let token = launch["token"].as_str().expect("token").to_owned();
    assert!(token.starts_with("decision-"));
    assert_eq!(
        launch["baseUrl"].as_str(),
        Some(format!("http://127.0.0.1:4567/v1/decision-router/{token}").as_str())
    );
    assert_eq!(launch["protocolVersion"], 1);

    let serialized = launch.to_string();
    for leaked in [
        "decision-upstream.example.com",
        "model-a",
        "apiKey",
        "upstream",
    ] {
        assert!(!serialized.contains(leaked), "launch leaked {leaked}");
    }
}

#[tokio::test]
async fn decision_proxy_register_needs_a_running_http_server() {
    let handler = decision_proxy_handler();
    let error = handler
        .dispatch(
            "runtime.decision_proxy.register",
            json!({"scope": "smart-app:install-3:no-server"}),
        )
        .await
        .expect_err("registration needs a bound loopback address");
    assert_eq!(error.code, "runtime_unavailable");
}

#[tokio::test]
async fn registration_binds_the_shared_connection_snapshot() {
    let handler = decision_proxy_handler();
    let launch = handler
        .register_decision_proxy_at(
            json!({"scope": "smart-app:install-4:login"}),
            "http://127.0.0.1:4567",
        )
        .expect("registration should succeed");
    let token = launch["token"].as_str().expect("token").to_owned();
    let route =
        crate::server::local_decision_proxy::lookup_route(&token).expect("registered route");
    let snapshot = route.snapshot();
    assert!(
        Arc::ptr_eq(&snapshot, &handler.backend_connection),
        "routes must share the handler connection snapshot"
    );
    crate::server::local_decision_proxy::unregister(&token);
}

#[tokio::test]
async fn decision_proxy_unregister_is_idempotent() {
    let handler = decision_proxy_handler();
    let error = handler
        .dispatch("runtime.decision_proxy.unregister", json!({}))
        .await
        .expect_err("token must be required");
    assert_eq!(error.code, "invalid_request");

    let launch = handler
        .register_decision_proxy_at(
            json!({"scope": "smart-app:install-6:stop"}),
            "http://127.0.0.1:4567",
        )
        .expect("registration should succeed");
    let token = launch["token"].as_str().expect("token").to_owned();
    for _ in 0..2 {
        let result = handler
            .dispatch("runtime.decision_proxy.unregister", json!({"token": token}))
            .await
            .expect("unregister should be idempotent");
        assert_eq!(result["unregistered"], true);
    }
    assert!(crate::server::local_decision_proxy::lookup_route(&token).is_none());
}
