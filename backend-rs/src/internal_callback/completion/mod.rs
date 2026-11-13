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
mod delivery;
mod events;
mod handlers;
mod persist;
mod sql;
mod text_value;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use brz_mysql::{Mysql, MysqlResult, MysqlTransaction};
use brz_redis::Redis;
use serde_json::Value;

use crate::executor_manager::ExecutorManager;

pub(crate) use collect::collect_completed_result;
pub(crate) use delivery::{
    Delivery, acknowledge_delivery, notification_key, publish_once, with_delivery_lock,
    with_owned_lease,
};
pub(crate) use events::publish_task_completed_for_owner;
pub(crate) use persist::{
    CollaborationStatus, claim_running_subtask, mark_subtask_running, persist_completed_result,
    update_task_status,
};
pub(crate) use sql::Tables;

pub(crate) async fn complete_executor_failure<M: Mysql, R: Redis>(
    mysql: &M,
    tables: Tables,
    ctx: Option<&Completion<'_, M, R>>,
    task_id: i64,
    subtask_id: i64,
    message: &str,
    code: &str,
) -> Option<Value> {
    let result = match ctx {
        Some(ctx) => collect_completed_result(
            ctx,
            task_id,
            subtask_id,
            "FAILED",
            None,
            Some(message),
            Some(code),
        )
        .await
        .unwrap_or_else(|| Value::Object(collect::failure_details(message, code))),
        None => Value::Object(collect::failure_details(message, code)),
    };
    let (row, metrics_message) = persist::persist_executor_failure(
        mysql, tables, task_id, subtask_id, &result, message,
    )
    .await
    .inspect_err(
        |error| tracing::warn!(%error, task_id, subtask_id, "executor failure transaction failed"),
    )
    .ok()??;
    if let Some(ctx) = ctx {
        persist::publish_task_run_metrics(ctx, &row, subtask_id, "FAILED", metrics_message).await;
        if let Err(error) =
            super::session::cleanup_streaming_state(ctx.redis, subtask_id, Some(task_id)).await
        {
            tracing::warn!(%error, "executor failure streaming cleanup failed");
        }
        events::publish_task_completed(
            ctx,
            task_id,
            subtask_id,
            "FAILED",
            Some(&result),
            Some(message),
        )
        .await;
    }
    Some(result)
}

/// The deployment inputs one completion flow renders.
pub(crate) struct Completion<'a, M: Mysql, R: Redis> {
    pub(crate) app: Option<&'a crate::AppState>,
    pub(crate) mysql: &'a M,
    pub(crate) redis: &'a R,
    pub(crate) tables: Tables,
    /// The retained executor-manager client the subscription handler's
    /// auto-delete cleanup calls.
    pub(crate) executor_manager: &'a ExecutorManager,
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
    pub(crate) subtask_id: i64,
    pub(crate) result: Option<&'a Value>,
    pub(crate) error: Option<&'a str>,
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

pub(crate) use wegent_task_store::projection::task_column;

pub(crate) struct StoredTerminal {
    pub status: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// Read the winning terminal result on the writer after a competing commit.
pub(crate) async fn read_terminal_result<M: Mysql>(
    mysql: &M,
    tables: Tables,
    task_id: i64,
    subtask_id: i64,
) -> MysqlResult<Option<StoredTerminal>> {
    let mysql = mysql.route(crate::task_routing::ByTaskId(task_id as u64));
    mysql.with_transaction(async |tx| {
        let row: Option<(String, Option<brz_mysql::Json<Value>>, Option<String>)> = tx
            .fetch_optional(
                format!("SELECT status, result, error_message FROM {} WHERE id = ? AND task_id = ? AND status IN ('COMPLETED','FAILED','CANCELLED')", tables.subtasks),
                (subtask_id, task_id),
            )
            .await?;
        Ok(row.map(|(status, result, error)| StoredTerminal {
            status,
            result: result.map(|json| json.0),
            error,
        }))
    }).await
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

/// A terminal state that was committed and can be delivered to callers.
pub(crate) struct TerminalCompletion {
    pub(crate) result: Option<Value>,
    pub(crate) user_id: Option<i64>,
    pub(crate) task: CollaborationStatus,
    pub(crate) replay_error: Option<Option<String>>,
    pub(crate) replay_source: Option<Value>,
}

/// Terminal delivery can be retried independently of the database transition.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn complete_with_delivery<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &super::event::ExecutionEvent,
    status: &str,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
    delivery: Delivery,
    source: Option<&Value>,
) -> MysqlResult<Option<TerminalCompletion>> {
    let user_id = task_status_user_id(ctx.mysql, ctx.tables, event.task_id).await;
    let result = finish_terminal_event(
        ctx,
        event.task_id,
        event.subtask_id,
        status,
        event.result.as_ref(),
        event.error.as_deref(),
        event.error_code.as_deref(),
        executor_name,
        executor_namespace,
        None,
        Some((delivery, source)),
    )
    .await?;
    Ok(result.map(|completion| TerminalCompletion {
        user_id,
        ..completion
    }))
}

/// Device binding observed by the heartbeat scan and rechecked under the writer lock.
pub(crate) struct DeviceAttempt<'a> {
    pub(crate) owner_id: i64,
    pub(crate) name: &'a str,
    pub(crate) namespace: &'a str,
}

pub(crate) async fn complete_device_timeout<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    attempt: &DeviceAttempt<'_>,
    error: &str,
) -> MysqlResult<Option<TerminalCompletion>> {
    finish_terminal_event(
        ctx,
        task_id,
        subtask_id,
        "FAILED",
        None,
        Some(error),
        None,
        None,
        None,
        Some(attempt),
        None,
    )
    .await
    .map(|completion| {
        completion.map(|value| TerminalCompletion {
            user_id: Some(attempt.owner_id),
            ..value
        })
    })
}

/// Complete an event whose Socket.IO status frame requires the task owner.
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
) -> MysqlResult<Option<TerminalCompletion>> {
    // `callback.py:145 _get_task_status_user_id`: the owner of the single
    // active state, read before the event is emitted so the Socket.IO status
    // frame can address `user:{id}`. The source reads it before the emit step;
    // that step is Redis-only here, so the read keeps its wire position.
    let user_id = task_status_user_id(ctx.mysql, ctx.tables, task_id).await;
    let completion = complete_terminal_event(
        ctx,
        task_id,
        subtask_id,
        status,
        result,
        error,
        error_code,
        executor_name,
        executor_namespace,
    )
    .await?;

    Ok(completion.map(|completion| TerminalCompletion {
        user_id,
        ..completion
    }))
}

/// `StatusUpdatingEmitter`'s terminal branch without the callback's owner
/// pre-read.
///
/// The create flow's synchronous dispatch wraps an `SSEResultEmitter` (no
/// Socket.IO `task:status` frame), so the source never runs
/// `callback.py:_get_task_status_user_id` there; only the
/// `_publish_task_completed_event` owner read (`is_active_query()`) happens,
/// inside [`finish_terminal`].
#[allow(clippy::too_many_arguments)]
pub(crate) async fn complete_terminal_event<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    error_code: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> MysqlResult<Option<TerminalCompletion>> {
    finish_terminal_event(
        ctx,
        task_id,
        subtask_id,
        status,
        result,
        error,
        error_code,
        executor_name,
        executor_namespace,
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn finish_terminal_event<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    error_code: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
    device_attempt: Option<&DeviceAttempt<'_>>,
    delivery: Option<(Delivery, Option<&Value>)>,
) -> MysqlResult<Option<TerminalCompletion>> {
    let final_result = collect::collect_completed_result(
        ctx, task_id, subtask_id, status, result, error, error_code,
    )
    .await;

    let committed = Box::pin(persist::persist_terminal_transition(
        ctx,
        task_id,
        subtask_id,
        status,
        final_result.as_ref(),
        error,
        executor_name,
        executor_namespace,
        device_attempt,
        delivery,
    ))
    .await;
    let Some(transition) = committed.inspect_err(|failure| {
        tracing::error!(%failure, task_id, subtask_id, status, "terminal persistence failed");
    })?
    else {
        tracing::info!(
            task_id,
            subtask_id,
            status,
            "terminal event already settled or stale"
        );
        return Ok(None);
    };

    let (task, final_result, replay_error, replay_source) = match transition {
        persist::Transition::Committed(task) => (task, final_result, None, None),
        persist::Transition::Replay {
            task,
            result,
            error,
            source,
        } => (task, result, Some(error), source),
    };
    if replay_error.is_none() {
        events::publish_task_completed(
            ctx,
            task_id,
            subtask_id,
            status,
            final_result.as_ref(),
            error,
        )
        .await;
    }

    Ok(Some(TerminalCompletion {
        result: final_result,
        user_id: None,
        task,
        replay_error,
        replay_source,
    }))
}
