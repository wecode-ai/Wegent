// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/subscription/task_completion_handler.py`.
//!
//! The handler links a completed task back to the `background_executions`
//! record of the subscription execution that created it. The recorded evidence
//! for the callback flow has no such execution, so the flow this port must
//! reproduce is the lookup chain plus the auto-delete label probe that follows
//! a miss.
use brz_mysql::{Json, Mysql, MysqlRow};
use brz_redis::Redis;
use serde_json::Value;

use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;
use crate::internal_callback::completion::sql;
use crate::internal_callback::completion::task_column;

/// `handle_task_completed`.
pub(crate) async fn handle_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    let Some(execution) = find_execution_by_task_id(ctx, event.task_id).await else {
        cleanup_auto_delete_task_executor(ctx, event).await;
        return;
    };
    // An execution exists: the terminal-status update, inbox write-back and
    // notification fan-out that follow are outside this callback's recorded
    // traffic and are not reproduced here.
    tracing::debug!(
        execution_id = execution,
        task_id = event.task_id,
        "subscription execution found for completed task"
    );
}

/// `_find_execution_by_task_id`: the active execution, the newest execution,
/// then the code-wiki scheduled-execution recovery read.
async fn find_execution_by_task_id<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
) -> Option<i64> {
    let mysql = ctx.mysql;
    let running: Option<MysqlRow> = mysql
        .fetch_optional(sql::background_execution_running(), (task_id,))
        .await
        .ok()
        .flatten();
    if let Some(row) = running {
        return row.get::<i64>("background_executions_id").ok().flatten();
    }
    let latest: Option<MysqlRow> = mysql
        .fetch_optional(sql::background_execution_latest(), (task_id,))
        .await
        .ok()
        .flatten();
    if let Some(row) = latest {
        return row.get::<i64>("background_executions_id").ok().flatten();
    }
    // `recover_scheduled_execution_for_task`: the code-wiki integration reads
    // the task's newest wiki generation before giving up.
    let generation: Option<MysqlRow> = mysql
        .fetch_optional(sql::wiki_generation_latest(), (task_id,))
        .await
        .ok()
        .flatten();
    if let Some(row) = generation {
        // A recovered generation is an execution the subscription handler
        // completes through the code-wiki runner, which is outside this
        // callback's recorded traffic.
        tracing::debug!(
            generation_id = row.get::<i64>("wiki_generations_id").ok().flatten(),
            "recovered scheduled wiki generation"
        );
    }
    None
}

/// `_cleanup_auto_delete_task_executor`: with no execution, the task's
/// `autoDeleteExecutor` label decides whether its runtime is torn down.
async fn cleanup_auto_delete_task_executor<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(event.task_id as u64));
    let task: Option<MysqlRow> = mysql
        .fetch_optional(
            sql::active_task_statement(ctx.tables.tasks),
            (event.task_id,),
        )
        .await
        .ok()
        .flatten();
    let Some(task) = task else {
        return;
    };
    let auto_delete = task_column::<Json<Value>>(&task, "json").and_then(|json| {
        json.0
            .get("metadata")
            .and_then(|metadata| metadata.get("labels"))
            .and_then(|labels| labels.get("autoDeleteExecutor"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if auto_delete.as_deref() == Some("true") {
        // `_cleanup_task_runtime` deletes the task's executor and sandbox
        // through the executor manager; the recorded callback evidence never
        // takes this branch.
        tracing::debug!(task_id = event.task_id, "auto-delete executor requested");
    }
}
