//! Reflect terminal turn results onto the linked BackgroundExecution once.
use super::model::{self, Execution, Subscription};
use super::state;
use crate::internal_callback::completion::{Completion, TaskCompletedEvent};
use anyhow::Result;
use brz_mysql::{Json, Mysql, MysqlResult, MysqlTransaction};
use brz_redis::Redis;
use serde_json::json;

/// `_map_status` + `_is_silent_exit` + `_extract_result_summary`: the terminal
/// status one event maps to, decided before any database work
/// (`app/services/subscription/task_completion_handler.py:100-111`).
pub(crate) struct TerminalResult {
    pub(crate) status: &'static str,
    pub(crate) silent: bool,
    pub(crate) summary: Option<String>,
}

pub(crate) fn terminal_result(event: &TaskCompletedEvent<'_>) -> TerminalResult {
    let silent = event
        .result
        .is_some_and(|value| value["silent_exit"] == true);
    let status = if silent && event.status == "COMPLETED" {
        "COMPLETED_SILENT"
    } else {
        match event.status {
            "COMPLETED" => "COMPLETED",
            "CANCELLED" => "CANCELLED",
            _ => "FAILED",
        }
    };
    TerminalResult {
        status,
        silent,
        summary: super::directives::strip(state::result_summary(event.result)),
    }
}

/// `update_execution_status` as `on_task_completed` calls it
/// (`task_completion_handler.py:120-127`): the CAS runs in the handler's own
/// session, so the caller owns the transaction boundary. The source commits at
/// the end of the status update (`execution.py:921`), which is also the end of
/// the recorded transaction that starts at `_find_execution_by_task_id`.
pub(crate) async fn apply_status<T: MysqlTransaction>(
    tx: &mut T,
    event: &TaskCompletedEvent<'_>,
    execution: &Execution,
    result: &TerminalResult,
) -> MysqlResult<Option<Execution>> {
    if model::terminal(&execution.status) {
        return Ok(None);
    }
    state::transition_in(
        tx,
        execution.id,
        result.status,
        result.summary.as_deref(),
        event.error,
    )
    .await
}

/// The rest of `on_task_completed` after the status update committed
/// (`task_completion_handler.py:132-181`): the frontend event, the inbox
/// writeback, the code-wiki check and the follower notifications. Every
/// statement here is autocommit, exactly like the source's post-commit block.
pub(crate) async fn after_status<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
    execution: &Execution,
    result: &TerminalResult,
) -> Result<Option<String>> {
    // The status update commits and then emits, and that commit expires the ORM
    // instance: the emitter's first attribute access reloads the row
    // (`app/services/subscription/execution.py:918,937`).
    let Some(execution): Option<Execution> = ctx
        .mysql
        .fetch_optional(model::execution_by_id(), (execution.id,))
        .await?
    else {
        return Ok(None);
    };
    state::emit(ctx.mysql, ctx.redis, &execution).await?;
    let status = result.status;
    if execution.inbox_message_id > 0
        && let Err(error) = writeback(
            ctx.mysql,
            &execution,
            event.status,
            result.summary.as_deref(),
            event.error,
        )
        .await
    {
        tracing::warn!(%error, "subscription inbox result writeback failed")
    }
    if result.silent || !matches!(status, "COMPLETED" | "FAILED") {
        return Ok(Some(status.into()));
    }
    // The notification block touches the instance again, so it reloads once more
    // before `_is_code_wiki_scheduled_update` runs
    // (`task_completion_handler.py:169-176`).
    let Some(execution): Option<Execution> = ctx
        .mysql
        .fetch_optional(model::execution_by_id(), (execution.id,))
        .await?
    else {
        return Ok(Some(status.into()));
    };
    // `_is_code_wiki_scheduled_update` (`task_completion_handler.py:193`):
    // `db.get(Kind, execution.subscription_id)`. A code-wiki schedule reports
    // through its own channel, so the follower dispatch is skipped for it, and a
    // missing subscription is not a code-wiki schedule.
    let subscription: Option<Subscription> = ctx
        .mysql
        .fetch_optional(model::kind_by_id_statement(), (execution.subscription_id,))
        .await?;
    if subscription
        .as_ref()
        .is_some_and(|subscription| model::code_wiki_id(subscription).is_some())
    {
        return Ok(Some(status.into()));
    }
    let Some(app) = ctx.app else {
        return Ok(Some(status.into()));
    };
    let message = if status == "FAILED" {
        event
            .error
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Execution failed; no error details were provided.")
    } else {
        result.summary.as_deref().unwrap_or("")
    };
    if let Err(error) = super::delivery::notify(app, &execution, status, message).await {
        tracing::warn!(%error, "subscription completion notification failed")
    }
    Ok(Some(status.into()))
}

async fn writeback<M: Mysql>(
    mysql: &M,
    execution: &Execution,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    mysql.with_transaction(async|tx|{match status{"COMPLETED"=>{tx.execute("UPDATE queue_messages SET status='processed',process_result=?,process_task_id=?,processed_at=UTC_TIMESTAMP() WHERE id=?",(Json(json!({"summary":summary.unwrap_or(""),"completedAt":chrono::Utc::now().to_rfc3339()})),execution.task_id,execution.inbox_message_id)).await?;},"FAILED"=>{tx.execute("UPDATE queue_messages SET status='failed',process_result=?,process_task_id=? WHERE id=?",(Json(json!({"error":error.unwrap_or("Execution failed")})),execution.task_id,execution.inbox_message_id)).await?;},"CANCELLED"=>{tx.execute("UPDATE queue_messages SET status='unread',process_result=?,process_subscription_id=NULL WHERE id=?",(Json(json!({"error":"Processing was cancelled"})),execution.inbox_message_id)).await?;},_=>{}}Ok(())}).await?;
    Ok(())
}
