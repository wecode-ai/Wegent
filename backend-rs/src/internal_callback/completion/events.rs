// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `TaskCompletedEvent` fan-out (`app/core/events.py`, `app/main.py:419-446`).
//!
//! The source registers five handlers and dispatches them concurrently with
//! `asyncio.gather`, so their relative order is not contractual. They run here
//! in registration order inside the request.
use brz_mysql::{Mysql, MysqlRow};
use brz_redis::Redis;

use super::Completion;
use super::Tables;
use super::TaskCompletedEvent;
use super::handlers;
use super::sql;
use super::task_column;

/// `StatusUpdatingEmitter._resolve_owner_user_id`
/// (`app/services/execution/emitters/status_updating.py:125-136`): the owner of
/// the task in the `is_active_query()` states, read before the event is
/// published so every handler receives it.
pub(super) async fn resolve_owner_user_id<M: Mysql>(
    mysql: &M,
    tables: Tables,
    task_id: i64,
) -> Option<i64> {
    let row: MysqlRow = mysql
        .route(crate::task_routing::ByTaskId(task_id as u64))
        .fetch_optional(sql::resolve_owner_statement(tables.tasks), (task_id,))
        .await
        .ok()
        .flatten()?;
    task_column::<i64>(&row, "user_id")
}

/// `event_bus.publish(TaskCompletedEvent(...))`.
///
/// `_publish_task_completed_event` skips the whole publish when the owner read
/// finds no row, so the handlers below only run for a resolved owner.
pub(crate) async fn publish_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: Option<&serde_json::Value>,
    error: Option<&str>,
) {
    let Some(user_id) = resolve_owner_user_id(ctx.mysql, ctx.tables, task_id).await else {
        tracing::warn!(task_id, "no task owner; TaskCompletedEvent not published");
        return;
    };
    let event = TaskCompletedEvent {
        task_id,
        user_id,
        status,
        subtask_id,
        result,
        error,
    };
    // `main.py:419 register_pet_event_handlers`
    handlers::pet::handle_task_completed_for_pet(ctx, &event).await;
    // `main.py:422 event_bus.subscribe(TaskCompletedEvent, handle_task_completed)`
    handlers::subscription::handle_task_completed(ctx, &event).await;
    // `main.py:429 event_bus.subscribe(TaskCompletedEvent, handle_channel_task_completed)`
    handlers::channel::handle_channel_task_completed(ctx, &event).await;
    // `main.py:437 register_project_automation_task_completion_handler`
    handlers::project_automation::handle_project_automation_task_completed(ctx, &event).await;
    // `main.py:446 event_bus.subscribe(TaskCompletedEvent, conclude_code_wiki_run)`
    handlers::code_wiki::conclude_code_wiki_run(ctx, &event).await;
}
