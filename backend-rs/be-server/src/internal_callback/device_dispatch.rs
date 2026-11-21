// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Settle device submission failures against the committed assistant turn.

use brz_mysql::{MysqlResult, MysqlRow, MysqlTransaction};
use brz_redis::RedisService;
use serde_json::Value;

use crate::state::AppState;

use super::{
    completion::{self, StoredTerminal},
    event::{EventType, ExecutionEvent},
    session,
};

/// Replay the committed winner, or settle the turn if device dispatch failed.
pub(super) async fn settle_locked(
    app: &AppState,
    redis: &RedisService,
    failure: &ExecutionEvent,
) -> anyhow::Result<()> {
    let (task_id, subtask_id) = (failure.task_id, failure.subtask_id);
    let (task_table, subtask_table) =
        completion::resolve_tables(Some(app), crate::internal_callback::tables(app), task_id)
            .await?;
    let terminal =
        completion::read_terminal_result(&app.mysql, &subtask_table, task_id, subtask_id).await?;
    let event = match terminal {
        Some(terminal) => replay_event(task_id, subtask_id, terminal),
        None => {
            let cancelling = cancellation_requested(app, &task_table, task_id).await?;
            if submit_terminal(app, redis, failure, cancelling).await? {
                return Ok(());
            }
            // A failure cannot replace a cancellation intent that committed
            // between the writer read and the terminal transaction.
            if !cancelling
                && cancellation_requested(app, &task_table, task_id).await?
                && submit_terminal(app, redis, failure, true).await?
            {
                return Ok(());
            }
            // The write may have lost to a competing producer, or regular
            // delivery may have suppressed an already published callback.
            match completion::read_terminal_result(&app.mysql, &subtask_table, task_id, subtask_id)
                .await?
            {
                Some(terminal) => replay_event(task_id, subtask_id, terminal),
                // A deleted or superseded turn cannot be settled in MySQL.
                // Its active SSE reader still needs the submission failure.
                None => failure.clone(),
            }
        }
    };
    session::publish_callback_event(redis, subtask_id, &event).await?;
    Ok(())
}

async fn submit_terminal(
    app: &AppState,
    redis: &RedisService,
    failure: &ExecutionEvent,
    cancelling: bool,
) -> anyhow::Result<bool> {
    let (mut event, status) = if cancelling {
        let mut event =
            ExecutionEvent::new(EventType::Cancelled, failure.task_id, failure.subtask_id);
        event.result = Some(serde_json::json!({}));
        event.message_id = failure.message_id;
        (event, "CANCELLED")
    } else {
        (failure.clone(), "FAILED")
    };
    // Recovery already records this work and will re-read the winner on retry.
    Box::pin(super::deliver_terminal_callback(
        app,
        redis,
        &mut event,
        status,
        (None, None),
        false,
    ))
    .await
    .map_err(|error| anyhow::anyhow!("device terminal delivery is pending recovery: {error:?}"))
}

async fn cancellation_requested(
    app: &AppState,
    task_table: &str,
    task_id: i64,
) -> MysqlResult<bool> {
    // The task-store read can still see an earlier state on its replica.
    let task: Option<MysqlRow> = app
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64))
        .with_transaction(async |tx| {
            tx.fetch_optional(
                crate::task_store_statements::task_by_id_statement(task_table),
                (task_id,),
            )
            .await
        })
        .await?;
    Ok(task
        .as_ref()
        .and_then(|task| completion::task_column::<brz_mysql::Json<Value>>(task, "json"))
        .is_some_and(|payload| {
            matches!(
                payload.0.pointer("/status/status").and_then(Value::as_str),
                Some("CANCELLING" | "CANCELLED")
            )
        }))
}

fn replay_event(task_id: i64, subtask_id: i64, terminal: StoredTerminal) -> ExecutionEvent {
    let event_type = match terminal.status.as_str() {
        "COMPLETED" => EventType::Done,
        "CANCELLED" => EventType::Cancelled,
        _ => EventType::Error,
    };
    let mut event = ExecutionEvent::new(event_type, task_id, subtask_id);
    event.error_code = terminal
        .result
        .as_ref()
        .and_then(|result| result.get("error_type"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    event.result = terminal.result;
    event.error = terminal.error;
    event
}
