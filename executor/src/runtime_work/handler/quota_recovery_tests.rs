// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::super::tests::ScalarEnv;
use super::*;

struct ProviderHold(PathBuf);

#[tokio::test]
async fn quota_recheck_reservation_remains_publicly_queued() {
    let _lock = crate::test_env::lock();
    let (handler, _root) = super::super::tests::isolated_runtime_work_handler("quota-recheck");
    let turn = queued_wait("waiting", now_ms() - 1);
    handler.store.upsert_task(RuntimeTaskLink::new_pending(
        "waiting".into(),
        "/work".into(),
        "Wait".into(),
    ));
    handler.project_quota_waits(&VecDeque::from([turn.clone()]));
    handler.reserve_turn_preparation(&turn);
    let response = handler.get_task(&json!({"taskId":"waiting"})).unwrap();
    assert_eq!(response["task"]["status"], "queued");
    assert_eq!(response["task"]["running"], false);
    assert_eq!(response["task"]["executionState"]["phase"], "queued");
    assert!(response["task"]["runtimeHandle"]["quotaWait"].is_object());
    assert!(handler
        .preparing_turns
        .lock()
        .unwrap()
        .contains_key("waiting"));
}

impl Drop for ProviderHold {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

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
                tokio::time::timeout(
                    Duration::from_secs(2),
                    handler.cancel_task(json!({"taskId":"waiting"})),
                )
                .await
                .expect("Cancellation must not wait for the provider query")
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
    verify_quota_wait_protocol(false);
}

#[cfg(unix)]
#[test]
fn quota_interrupt_during_account_read_does_not_wait_for_the_send_gate() {
    verify_quota_wait_protocol(true);
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug)]
enum ReplacementCheckpoint {
    PendingQuery,
    CancelledAtSendGate,
    ReplacedAtSendGate,
    ReplacedAtQueueOperation,
}

#[cfg(unix)]
fn verify_quota_wait_protocol(interrupt: bool) {
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
            let _hold_cleanup = ProviderHold(home.path().join("hold-account"));
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
            if interrupt {
                // A malformed replacement isolates stop acknowledgement from starting another turn.
                let error = tokio::time::timeout(
                    Duration::from_secs(2),
                    handler.interrupt_and_send(json!({"taskId":"waiting"})),
                )
                .await
                .expect("interrupt must acknowledge the stopped quota check before sending")
                .unwrap_err();
                assert_eq!(error.code, "bad_request");
            } else {
                assert_eq!(
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        handler.cancel_task(json!({"taskId":"waiting"})),
                    )
                    .await
                    .expect("cancellation must not wait for the blocked account read")
                    .unwrap()["accepted"],
                    true
                );
            }
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

            for checkpoint in [
                ReplacementCheckpoint::PendingQuery,
                ReplacementCheckpoint::CancelledAtSendGate,
                ReplacementCheckpoint::ReplacedAtSendGate,
                ReplacementCheckpoint::ReplacedAtQueueOperation,
            ] {
                let query_completed = !matches!(checkpoint, ReplacementCheckpoint::PendingQuery);
                let waits_for_queue =
                    matches!(checkpoint, ReplacementCheckpoint::ReplacedAtQueueOperation);
                // A cancelled request must not consume the next scenario's marker.
                handler.codex_app_server.restart().await;
                fs::remove_file(home.path().join("account-requested")).unwrap();
                fs::write(home.path().join("hold-account"), "").unwrap();
                let mut replacement_turn = queued_wait("replacement", 0);
                if waits_for_queue {
                    let mut saved = wait(&replacement_turn).unwrap();
                    saved.account = account_identity(&account);
                    set_wait(&mut replacement_turn, &saved);
                    fs::write(
                        home.path().join("turns.json"),
                        r#"{"data":[{"id":"failed","status":"failed","items":[]}]}"#,
                    )
                    .unwrap();
                    fs::write(
                        home.path().join("limits.json"),
                        json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":deadline / 1000}}})
                            .to_string(),
                    )
                    .unwrap();
                }
                let mut link = RuntimeTaskLink::new_pending(
                    "replacement".into(),
                    "/work".into(),
                    "Replacement".into(),
                );
                link.thread_id = Some("thread".into());
                handler.store.upsert_task(link);
                handler.reserve_turn_preparation(&replacement_turn);
                let recovering = handler.start_quota_turn(replacement_turn.clone());
                tokio::pin!(recovering);
                tokio::select! {
                    _ = &mut recovering => panic!("Recovery finished before the held provider query"),
                    requested = tokio::time::timeout(Duration::from_secs(2), async {
                        while !home.path().join("account-requested").exists() {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    }) => requested.unwrap(),
                }
                let gate = handler.task_send_gate("replacement");
                let send = gate.lock().await;
                let operation = if waits_for_queue {
                    Some(handler.turn_queue_operation.clone().lock_owned().await)
                } else {
                    None
                };
                if query_completed {
                    fs::remove_file(home.path().join("hold-account")).unwrap();
                    let client = handler.codex_app_server.for_request(&replacement_turn.request).unwrap();
                    // The fixture answers requests in order. This round trip flushes account/read.
                    client.request("account/read", json!({"refreshToken": false})).await.unwrap();
                    // An account mismatch reaches the gate immediately; the queue case reads on.
                    assert!(futures_util::poll!(recovering.as_mut()).is_pending());
                }
                let send = if waits_for_queue {
                    drop(send);
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        futures_util::future::poll_fn(|cx| {
                            assert!(std::future::Future::poll(recovering.as_mut(), cx).is_pending());
                            // Owning the send gate proves the query and first ownership guard ran.
                            if gate.try_lock().is_err() {
                                std::task::Poll::Ready(())
                            } else {
                                std::task::Poll::Pending
                            }
                        }),
                    )
                    .await
                    .expect("Recovery must reach the held queue operation");
                    None
                } else {
                    Some(send)
                };
                let retained_execution = if matches!(
                    checkpoint,
                    ReplacementCheckpoint::ReplacedAtSendGate
                        | ReplacementCheckpoint::ReplacedAtQueueOperation
                ) {
                    // Keep the sender alive so ownership changes without cancellation winning.
                    Some(handler.active_local_executions.lock().unwrap().remove("replacement").unwrap())
                } else {
                    None
                };
                handler.reserve_turn_preparation(&replacement_turn);
                let (cancel, _cancelled) = oneshot::channel();
                let (_stopped, stopped) = oneshot::channel();
                let execution =
                    handler.start_local_task_execution("replacement".into(), cancel, stopped);
                let expected = handler.store.get_task("replacement").unwrap();
                drop(send);
                drop(operation);
                tokio::time::timeout(Duration::from_secs(2), recovering)
                    .await
                    .expect("Replaced quota recovery must stop without waiting for the provider");
                assert!(handler.is_current_local_task_execution("replacement", execution));
                assert!(handler
                    .preparing_turns
                    .lock()
                    .unwrap()
                    .contains_key("replacement"));
                assert_eq!(
                    serde_json::to_value(handler.store.get_task("replacement").unwrap()).unwrap(),
                    serde_json::to_value(expected).unwrap(),
                    "Old recovery must preserve the replacement's task state and preparation ({checkpoint:?})"
                );
                drop(retained_execution);
                handler.finish_local_task_execution("replacement", execution);
                handler
                    .preparing_turns
                    .lock()
                    .unwrap()
                    .remove("replacement");
                if !query_completed {
                    fs::remove_file(home.path().join("hold-account")).unwrap();
                }
            }
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

#[test]
fn replaced_quota_check_cannot_settle_or_remove_the_current_execution() {
    use std::future::Future;
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
          for provider_finished in [false, true] {
            let (mut handler, root) =
                super::super::tests::isolated_runtime_work_handler("quota-replaced-check");
            super::super::tests::install_native_history(&mut handler, &root, vec![], None);
            let mut link =
                RuntimeTaskLink::new_pending("waiting".into(), "/work".into(), "Wait".into());
            link.thread_id = Some("thread".into());
            handler.store.upsert_task(link);
            fs::write(root.join("account_read.hold"), "").unwrap();
            fs::write(
                root.join("account_read.json"),
                json!({"account":{"type":"chatgpt","email":"changed@example.com"}}).to_string(),
            )
            .unwrap();
            let turn = queued_wait("waiting", 0);
            let client = handler.codex_app_server.for_request(&turn.request).unwrap();
            handler.reserve_turn_preparation(&turn);
            let mut running = std::pin::pin!(handler.start_quota_turn(turn));
            let requested = async {
                while !fs::read_to_string(root.join("requests.jsonl"))
                    .unwrap_or_default()
                    .contains("\"method\":\"account/read\"")
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            tokio::time::timeout(Duration::from_secs(5), async {
                tokio::select! {
                    _ = &mut running => panic!("Quota check completed before the held account response"),
                    _ = requested => {},
                }
            }).await.unwrap();
            let gate = handler.task_send_gate("waiting");
            let replacement = gate.lock().await;
            if provider_finished {
                fs::write(root.join("test_fence.json"), "{}").unwrap();
                fs::remove_file(root.join("account_read.hold")).unwrap();
                // The serial native fixture answers this only after delivering account/read.
                client.request("test/fence", Value::Null).await.unwrap();
                // Consume that result and park specifically on the held send gate.
                std::future::poll_fn(|cx| {
                    assert!(running.as_mut().poll(cx).is_pending());
                    std::task::Poll::Ready(())
                }).await;
            }
            let (cancel, _cancelled) = oneshot::channel();
            let (_stopped, stopped) = oneshot::channel();
            let execution = handler.start_local_task_execution("waiting".into(), cancel, stopped);
            let state = handler.local_task_link("waiting").unwrap().execution_state;
            drop(replacement);
            tokio::time::timeout(Duration::from_secs(5), running)
                .await
                .unwrap();
            assert!(handler.is_current_local_task_execution("waiting", execution));
            assert_eq!(
                handler.local_task_link("waiting").unwrap().execution_state,
                state
            );
            assert!(handler
                .preparing_turns
                .lock()
                .unwrap()
                .contains_key("waiting"));
            if !provider_finished {
                fs::remove_file(root.join("account_read.hold")).unwrap();
            }
            handler.finish_local_task_execution("waiting", execution);
            handler.preparing_turns.lock().unwrap().remove("waiting");
            handler.codex_app_server.restart().await;
            let _ = fs::remove_dir_all(root);
          }
        });
}

#[test]
fn interrupting_a_pending_quota_read_admits_the_replacement_without_stop_timeout() {
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
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let (mut handler, root) = super::super::tests::isolated_runtime_work_handler("quota-interrupt-send");
        super::super::tests::install_native_history(&mut handler, &root, vec![], None);
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let mut link = RuntimeTaskLink::new_pending("waiting".into(), workspace.to_string_lossy().into(), "Wait".into());
        link.thread_id = Some("thread".into());
        handler.store.upsert_task(link);
        fs::write(root.join("account_read.defer"), "").unwrap();
        let turn = queued_wait("waiting", 0);
        handler.reserve_turn_preparation(&turn);
        let worker = handler.clone();
        let running = tokio::spawn(async move { worker.start_quota_turn(turn).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fs::read_to_string(root.join("requests.jsonl")).unwrap_or_default().contains("\"method\":\"account/read\"") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.settings.max_concurrent_tasks = 1;
            scheduler.active_task_ids.insert("another-task".into(), RuntimeTaskKind::Personal);
        }
        let sent = tokio::time::timeout(Duration::from_secs(2), handler.interrupt_and_send(json!({
            "taskId":"waiting", "message":"replacement", "executionRequest": ExecutionRequest {
                task_id: "waiting".into(),
                prompt: json!("replacement"),
                model_config: json!({"model_id":"original-model"}),
                project_workspace_path: Some(workspace.to_string_lossy().into()),
                bot: json!([{"shell_type":"Codex"}]),
                ..Default::default()
            }
        }))).await.expect("Interrupt must not hold the send gate needed by quota cancellation").unwrap();
        assert_eq!(sent["accepted"], true, "{sent}");
        assert_eq!(sent["status"], "queued", "{sent}");
        tokio::time::timeout(Duration::from_secs(2), running).await.unwrap().unwrap();
        assert!(!handler.is_active_local_task("waiting"));
        {
            let scheduler = handler.turn_scheduler.lock().unwrap();
            let replacement = scheduler.queued_turns.iter().find(|turn| turn.local_task_id == "waiting").unwrap();
            assert_eq!(replacement.request.prompt, json!("replacement"));
            assert!(!replacement.request.extra.contains_key(MARKER));
        }
        handler.codex_app_server.restart().await;
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn interrupt_stop_cannot_cancel_a_replacement_execution() {
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
                super::super::tests::isolated_runtime_work_handler("interrupt-new-owner");
            handler.store.upsert_task(RuntimeTaskLink::new_pending(
                "task".into(),
                root.to_string_lossy().into(),
                "Wait".into(),
            ));
            let (cancel, cancelled) = oneshot::channel();
            let (_old_stopped, stopped) = oneshot::channel();
            handler.start_local_task_execution("task".into(), cancel, stopped);
            let worker = handler.clone();
            let interrupt = tokio::spawn(async move {
                worker
                    .interrupt_and_send(json!({"taskId":"task","message":"replacement"}))
                    .await
            });
            tokio::time::timeout(Duration::from_secs(2), cancelled)
                .await
                .unwrap()
                .unwrap();
            let gate = handler.task_send_gate("task");
            let guard = tokio::time::timeout(Duration::from_secs(2), gate.lock())
                .await
                .expect("Interrupt must release admission while waiting for the old execution");
            let (cancel, mut cancelled) = oneshot::channel();
            let (_new_stopped, stopped) = oneshot::channel();
            let execution = handler.start_local_task_execution("task".into(), cancel, stopped);
            let state = handler.local_task_link("task").unwrap().execution_state;
            drop(guard);
            let result = tokio::time::timeout(Duration::from_secs(2), interrupt)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(result["success"], false, "{result}");
            assert_eq!(result["error"], "runtime task is already running");
            assert!(handler.is_current_local_task_execution("task", execution));
            assert!(matches!(
                cancelled.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            assert_eq!(
                handler.local_task_link("task").unwrap().execution_state,
                state
            );
            handler.finish_local_task_execution("task", execution);
            let _ = fs::remove_dir_all(root);
        });
}

#[tokio::test]
async fn interrupt_timeout_preserves_the_unconfirmed_execution() {
    let (handler, root) =
        super::super::tests::isolated_runtime_work_handler("interrupt-unconfirmed");
    handler.store.upsert_task(RuntimeTaskLink::new_pending(
        "task".into(),
        root.to_string_lossy().into(),
        "Wait".into(),
    ));
    let (cancel, _cancelled) = oneshot::channel();
    let (_stop_sender, stopped) = oneshot::channel();
    let execution = handler.start_local_task_execution("task".into(), cancel, stopped);
    let result = handler
        .interrupt_and_send(json!({"taskId":"task", "message":"replacement"}))
        .await;
    assert!(
        handler.is_current_local_task_execution("task", execution),
        "An unacknowledged stop cannot release execution ownership: {result:?}"
    );
    let result = result.unwrap();
    assert_eq!(result["success"], false);
    assert_eq!(result["error"], "runtime task is already running");
    assert!(handler
        .turn_scheduler
        .lock()
        .unwrap()
        .queued_turns
        .is_empty());
    handler.finish_local_task_execution("task", execution);
    let _ = fs::remove_dir_all(root);
}

fn with_handler(label: &str, verify: impl FnOnce(&RuntimeWorkRpcHandler)) {
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
    let (handler, root) = super::super::tests::isolated_runtime_work_handler(label);
    verify(&handler);
    fs::remove_dir_all(root).unwrap();
}

fn seed_wait(handler: &RuntimeWorkRpcHandler, active: bool) {
    let mut link = RuntimeTaskLink::new_pending("waiting".into(), "/work".into(), "Wait".into());
    link.thread_id = Some("thread".into());
    if active {
        crate::runtime_work::lifecycle::begin_native_request(&mut link);
    }
    handler.store.upsert_task(link);
    let turns = VecDeque::from([queued_wait("waiting", now_ms() + 3_600_000)]);
    handler.turn_scheduler.lock().unwrap().queued_turns = turns.clone();
    handler.project_quota_waits(&turns);
}

#[test]
fn publishing_a_parked_quota_wait_also_settles_the_active_lifecycle() {
    with_handler("quota-park-projection", |handler| {
        seed_wait(handler, true);
        let public = handler.get_task(&json!({"taskId":"waiting"})).unwrap();
        assert_eq!(public["task"]["status"], "queued");
        assert_eq!(public["task"]["running"], false);
        assert_eq!(public["task"]["executionState"]["phase"], "queued");
        assert!(public["task"]["runtimeHandle"]["quotaWait"].is_object());
    });
}

#[test]
fn admitting_a_quota_recheck_removes_the_wait_with_the_starting_lifecycle() {
    with_handler("quota-admit-projection", |handler| {
        seed_wait(handler, false);
        handler.turn_scheduler.lock().unwrap().queued_turns.clear();
        handler.store.update_task("waiting", |link| {
            crate::runtime_work::lifecycle::begin_native_request(link);
        });
        let public = handler.get_task(&json!({"taskId":"waiting"})).unwrap();
        assert_eq!(public["task"]["running"], true);
        assert_eq!(public["task"]["executionState"]["phase"], "starting");
        assert!(public["task"]["runtimeHandle"].get("quotaWait").is_none());
    });
}
