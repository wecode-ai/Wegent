// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Settle device submission failures against the committed assistant turn.

use brz_mysql::{MysqlResult, MysqlRow, MysqlTransaction};
use serde_json::Value;

use crate::internal_callback::{
    completion::{self, StoredTerminal},
    event::{EventType, ExecutionEvent},
    session,
};
use crate::state::AppState;

use super::ExecutionRequest;

/// Replay the committed winner, or settle the turn if device dispatch did not start.
pub(crate) async fn settle_dispatch_error(
    app: &AppState,
    request: &ExecutionRequest,
    message: &str,
) {
    if let Err(error) = settle(app, request, message).await {
        tracing::warn!(
            %error,
            task_id = request.task_id,
            subtask_id = request.subtask_id,
            "device dispatch terminal settlement failed"
        );
    }
}

async fn settle(app: &AppState, request: &ExecutionRequest, message: &str) -> anyhow::Result<()> {
    let Some(redis) = app.redis.as_ref() else {
        return Ok(());
    };
    let (task_id, subtask_id) = (request.task_id, request.subtask_id);
    let (task_table, subtask_table) =
        completion::resolve_tables(Some(app), crate::internal_callback::tables(app), task_id)
            .await?;
    let terminal =
        completion::read_terminal_result(&app.mysql, &subtask_table, task_id, subtask_id).await?;
    let event = match terminal {
        Some(terminal) => replay_event(task_id, subtask_id, terminal),
        None => {
            let cancelling = cancellation_requested(app, &task_table, task_id).await?;
            if submit_terminal(app, request, message, cancelling).await? {
                return Ok(());
            }
            // A failure cannot replace a cancellation intent that committed
            // between the writer read and the terminal transaction.
            if !cancelling
                && cancellation_requested(app, &task_table, task_id).await?
                && submit_terminal(app, request, message, true).await?
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
                None => failure_event(request, message),
            }
        }
    };
    session::publish_callback_event(redis, subtask_id, &event).await?;
    Ok(())
}

async fn submit_terminal(
    app: &AppState,
    request: &ExecutionRequest,
    message: &str,
    cancelling: bool,
) -> anyhow::Result<bool> {
    let event = if cancelling {
        let mut event =
            ExecutionEvent::new(EventType::Cancelled, request.task_id, request.subtask_id);
        event.result = Some(serde_json::json!({}));
        event.message_id = request.message_id;
        event
    } else {
        failure_event(request, message)
    };
    crate::internal_callback::process_dispatch_failure(app, event)
        .await
        .map_err(|error| anyhow::anyhow!("device terminal delivery is pending recovery: {error:?}"))
}

fn failure_event(request: &ExecutionRequest, message: &str) -> ExecutionEvent {
    let mut event = ExecutionEvent::new(EventType::Error, request.task_id, request.subtask_id);
    event.message_id = request.message_id;
    event.error = Some(message.to_owned());
    event.error_code = Some("EXECUTOR_DISPATCH_FAILED".to_owned());
    event
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
