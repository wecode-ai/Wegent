// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Bound execution lookups shared by streaming and terminal observations.

use super::{ExecutionRow, execution_conversation_task_id};
use crate::socketio::execution_aggregate::CAPACITY_STATUSES;
use crate::sql_support::StatementArg;
use brz_mysql::{MysqlResult, MysqlTransaction};

/// Fields decoded by `ExecutionRow` for runtime event projection.
const RUNTIME_EXECUTION_COLUMNS: &str = "loop_item_executions.id AS loop_item_executions_id, \
    loop_item_executions.loop_item_id AS loop_item_executions_loop_item_id, \
    loop_item_executions.cloud_project_id AS loop_item_executions_cloud_project_id, \
    loop_item_executions.executor_owner_user_id AS loop_item_executions_executor_owner_user_id, \
    loop_item_executions.agent_id AS loop_item_executions_agent_id, \
    loop_item_executions.team_id AS loop_item_executions_team_id, \
    loop_item_executions.automation_run_id AS loop_item_executions_automation_run_id, \
    loop_item_executions.execution_environment AS loop_item_executions_execution_environment, \
    loop_item_executions.execution_device_id AS loop_item_executions_execution_device_id, \
    loop_item_executions.assigner_user_id AS loop_item_executions_assigner_user_id, \
    loop_item_executions.status AS loop_item_executions_status, \
    loop_item_executions.priority_weight AS loop_item_executions_priority_weight, \
    loop_item_executions.started_at AS loop_item_executions_started_at, \
    loop_item_executions.attempt_no AS loop_item_executions_attempt_no, \
    loop_item_executions.execution_scope AS loop_item_executions_execution_scope, \
    loop_item_executions.observed_state AS loop_item_executions_observed_state, \
    loop_item_executions.start_requested_at AS loop_item_executions_start_requested_at, \
    loop_item_executions.last_event_seq AS loop_item_executions_last_event_seq, \
    loop_item_executions.termination_reason AS loop_item_executions_termination_reason, \
    loop_item_executions.retry_attempt AS loop_item_executions_retry_attempt, \
    loop_item_executions.max_retries AS loop_item_executions_max_retries, \
    loop_item_executions.execution_note AS loop_item_executions_execution_note, \
    loop_item_executions.approval_status AS loop_item_executions_approval_status, \
    loop_item_executions.approved_by_user_id AS loop_item_executions_approved_by_user_id, \
    loop_item_executions.approved_at AS loop_item_executions_approved_at, \
    loop_item_executions.runtime_device_id AS loop_item_executions_runtime_device_id, \
    loop_item_executions.runtime_task_id AS loop_item_executions_runtime_task_id, \
    loop_item_executions.execution_payload AS loop_item_executions_execution_payload, \
    loop_item_executions.version AS loop_item_executions_version";

/// Device/task identities are bound; only placeholder counts are structural.
pub(super) fn execution_statement(
    device_count: usize,
    task_count: usize,
    owner: bool,
    limit: bool,
) -> String {
    let device_placeholders = vec!["?"; device_count].join(", ");
    let task_placeholders = vec!["?"; task_count].join(", ");
    let owner = if owner {
        " AND loop_item_executions.executor_owner_user_id = ?"
    } else {
        ""
    };
    let limit = if limit { " \n LIMIT 1" } else { "" };
    format!(
        "SELECT {RUNTIME_EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.runtime_device_id IN ({device_placeholders}) \
         AND loop_item_executions.runtime_task_id IN ({task_placeholders}) \
         AND loop_item_executions.status IN ({CAPACITY_STATUSES}){owner} \
         ORDER BY loop_item_executions.id DESC{limit}"
    )
}

pub(super) fn execution_args(
    device_ids: &[String],
    task_ids: &[String],
    owner: Option<i64>,
) -> Vec<StatementArg> {
    let mut args = device_ids
        .iter()
        .cloned()
        .map(StatementArg::Str)
        .collect::<Vec<_>>();
    args.extend(task_ids.iter().cloned().map(StatementArg::Str));
    if let Some(owner) = owner {
        args.push(StatementArg::Int(owner));
    }
    args
}

pub(super) fn runtime_task_ids(task_id: &str, include_initial_manager: bool) -> Vec<String> {
    let mut task_ids = vec![task_id.to_owned()];
    if include_initial_manager && let Some(base) = task_id.strip_suffix("-manager-initial") {
        task_ids.push(base.to_owned());
    }
    task_ids
}

pub(super) fn execution_matches_runtime_task(row: &ExecutionRow, runtime_task_id: &str) -> bool {
    row.runtime_task_id.as_deref() == Some(runtime_task_id)
        || execution_conversation_task_id(row) == runtime_task_id
}

pub(in crate::socketio) async fn execution_for_runtime<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
    owner: Option<i64>,
    include_initial_manager: bool,
) -> MysqlResult<Option<ExecutionRow>> {
    let task_ids = runtime_task_ids(task_id, include_initial_manager);
    let statement = execution_statement(
        device_ids.len(),
        task_ids.len(),
        owner.is_some(),
        !include_initial_manager,
    );
    let args = execution_args(device_ids, &task_ids, owner);
    if !include_initial_manager {
        return transaction.fetch_optional(statement, args).await;
    }
    let rows: Vec<ExecutionRow> = transaction.fetch_all(statement, args).await?;
    Ok(rows
        .into_iter()
        .find(|row| execution_matches_runtime_task(row, task_id)))
}
