// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `LoopItemExecution` aggregate's durable transitions.
//!
//! Source: `app/services/loop_item_executions/service.py`'s
//! `_transition_terminal`, `_set_automation_run_status`, the terminal-projection
//! activity half and the acceptance rules around the execution row. The
//! `runtime:event` projection ([`super::runtime_projection`]) and the
//! registration-time execution reconciliation
//! ([`super::device_reconcile`]) share one aggregate implementation, exactly
//! like the source service they both call.

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};

use crate::sql_support::StatementArg;

/// `CAPACITY_STATUSES`: the execution statuses that still accept events.
pub(crate) const CAPACITY_STATUSES: &str = "'running', 'claimed', 'cancel_requested'";

/// `PROJECT_CHAT_TERMINAL_RUN_STATUSES`.
pub(super) const TERMINAL_RUN_STATUSES: [&str; 4] =
    ["completed", "failed", "cancelled", "canceled"];
/// `DEFAULT_LEASE_SECONDS` (`app/services/loop_item_executions/service.py:235`).
/// `handle_runtime_event` and the reconcile's accepted observation both use
/// the source default of five minutes; no caller overrides it.
pub(super) const DEFAULT_LEASE_SECONDS: i64 = 5 * 60;
/// `EPOCH_TIME` (`datetime(1970, 1, 1)`).
pub(super) const EPOCH_TIME: &str = "1970-01-01 00:00:00";
/// `_error_text(...)[:2000]` bound.
pub(super) const ERROR_LIMIT: usize = 2000;
/// `_execution_note(note)[:500]` bound.
pub(super) const NOTE_LIMIT: usize = 500;
/// `_set_automation_run_status`'s guard: an already terminal run is never
/// rewritten. This is the automation-run status set, not
/// `PROJECT_CHAT_TERMINAL_RUN_STATUSES`.
pub(super) const AUTOMATION_RUN_TERMINAL_STATUSES: [&str; 3] = ["succeeded", "failed", "cancelled"];

/// One execution row resolved by `execution_for_runtime`.
#[derive(Debug, FromMysqlRow)]
pub(super) struct ExecutionRow {
    #[mysql(rename = "loop_item_executions_id")]
    pub(super) id: i64,
    #[mysql(rename = "loop_item_executions_loop_item_id")]
    pub(super) loop_item_id: Option<String>,
    #[mysql(rename = "loop_item_executions_cloud_project_id")]
    pub(super) cloud_project_id: Option<String>,
    #[mysql(rename = "loop_item_executions_executor_owner_user_id")]
    pub(super) executor_owner_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_agent_id")]
    pub(super) agent_id: Option<String>,
    #[mysql(rename = "loop_item_executions_team_id")]
    pub(super) team_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_automation_run_id")]
    pub(super) automation_run_id: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_environment")]
    pub(super) execution_environment: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_device_id")]
    pub(super) execution_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_assigner_user_id")]
    pub(super) assigner_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_status")]
    pub(super) status: Option<String>,
    #[mysql(rename = "loop_item_executions_priority_weight")]
    pub(super) priority_weight: Option<i64>,
    #[mysql(rename = "loop_item_executions_started_at")]
    pub(super) started_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_attempt_no")]
    pub(super) attempt_no: Option<i64>,
    #[mysql(rename = "loop_item_executions_execution_scope")]
    pub(super) execution_scope: Option<String>,
    #[mysql(rename = "loop_item_executions_observed_state")]
    pub(super) observed_state: Option<String>,
    #[mysql(rename = "loop_item_executions_start_requested_at")]
    pub(super) start_requested_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_last_event_seq")]
    pub(super) last_event_seq: Option<i64>,
    #[mysql(rename = "loop_item_executions_termination_reason")]
    pub(super) termination_reason: Option<String>,
    #[mysql(rename = "loop_item_executions_retry_attempt")]
    pub(super) retry_attempt: Option<i64>,
    #[mysql(rename = "loop_item_executions_max_retries")]
    pub(super) max_retries: Option<i64>,
    #[mysql(rename = "loop_item_executions_execution_note")]
    pub(super) execution_note: Option<String>,
    #[mysql(rename = "loop_item_executions_approval_status")]
    pub(super) approval_status: Option<String>,
    #[mysql(rename = "loop_item_executions_approved_by_user_id")]
    pub(super) approved_by_user_id: Option<i64>,
    #[mysql(rename = "loop_item_executions_approved_at")]
    pub(super) approved_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_item_executions_runtime_device_id")]
    pub(super) runtime_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    pub(super) runtime_task_id: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_payload")]
    pub(super) execution_payload: Option<String>,
    #[mysql(rename = "loop_item_executions_version")]
    pub(super) version: Option<i64>,
}

impl ExecutionRow {
    pub(super) fn status_or_empty(&self) -> &str {
        self.status.as_deref().unwrap_or("")
    }

    pub(super) fn is_terminal(&self) -> bool {
        TERMINAL_RUN_STATUSES.contains(&self.status_or_empty())
    }

    pub(super) fn observed_start(&self, now: NaiveDateTime) -> NaiveDateTime {
        self.started_at
            .filter(|start| !crate::background_jobs::robot::model::unset(Some(*start)))
            .unwrap_or(now)
    }
}

/// `LoopItemExecutionService._transition_terminal`'s conditional update.
///
/// `expected_version` chooses whether the source's optional `version`
/// predicate is present. `None` matches the call sites that pass
/// `expected_status` without `expected_version` (the source then updates any
/// row still in that status).
#[allow(clippy::too_many_arguments)]
pub(super) async fn transition_terminal<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    status: &str,
    error: &str,
    note: Option<&str>,
    expected_version: Option<i64>,
    seq: Option<i64>,
    reason: &str,
    observed_state: &str,
    now: NaiveDateTime,
) -> MysqlResult<u64> {
    let error = if status == "failed" {
        error.chars().take(ERROR_LIMIT).collect::<String>()
    } else {
        String::new()
    };
    let mut sql = "UPDATE loop_item_executions SET status=?, completed_at=?, lease_expires_at=?, \
         version=version+1, observed_state=?, sync_state='in_sync', observed_at=?, \
         termination_reason=?, error_message=?"
        .to_string();
    if note.is_some_and(|note| !note.is_empty()) {
        sql.push_str(", execution_note=?");
    }
    if seq.is_some() {
        sql.push_str(", last_event_seq=?");
    }
    sql.push_str(", updated_at=? WHERE id=? AND status=?");
    if expected_version.is_some() {
        sql.push_str(" AND version=?");
    }
    if seq.is_some() {
        sql.push_str(" AND last_event_seq < ?");
    }
    let mut args = vec![
        StatementArg::Str(status.to_owned()),
        StatementArg::DateTime(now),
        StatementArg::Str(EPOCH_TIME.to_owned()),
        StatementArg::Str(observed_state.to_owned()),
        StatementArg::DateTime(now),
        StatementArg::Str(reason.to_owned()),
        StatementArg::Str(error),
    ];
    if let Some(note) = note.filter(|note| !note.is_empty()) {
        args.push(StatementArg::Str(note.chars().take(NOTE_LIMIT).collect()));
    }
    if let Some(seq) = seq {
        args.push(StatementArg::Int(seq));
    }
    args.push(StatementArg::DateTime(Utc::now().naive_utc()));
    args.push(StatementArg::Int(row.id));
    args.push(StatementArg::Str(row.status_or_empty().to_owned()));
    if let Some(version) = expected_version {
        args.push(StatementArg::Int(version));
    }
    if let Some(seq) = seq {
        args.push(StatementArg::Int(seq));
    }
    let execution = transaction.execute(sql, args).await?;
    Ok(execution.rows_affected)
}

/// `handle_runtime_event`'s accepted non-terminal observation.
pub(super) async fn accept_observation<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    seq: i64,
    now: NaiveDateTime,
) -> MysqlResult<u64> {
    let next_status = if row.status_or_empty() == "cancel_requested" {
        "cancel_requested"
    } else {
        "running"
    };
    let started_at = row.observed_start(now);
    let lease_expires_at = now + chrono::Duration::seconds(DEFAULT_LEASE_SECONDS);
    let execution = transaction
        .execute(
            "UPDATE loop_item_executions SET status=?, observed_state='running', \
             sync_state='in_sync', error_message='', termination_reason='', observed_at=?, \
             started_at=?, heartbeat_at=?, lease_expires_at=?, last_event_seq=?, \
             version=version+1, updated_at=? \
             WHERE id=? AND version=? AND status IN \
             ('running', 'claimed', 'cancel_requested') AND last_event_seq < ?",
            (
                next_status,
                now,
                started_at,
                now,
                lease_expires_at,
                seq,
                now,
                row.id,
                row.version.unwrap_or(0),
                seq,
            ),
        )
        .await?;
    Ok(execution.rows_affected)
}

/// `_set_automation_run_status` / `_update_project_automation_run`.
pub(super) async fn set_automation_run_status<T: MysqlTransaction>(
    transaction: &mut T,
    run_id: Option<&str>,
    status: &str,
) -> MysqlResult<()> {
    let Some(run_id) = run_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let terminal = AUTOMATION_RUN_TERMINAL_STATUSES
        .iter()
        .map(|value| format!("'{value}'"))
        .collect::<Vec<_>>()
        .join(", ");
    transaction
        .execute(
            format!(
                "UPDATE loop_items SET status=?, version=version+1, updated_at=UTC_TIMESTAMP(6) \
                 WHERE id=? AND resource_type='automation_run' AND status NOT IN ({terminal})"
            ),
            (status, run_id),
        )
        .await?;
    Ok(())
}

/// `_bind_activity_runtime_turn`: identify the current turn on the open
/// activity, if one is linked.
pub(super) async fn bind_activity_runtime_turn<T: MysqlTransaction>(
    transaction: &mut T,
    row: &ExecutionRow,
    turn_id: Option<&str>,
) -> MysqlResult<()> {
    let (Some(device_id), Some(task_id), Some(turn_id)) = (
        row.runtime_device_id.as_deref(),
        row.runtime_task_id.as_deref(),
        turn_id,
    ) else {
        return Ok(());
    };
    transaction
        .execute(
            "UPDATE project_chat_messages SET metadata=JSON_SET(metadata, '$.runtime_turn_id', ?), \
             updated_at=UTC_TIMESTAMP(6) \
             WHERE runtime_device_id=? AND runtime_task_id=? AND sender_type='agent' \
             AND status IN ('pending','streaming') \
             AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))",
            (turn_id, device_id, task_id),
        )
        .await?;
    Ok(())
}
