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
mod events;
mod handlers;
mod sql;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
mod persist_running_tests;

use std::borrow::Cow;

use brz_mysql::{Mysql, MysqlResult};
use brz_redis::Redis;
use serde_json::Value;

use crate::executor_manager::ExecutorManager;

pub(crate) use wegent_execution_completion::DeviceAttempt;
use wegent_execution_completion::delivery;
#[cfg(test)]
pub(crate) use wegent_execution_completion::lease_receipt::{self, LeaseReceipt};
use wegent_execution_completion::{CompletionStore, collect, metrics, persist};

pub(crate) use collect::collect_completed_result;
pub(crate) use delivery::{
    Delivery, acknowledge_delivery, delivery_lock_key, notification_key, with_delivery_lock,
    with_owned_lease,
};
#[cfg(test)]
pub(crate) use persist::update_task_status;
pub(crate) use persist::{
    CollaborationStatus, commit_subtask_running, mark_subtask_running, persist_completed_result,
};
pub(crate) use sql::Tables;
pub(crate) use sql::{dispatchable_task_status, is_active_task, latest_assistant_id};

pub(crate) async fn complete_executor_failure<M: Mysql, R: Redis>(
    mysql: &M,
    tables: Tables,
    ctx: Option<&Completion<'_, M, R>>,
    task_id: i64,
    subtask_id: i64,
    message: &str,
    code: &str,
) -> Option<Value> {
    // A transient read failure must leave the stored result untouched. Passing
    // no collected payload makes the terminal update status-only; retrying with
    // a fabricated empty object could erase a previously persisted answer.
    let result = if let Some(ctx) = ctx {
        match collect_completed_result(
            &ctx.storage(),
            task_id,
            subtask_id,
            "FAILED",
            None,
            Some(message),
            Some(code),
        )
        .await
        {
            Ok(Some(result)) => Some(result),
            Ok(None) => Some(Value::Object(collect::failure_details(message, code))),
            Err(failure) => {
                tracing::warn!(%failure, task_id, subtask_id, "executor failure result read failed");
                None
            }
        }
    } else {
        Some(Value::Object(collect::failure_details(message, code)))
    };
    let (task_table, subtask_table) = resolve_tables(
        ctx.and_then(|ctx| ctx.app),
        ctx.map_or(tables, |ctx| ctx.tables),
        task_id,
    )
    .await
    .inspect_err(|error| {
        tracing::warn!(%error, task_id, subtask_id, "executor failure table read failed");
    })
    .ok()?;
    let (row, metrics_message, labels) = persist::persist_executor_failure(
        mysql,
        &task_table,
        &subtask_table,
        task_id,
        subtask_id,
        result.as_ref(),
        message,
    )
    .await
    .inspect_err(
        |error| tracing::warn!(%error, task_id, subtask_id, "executor failure transaction failed"),
    )
    .ok()??;
    metrics::record(
        &row,
        "FAILED",
        Some(code),
        Some(message),
        result.as_ref(),
        labels,
    );
    if let Some(ctx) = ctx {
        persist::publish_task_run_metrics(
            &ctx.storage(),
            &row,
            subtask_id,
            "FAILED",
            metrics_message,
        )
        .await;
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
            result.as_ref(),
            Some(message),
        )
        .await;
    }
    result
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

impl<M: Mysql, R: Redis> Completion<'_, M, R> {
    pub(crate) fn storage(&self) -> CompletionStore<'_, M, R> {
        CompletionStore {
            mysql: self.mysql,
            redis: self.redis,
            tables: self.tables,
            task_store: self.app.map(|app| app.task_store.as_ref()),
        }
    }
}

/// Resolve the physical tables together before opening a writer transaction.
pub(crate) async fn resolve_tables(
    app: Option<&crate::AppState>,
    templates: Tables,
    task_id: i64,
) -> MysqlResult<(Cow<'static, str>, Cow<'static, str>)> {
    wegent_execution_completion::resolve_tables(
        app.map(|app| app.task_store.as_ref()),
        templates,
        task_id,
    )
    .await
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

pub(crate) use wegent_execution_completion::{
    StoredTerminal, read_terminal_result, task_status_user_id,
};
pub(crate) use wegent_task_store::projection::task_column;

pub(crate) use wegent_execution_events::event::terminal_status;

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
    delivery: Delivery<'_>,
    source: Option<&Value>,
) -> MysqlResult<Option<TerminalCompletion>> {
    let (task_table, _) = resolve_tables(ctx.app, ctx.tables, event.task_id).await?;
    let user_id = task_status_user_id(ctx.mysql, &task_table, event.task_id).await;
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
    let (task_table, _) = resolve_tables(ctx.app, ctx.tables, task_id).await?;
    let user_id = task_status_user_id(ctx.mysql, &task_table, task_id).await;
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
    delivery: Option<(Delivery<'_>, Option<&Value>)>,
) -> MysqlResult<Option<TerminalCompletion>> {
    let final_result = collect::collect_completed_result(
        &ctx.storage(),
        task_id,
        subtask_id,
        status,
        result,
        error,
        error_code,
    )
    .await?;

    let committed = Box::pin(persist::persist_terminal_transition(
        &ctx.storage(),
        task_id,
        subtask_id,
        status,
        final_result.as_ref(),
        error,
        error_code,
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
