// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn overload_recovery_waits_for_saved_history_and_uses_bounded_backoff() {
    let mut recovery = TurnRecovery::default();
    let state = state();
    for (index, seconds) in [10, 30, 120, 300].into_iter().enumerate() {
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
        assert_eq!(notification["params"]["retryAttempt"], index + 1);
        assert_eq!(
            notification["params"]["retryMaxAttempts"],
            RETRY_DELAYS.len()
        );
        assert_eq!(
            notification["params"]["error"]["codexErrorInfo"],
            "serverOverloaded"
        );
        assert!(notification["params"]["error"]["additionalDetails"]
            .as_str()
            .unwrap()
            .contains(&format!("({}/4)", index + 1)));
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
    let mut recovery = TurnRecovery::default();
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

#[test]
fn overload_recovery_restores_only_the_goal_stopped_by_the_failed_turn() {
    for turn_id in [json!("failed-turn"), json!("other-turn"), Value::Null] {
        let mut recovery = TurnRecovery::default();
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
        let mut recovery = TurnRecovery::default();
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
    let mut accounted = expected.clone();
    accounted["tokensUsed"] = json!(1000);
    accounted["timeUsedSeconds"] = json!(90);
    accounted["updatedAt"] = json!(3);
    assert!(goal_resume_params(&expected, &json!({"goal": accounted}))
        .unwrap()
        .is_some());
}

#[test]
fn overload_recovery_never_retries_unrelated_errors_or_native_retries() {
    for code in [
        "usageLimitExceeded",
        "contextWindowExceeded",
        "badRequest",
        "unauthorized",
    ] {
        let mut recovery = TurnRecovery::default();
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
    let mut recovery = TurnRecovery::default();
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
        let mut recovery = TurnRecovery::default();
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
    let mut recovery = TurnRecovery::default();
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

#[test]
fn overload_recovery_test_timing_preserves_ratios_and_rejects_invalid_bases() {
    for (attempt, milliseconds) in [2_000, 6_000, 24_000, 60_000].into_iter().enumerate() {
        assert_eq!(
            super::overload_retry_delay(attempt, Some("2000")),
            std::time::Duration::from_millis(milliseconds)
        );
    }
    for configured in [
        None,
        Some("0"),
        Some("10001"),
        Some("invalid"),
        Some("18446744073709551615"),
    ] {
        assert_eq!(
            super::overload_retry_delay(3, configured),
            std::time::Duration::from_secs(300)
        );
    }
}
