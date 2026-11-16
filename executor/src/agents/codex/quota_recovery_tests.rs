// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::tests::{completed, overload_error, shared_options, state};
use super::*;

#[tokio::test]
async fn quota_recovery_shared_reader_requires_a_durable_runtime_owner() {
    use super::super::{read_shared_turn_notifications, CodexAppServerClient};
    use crate::runner::ExecutionOutcome;
    for enabled in [false, true] {
        let client = CodexAppServerClient::new("quota-reader-test");
        let (sender, mut receiver) = tokio::sync::broadcast::channel(16);
        let (notify, _notifications) = tokio::sync::mpsc::unbounded_channel();
        let mut error = overload_error();
        error["params"]["error"]["codexErrorInfo"] = json!("usageLimitExceeded");
        sender.send(error.into()).unwrap();
        sender.send(completed("failed").into()).unwrap();
        let mut options = shared_options(notify, None);
        options.recover_usage_limits = enabled;
        let mut state = state();
        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            read_shared_turn_notifications(
                &client,
                &mut receiver,
                "root-thread",
                &mut state,
                30,
                tokio::time::Instant::now() + Duration::from_secs(30),
                options,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        if enabled {
            assert_eq!(outcome, ExecutionOutcome::Running);
            assert_eq!(state.quota_recovery.unwrap().turn_id, "failed-turn");
        } else {
            assert!(matches!(outcome, ExecutionOutcome::Failed { .. }));
            assert!(state.quota_recovery.is_none());
        }
    }
}

#[test]
fn quota_recovery_waits_for_saved_history_and_preserves_the_stopped_goal() {
    let mut recovery = TurnRecovery::default();
    recovery.recover_usage_limits = true;
    let mut error = overload_error();
    error["params"]["error"]["codexErrorInfo"] = json!("usageLimitExceeded");
    assert!(matches!(
        recovery.observe(&error, &state()),
        RecoveryAction::AwaitCompletion
    ));
    let goal = json!({"threadId":"root-thread","objective":"finish", "status":"usageLimited","tokenBudget":2000,"tokensUsed":300});
    recovery.observe(
        &json!({"method":"thread/goal/updated","params":{
            "threadId":"root-thread","turnId":"failed-turn","goal":goal
        }}),
        &state(),
    );
    let RecoveryAction::WaitForQuota(wait) = recovery.observe(&completed("failed"), &state())
    else {
        panic!("quota recovery was not deferred")
    };
    assert_eq!(wait.thread_id, "root-thread");
    assert_eq!(wait.turn_id, "failed-turn");
    assert_eq!(wait.goal, Some(goal));
}

#[test]
fn quota_recovery_never_overrides_native_retries_or_a_user_goal_change() {
    let mut recovery = TurnRecovery::default();
    recovery.recover_usage_limits = true;
    let mut error = overload_error();
    error["params"]["error"]["codexErrorInfo"] = json!("usageLimitExceeded");
    error["params"]["willRetry"] = json!(true);
    assert!(matches!(
        recovery.observe(&error, &state()),
        RecoveryAction::Forward
    ));
    error["params"]["willRetry"] = json!(false);
    recovery.observe(&error, &state());
    recovery.observe(
        &json!({"method":"thread/goal/updated","params":{
            "threadId":"root-thread","turnId":"failed-turn","goal":{"status":"usageLimited"}
        }}),
        &state(),
    );
    recovery.observe(
        &json!({"method":"thread/goal/cleared","params":{"threadId":"root-thread"}}),
        &state(),
    );
    assert!(matches!(
        recovery.observe(&completed("failed"), &state()),
        RecoveryAction::Forward
    ));
}
