// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::super::tests::ScalarEnv;
use super::*;

fn queued_wait(task: &str, deadline: i64) -> SpawnTurnRequest {
    let mut turn = SpawnTurnRequest {
        task_kind: None,
        local_task_id: task.into(),
        runtime: "codex".into(),
        request: ExecutionRequest {
            model_config: json!({"model_id":"original-model", "reasoning_effort":"high"}),
            ..Default::default()
        },
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: Some("thread".into()),
        initial_thread_goal: None,
    };
    set_wait(
        &mut turn,
        &QuotaWait {
            recovery: CodexQuotaRecovery {
                thread_id: "thread".into(),
                turn_id: "failed".into(),
                goal: None,
            },
            account: json!({"email":"original@example.com"}),
            auth_identity: None,
            reset_at: Some(deadline),
            next_check_at: deadline,
        },
    );
    turn
}

#[test]
fn quota_wait_uses_the_last_exhausted_window_of_the_selected_bucket() {
    let limits = json!({"rateLimitsByLimitId":{
        "codex":{"primary":{"usedPercent":100,"resetsAt":20},"secondary":{"usedPercent":100,"resetsAt":40}},
        "other-model":{"primary":{"usedPercent":100,"resetsAt":999}}
    }});
    assert_eq!(
        quota_deadline(&limits, &json!({"model_id":"original-model"})),
        (true, Some(40_000))
    );
    assert_eq!(
        quota_deadline(&limits, &json!({"model_id":"other-model"})),
        (true, Some(999_000))
    );
    let mut limits = limits;
    limits["rateLimitsByLimitId"]["other-model"]["primary"]["resetsAt"] = json!(1);
    assert_eq!(
        quota_deadline(&limits, &json!({"model_id":"other-model"})),
        (true, Some(40_000))
    );
    limits["rateLimitsByLimitId"]["codex"]["secondary"]["usedPercent"] = json!(50);
    assert_eq!(quota_deadline(&limits, &Value::Null), (true, Some(20_000)));
}

#[test]
fn quota_wait_does_not_invent_reset_times_or_overflow() {
    for window in [
        json!({"usedPercent":100}),
        json!({"usedPercent":100,"resetsAt":i64::MAX}),
    ] {
        assert_eq!(
            quota_deadline(&json!({"rateLimits":{"primary":window}}), &Value::Null),
            (true, None)
        );
    }
    assert_eq!(quota_deadline(&Value::Null, &Value::Null), (true, None));
    assert_eq!(
        quota_deadline(
            &json!({"rateLimits":{"primary":null,"secondary":null}}),
            &Value::Null
        ),
        (true, None)
    );
    assert_eq!(
        quota_deadline(
            &json!({"rateLimits":{"primary":{"usedPercent":99,"resetsAt":1}}}),
            &Value::Null
        ),
        (false, None)
    );
}

#[test]
fn quota_wait_releases_capacity_and_preserves_the_original_request_on_disk() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("queue.json");
    let mut original = queued_wait("waiting", now_ms() + 3_600_000);
    let worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
    let managed_root = root.path().join("worktrees");
    worktrees
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(managed_root.display().to_string()),
            ..Default::default()
        })
        .unwrap();
    original.request.project_workspace_path = Some(
        managed_root
            .join("waiting/repository")
            .display()
            .to_string(),
    );
    let mut ready = queued_wait("ready", 0);
    ready.request.extra.remove(MARKER);
    let queue = VecDeque::from([original.clone(), ready]);
    super::super::turns::write_runtime_turn_queue(&path, &queue).unwrap();
    let mut restored = super::super::turns::read_runtime_turn_queue(&path).unwrap();
    assert_eq!(
        super::super::turns::remove_worktree_turns_after_restart(&worktrees, &mut restored),
        0
    );
    assert_eq!(
        restored[0].request.model_config,
        original.request.model_config
    );
    assert_eq!(restored[0].request.prompt, json!(""));
    assert_eq!(wait(&restored[0]).unwrap().recovery.turn_id, "failed");
    let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), restored);
    let started = scheduler.take_available();
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].local_task_id, "ready");
    assert_eq!(scheduler.queued_turns[0].local_task_id, "waiting");
    assert!(!String::from_utf8(fs::read(path).unwrap())
        .unwrap()
        .contains("original-model"));
}

#[test]
fn quota_wait_reserves_queue_capacity_only_when_ready_and_obeys_the_limit_on_resume() {
    for (kind, origin) in [
        (RuntimeTaskKind::Personal, Value::Null),
        (
            RuntimeTaskKind::StandIn,
            json!({"type":"stand_in_identity"}),
        ),
        (
            RuntimeTaskKind::Agent,
            json!({"type":"board_task","executionId":"issue-wait"}),
        ),
    ] {
        let mut waiting = queued_wait("waiting", now_ms() + 3_600_000);
        waiting
            .request
            .extra
            .insert("origin".into(), origin.clone());
        let mut scheduler =
            RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), VecDeque::from([waiting]));
        assert_eq!(scheduler.queued(kind), 1);
        assert_eq!(scheduler.available(kind), 1);
        assert!(!scheduler.has_ready_queued_kind(kind));

        let ready = |id: &str| {
            let mut turn = queued_wait(id, 0);
            turn.request.extra.remove(MARKER);
            turn.request.extra.insert("origin".into(), origin.clone());
            turn
        };
        assert!(scheduler.enqueue(ready("other-issue")).is_some());
        assert_eq!(scheduler.active(kind), 1);
        assert_eq!(scheduler.available(kind), 0);
        assert!(scheduler.enqueue(ready("queued-issue")).is_none());
        let started = scheduler.finish("other-issue");
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].local_task_id, "queued-issue");
        assert!(scheduler.finish("queued-issue").is_empty());
        assert_eq!(scheduler.available(kind), 1);

        let waiting = &mut scheduler.queued_turns[0];
        let mut state = wait(waiting).unwrap();
        state.next_check_at = 0;
        set_wait(waiting, &state);
        assert_eq!(scheduler.available(kind), 0);
        assert!(scheduler.has_ready_queued_kind(kind));
        assert!(scheduler.enqueue(ready("later-issue")).is_none());
        let started = scheduler.take_available();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].local_task_id, "waiting");
        assert_eq!(scheduler.active(kind), 1);
        assert!(scheduler.take_available().is_empty());
        assert_eq!(scheduler.finish("waiting")[0].local_task_id, "later-issue");
    }
}

#[test]
fn quota_wait_restores_unconfirmed_dispatch_without_replaying_started_turns() {
    use super::super::command_journal::{CommandState, RuntimeCommand};
    let mut turn = queued_wait("waiting", 0);
    turn.request
        .extra
        .insert("runtime_command_id".into(), json!("command"));
    turn.request.extra.insert(
        "runtime_command_input".into(),
        json!({"message":"original"}),
    );
    turn.request.extra.insert("user_id".into(), json!(7));
    let mut command = RuntimeCommand::from_turn(&turn, CommandState::Dispatching)
        .unwrap()
        .unwrap();
    command.native = Some((1, "thread".into(), "failed".into()));
    let key = command.key();
    let mut state = super::super::turns::RuntimeTurnQueueState::default();
    state.commands.insert(key.clone(), command);
    restore_dispatches(&mut state);
    restore_dispatches(&mut state);
    assert_eq!(state.queued_turns.len(), 1);
    assert_eq!(state.commands[&key].state, CommandState::Queued);
    state.queued_turns.clear();
    state.commands.get_mut(&key).unwrap().state = CommandState::Started;
    restore_dispatches(&mut state);
    assert!(state.queued_turns.is_empty());
}

#[test]
fn quota_wait_can_be_cancelled_between_dequeue_and_preflight() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_CODEX_HOME",
        "CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (handler, root) =
                super::super::tests::isolated_runtime_work_handler("quota-dispatch-cancel");
            let turn = queued_wait("waiting", 0);
            let mut link =
                RuntimeTaskLink::new_pending("waiting".into(), "/work".into(), "Wait".into());
            link.thread_id = Some("thread".into());
            handler.store.upsert_task(link);
            handler
                .turn_scheduler
                .lock()
                .unwrap()
                .enqueue_forced(turn.clone());
            handler.reserve_turn_preparation(&turn);
            assert_eq!(
                handler
                    .cancel_task(json!({"taskId":"waiting"}))
                    .await
                    .unwrap()["accepted"],
                true
            );
            handler.start_quota_turn(turn).await;
            assert!(!handler.is_active_local_task("waiting"));
            let scheduler = handler.turn_scheduler.lock().unwrap();
            assert!(scheduler.queued_turns.is_empty());
            assert!(!scheduler.active_task_ids.contains_key("waiting"));
            assert!(!handler
                .preparing_turns
                .lock()
                .unwrap()
                .contains_key("waiting"));
            fs::remove_dir_all(root).unwrap();
        });
}

#[test]
fn quota_wait_cancellation_is_durable_and_cannot_be_woken() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_CODEX_HOME",
        "CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (handler, root) =
                super::super::tests::isolated_runtime_work_handler("quota-cancel");
            let turn = queued_wait("waiting", now_ms() + 3_600_000);
            let mut link =
                RuntimeTaskLink::new_pending("waiting".into(), "/work".into(), "Wait".into());
            link.thread_id = Some("thread".into());
            handler.store.upsert_task(link);
            let operation = handler.turn_queue_operation.lock().await;
            handler.park_quota_turn_locked(turn, None).await.unwrap();
            drop(operation);
            assert!(
                handler.local_task_link("waiting").unwrap().runtime_handle["quotaWait"].is_object()
            );
            // Replaying the saved failed turn after restart cannot complete a
            // task whose continuation still belongs to the durable queue.
            handler.store.update_task("waiting", |link| {
                settle_native_execution(link, "failed");
            });
            let public = handler.get_task(&json!({"taskId":"waiting"})).unwrap();
            assert_eq!(public["task"]["status"], "queued");
            assert_eq!(public["task"]["running"], false);
            assert_eq!(public["task"]["executionState"]["phase"], "queued");
            assert!(public["task"]["runtimeHandle"]["quotaWait"]["resumeAt"].is_number());
            assert!(!public.to_string().contains("original@example.com"));
            assert!(
                handler
                    .cancel_task(json!({"taskId":"waiting"}))
                    .await
                    .unwrap()["accepted"]
                    == true
            );
            let restored =
                super::super::turns::read_runtime_turn_queue(&handler.turn_queue_path).unwrap();
            assert!(restored.is_empty());
            assert!(handler
                .local_task_link("waiting")
                .unwrap()
                .runtime_handle
                .get("quotaWait")
                .is_none());
            assert!(handler
                .turn_scheduler
                .lock()
                .unwrap()
                .take_available()
                .is_empty());
            fs::remove_dir_all(root).unwrap();
        });
}

#[test]
fn quota_wait_goal_pause_cancels_the_exact_durable_wait() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_CODEX_HOME",
        "CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (handler, root) =
                super::super::tests::isolated_runtime_work_handler("quota-goal-pause");
            let mut turn = queued_wait("waiting", now_ms() + 3_600_000);
            let mut state = wait(&turn).unwrap();
            state.recovery.goal = Some(json!({"status":"usageLimited","objective":"finish"}));
            set_wait(&mut turn, &state);
            let mut link =
                RuntimeTaskLink::new_pending("waiting".into(), "/work".into(), "Wait".into());
            link.thread_id = Some("thread".into());
            handler.store.upsert_task(link);
            let operation = handler.turn_queue_operation.lock().await;
            handler.park_quota_turn_locked(turn, None).await.unwrap();
            drop(operation);
            handler.cancel_quota_wait_for_goal_change(
                "waiting",
                Some(&json!({"status":"paused","objective":"finish"})),
            );
            tokio::time::timeout(Duration::from_secs(2), async {
                while handler.is_queued_local_task("waiting") {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            // Wait for the queue transaction, not only its in-memory mutation.
            let _operation = handler.turn_queue_operation.lock().await;
            assert!(
                super::super::turns::read_runtime_turn_queue(&handler.turn_queue_path)
                    .unwrap()
                    .is_empty()
            );
            assert!(handler
                .local_task_link("waiting")
                .unwrap()
                .runtime_handle
                .get("quotaWait")
                .is_none());
            fs::remove_dir_all(root).unwrap();
        });
}

#[cfg(unix)]
#[test]
fn quota_wait_protocol_checks_windows_and_rejects_changed_native_owners() {
    use std::os::unix::fs::PermissionsExt;
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_CODEX_HOME",
        "CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    let binary = home.path().join("codex-fixture");
    fs::write(
        &binary,
        crate::test_env::with_codex_bundled_catalog(
            r#"#!/bin/sh
directory=$(dirname "$0")
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"account/read"'*)
      if [ -f "$directory/hold-account" ]; then
        touch "$directory/account-requested"
        while [ -f "$directory/hold-account" ]; do sleep 0.01; done
      fi
      result=$(cat "$directory/account.json");;
    *'"method":"account/rateLimits/read"'*) result=$(cat "$directory/limits.json");;
    *'"method":"thread/turns/list"'*) result=$(cat "$directory/turns.json");;
    *'"method":"thread/read"'*) result='{"thread":{"id":"thread","status":{"type":"idle"}}}';;
    *'"method":"thread/goal/get"'*) result=$(cat "$directory/goal.json");;
    *'"method":"turn/start"'*) touch "$directory/unexpected-turn"; result='{}';;
    *) result='{}';;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#,
        ),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let account = json!({"account":{"type":"chatgpt","email":"original@example.com"}});
    let deadline = (now_ms() / 1000 + 3600) * 1000;
    fs::write(home.path().join("account.json"), account.to_string()).unwrap();
    fs::write(
        home.path().join("limits.json"),
        json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":deadline / 1000}}})
            .to_string(),
    )
    .unwrap();
    fs::write(
        home.path().join("turns.json"),
        r#"{"data":[{"id":"failed","status":"failed","items":[]}]}"#,
    )
    .unwrap();
    fs::write(home.path().join("goal.json"), r#"{"goal":null}"#).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (mut handler, root) =
                super::super::tests::isolated_runtime_work_handler("quota-protocol");
            handler.codex_app_server = CodexAppServerClient::isolated_for_test(
                binary.to_str().unwrap(),
                home.path().to_path_buf(),
            );
            let turn = queued_wait("waiting", 0);
            let mut state = wait(&turn).unwrap();
            state.account = account_identity(&account);
            assert_eq!(
                handler.check_quota_turn(&turn, &state).await.unwrap(),
                Some(Some(deadline))
            );
            fs::write(
                home.path().join("limits.json"),
                r#"{"rateLimits":{"primary":{"usedPercent":0}}}"#,
            )
            .unwrap();
            assert_eq!(handler.check_quota_turn(&turn, &state).await.unwrap(), None);
            fs::write(
                home.path().join("goal.json"),
                r#"{"goal":{"status":"paused"}}"#,
            )
            .unwrap();
            assert_eq!(
                handler
                    .check_quota_turn(&turn, &state)
                    .await
                    .unwrap_err()
                    .code,
                "quota_recovery_cancelled"
            );
            fs::write(home.path().join("goal.json"), r#"{"goal":null}"#).unwrap();
            fs::write(
                home.path().join("turns.json"),
                r#"{"data":[{"id":"newer","status":"completed","items":[]}]}"#,
            )
            .unwrap();
            assert_eq!(
                handler
                    .check_quota_turn(&turn, &state)
                    .await
                    .unwrap_err()
                    .code,
                "quota_recovery_cancelled"
            );
            fs::write(
                home.path().join("account.json"),
                r#"{"account":{"type":"chatgpt","email":"another@example.com"}}"#,
            )
            .unwrap();
            let changed = handler.check_quota_turn(&turn, &state).await.unwrap_err();
            assert!(changed.message.contains("account changed"));
            fs::write(home.path().join("account.json"), account.to_string()).unwrap();
            fs::write(home.path().join("hold-account"), "").unwrap();
            let mut link =
                RuntimeTaskLink::new_pending("waiting".into(), "/work".into(), "Wait".into());
            link.thread_id = Some("thread".into());
            handler.store.upsert_task(link);
            let mut queued = turn.clone();
            let mut waiting = wait(&queued).unwrap();
            waiting.next_check_at = now_ms() + 50;
            set_wait(&mut queued, &waiting);
            let operation = handler.turn_queue_operation.lock().await;
            handler.park_quota_turn_locked(queued, None).await.unwrap();
            drop(operation);
            tokio::time::timeout(Duration::from_secs(2), async {
                while !home.path().join("account-requested").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                handler
                    .cancel_task(json!({"taskId":"waiting"}))
                    .await
                    .unwrap()["accepted"],
                true
            );
            tokio::time::timeout(Duration::from_secs(2), async {
                while handler.is_busy_local_task("waiting")
                    || handler
                        .turn_scheduler
                        .lock()
                        .unwrap()
                        .active_task_ids
                        .contains_key("waiting")
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            fs::remove_file(home.path().join("hold-account")).unwrap();
            assert!(!handler.is_active_local_task("waiting"));
            assert!(!handler.is_queued_local_task("waiting"));
            assert!(!handler
                .turn_scheduler
                .lock()
                .unwrap()
                .active_task_ids
                .contains_key("waiting"));
            assert!(!home.path().join("unexpected-turn").exists());
            handler.codex_app_server.restart().await;
            fs::remove_dir_all(root).unwrap();
        });
}

#[test]
fn quota_wait_account_identity_survives_plan_changes_but_not_account_switches() {
    let original = json!({"account":{"type":"chatgpt","email":"a@example.com","id":"account-a","planType":"plus"}});
    let mut upgraded = original.clone();
    upgraded["account"]["planType"] = json!("pro");
    assert_eq!(account_identity(&original), account_identity(&upgraded));
    upgraded["account"]["id"] = json!("account-b");
    assert_ne!(account_identity(&original), account_identity(&upgraded));
}

#[test]
fn quota_wait_revalidates_the_model_binding_without_switching_models() {
    let original = json!({"model_id":"selected", "model_provider":"provider", "api_key":"old"});
    let mut rotated = original.clone();
    rotated["api_key"] = json!("rotated");
    validate_model(&original, &rotated).unwrap();
    rotated["model_id"] = json!("another-model");
    assert_eq!(
        validate_model(&original, &rotated).unwrap_err().code,
        "quota_model_changed"
    );
}
