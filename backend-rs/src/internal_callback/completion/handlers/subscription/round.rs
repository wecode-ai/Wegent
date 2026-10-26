// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Match a completion to the current assistant round before task-wide effects.
use brz_mysql::{MysqlResult, MysqlRow, MysqlTransaction};

use crate::internal_callback::completion::{Tables, TaskCompletedEvent, sql, task_column};

pub(super) async fn current_task<T: MysqlTransaction>(
    transaction: &mut T,
    tables: Tables,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<Option<MysqlRow>> {
    let task: Option<MysqlRow> = transaction
        .fetch_optional(
            format!("{} FOR UPDATE", sql::resolve_owner_statement(tables.tasks)),
            (event.task_id,),
        )
        .await?;
    let Some(task) = task.filter(|task| task_column::<i64>(task, "user_id") == Some(event.user_id))
    else {
        return Ok(None);
    };
    // Message order is the same order used to derive the Task's status. Lock
    // the current round/range as well as the Task until its effects commit.
    let latest: Option<MysqlRow> = transaction
        .fetch_optional(
            format!("SELECT id FROM {} WHERE task_id=? AND user_id=? AND `role`='ASSISTANT' ORDER BY message_id DESC, id DESC LIMIT 1 FOR UPDATE", tables.subtasks),
            (event.task_id, event.user_id),
        )
        .await?;
    if latest
        .map(|row| row.get_required::<i64>("id"))
        .transpose()?
        != Some(event.subtask_id)
    {
        tracing::info!(
            task_id = event.task_id,
            subtask_id = event.subtask_id,
            "stale completion round skipped"
        );
        return Ok(None);
    }
    Ok(Some(task))
}
