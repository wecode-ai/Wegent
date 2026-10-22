// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The execution callback's terminal task-completion subsystem.
//!
//! `POST /api/internal/callback` maps a terminal inbound event
//! (`response.completed` / `response.failed` / a cancelled response) to a
//! terminal `done` / `error` / `cancelled` event. The source's
//! `StatusUpdatingEmitter` then runs the task-completion subsystem inside the
//! request: it collects the final result, persists it, cleans up the streaming
//! state and publishes `TaskCompletedEvent` to every registered handler.
//!
//! This module ports that subsystem. The Redis half lives in
//! [`super::session`]; this module owns the MySQL writes and the handler fan-out.
//!
//! Every step runs inline in the request, awaited, exactly like the source:
//! the event bus dispatches handlers with `asyncio.gather`, so they are part of
//! the request rather than detached work.
mod collect;
mod events;
mod handlers;
mod persist;
mod sql;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use brz_mysql::Mysql;
use brz_redis::Redis;
use serde_json::Value;

pub(crate) use sql::Tables;

/// The deployment inputs one completion flow renders.
pub(crate) struct Completion<'a, M: Mysql, R: Redis> {
    pub(crate) mysql: &'a M,
    pub(crate) redis: &'a R,
    pub(crate) tables: Tables,
}

/// One `TaskCompletedEvent` (`app/core/events.py`).
///
/// The handlers this callback reaches consume the task identity, the owner and
/// the terminal status; the collected result and error stay in the persistence
/// step that already wrote them. The source only publishes the event once
/// `_resolve_owner_user_id` produced an owner, so the owner is always known.
pub(crate) struct TaskCompletedEvent<'a> {
    pub(crate) task_id: i64,
    pub(crate) user_id: i64,
    pub(crate) status: &'a str,
}

/// `_get_task_status_user_id`: the owner of one active task, read before the
/// event is emitted so the Socket.IO status frame can address `user:{id}`.
pub(crate) async fn task_status_user_id<M: Mysql>(
    mysql: &M,
    tables: Tables,
    task_id: i64,
) -> Option<i64> {
    let sql = sql::active_task_statement_single_state(tables.tasks);
    let row: brz_mysql::MysqlRow = mysql
        .route(crate::task_routing::ByTaskId(task_id as u64))
        .fetch_optional(sql, (task_id,))
        .await
        .ok()
        .flatten()?;
    task_column::<i64>(&row, "user_id")
}

/// Decode one column of a task projection positionally.
///
/// The recorded source query aliases every task column with the resolved
/// physical table name (`tasks_0030_user_id`), which a caller cannot know, so
/// the completion flow positions into the fixed 12-column projection instead.
pub(crate) fn task_column<T: brz_mysql::FromMysqlCol>(
    row: &brz_mysql::MysqlRow,
    column: &str,
) -> Option<T> {
    let index = crate::task_store::task_column_index(column)?;
    row.get_at::<Option<T>>(index).ok().flatten()
}

/// The status string a terminal event maps to (`SubtaskStatus`).
pub(crate) fn terminal_status(event_type: &str) -> Option<&'static str> {
    match event_type {
        "done" => Some("COMPLETED"),
        "error" => Some("FAILED"),
        "cancelled" => Some("CANCELLED"),
        _ => None,
    }
}

/// `StatusUpdatingEmitter.emit`'s terminal branch: collect the final result,
/// persist it and publish `TaskCompletedEvent`.
///
/// Returns the collected result the source assigns back to `event.result`
/// before the wrapped emitter publishes `chat:done`, and the owner the
/// `task:status` frame is addressed to.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn complete_terminal<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    error_code: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> (Option<Value>, Option<i64>) {
    // `callback.py:145 _get_task_status_user_id`: the owner of the single
    // active state, read before the event is emitted so the Socket.IO status
    // frame can address `user:{id}`. The source reads it before the emit step;
    // that step is Redis-only here, so the read keeps its wire position.
    let user_id = task_status_user_id(ctx.mysql, ctx.tables, task_id).await;
    let final_result =
        collect::collect_completed_result(ctx, subtask_id, status, result, error, error_code).await;

    persist::persist_completed_result(
        ctx,
        task_id,
        subtask_id,
        status,
        final_result.as_ref(),
        error,
        executor_name,
        executor_namespace,
    )
    .await;

    events::publish_task_completed(ctx, task_id, status).await;

    (final_result, user_id)
}
