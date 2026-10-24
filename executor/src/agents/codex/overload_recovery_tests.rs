// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runner::ExecutionOutcome;

fn overload_error() -> Value {
    json!({
        "method": "error",
        "params": {
            "threadId": "root-thread",
            "turnId": "failed-turn",
            "willRetry": false,
            "error": {
                "message": "Selected model is at capacity. Please try a different model.",
                "codexErrorInfo": "serverOverloaded",
                "additionalDetails": null
            }
        }
    })
}

fn completed(status: &str) -> Value {
    json!({
        "method": "turn/completed",
        "params": {
            "threadId": "root-thread",
            "turn": {"id": "failed-turn", "status": status}
        }
    })
}

fn state() -> CodexRunState {
    let mut state = CodexRunState::default();
    state.set_root_thread_id("root-thread");
    state
}

#[test]
fn overload_recovery_waits_for_saved_history_and_uses_bounded_backoff() {
    let mut recovery = OverloadRecovery::default();
    let state = state();
    for (index, seconds) in RETRY_DELAYS.into_iter().enumerate() {
        assert!(matches!(
            recovery.observe(&overload_error(), &state),
            RecoveryAction::AwaitCompletion
        ));
        assert!(matches!(
            recovery.observe(&json!({"method": "thread/status/changed"}), &state),
            RecoveryAction::Forward
        ));
        let RecoveryAction::Retry {
            delay,
            notification,
            ..
        } = recovery.observe(&completed("failed"), &state)
        else {
            panic!("settled overload should retry");
        };
        assert_eq!(delay, Duration::from_secs(seconds));
        assert_eq!(notification["params"]["willRetry"], true);
        assert_eq!(
            notification["params"]["error"]["codexErrorInfo"],
            "serverOverloaded"
        );
        assert!(notification["params"]["error"]["additionalDetails"]
            .as_str()
            .unwrap()
            .contains(&format!("({}/5)", index + 1)));
    }
    assert!(matches!(
        recovery.observe(&overload_error(), &state),
        RecoveryAction::Forward
    ));
    assert!(matches!(
        recovery.observe(&completed("failed"), &state),
        RecoveryAction::Forward
    ));
}

#[test]
fn overload_recovery_accepts_structured_completion_without_error_notification() {
    let mut recovery = OverloadRecovery::default();
    let mut message = completed("failed");
    message["params"]["turn"]["error"] = overload_error()["params"]["error"].clone();
    assert!(matches!(
        recovery.observe(&message, &state()),
        RecoveryAction::Retry { .. }
    ));
    let outcome = state().handle_message(&message).unwrap();
    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "Selected model is at capacity. Please try a different model.".to_owned()
        }
    );
}

fn blocked_goal(turn_id: Value) -> Value {
    json!({"method": "thread/goal/updated", "params": {
        "threadId": "root-thread", "turnId": turn_id,
        "goal": {
            "threadId": "root-thread", "objective": "Finish the original task",
            "status": "blocked", "tokenBudget": 10000,
            "tokensUsed": 123, "timeUsedSeconds": 45,
            "createdAt": 1, "updatedAt": 2
        }
    }})
}

#[test]
fn overload_recovery_restores_only_the_goal_stopped_by_the_failed_turn() {
    for turn_id in [json!("failed-turn"), json!("other-turn"), Value::Null] {
        let mut recovery = OverloadRecovery::default();
        let update = blocked_goal(turn_id.clone());
        recovery.observe(&update, &state());
        recovery.observe(&overload_error(), &state());
        let RecoveryAction::Retry { goal, .. } = recovery.observe(&completed("failed"), &state())
        else {
            panic!("overload should retry");
        };
        assert_eq!(
            goal,
            (turn_id == "failed-turn").then(|| update["params"]["goal"].clone())
        );
    }
}

#[test]
fn overload_recovery_does_not_restore_a_goal_after_user_mutation() {
    let stopped = blocked_goal(json!("failed-turn"));
    for status in [
        "active",
        "paused",
        "blocked",
        "complete",
        "usageLimited",
        "budgetLimited",
        "cleared",
    ] {
        let mut recovery = OverloadRecovery::default();
        recovery.observe(&stopped, &state());
        let mut mutation = blocked_goal(Value::Null);
        mutation["params"]["goal"]["status"] = json!(status);
        if status == "cleared" {
            mutation["method"] = json!("thread/goal/cleared");
        }
        recovery.observe(&mutation, &state());
        recovery.observe(&overload_error(), &state());
        assert!(
            matches!(
                recovery.observe(&completed("failed"), &state()),
                RecoveryAction::Forward
            ),
            "retried after {status}"
        );
    }
}

#[test]
fn overload_goal_resume_preserves_accounting_and_rejects_changes_during_backoff() {
    let expected = blocked_goal(json!("failed-turn"))["params"]["goal"].clone();
    assert_eq!(
        goal_resume_params(&expected, &json!({"goal": expected}))
            .unwrap()
            .unwrap(),
        json!({
            "threadId": "root-thread", "status": "active", "origin": "automatic",
        })
    );
    for (field, value) in [
        ("status", json!("active")),
        ("status", json!("paused")),
        ("status", json!("complete")),
        ("objective", json!("A different task")),
        ("tokenBudget", json!(20000)),
        ("updatedAt", json!(3)),
        ("createdAt", json!(3)),
    ] {
        let mut current = expected.clone();
        current[field] = value;
        assert!(goal_resume_params(&expected, &json!({"goal": current}))
            .unwrap()
            .is_none());
    }
    assert!(goal_resume_params(&expected, &json!({"goal": null}))
        .unwrap()
        .is_none());
}

#[test]
fn overload_recovery_never_retries_unrelated_errors_or_native_retries() {
    for code in [
        "usageLimitExceeded",
        "contextWindowExceeded",
        "badRequest",
        "unauthorized",
    ] {
        let mut recovery = OverloadRecovery::default();
        let mut message = overload_error();
        message["params"]["error"]["codexErrorInfo"] = json!(code);
        assert!(matches!(
            recovery.observe(&message, &state()),
            RecoveryAction::Forward
        ));
        assert!(matches!(
            recovery.observe(&completed("failed"), &state()),
            RecoveryAction::Forward
        ));
    }
    let mut recovery = OverloadRecovery::default();
    let mut message = overload_error();
    message["params"]["willRetry"] = json!(true);
    assert!(matches!(
        recovery.observe(&message, &state()),
        RecoveryAction::Forward
    ));
    message["params"]["willRetry"] = json!(false);
    message["params"]["error"]
        .as_object_mut()
        .unwrap()
        .remove("codexErrorInfo");
    assert!(matches!(
        recovery.observe(&message, &state()),
        RecoveryAction::Forward
    ));
}

#[test]
fn overload_recovery_does_not_resume_cancelled_or_completed_turns() {
    for status in ["interrupted", "completed"] {
        let mut recovery = OverloadRecovery::default();
        let state = state();
        recovery.observe(&overload_error(), &state);
        assert!(matches!(
            recovery.observe(&completed(status), &state),
            RecoveryAction::Forward
        ));
        assert!(matches!(
            recovery.observe(&completed("failed"), &state),
            RecoveryAction::Forward
        ));
    }
}

#[test]
fn overload_recovery_ignores_child_thread_and_subagent_turn_failures() {
    let mut recovery = OverloadRecovery::default();
    let mut error = overload_error();
    error["params"]["threadId"] = json!("child-thread");
    assert!(matches!(
        recovery.observe(&error, &state()),
        RecoveryAction::Forward
    ));
    let mut completion = completed("failed");
    completion["params"]["turn"]["agentPath"] = json!("/root/child");
    completion["params"]["turn"]["error"] = overload_error()["params"]["error"].clone();
    assert!(matches!(
        recovery.observe(&completion, &state()),
        RecoveryAction::Forward
    ));
}

#[test]
fn overload_recovery_continuation_preserves_settings_without_replaying_input() {
    let params = continuation_params(json!({
        "threadId": "root-thread",
        "model": "chosen-model",
        "effort": "high",
        "cwd": "/workspace",
        "approvalPolicy": "never",
        "outputSchema": {"type": "object"},
        "input": [{"type": "text", "text": "original task"}],
        "clientUserMessageId": "original-user-message",
        "additionalContext": [{"text": "already merged"}]
    }));
    assert_eq!(params["input"], json!([]));
    assert_eq!(params["threadId"], "root-thread");
    assert_eq!(params["model"], "chosen-model");
    assert_eq!(params["effort"], "high");
    assert_eq!(params["cwd"], "/workspace");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["outputSchema"], json!({"type": "object"}));
    assert!(params.get("clientUserMessageId").is_none());
    assert!(params.get("additionalContext").is_none());
}

#[tokio::test]
async fn overload_recovery_backoff_cancels_immediately() {
    let (sender, receiver) = oneshot::channel();
    let mut cancellation = Some(receiver);
    sender.send(()).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        wait_for_retry(Duration::from_secs(60), &mut cancellation),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), CODEX_APP_SERVER_TURN_CANCELLED);
}

#[tokio::test]
async fn overload_recovery_backoff_completes_without_cancellation() {
    wait_for_retry(Duration::ZERO, &mut None).await.unwrap();
}

fn shared_options(
    notifications: tokio::sync::mpsc::UnboundedSender<Value>,
    cancellation: Option<oneshot::Receiver<()>>,
) -> super::super::SharedTurnNotificationOptions {
    super::super::SharedTurnNotificationOptions {
        overload_turn_recovering: None,
        overload_continuation_params: json!({"threadId": "root-thread", "input": []}),
        active_turn_id: Some("failed-turn".to_owned()),
        expected_client_user_message_id: Some("original-user-message".to_owned()),
        notifications: Some(notifications),
        cancellation,
        request_user_input_answers: None,
        active_turn_started: None,
        active_turn_finished: None,
        wait_for_goal_continuation: false,
        auto_approve_mcp_tool_calls: false,
        stand_in_single_approval: false,
    }
}

#[tokio::test]
async fn overload_recovery_shared_reader_keeps_failure_internal_and_cancels_backoff() {
    use super::super::{read_shared_turn_notifications, CodexAppServerClient};
    let client = CodexAppServerClient::new("overload-cancel-reader-test");
    let (sender, mut receiver) = tokio::sync::broadcast::channel(16);
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    sender.send(overload_error()).unwrap();
    sender.send(completed("failed")).unwrap();
    let mut state = state();
    let (recovery_tx, mut recovery_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut options = shared_options(notify_tx, Some(cancel_rx));
    options.overload_turn_recovering = Some(Box::new(move |thread_id, turn_id| {
        recovery_tx.send((thread_id, turn_id)).unwrap();
    }));
    let read = read_shared_turn_notifications(
        &client,
        &mut receiver,
        "root-thread",
        &mut state,
        30,
        tokio::time::Instant::now() + Duration::from_secs(30),
        options,
    );
    let cancel = async {
        let notification = notify_rx.recv().await.unwrap();
        assert_eq!(notification["method"], "error");
        assert_eq!(notification["params"]["willRetry"], true);
        assert!(
            notify_rx.try_recv().is_err(),
            "failed turn leaked to the UI"
        );
        cancel_tx.send(()).unwrap();
    };
    let (result, ()) =
        tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(read, cancel) })
            .await
            .unwrap();
    assert_eq!(result.unwrap_err(), CODEX_APP_SERVER_TURN_CANCELLED);
    assert_eq!(
        recovery_rx.try_recv().unwrap(),
        ("root-thread".to_owned(), "failed-turn".to_owned())
    );
    assert!(recovery_rx.try_recv().is_err());
}

#[tokio::test]
async fn overload_recovery_shared_reader_does_not_retry_other_terminal_errors() {
    use super::super::{read_shared_turn_notifications, CodexAppServerClient};
    let client = CodexAppServerClient::new("overload-nonretryable-reader-test");
    let (sender, mut receiver) = tokio::sync::broadcast::channel(16);
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut error = overload_error();
    error["params"]["error"]["codexErrorInfo"] = json!("usageLimitExceeded");
    sender.send(error.clone()).unwrap();
    let mut state = state();
    let result = read_shared_turn_notifications(
        &client,
        &mut receiver,
        "root-thread",
        &mut state,
        30,
        tokio::time::Instant::now() + Duration::from_secs(30),
        shared_options(notify_tx, None),
    )
    .await
    .unwrap();
    assert!(matches!(result, ExecutionOutcome::Failed { .. }));
    assert_eq!(notify_rx.recv().await.unwrap(), error);
}

#[cfg(unix)]
#[tokio::test]
async fn overload_recovery_native_reader_continues_only_after_completion() {
    use super::super::{debug_stdout::CodexStdout, json_rpc::JsonRpcConnection};
    use std::process::Stdio;
    let script = format!(
        r#"printf '%s\n' '{{"id":1,"result":{{}}}}' '{error}' '{completed}'
IFS= read -r continuation
printf '%s\n' "{{\"method\":\"test/continuation\",\"params\":$continuation}}" '{{"id":2,"result":{{}}}}'
printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"root-thread","turn":{{"id":"recovered-turn"}}}}}}'
printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"root-thread","turnId":"recovered-turn","delta":"recovered"}}}}'
printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"root-thread","turn":{{"id":"recovered-turn","status":"completed"}}}}}}'
"#,
        error = overload_error(),
        completed = completed("failed"),
    );
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut rpc = JsonRpcConnection::new(
        child.stdin.take().unwrap(),
        CodexStdout::new(child.stdout.take().unwrap(), None),
        2,
    );
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel();
    let (recovery_tx, mut recovery_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut state = state();
    let params = continuation_params(json!({
        "threadId": "root-thread", "model": "original-model",
        "input": [{"type": "text", "text": "original task"}],
        "clientUserMessageId": "original-user-message",
    }));
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        rpc.read_turn(
            1,
            &mut state,
            super::super::json_rpc::TurnReadOptions {
                overload_turn_recovering: Some(Box::new(move |thread_id, turn_id| {
                    recovery_tx.send((thread_id, turn_id)).unwrap();
                })),
                overload_continuation_params: params,
                notifications: Some(notify_tx),
                request_user_input_answers: None,
                auto_approve_mcp_tool_calls: false,
                stand_in_single_approval: false,
                defer_interactive_forms: false,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "recovered".to_owned()
        }
    );
    let mut saw_continuation = false;
    let mut retry_notifications = 0;
    while let Ok(message) = notify_rx.try_recv() {
        if message["method"] == "test/continuation" {
            saw_continuation = true;
            assert_eq!(message["params"]["method"], "turn/start");
            assert_eq!(message["params"]["params"]["input"], json!([]));
            assert_eq!(message["params"]["params"]["model"], "original-model");
            assert!(message["params"]["params"]
                .get("clientUserMessageId")
                .is_none());
        } else if message["method"] == "error" {
            retry_notifications += 1;
            assert_eq!(message["params"]["willRetry"], true);
        } else if message["method"] == "turn/completed" {
            assert_eq!(message["params"]["turn"]["status"], "completed");
        }
    }
    assert!(saw_continuation);
    assert_eq!(retry_notifications, 1);
    assert_eq!(
        recovery_rx.try_recv().unwrap(),
        ("root-thread".to_owned(), "failed-turn".to_owned())
    );
    assert!(recovery_rx.try_recv().is_err());
    assert!(child.wait().await.unwrap().success());
}

#[cfg(unix)]
#[tokio::test]
async fn overload_recovery_native_reader_restores_goal_and_waits_for_automatic_continuation() {
    use super::super::{debug_stdout::CodexStdout, json_rpc::JsonRpcConnection};
    use std::process::Stdio;
    let stopped = blocked_goal(json!("failed-turn"));
    let mut active = stopped.clone();
    active["params"]["turnId"] = Value::Null;
    active["params"]["goal"]["status"] = json!("active");
    let mut complete = active.clone();
    complete["params"]["goal"]["status"] = json!("complete");
    let script = format!(
        r#"printf '%s\n' '{{"id":1,"result":{{}}}}' '{stopped}' '{error}' '{failed}'
IFS= read -r goal_get
printf '%s\n' '{{"id":2,"result":{{"goal":{goal}}}}}'
IFS= read -r goal_set
printf '%s\n' "{{\"method\":\"test/resume\",\"params\":$goal_set}}" '{{"id":3,"result":{{"goal":{active_goal}}}}}' '{active}'
printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"root-thread","turn":{{"id":"recovered-turn"}}}}}}'
printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"root-thread","turnId":"recovered-turn","delta":"first turn"}}}}'
printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"root-thread","turn":{{"id":"recovered-turn","status":"completed"}}}}}}'
printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"root-thread","turn":{{"id":"goal-continuation"}}}}}}'
printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"root-thread","turnId":"goal-continuation","delta":"goal finished"}}}}' '{complete}'
printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"root-thread","turn":{{"id":"goal-continuation","status":"completed"}}}}}}'
"#,
        error = overload_error(),
        failed = completed("failed"),
        goal = stopped["params"]["goal"],
        active_goal = active["params"]["goal"],
    );
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut rpc = JsonRpcConnection::new(
        child.stdin.take().unwrap(),
        CodexStdout::new(child.stdout.take().unwrap(), None),
        2,
    );
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut state = state();
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        rpc.read_turn(
            1,
            &mut state,
            super::super::json_rpc::TurnReadOptions {
                overload_turn_recovering: None,
                overload_continuation_params: json!({"threadId": "root-thread", "input": []}),
                notifications: Some(notify_tx),
                request_user_input_answers: None,
                auto_approve_mcp_tool_calls: false,
                stand_in_single_approval: false,
                defer_interactive_forms: false,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "goal finished".to_owned()
        }
    );
    assert_eq!(
        state.goal_status_snapshot(),
        (true, Some("complete".to_owned()))
    );
    let mut resume = None;
    while let Ok(message) = notify_rx.try_recv() {
        if message["method"] == "test/resume" {
            resume = Some(message["params"].clone());
        }
    }
    let resume = resume.expect("Goal was never resumed");
    assert_eq!(resume["method"], "thread/goal/set");
    assert_eq!(
        resume["params"],
        json!({"threadId": "root-thread", "status": "active", "origin": "automatic"})
    );
    assert!(child.wait().await.unwrap().success());
}

#[cfg(unix)]
#[tokio::test]
async fn overload_recovery_native_reader_settles_goal_mutation_without_stop_button_request() {
    use super::super::{debug_stdout::CodexStdout, json_rpc::JsonRpcConnection};
    use std::process::Stdio;
    let stopped = blocked_goal(json!("failed-turn"));
    let mut paused = stopped["params"]["goal"].clone();
    paused["status"] = json!("paused");
    let script = format!(
        r#"printf '%s\n' '{{"id":1,"result":{{}}}}' '{stopped}' '{error}' '{failed}'
IFS= read -r goal_get
printf '%s\n' '{{"id":2,"result":{{"goal":{paused}}}}}'
"#,
        error = overload_error(),
        failed = completed("failed"),
    );
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut rpc = JsonRpcConnection::new(
        child.stdin.take().unwrap(),
        CodexStdout::new(child.stdout.take().unwrap(), None),
        2,
    );
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut state = state();
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        rpc.read_turn(
            1,
            &mut state,
            super::super::json_rpc::TurnReadOptions {
                overload_turn_recovering: None,
                overload_continuation_params: json!({"threadId": "root-thread", "input": []}),
                notifications: Some(notify_tx),
                request_user_input_answers: None,
                auto_approve_mcp_tool_calls: false,
                stand_in_single_approval: false,
                defer_interactive_forms: false,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(outcome, ExecutionOutcome::Cancelled { .. }));
    assert_eq!(
        state.goal_status_snapshot(),
        (true, Some("paused".to_owned()))
    );
    let mut last_goal = None;
    while let Ok(message) = notify_rx.try_recv() {
        if message["method"] == "thread/goal/updated" {
            last_goal = Some(message["params"]["goal"].clone());
        }
    }
    assert_eq!(last_goal, Some(paused));
    assert!(child.wait().await.unwrap().success());
}

#[cfg(unix)]
#[tokio::test]
async fn overload_recovery_serializes_user_mutations_between_goal_read_and_resume() {
    use super::super::{CodexAppServerClient, CodexAppServerProcess, CodexNotificationHub};
    use std::{
        collections::{BTreeMap, HashMap},
        process::Stdio,
        sync::Arc,
    };
    use tokio::{
        io::{AsyncBufReadExt, BufReader},
        sync::Mutex,
    };
    for method in ["thread/goal/set", "thread/goal/clear"] {
        let client = CodexAppServerClient::new(format!("goal-recovery-gate-{method}"));
        client.mark_thread_active("root-thread").await;
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "cat"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        super::super::configure_codex_app_server_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut requests = BufReader::new(child.stdout.take().unwrap()).lines();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut shared = client.state.lock().await;
            shared.process_environment =
                client.process_environment(&shared.runtime_proxy_env, &BTreeMap::new());
            shared.process = Some(CodexAppServerProcess {
                child,
                stdin: Arc::new(Mutex::new(stdin)),
                pending: Arc::clone(&pending),
                notifications: CodexNotificationHub::new(),
                reader_task: tokio::spawn(async {}),
            });
        }
        let expected = blocked_goal(json!("failed-turn"))["params"]["goal"].clone();
        let gate = client.thread_lifecycle_gate("root-thread").await;
        let recovery_client = client.clone();
        let recovery_goal = expected.clone();
        let recovery = tokio::spawn(async move {
            resume_goal(&recovery_client, "root-thread", &recovery_goal).await
        });
        let read: Value =
            serde_json::from_str(&requests.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(read["method"], "thread/goal/get");
        let user_client = client.clone();
        let user_mutation = tokio::spawn(async move {
            user_client
                .mutate_thread_goal(
                    method,
                    json!({"threadId": "root-thread", "status": "paused"}),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while Arc::strong_count(&gate) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("user mutation must reach the gate while the recovery snapshot is held");
        assert!(!user_mutation.is_finished());
        pending
            .lock()
            .await
            .remove(&read["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"goal": expected})))
            .unwrap();
        let resume: Value =
            serde_json::from_str(&requests.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(resume["method"], "thread/goal/set");
        assert_eq!(
            resume["params"]["status"], "active",
            "the user mutation interleaved before automatic recovery"
        );
        let mut active = expected.clone();
        active["status"] = json!("active");
        pending
            .lock()
            .await
            .remove(&resume["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"goal": active})))
            .unwrap();
        assert!(recovery.await.unwrap().unwrap().1);
        let user: Value =
            serde_json::from_str(&requests.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(user["method"], method);
        assert_eq!(user["params"]["status"], "paused");
        let response = if method == "thread/goal/clear" {
            json!({"cleared": true})
        } else {
            json!({"goal": {"status": "paused"}})
        };
        pending
            .lock()
            .await
            .remove(&user["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(response.clone()))
            .unwrap();
        assert_eq!(user_mutation.await.unwrap().unwrap(), response);
        client.restart().await;
    }
}
