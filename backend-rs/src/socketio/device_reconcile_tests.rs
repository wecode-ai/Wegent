#![cfg(test)]

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use brz_mysql::{
    FromMysqlRow, MysqlArgs, MysqlError, MysqlExecution, MysqlResult, MysqlTransaction,
};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};

use super::*;
use crate::socketio::execution_aggregate::{ExecutionRow, transition_terminal};

fn requested_at() -> NaiveDateTime {
    NaiveDateTime::parse_from_str("2026-10-29 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap()
}

fn row(status: &str, observed: &str, reason: Option<&str>) -> ExecutionRow {
    ExecutionRow {
            id: 7,
            loop_item_id: Some("issue-1".into()),
            cloud_project_id: Some("project-1".into()),
            executor_owner_user_id: Some(3),
            agent_id: Some("agent-1".into()),
            team_id: Some(0),
            automation_run_id: Some("run-1".into()),
            execution_environment: Some("cloud".into()),
            execution_device_id: Some("device-1".into()),
            assigner_user_id: Some(3),
            status: Some(status.into()),
            priority_weight: Some(20),
            started_at: None,
            attempt_no: Some(1),
            execution_scope: Some("scope-1".into()),
            observed_state: Some(observed.into()),
            start_requested_at: reason.map(|_| requested_at()),
            last_event_seq: None,
            termination_reason: reason.map(str::to_owned),
            retry_attempt: Some(0),
            max_retries: Some(1),
            execution_note: Some("previous note".into()),
            approval_status: Some(String::new()),
            approved_by_user_id: None,
            approved_at: None,
            runtime_device_id: Some("device-1".into()),
            runtime_task_id: Some("codex-queue-7".into()),
            execution_payload: Some(
                r#"{"schema_version":2,"runtime_selection":{"executor_kind":"local"},"origin_context":{}}"#
                    .into(),
            ),
            version: Some(4),
        }
}

#[test]
fn capacity_statuses_match_the_source_set() {
    for status in ["running", "claimed", "cancel_requested"] {
        assert!(is_capacity_status(Some(status)), "{status}");
    }
    for status in ["completed", "queued", "failed", ""] {
        assert!(!is_capacity_status(Some(status)), "{status}");
    }
    assert!(!is_capacity_status(None));
}

#[test]
fn terminal_families_prefer_failed_then_cancelled_then_completed() {
    assert_eq!(terminal_status("failed", ""), Some("failed"));
    assert_eq!(terminal_status("error", ""), Some("failed"));
    assert_eq!(terminal_status("running", "interrupted"), Some("cancelled"));
    assert_eq!(terminal_status("canceled", ""), Some("cancelled"));
    assert_eq!(terminal_status("succeeded", ""), Some("completed"));
    assert_eq!(terminal_status("weird", "completed"), Some("completed"));
    assert_eq!(terminal_status("weird", ""), None);
    // The whole observation set decides, so a failed turn wins over a
    // completed status.
    assert_eq!(terminal_status("completed", "failed"), Some("failed"));
}

#[test]
fn unconfirmed_start_requires_the_whole_source_predicate() {
    assert!(is_unconfirmed_start(&row(
        "claimed",
        "unconfirmed",
        Some("start_confirmation_timeout")
    )));
    assert!(!is_unconfirmed_start(&row(
        "running",
        "unconfirmed",
        Some("start_confirmation_timeout")
    )));
    assert!(!is_unconfirmed_start(&row(
        "claimed",
        "accepted",
        Some("start_confirmation_timeout")
    )));
    assert!(!is_unconfirmed_start(&row("claimed", "unconfirmed", None)));
    let mut epoch = row("claimed", "unconfirmed", Some("start_confirmation_timeout"));
    epoch.start_requested_at = Some(chrono::DateTime::<Utc>::UNIX_EPOCH.naive_utc());
    assert!(!is_unconfirmed_start(&epoch));
}

#[test]
fn snapshots_keep_the_task_id_aliases_and_success_guard() {
    let response = json!({
        "success": true,
        "workspaces": [
            {"tasks": [{"taskId": "codex-queue-7", "status": "running", "running": true}]},
            {"tasks": [{"task_id": "codex-queue-8", "status": "completed"}]},
            {"tasks": [{}]},
            "ignored",
        ],
    });
    let snapshots = reported_snapshots(&response).expect("a successful response");
    assert_eq!(snapshots.len(), 2);
    assert_eq!(snapshots["codex-queue-7"]["status"], json!("running"));
    assert_eq!(snapshots["codex-queue-8"]["status"], json!("completed"));
}

#[test]
fn protocol_failures_never_become_an_empty_task_list() {
    // `success: false`, a missing `success`, and a non-object response are
    // the source's `return 0`: no snapshot may be produced, so the caller
    // cannot write a `missing` observation for every execution.
    for response in [
        json!({"success": false, "workspaces": [{"tasks": [{"taskId": "codex-queue-7"}]}]}),
        json!({"workspaces": [{"tasks": [{"taskId": "codex-queue-7"}]}]}),
        json!({"success": 0}),
        json!(["not-a-dict"]),
        json!("not-a-dict"),
        Value::Null,
    ] {
        assert_eq!(reported_snapshots(&response), None, "{response}");
    }
    // A successful response with no tasks is a valid empty observation.
    assert_eq!(
        reported_snapshots(&json!({"success": true})),
        Some(HashMap::new())
    );
}

#[test]
fn non_iterable_task_containers_abort_before_any_write() {
    // Python's `for` raises `TypeError` on these present values, so the
    // background job ends before any execution is reconciled.
    for response in [
        json!({"success": true, "workspaces": null}),
        json!({"success": true, "workspaces": 3}),
        json!({"success": true, "workspaces": true}),
        json!({"success": true, "workspaces": [{"tasks": null}]}),
        json!({"success": true, "workspaces": [{"tasks": 7}]}),
        json!({"success": true, "workspaces": [{"tasks": false}]}),
    ] {
        assert_eq!(reported_snapshots(&response), None, "{response}");
    }
    // Strings and objects are iterable in Python; every member is a
    // non-dict and is skipped, so these are valid empty observations.
    for response in [
        json!({"success": true, "workspaces": "text"}),
        json!({"success": true, "workspaces": {"0": {"tasks": []}}}),
        json!({"success": true, "workspaces": [{"tasks": "text"}]}),
    ] {
        assert_eq!(
            reported_snapshots(&response),
            Some(HashMap::new()),
            "{response}"
        );
    }
}

#[test]
fn the_accepted_lease_uses_the_source_five_minutes() {
    assert_eq!(DEFAULT_LEASE_SECONDS, 300);
    let now = NaiveDateTime::parse_from_str("2026-10-29 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    let expected =
        NaiveDateTime::parse_from_str("2026-10-29 00:05:00", "%Y-%m-%d %H:%M:%S").unwrap();
    assert_eq!(accepted_lease_expires_at(now), expected);
}

#[test]
fn a_missing_snapshot_is_the_source_missing_status() {
    let response = json!({"success": true, "workspaces": [{"tasks": []}]});
    let snapshots = reported_snapshots(&response).expect("a successful response");
    assert!(!snapshots.contains_key("codex-queue-7"));
}

#[test]
fn the_reported_start_rewrites_the_epoch_sentinels() {
    let now = NaiveDateTime::parse_from_str("2026-10-29 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    let started =
        NaiveDateTime::parse_from_str("2026-10-29 00:00:05", "%Y-%m-%d %H:%M:%S").unwrap();
    let mut execution = row("running", "running", None);
    execution.started_at = Some(started);
    assert_eq!(observed_started_at(&execution, now), started);
    for sentinel in [
        chrono::DateTime::<Utc>::UNIX_EPOCH.naive_utc(),
        chrono::DateTime::<Utc>::UNIX_EPOCH.naive_utc() + chrono::Duration::seconds(1),
    ] {
        execution.started_at = Some(sentinel);
        assert_eq!(observed_started_at(&execution, now), now, "{sentinel}");
    }
    execution.started_at = None;
    assert_eq!(observed_started_at(&execution, now), now);
}

#[test]
fn turn_status_prefers_the_camel_case_field() {
    assert_eq!(
        turn_status_text(&json!({"turnStatus": "failed", "turn_status": "completed"})),
        "failed"
    );
    assert_eq!(
        turn_status_text(&json!({"turn_status": "completed"})),
        "completed"
    );
    assert_eq!(turn_status_text(&json!({"turnStatus": ""})), "");
    assert_eq!(truthy_text(Some(&json!(0))), "");
    assert_eq!(truthy_text(Some(&json!("running"))), "running");
}

#[test]
fn the_stall_snapshot_separates_the_transition_note_from_the_content() {
    let mut execution = row("cancel_requested", "running", Some("stall_timeout"));
    execution.execution_note = Some(String::new());
    assert_eq!(
        cancelled_snapshot_text(&execution),
        (
            CANCELLED_SNAPSHOT_NOTE.to_owned(),
            "Runtime execution stalled".to_owned()
        )
    );
    execution.execution_note = Some("stalled at tool call".into());
    assert_eq!(
        cancelled_snapshot_text(&execution),
        (
            CANCELLED_SNAPSHOT_NOTE.to_owned(),
            "stalled at tool call".to_owned()
        )
    );
    let ordinary = row("cancel_requested", "running", None);
    assert_eq!(
        cancelled_snapshot_text(&ordinary),
        (
            CANCELLED_SNAPSHOT_NOTE.to_owned(),
            CANCELLED_SNAPSHOT_NOTE.to_owned()
        )
    );
}
#[tokio::test]
async fn a_slow_first_job_does_not_block_the_second_worker() {
    let (sender, receiver) = mpsc::channel(4);
    let receiver = Arc::new(Mutex::new(receiver));
    sender
        .send(ReconcileJob {
            user_id: 1,
            device_id: "device-a".into(),
            needs_confirmation_only: false,
        })
        .await
        .expect("queue the first job");
    sender
        .send(ReconcileJob {
            user_id: 2,
            device_id: "device-b".into(),
            needs_confirmation_only: true,
        })
        .await
        .expect("queue the second job");
    // The first worker takes its job and parks on a slow RPC; the receive
    // lock is released before processing, so the second worker still
    // reads its own job immediately.
    let first = next_job(&receiver).await.expect("the first job");
    let second = tokio::time::timeout(Duration::from_millis(200), next_job(&receiver))
        .await
        .expect("the second job is not queued behind the first")
        .expect("the second job");
    assert_eq!(first.device_id, "device-a");
    assert!(!first.needs_confirmation_only);
    assert_eq!(second.device_id, "device-b");
    assert!(second.needs_confirmation_only);
}

/// A transaction that records every `execute` statement and its argument count.
#[derive(Clone, Default)]
struct RecordingTransaction {
    statements: Arc<StdMutex<Vec<(String, usize)>>>,
}

impl RecordingTransaction {
    fn statements(&self) -> Vec<(String, usize)> {
        self.statements.lock().unwrap().clone()
    }
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        let sql = sql
            .as_ref()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        self.statements.lock().unwrap().push((sql, args.len()));
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Err(MysqlError::RowNotFound)
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::empty()
    }

    async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn cancel_confirmation_has_no_version_predicate() {
    let recorder = RecordingTransaction::default();
    let mut transaction = recorder.clone();
    let execution = row("cancel_requested", "running", None);
    confirm_runtime_cancelled(&mut transaction, &execution, requested_at())
        .await
        .expect("the confirmation runs");
    let statements = recorder.statements();
    let (sql, args) = statements.first().expect("one execution update");
    // The source's `confirm_runtime_cancelled` passes `expected_status` only.
    assert!(sql.contains("WHERE id=? AND status=?"), "{sql}");
    assert!(!sql.contains("AND version=?"), "{sql}");
    // SET status/completed_at/lease/observed_state/observed_at/reason/error,
    // the execution note, then updated_at/id/status; no version argument.
    assert_eq!(*args, 11, "{sql}");
}

#[tokio::test]
async fn a_heartbeat_version_bump_does_not_defeat_the_cancel_confirmation() {
    // The row was read at version 4; a heartbeat advanced it to 5 before the
    // confirmation ran. Because the confirmation's statement carries no
    // version predicate, it still elects the row instead of silently
    // updating zero rows.
    let recorder = RecordingTransaction::default();
    let mut transaction = recorder.clone();
    let read_row = row("cancel_requested", "running", None);
    assert_eq!(read_row.version, Some(4));
    confirm_runtime_cancelled(&mut transaction, &read_row, requested_at())
        .await
        .expect("the confirmation runs");
    let statements = recorder.statements();
    let (sql, _) = statements.first().expect("one execution update");
    assert!(
        !sql.contains("version=?"),
        "a version bump after the read must not defeat the confirmation: {sql}"
    );
    assert!(sql.contains("status=?"), "{sql}");
}

#[tokio::test]
async fn a_snapshot_terminal_keeps_the_version_predicate() {
    let recorder = RecordingTransaction::default();
    let mut transaction = recorder.clone();
    let execution = row("running", "running", None);
    transition_terminal(
        &mut transaction,
        &execution,
        "completed",
        "",
        Some("Runtime reconciled"),
        Some(execution.version.unwrap_or(0)),
        None,
        "runtime_succeeded",
        "succeeded",
        requested_at(),
    )
    .await
    .expect("the terminal update runs");
    let statements = recorder.statements();
    let (sql, args) = statements.first().expect("one execution update");
    assert!(sql.contains("AND version=?"), "{sql}");
    // SET (7 + note) + updated_at/id/status/version.
    assert_eq!(*args, 12, "{sql}");
}

pub(crate) async fn verify_reconnect_projection(
    mysql: &impl brz_mysql::Mysql,
) -> anyhow::Result<()> {
    const PROJECT: &str = "reconnect-fixture-project";
    const ISSUE: &str = "reconnect-fixture-issue";
    const AGENT: &str = "reconnect-fixture-agent";
    mysql.execute(
        "INSERT INTO loop_items(id, resource_type, description, metadata, created_at, updated_at) VALUES (?, 'project', '', JSON_OBJECT(), NOW(), NOW())",
        (PROJECT,),
    ).await?;
    mysql.execute(
        "INSERT INTO loop_items(id, resource_type, cloud_project_id, title, description, metadata, status, assignee_agent_id, created_at, updated_at) VALUES (?, 'task', ?, 'Reconnect issue', '', JSON_OBJECT(), 'in_progress', ?, NOW(), NOW()), (?, 'chat_agent', ?, 'Reconnect agent', '', JSON_OBJECT(), 'active', '', NOW(), NOW())",
        (ISSUE, PROJECT, AGENT, AGENT, PROJECT),
    ).await?;
    let inserted = mysql.execute(
        "INSERT INTO loop_item_executions(loop_item_id, cloud_project_id, agent_id, executor_owner_user_id, status, observed_state, runtime_device_id, runtime_task_id, execution_payload, error_message) VALUES (?, ?, ?, 7, 'running', 'running', 'fixture-device', 'fixture-conversation', '{}', '')",
        (ISSUE, PROJECT, AGENT),
    ).await?;
    let execution_id = inserted.last_insert_id as i64;
    mysql.execute(
        "UPDATE loop_items SET metadata=JSON_OBJECT('ai_state', JSON_OBJECT('run_id', 'fixture-run', 'status', 'running', 'project_chat_message_id', 'missing-activity', 'runtime_task_id', 'fixture-conversation')) WHERE id=?",
        (ISSUE,),
    ).await?;
    let effects = mysql
        .with_transaction(async |tx| {
            let execution = runtime_projection::reload_execution(tx, execution_id)
                .await?
                .unwrap();
            assert!(
                runtime_projection::linked_activity(tx, &execution)
                    .await?
                    .is_none()
            );
            let snapshots = reported_snapshots(&json!({"success": true, "workspaces": [{"tasks": [
                {"taskId": "fixture-conversation", "status": "completed", "running": false}
            ]}]}))
            .unwrap();
            let status = truthy_text(snapshots["fixture-conversation"].get("status"));
            apply_snapshot(tx, &execution, &status, false, None).await
        })
        .await?
        .expect("the snapshot wins the terminal transition");
    assert!(effects.changed);
    assert_eq!(
        effects.matched.as_ref().unwrap().status_or_empty(),
        "completed"
    );
    assert_eq!(effects.messages.len(), 1);
    assert_eq!(effects.messages[0].status, "completed");
    assert_eq!(effects.messages[0].metadata.0["run_id"], "fixture-run");
    assert!(effects.messages[0].metadata.0["runtime_completed_at"].is_string());
    let issue = crate::background_jobs::project::store::get(mysql, "task", ISSUE)
        .await?
        .unwrap();
    assert_eq!(issue.status, "in_review");
    assert_eq!(issue.metadata.0["ai_state"]["status"], "completed");

    let repeat = mysql
        .with_transaction(async |tx| {
            let execution = runtime_projection::reload_execution(tx, execution_id)
                .await?
                .unwrap();
            let activity = runtime_projection::linked_activity(tx, &execution)
                .await?
                .unwrap();
            assert_eq!(activity.message_id, effects.messages[0].message_id);
            assert_eq!(activity.status, "completed");
            apply_snapshot(tx, &execution, "completed", false, None).await
        })
        .await?;
    assert!(
        repeat.is_none(),
        "duplicate snapshots must not produce lifecycle effects"
    );
    Ok(())
}
