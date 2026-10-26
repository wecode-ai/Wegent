// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

#[tokio::test]
async fn task_streaming_cleanup_identifies_the_callback_round_in_its_atomic_delete() {
    let id = 9_007_199_254_740_993_i64;
    let current = json!({"subtask_id": id}).to_string();
    let next = json!({"subtask_id": id + 1}).to_string();
    for (stored, deleted) in [
        (Some(current.clone()), true),
        (Some(next), false),
        (Some("{invalid".to_owned()), false),
        (None, false),
    ] {
        let redis = NoRedis {
            streaming_status: stored.clone(),
            ..Default::default()
        };
        let result = crate::internal_callback::session::clear_task_streaming_status(&redis, 42, id)
            .await
            .unwrap();
        assert_eq!(result, i64::from(deleted));
        let commands = redis.commands.lock().unwrap();
        assert_eq!(commands[0], ["GET", "chat:task_streaming:42"]);
        assert_eq!(commands.len(), if deleted { 2 } else { 1 });
        if deleted {
            assert_eq!(commands[1][0], "EVAL");
            assert_eq!(
                &commands[1][2..],
                &["1", "chat:task_streaming:42", stored.as_ref().unwrap()]
            );
        }
    }
}

#[tokio::test]
async fn late_terminal_callbacks_cannot_finish_the_next_execution_of_a_reused_task() {
    for status in ["COMPLETED", "FAILED", "CANCELLED"] {
        let capture = TransactionCapture::default();
        let completed_a = execution_row_with(11, "COMPLETED").await;
        let running_b = execution_row_with(12, "RUNNING").await;
        *capture.executions.lock().unwrap() = Some(std::collections::BTreeMap::from([
            (11, completed_a),
            (12, running_b),
        ]));
        let round_b = current_round_rows(12, 34).await;
        capture.rows.lock().unwrap().extend(round_b);
        let redis = NoRedis::default();
        let manager = manager();
        let celery = crate::CeleryBroker::new(None);
        let ctx = Completion {
            mysql: &capture,
            redis: &redis,
            tables: tables(),
            executor_manager: &manager,
            celery: &celery,
        };
        let old_result = json!({"value": "result from A"});
        let event_a = TaskCompletedEvent {
            task_id: 42,
            subtask_id: 33,
            user_id: 7,
            status,
            result: Some(&old_result),
            error: Some("error from A"),
        };
        handle_task_completed(&ctx, &event_a).await;
        assert_eq!(
            capture.update_attempts(),
            0,
            "old {status} must not update B or counters/inbox"
        );
        assert!(
            redis.commands.lock().unwrap().is_empty(),
            "old {status} must not publish status/notification"
        );
        assert_eq!(
            capture.executions.lock().unwrap().as_ref().unwrap().len(),
            2
        );
        assert_eq!(
            capture.statements().len(),
            2,
            "stale round stops before execution lookup or cleanup"
        );

        // The same handler and database fixture must accept B's own callback.
        let round_b = current_round_rows(12, 34).await;
        capture.rows.lock().unwrap().extend(round_b);
        let result_b = json!({"value": "result from B"});
        let event_b = TaskCompletedEvent {
            subtask_id: 34,
            result: Some(&result_b),
            error: None,
            ..event_a
        };
        handle_task_completed(&ctx, &event_b).await;
        assert!(
            capture.update_attempts() > 0,
            "current {status} must finalize B"
        );
        let statements = capture.statements();
        let lookup = statements
            .iter()
            .find(|query| query.sql.contains("FROM background_executions WHERE id=?"))
            .unwrap();
        assert_eq!(lookup.first_integer, Some(12));
        let remaining = capture.executions.lock().unwrap();
        assert!(
            remaining.as_ref().unwrap().contains_key(&11),
            "A must not be selected again"
        );
        assert!(!remaining.as_ref().unwrap().contains_key(&12));
        let commands = redis.commands.lock().unwrap();
        let update: Value = serde_json::from_str(&commands[0][2]).unwrap();
        assert_eq!(update["data"][0]["execution_id"], 12);
        assert_eq!(update["data"][0]["result_summary"], "result from B");
        assert_eq!(update["data"][0]["error_message"], "");
        assert_eq!(
            commands
                .iter()
                .filter(|command| command[0] == "PUBLISH")
                .count(),
            1
        );
        assert_eq!(
            commands
                .iter()
                .filter(|command| command[0] == "LPUSH")
                .count(),
            usize::from(status != "CANCELLED")
        );
    }
}

#[tokio::test]
async fn a_new_round_starting_after_status_commit_prevents_old_runtime_cleanup() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let manager =
        ExecutorManager::new(format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let capture = TransactionCapture::default();
    let initial_round = current_round_rows(11, 33).await;
    let next_round = current_round_rows(12, 34).await;
    let execution = execution_row().await;
    let subscription = crate::sql_test_support::mysql_row::row(vec![
        (
            "json",
            json!(json!({"spec": {"displayName": "Fixture"}}).to_string()),
        ),
        ("name", json!("schedule")),
    ])
    .await;
    capture.rows.lock().unwrap().extend(
        initial_round
            .into_iter()
            .chain([execution, subscription])
            .chain(next_round),
    );
    let redis = NoRedis::default();
    let celery = crate::CeleryBroker::new(None);
    let ctx = Completion {
        mysql: &capture,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
        celery: &celery,
    };
    let event = TaskCompletedEvent {
        task_id: 42,
        subtask_id: 33,
        user_id: 7,
        status: "COMPLETED",
        result: None,
        error: None,
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        handle_task_completed(&ctx, &event),
    )
    .await
    .unwrap();
    assert_eq!(capture.transaction_count(), 2);
    assert!(
        listener.accept().unwrap_err().kind() == std::io::ErrorKind::WouldBlock,
        "B's runtime must not receive a delete request"
    );
    assert!(
        !capture
            .statements()
            .iter()
            .any(|query| query.sql.contains("executor_deleted_at=?"))
    );
    assert!(capture.values.lock().unwrap().iter().any(|(sql, value)| {
        sql.starts_with("UPDATE background_executions") && value == "COMPLETED"
    }));
}
