// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Bound execution lookups shared by streaming and terminal observations.

use super::{ExecutionRow, execution_conversation_task_id};
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;
use crate::socketio::execution_aggregate::CAPACITY_STATUSES;
use crate::sql_support::StatementArg;
use brz_mysql::{MysqlResult, MysqlTransaction};

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
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
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
