// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Post-registration execution reconciliation.
//!
//! Source: `app/api/ws/device_namespace.py::_register_device_session`
//! schedules `_schedule_background_task(reconcile_device_executions(...))`
//! after it marks the device online, and
//! `app/tasks/robot_queue_tasks.py::reconcile_device_executions` reads the
//! active executions, asks the executor for its task list through
//! `sio.call("runtime:rpc", {"method": "runtime.tasks.list", "payload": {}})`
//! with a 15 second timeout, and applies each reported snapshot through
//! `loop_item_execution_service.reconcile_runtime_snapshot`.
//!
//! The source runs this on its own event-loop task. This module owns a
//! dedicated bounded worker so the read is never queued behind the
//! registration capability sync, mirroring the source's independent task.
//!
//! The execution aggregate and activity projection are committed together.
//! Lifecycle effects are delivered after commit.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use brz_json::adapters::python_truthy;
use brz_mysql::{MysqlResult, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::device_online_state::read_online_state;
use crate::json_compat::python_str;
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;
use crate::runtime_work::call_runtime_rpc;
use crate::socketio::execution_aggregate::{
    CAPACITY_STATUSES, DEFAULT_LEASE_SECONDS, EPOCH_TIME, ERROR_LIMIT, ExecutionRow, NOTE_LIMIT,
    set_automation_run_status, transition_terminal,
};
use crate::socketio::execution_intent::{retry_execution_payload, retry_runtime_task_id};
use crate::sql_support::StatementArg;
use crate::state::AppState;

use super::{
    runtime::SocketRuntime,
    runtime_projection::{self, lifecycle::Effects},
};

/// `reconcile_device_executions`' `runtime.tasks.list` method.
const RUNTIME_TASKS_LIST_METHOD: &str = "runtime.tasks.list";
/// The `/local-executor` namespace that carries the call.
const LOCAL_EXECUTOR_NAMESPACE: &str = "/local-executor";
/// `sio.call(..., timeout=15)`.
const RECONCILE_TIMEOUT_SECONDS: u64 = 15;
/// `active_for_device_reconciliation`'s row bound.
const RECONCILE_LIMIT: usize = 100;

/// The `missing` snapshot of a `cancel_requested` execution.
const CANCELLED_SNAPSHOT_NOTE: &str = "Runtime no longer reports the cancelled task";

/// One queued post-registration or post-heartbeat reconciliation.
pub struct ReconcileJob {
    pub user_id: i64,
    pub device_id: String,
    /// The source keeps the two call sites distinguishable: registration uses
    /// `needs_confirmation_only=false`, heartbeat `true`.
    pub needs_confirmation_only: bool,
}

/// Startup-owned reconcile workers; several jobs run independently, like the
/// source's per-registration `asyncio` tasks.
pub(crate) const RECONCILE_WORKER_COUNT: usize = 4;

/// Takes the next job, holding the receiver lock only for the receive.
///
/// The caller processes the job after this returns, so another worker can take
/// the next one while a slow `runtime.tasks.list` RPC is in flight.
pub(super) async fn next_job(
    jobs: &Arc<tokio::sync::Mutex<mpsc::Receiver<ReconcileJob>>>,
) -> Option<ReconcileJob> {
    let mut jobs = jobs.lock().await;
    jobs.recv().await
}

/// The reconcile worker. Runs until the queue closes or the service stops.
pub(crate) async fn run_worker(
    jobs: Arc<tokio::sync::Mutex<mpsc::Receiver<ReconcileJob>>>,
    state: Arc<AppState>,
    runtime: Weak<SocketRuntime>,
) {
    loop {
        let job = tokio::select! {
            job = next_job(&jobs) => job,
            () = tokio::time::sleep(Duration::from_secs(1)) => {
                if state.shutdown.is_shutting_down() {
                    return;
                }
                continue;
            }
        };
        let Some(job) = job else {
            return;
        };
        if state.shutdown.is_shutting_down() {
            return;
        }
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        reconcile_after_register(
            &state,
            &runtime,
            job.user_id,
            &job.device_id,
            job.needs_confirmation_only,
        )
        .await;
    }
}

/// `reconcile_device_executions`. The active read runs on a pooled connection
/// and releases it before the online read, matching the source's closed
/// session boundary.
async fn reconcile_after_register(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    needs_confirmation_only: bool,
) {
    let executions: Vec<ExecutionRow> = match state
        .mysql
        .fetch_all(
            reconcile_statement(needs_confirmation_only),
            (user_id, device_id),
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, user_id, device_id, "device execution reconcile read failed");
            return;
        }
    };
    if executions.is_empty() {
        return;
    }
    let Some(socket_id) = online_socket_id(state, user_id, device_id).await else {
        return;
    };
    let Some(response) = call_runtime_tasks_list(state, user_id, device_id, &socket_id).await
    else {
        return;
    };
    // A non-dict response or a falsy `success` is the source's `return 0`.
    // Only a successful response turns an absent task into an observed
    // `missing` snapshot.
    let Some(snapshots) = reported_snapshots(&response) else {
        return;
    };
    for execution in &executions {
        let runtime_task_id = execution.runtime_task_id.clone().unwrap_or_default();
        let snapshot = snapshots.get(&runtime_task_id);
        let (runtime_status, running, turn_status) = match snapshot {
            Some(value) => (
                truthy_text(value.get("status")),
                value.get("running").is_some_and(python_truthy),
                Some(turn_status_text(value)),
            ),
            None => ("missing".to_owned(), false, None),
        };
        if let Err(error) = reconcile_one(
            state,
            runtime,
            execution.id,
            &runtime_status,
            running,
            turn_status.as_deref(),
        )
        .await
        {
            // The source's exception escapes `reconcile_device_executions` and
            // ends the background task; later executions are not processed.
            tracing::error!(
                %error,
                user_id,
                device_id,
                execution = execution.id,
                "device execution snapshot reconcile failed"
            );
            return;
        }
    }
}

/// `active_for_device_reconciliation`'s statement. The heartbeat caller adds
/// the source's unconfirmed-attempt predicate; the registration caller does
/// not.
fn reconcile_statement(needs_confirmation_only: bool) -> String {
    let confirmation = if needs_confirmation_only {
        " AND (loop_item_executions.sync_state = 'stale' OR \
         (loop_item_executions.status = 'claimed' \
         AND loop_item_executions.observed_state = 'accepted'))"
    } else {
        ""
    };
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.executor_owner_user_id = ? \
         AND loop_item_executions.runtime_device_id = ? \
         AND loop_item_executions.runtime_task_id != '' \
         AND loop_item_executions.status IN ({CAPACITY_STATUSES}){confirmation} \
         ORDER BY loop_item_executions.id ASC \n LIMIT {RECONCILE_LIMIT}"
    )
}

/// `device_service.get_device_online_info` followed by the truthy
/// `socket_id` guard. A read failure is the source's unhandled background-task
/// error, so it only stops this job.
async fn online_socket_id(state: &AppState, user_id: i64, device_id: &str) -> Option<String> {
    match read_online_state::<Value>(state, user_id, device_id).await {
        Ok(Some(Value::Object(online))) => online
            .get("socket_id")
            .filter(|value| python_truthy(value))
            .and_then(Value::as_str)
            .map(str::to_owned),
        Ok(_) => None,
        Err(error) => {
            tracing::error!(
                ?error,
                user_id,
                device_id,
                "device execution reconcile online read failed"
            );
            None
        }
    }
}

/// `sio.call("runtime:rpc", {"method": "runtime.tasks.list", "payload": {}},
/// to=socket_id, namespace="/local-executor", timeout=15)`.
async fn call_runtime_tasks_list(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    socket_id: &str,
) -> Option<Value> {
    match call_runtime_rpc(
        state,
        user_id,
        socket_id,
        LOCAL_EXECUTOR_NAMESPACE,
        RUNTIME_TASKS_LIST_METHOD,
        json!({}),
        Duration::from_secs(RECONCILE_TIMEOUT_SECONDS),
    )
    .await
    {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::error!(
                %error,
                user_id,
                device_id,
                "device execution reconcile RPC failed"
            );
            None
        }
    }
}

/// `snapshots[runtime_task_id] = task` from a successful `runtime.tasks.list`
/// response.
///
/// `None` is the source's abrupt end: a non-dict response, a falsy `success`,
/// or a present `workspaces`/`tasks` value that Python cannot iterate
/// (`null`, a number, or a boolean raises `TypeError`) stops the background
/// job before any snapshot is applied. A missing key defaults to `[]`, and
/// strings/objects iterate to non-dict members that are skipped, so those are
/// valid empty observations.
fn reported_snapshots(response: &Value) -> Option<HashMap<String, Value>> {
    let object = response.as_object()?;
    if !object.get("success").is_some_and(python_truthy) {
        return None;
    }
    let mut snapshots = HashMap::new();
    for workspace in python_iter(object.get("workspaces"))? {
        let Some(workspace) = workspace.as_object() else {
            continue;
        };
        for task in python_iter(workspace.get("tasks"))? {
            let Some(task) = task.as_object() else {
                continue;
            };
            let task_id = task
                .get("taskId")
                .filter(|value| python_truthy(value))
                .or_else(|| task.get("task_id").filter(|value| python_truthy(value)))
                .map(python_str)
                .unwrap_or_default();
            if !task_id.is_empty() {
                snapshots.insert(task_id, Value::Object(task.clone()));
            }
        }
    }
    Some(snapshots)
}

/// Python's `for item in value` over a JSON value.
///
/// A missing key defaults to `[]`. Arrays yield their members, and strings and
/// objects are iterable too (characters and keys), but their members are never
/// dicts, so the callers' `isinstance(..., dict)` guard skips them. `null`, a
/// number, or a boolean raises `TypeError`, which the source does not catch.
fn python_iter(value: Option<&Value>) -> Option<Vec<&Value>> {
    match value {
        None => Some(Vec::new()),
        Some(Value::Array(items)) => Some(items.iter().collect()),
        Some(Value::String(_) | Value::Object(_)) => Some(Vec::new()),
        Some(Value::Null | Value::Bool(_) | Value::Number(_)) => None,
    }
}

/// `snapshot.get("status") or ""`.
fn truthy_text(value: Option<&Value>) -> String {
    value
        .filter(|value| python_truthy(value))
        .map(python_str)
        .unwrap_or_default()
}

/// `snapshot.get("turnStatus") or snapshot.get("turn_status") or ""`.
fn turn_status_text(snapshot: &Value) -> String {
    snapshot
        .get("turnStatus")
        .filter(|value| python_truthy(value))
        .or_else(|| {
            snapshot
                .get("turn_status")
                .filter(|value| python_truthy(value))
        })
        .map(python_str)
        .unwrap_or_default()
}

/// One `reconcile_runtime_snapshot` call on its own transaction.
async fn reconcile_one(
    state: &AppState,
    runtime: &SocketRuntime,
    execution_id: i64,
    runtime_status: &str,
    running: bool,
    turn_status: Option<&str>,
) -> MysqlResult<()> {
    let effects = state
        .mysql
        .with_transaction(async |transaction| {
            let Some(row) = runtime_projection::reload_execution(transaction, execution_id).await?
            else {
                return Ok(None);
            };
            if !is_capacity_status(row.status.as_deref()) {
                return Ok(None);
            }
            apply_snapshot(transaction, &row, runtime_status, running, turn_status).await
        })
        .await?;
    if let Some(effects) = effects {
        effects.deliver(state, runtime).await;
    }
    Ok(())
}

/// `is_capacity_status`: the aggregate still accepts runtime observations.
fn is_capacity_status(status: Option<&str>) -> bool {
    matches!(status, Some("running" | "claimed" | "cancel_requested"))
}

/// `reconcile_runtime_snapshot`'s branch selection and transitions.
pub(super) async fn apply_snapshot<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    runtime_status: &str,
    running: bool,
    turn_status: Option<&str>,
) -> MysqlResult<Option<Effects>> {
    if !is_capacity_status(row.status.as_deref()) {
        return Ok(None);
    }
    let now = Utc::now().naive_utc();
    let normalized = runtime_status.to_lowercase().trim().to_owned();
    let normalized_turn = turn_status.unwrap_or("").to_lowercase().trim().to_owned();
    if normalized == "missing" && row.status.as_deref() == Some("cancel_requested") {
        return confirm_runtime_cancelled(transaction, row, now).await;
    }
    if normalized == "missing" && is_unconfirmed_start(row) {
        requeue_unconfirmed_start(transaction, row, now).await?;
        return Ok(None);
    }
    if running || matches!(normalized.as_str(), "running" | "in_progress") {
        observe_running(transaction, row, now).await?;
        return restore_active_activity(transaction, row.id).await;
    }
    match terminal_status(&normalized, &normalized_turn) {
        Some("completed") => {
            return terminal(
                transaction,
                row,
                "completed",
                "",
                Some("Runtime reconciled"),
                Some(""),
                Some(row.version.unwrap_or(0)),
                "runtime_succeeded",
                "succeeded",
                now,
            )
            .await;
        }
        Some("failed") => {
            return fail_reconciled(transaction, row, now).await;
        }
        Some(_) => {
            return terminal(
                transaction,
                row,
                "cancelled",
                "",
                Some("Runtime reconciled cancellation"),
                Some("AI execution was cancelled."),
                Some(row.version.unwrap_or(0)),
                "runtime_reconciled_cancelled",
                "cancelled",
                now,
            )
            .await;
        }
        None => {}
    }
    if matches!(
        normalized.as_str(),
        "accepted" | "active" | "pending" | "queued" | "starting"
    ) {
        observe_accepted(transaction, row, now).await?;
        return restore_active_activity(transaction, row.id).await;
    }
    observe_diverged(transaction, row, runtime_status, now).await?;
    Ok(None)
}

async fn restore_active_activity(
    tx: &mut impl MysqlTransaction,
    execution_id: i64,
) -> MysqlResult<Option<Effects>> {
    let Some(row) = runtime_projection::reload_execution(tx, execution_id).await? else {
        return Ok(None);
    };
    let before = runtime_projection::lifecycle::item_version(tx, Some(&row)).await?;
    let messages = runtime_projection::open_runtime_activity(tx, &row)
        .await?
        .into_iter()
        .collect();
    let changed = runtime_projection::lifecycle::item_version(tx, Some(&row)).await? != before;
    Ok(Some(Effects {
        matched: Some(row),
        changed,
        detail: String::new(),
        messages,
    }))
}

/// `terminal_observations` mapping: the first matching family wins.
fn terminal_status(normalized: &str, normalized_turn: &str) -> Option<&'static str> {
    let observed = [normalized, normalized_turn];
    if observed
        .iter()
        .any(|value| matches!(*value, "failed" | "error"))
    {
        return Some("failed");
    }
    if observed
        .iter()
        .any(|value| matches!(*value, "cancelled" | "canceled" | "interrupted" | "aborted"))
    {
        return Some("cancelled");
    }
    if observed
        .iter()
        .any(|value| matches!(*value, "completed" | "succeeded"))
    {
        return Some("completed");
    }
    None
}

/// `normalized == "missing" and row.status == "claimed" and
/// row.observed_state == "unconfirmed" and
/// row.termination_reason == "start_confirmation_timeout" and
/// not loop_datetime_value_is_unset(row.start_requested_at)`.
fn is_unconfirmed_start(row: &ExecutionRow) -> bool {
    row.status.as_deref() == Some("claimed")
        && row.observed_state.as_deref() == Some("unconfirmed")
        && row.termination_reason.as_deref() == Some("start_confirmation_timeout")
        && row
            .start_requested_at
            .is_some_and(|value| !datetime_is_unset(value))
}

/// `loop_datetime_value_is_unset`: NULL or one of the epoch sentinels.
fn datetime_is_unset(value: NaiveDateTime) -> bool {
    let epoch = chrono::DateTime::<Utc>::UNIX_EPOCH.naive_utc();
    value == epoch || value == epoch + chrono::Duration::seconds(1)
}

/// The `(note, content/error)` pair `confirm_runtime_cancelled` computes for a
/// `missing` snapshot.
///
/// `stall_timeout` keeps the passed note for the transition note while the
/// persisted execution note (or its default) supplies `content`/`error`; the
/// ordinary cancellation uses the passed note for both.
fn cancelled_snapshot_text(row: &ExecutionRow) -> (String, String) {
    if row.termination_reason.as_deref() != Some("stall_timeout") {
        return (
            CANCELLED_SNAPSHOT_NOTE.to_owned(),
            CANCELLED_SNAPSHOT_NOTE.to_owned(),
        );
    }
    let stored_note = row
        .execution_note
        .as_deref()
        .filter(|value| !value.is_empty());
    let content = stored_note
        .unwrap_or("Runtime execution stalled")
        .to_owned();
    let note = Some(CANCELLED_SNAPSHOT_NOTE)
        .filter(|value| !value.is_empty())
        .or(stored_note)
        .unwrap_or_default()
        .to_owned();
    (note, content)
}

/// `confirm_runtime_cancelled` for the `missing` snapshot of a
/// `cancel_requested` execution.
async fn confirm_runtime_cancelled<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    now: NaiveDateTime,
) -> MysqlResult<Option<Effects>> {
    let (note, content) = cancelled_snapshot_text(row);
    if row.termination_reason.as_deref() == Some("stall_timeout") {
        return terminal(
            transaction,
            row,
            "failed",
            &content,
            Some(&note),
            Some(&content),
            None,
            "stall_timeout",
            "cancelled",
            now,
        )
        .await;
    }
    terminal(
        transaction,
        row,
        "cancelled",
        "",
        Some(&note),
        // `content=note or "AI execution was cancelled."`; this call site's
        // note is the fixed non-empty text.
        Some(CANCELLED_SNAPSHOT_NOTE),
        // `confirm_runtime_cancelled` passes `expected_status` only; the
        // source adds no version predicate, so a heartbeat-driven version
        // bump after this row was read must not defeat the confirmation.
        None,
        "runtime_cancel_acknowledged",
        "cancelled",
        now,
    )
    .await
}

/// `if loop_datetime_value_is_unset(row.started_at): started_at = now`: the
/// epoch sentinels count as unset, so they are never kept as a real start.
fn observed_started_at(row: &ExecutionRow, now: NaiveDateTime) -> NaiveDateTime {
    row.started_at
        .filter(|value| !datetime_is_unset(*value))
        .unwrap_or(now)
}

/// The `running` / `in_progress` observation.
async fn observe_running<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    now: NaiveDateTime,
) -> MysqlResult<()> {
    let next_status = if row.status.as_deref() == Some("cancel_requested") {
        "cancel_requested"
    } else {
        "running"
    };
    let started_at = observed_started_at(row, now);
    let version = row.version.unwrap_or(0) + 1;
    transaction
        .execute(
            "UPDATE loop_item_executions SET status=?, observed_state='running', \
             sync_state='in_sync', error_message='', termination_reason='', observed_at=?, \
             started_at=?, version=?, updated_at=? WHERE id=?",
            (next_status, now, started_at, version, now, row.id),
        )
        .await?;
    set_automation_run_status(transaction, row.automation_run_id.as_deref(), "running").await
}

/// `row.lease_expires_at = now + timedelta(seconds=DEFAULT_LEASE_SECONDS)` for
/// the accepted observation.
fn accepted_lease_expires_at(now: NaiveDateTime) -> NaiveDateTime {
    now + chrono::Duration::seconds(DEFAULT_LEASE_SECONDS)
}

/// The `accepted` / `active` / `pending` / `queued` / `starting` observation.
async fn observe_accepted<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    now: NaiveDateTime,
) -> MysqlResult<()> {
    let lease_expires_at = accepted_lease_expires_at(now);
    let version = row.version.unwrap_or(0) + 1;
    transaction
        .execute(
            "UPDATE loop_item_executions SET observed_state='accepted', sync_state='in_sync', \
             error_message='', termination_reason='', observed_at=?, heartbeat_at=?, \
             lease_expires_at=?, version=?, updated_at=? WHERE id=?",
            (now, now, lease_expires_at, version, now, row.id),
        )
        .await?;
    Ok(())
}

/// The unrecognized snapshot status.
async fn observe_diverged<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    runtime_status: &str,
    now: NaiveDateTime,
) -> MysqlResult<()> {
    let reported = if runtime_status.is_empty() {
        "missing"
    } else {
        runtime_status
    };
    let message: String = format!("Runtime returned unrecognized status '{reported}'")
        .chars()
        .take(ERROR_LIMIT)
        .collect();
    let version = row.version.unwrap_or(0) + 1;
    transaction
        .execute(
            "UPDATE loop_item_executions SET sync_state='diverged', error_message=?, \
             version=?, updated_at=? WHERE id=?",
            (message, version, now, row.id),
        )
        .await?;
    Ok(())
}

/// `fail(requeue_infra=True)` for a claimed attempt whose start never
/// confirmed: the row returns to `queued` without consuming a retry.
async fn requeue_unconfirmed_start<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    now: NaiveDateTime,
) -> MysqlResult<()> {
    let error = "Runtime confirmed that the task does not exist after start \
                 confirmation timed out";
    let note: String = "Runtime task was missing after an unconfirmed start"
        .chars()
        .take(NOTE_LIMIT)
        .collect();
    let version = row.version.unwrap_or(0) + 1;
    transaction
        .execute(
            "UPDATE loop_item_executions SET status='queued', queued_at=?, lease_expires_at=?, \
             error_message=?, start_requested_at=?, observed_state='unconfirmed', observed_at=?, \
             sync_state='pending', termination_reason='', execution_note=?, version=?, updated_at=? \
             WHERE id=? AND status='claimed' AND version=?",
            (
                now,
                EPOCH_TIME,
                error,
                EPOCH_TIME,
                EPOCH_TIME,
                note,
                version,
                now,
                row.id,
                row.version.unwrap_or(0),
            ),
        )
        .await?;
    Ok(())
}

/// `fail(requeue=True, termination_reason="runtime_reconciled_failed")`: the
/// elected failure, then a new retry attempt while retries remain.
async fn fail_reconciled<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    now: NaiveDateTime,
) -> MysqlResult<Option<Effects>> {
    let error = "Runtime reported a failed task during reconciliation";
    let updated = transition_terminal(
        transaction,
        row,
        "failed",
        error,
        None,
        Some(row.version.unwrap_or(0)),
        None,
        "runtime_reconciled_failed",
        "failed",
        now,
    )
    .await?;
    if updated != 1 {
        return Ok(None);
    }
    let effects = project_terminal(transaction, row, "failed", error, now).await?;
    if row.retry_attempt.unwrap_or(0) >= row.max_retries.unwrap_or(0) {
        return Ok(Some(effects));
    }
    let retry_id = insert_retry_attempt(transaction, row, now).await?;
    set_automation_run_status(transaction, row.automation_run_id.as_deref(), "queued").await?;
    let runtime_task_id = retry_runtime_task_id(row.execution_payload.as_deref(), retry_id);
    transaction
        .execute(
            "UPDATE loop_item_executions SET runtime_task_id=? WHERE id=?",
            (runtime_task_id, retry_id),
        )
        .await?;
    Ok(Some(effects))
}

/// `_new_retry_attempt`: one isolated queued attempt after Runtime proved the
/// previous one ended.
async fn insert_retry_attempt<T: MysqlTransaction>(
    transaction: &mut T,
    previous: &ExecutionRow,
    now: NaiveDateTime,
) -> MysqlResult<i64> {
    let payload = retry_execution_payload(previous.execution_payload.as_deref());
    let args: Vec<Option<StatementArg>> = vec![
        previous.loop_item_id.clone().map(StatementArg::Str),
        previous.cloud_project_id.clone().map(StatementArg::Str),
        previous.executor_owner_user_id.map(StatementArg::Int),
        previous.agent_id.clone().map(StatementArg::Str),
        previous.team_id.map(StatementArg::Int),
        previous.automation_run_id.clone().map(StatementArg::Str),
        previous
            .execution_environment
            .clone()
            .map(StatementArg::Str),
        previous.execution_device_id.clone().map(StatementArg::Str),
        previous.assigner_user_id.map(StatementArg::Int),
        previous.priority_weight.map(StatementArg::Int),
        Some(StatementArg::DateTime(now)),
        Some(StatementArg::Int(previous.attempt_no.unwrap_or(0) + 1)),
        Some(StatementArg::Int(previous.id)),
        previous.execution_scope.clone().map(StatementArg::Str),
        previous.execution_note.clone().map(StatementArg::Str),
        Some(StatementArg::Str(
            if previous
                .approval_status
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                "approved".to_owned()
            } else {
                String::new()
            },
        )),
        previous.approved_by_user_id.map(StatementArg::Int),
        previous.approved_at.map(StatementArg::DateTime),
        Some(StatementArg::Str(payload)),
        Some(StatementArg::Int(previous.retry_attempt.unwrap_or(0) + 1)),
        Some(StatementArg::Int(previous.max_retries.unwrap_or(0))),
    ];
    let inserted = transaction
        .execute(
            "INSERT INTO loop_item_executions (loop_item_id, cloud_project_id, \
             executor_owner_user_id, agent_id, team_id, automation_run_id, execution_environment, \
             execution_device_id, assigner_user_id, status, priority_weight, queued_at, attempt_no, \
             previous_execution_id, execution_scope, execution_note, approval_status, \
             approved_by_user_id, approved_at, execution_payload, retry_attempt, max_retries, \
             observed_state, sync_state, error_message) \
             VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?,'unconfirmed','pending','')",
            args,
        )
        .await?;
    Ok(inserted.last_insert_id as i64)
}

/// One terminal outcome: the elected execution update plus its automation-run
/// and linked-activity projections.
#[allow(clippy::too_many_arguments)]
async fn terminal<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    status: &str,
    error: &str,
    note: Option<&str>,
    content: Option<&str>,
    expected_version: Option<i64>,
    reason: &str,
    observed_state: &str,
    now: NaiveDateTime,
) -> MysqlResult<Option<Effects>> {
    let updated = transition_terminal(
        transaction,
        row,
        status,
        error,
        note,
        expected_version,
        None,
        reason,
        observed_state,
        now,
    )
    .await?;
    if updated != 1 {
        return Ok(None);
    }
    project_terminal(transaction, row, status, content.unwrap_or(error), now)
        .await
        .map(Some)
}

async fn project_terminal(
    tx: &mut impl MysqlTransaction,
    row: &ExecutionRow,
    status: &str,
    detail: &str,
    now: NaiveDateTime,
) -> MysqlResult<Effects> {
    let before = runtime_projection::lifecycle::item_version(tx, Some(row)).await?;
    if runtime_projection::linked_activity(tx, row)
        .await?
        .is_none()
    {
        runtime_projection::open_accepted_activity(tx, row.id, false).await?;
    }
    let run_status = match status {
        "completed" => "succeeded",
        "failed" => "failed",
        _ => "cancelled",
    };
    set_automation_run_status(tx, row.automation_run_id.as_deref(), run_status).await?;
    let messages = runtime_projection::finish_runtime_activity(
        tx,
        row,
        status,
        detail,
        row.last_event_seq,
        (status == "completed").then_some(now),
    )
    .await?;
    let changed = runtime_projection::lifecycle::item_version(tx, Some(row)).await? != before;
    Ok(Effects {
        matched: runtime_projection::reload_execution(tx, row.id).await?,
        changed,
        detail: detail.to_owned(),
        messages,
    })
}

#[cfg(test)]
#[path = "device_reconcile_tests.rs"]
mod tests;
#[cfg(test)]
pub(crate) use tests::verify_reconnect_projection;
