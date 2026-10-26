// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/subscription/task_completion_handler.py`.
//!
//! The handler links a completed task back to the `background_executions`
//! record of the subscription execution that created it. When no execution
//! exists, `_cleanup_auto_delete_task_executor` tears down the task's executor
//! runtime and marks the subtasks whose runtime was deleted.
use brz_mysql::{FromMysqlCol, Json, Mysql, MysqlResult, MysqlRow, MysqlTransaction};
use brz_redis::Redis;
use serde_json::Value;

use crate::executor_manager::{ExecutorManager, SandboxLookup};
use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::Tables;
use crate::internal_callback::completion::TaskCompletedEvent;
use crate::internal_callback::completion::sql;
use crate::internal_callback::completion::task_column;

use super::{local_datetime, now_local};

mod execution;
mod round;

/// Finalize projections before best-effort network effects. A cleanup failure
/// must not roll a successfully completed execution back to RUNNING.
pub(crate) async fn handle_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(event.task_id as u64));
    let completed = mysql
        .with_transaction(async |transaction| {
            let Some(task) = round::current_task(transaction, ctx.tables, event).await? else {
                return Ok(None);
            };
            if let Some(execution) = execution::find(transaction, &task, event).await? {
                return execution::complete(transaction, execution, event).await;
            }
            cleanup_auto_delete_task_executor(transaction, ctx.tables, ctx.executor_manager, event)
                .await?;
            Ok(None)
        })
        .await;
    let completed = match completed {
        Ok(Some(completed)) => completed,
        Ok(None) => return,
        Err(error) => {
            tracing::error!(task_id=event.task_id, %error, "subscription completion transaction failed");
            return;
        }
    };
    let execution_id = completed.execution.id;
    tracing::info!(execution_id, task_id=event.task_id, status=%completed.execution.status, "subscription execution finalized");
    if let Err(error) = crate::internal_callback::socketio::publish_emit_in_room(
        ctx.redis,
        "background:execution_update",
        &format!("user:{}", completed.execution.user_id),
        completed.payload,
    )
    .await
    {
        tracing::warn!(execution_id, %error, "subscription status event failed");
    }
    if matches!(
        completed.execution.status.as_str(),
        "COMPLETED" | "COMPLETED_SILENT"
    ) && completed.subscription.is_some()
    {
        if let Err(error) = mysql
            .with_transaction(async |transaction| {
                // A new round can start after the status transaction commits.
                // Recheck under the same locks held throughout runtime deletion.
                if round::current_task(transaction, ctx.tables, event)
                    .await?
                    .is_none()
                {
                    return Ok(());
                }
                cleanup_task_runtime(
                    transaction,
                    ctx.tables,
                    ctx.executor_manager,
                    event.task_id,
                    "subscription",
                )
                .await
            })
            .await
        {
            tracing::error!(execution_id, task_id=event.task_id, %error, "subscription executor cleanup failed after completion");
        }
    }
    if completed.notify {
        let kwargs = serde_json::Map::from_iter([("execution_id".to_owned(), execution_id.into())]);
        if let Err(error) = ctx
            .celery
            .dispatch_background(
                ctx.redis,
                "app.tasks.subscription_completion_tasks.notify_execution",
                &kwargs,
            )
            .await
        {
            tracing::error!(execution_id, task_id=event.task_id, %error, "subscription notification enqueue failed");
        }
    }
}

/// `_cleanup_auto_delete_task_executor`: with no execution, the task's
/// `autoDeleteExecutor` label decides whether its runtime is torn down.
async fn cleanup_auto_delete_task_executor<T: MysqlTransaction>(
    transaction: &mut T,
    tables: Tables,
    executor_manager: &ExecutorManager,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<()> {
    if !matches!(event.status, "COMPLETED" | "FAILED" | "CANCELLED") {
        return Ok(());
    }
    let Some(task) = active_task(transaction, tables, event.task_id).await else {
        tracing::warn!(
            task_id = event.task_id,
            "no task row; auto-delete executor skipped"
        );
        return Ok(());
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
        return cleanup_task_runtime(
            transaction,
            tables,
            executor_manager,
            event.task_id,
            "auto-delete task",
        )
        .await;
    }
    Ok(())
}

/// `_cleanup_task_runtime`: delete the sandbox or executor runtime of one
/// completed task, then mark every subtask whose executor was deleted.
async fn cleanup_task_runtime<T: MysqlTransaction>(
    transaction: &mut T,
    tables: Tables,
    executor_manager: &ExecutorManager,
    task_id: i64,
    cleanup_source: &str,
) -> MysqlResult<()> {
    let Some(task) = active_task(transaction, tables, task_id).await else {
        tracing::warn!(cleanup_source, "no task row; runtime cleanup skipped");
        return Ok(());
    };
    let Some(owner_user_id) = task_column::<i64>(&task, "user_id") else {
        return Ok(());
    };
    let subtasks =
        list_not_executor_deleted_by_task(transaction, tables, task_id, owner_user_id).await;
    if subtasks.is_empty() {
        tracing::info!(
            cleanup_source,
            "no undeleted subtasks; runtime cleanup skipped"
        );
        return Ok(());
    }

    // Source builds a set of `(namespace, name)` pairs; only membership is
    // consulted, so a de-duplicated ordered list keeps the same contract.
    let mut unique_executors: Vec<(String, String)> = Vec::new();
    for row in &subtasks {
        let Some(name) =
            subtask_column::<String>(row, "executor_name").filter(|name| !name.is_empty())
        else {
            continue;
        };
        let key = (
            subtask_column::<String>(row, "executor_namespace").unwrap_or_default(),
            name,
        );
        if !unique_executors.contains(&key) {
            unique_executors.push(key);
        }
    }

    let sandbox_id = task_id.to_string();
    let cleanup_mode = match executor_manager.get_sandbox(&sandbox_id).await {
        SandboxLookup::Found => "sandbox",
        SandboxLookup::NotFound => "executor",
        SandboxLookup::Failed => "fallback",
    };
    let mut sandbox_deleted = false;
    if matches!(cleanup_mode, "sandbox" | "fallback") {
        let (deleted, error) = executor_manager.delete_sandbox(&sandbox_id).await;
        sandbox_deleted = deleted;
        if deleted {
            tracing::info!(cleanup_source, task_id, "sandbox runtime cleanup succeeded");
        } else {
            tracing::info!(
                cleanup_source,
                task_id,
                ?error,
                "sandbox runtime cleanup skipped or failed"
            );
        }
    }

    let mut successful_keys: Vec<(String, String)> = Vec::new();
    if matches!(cleanup_mode, "executor" | "fallback") {
        if unique_executors.is_empty() {
            tracing::info!(cleanup_source, "no executor-backed subtasks");
        }
        for (namespace, name) in &unique_executors {
            match executor_manager.delete_executor_task(name, namespace).await {
                Ok(()) => successful_keys.push((namespace.clone(), name.clone())),
                Err(error) => {
                    tracing::warn!(
                        cleanup_source,
                        namespace,
                        name,
                        error = %format!("{error:#}"),
                        "executor delete failed"
                    );
                }
            }
        }
    }

    if successful_keys.is_empty() && !sandbox_deleted {
        tracing::warn!(
            cleanup_source,
            task_id,
            cleanup_mode,
            "runtime cleanup finished without a successful deletion"
        );
        return Ok(());
    }

    let updates: Vec<(String, i64)> = subtasks
        .iter()
        .filter_map(|row| {
            let key = (
                subtask_column::<String>(row, "executor_namespace").unwrap_or_default(),
                subtask_column::<String>(row, "executor_name").unwrap_or_default(),
            );
            if !sandbox_deleted && !successful_keys.contains(&key) {
                return None;
            }
            // `subtask_store.update_fields` stamps each row's `updated_at`
            // independently before the shared flush.
            Some((
                local_datetime(now_local()),
                subtask_column::<i64>(row, "id").unwrap_or(0),
            ))
        })
        .collect();
    let sql = sql::update_subtask_executor_deleted(tables);
    apply_executor_deleted_updates(transaction, &sql, &updates).await
}

/// `_cleanup_task_runtime`'s `db_session` flush: every selected
/// `executor_deleted_at` update runs on the session's one connection and joins
/// the transaction that already covers the handler's reads. The source flushes
/// them together and commits once (`task_completion_handler.py:498`), so a
/// failed update rolls the whole batch back; the caller's transaction supplies
/// that commit.
async fn apply_executor_deleted_updates<T: MysqlTransaction>(
    transaction: &mut T,
    sql: &str,
    updates: &[(String, i64)],
) -> MysqlResult<()> {
    for (updated_at, subtask_id) in updates {
        transaction
            .execute(sql, (true, updated_at.as_str(), *subtask_id))
            .await?;
    }
    Ok(())
}

/// `task_store.get_task_by_states(states=TaskResource.is_active_query())`: the
/// two-state active read the auto-delete path issues twice.
async fn active_task<T: MysqlTransaction>(
    transaction: &mut T,
    tables: Tables,
    task_id: i64,
) -> Option<MysqlRow> {
    transaction
        .fetch_optional(sql::resolve_owner_statement(tables.tasks), (task_id,))
        .await
        .ok()
        .flatten()
}

/// `ShardedSubtaskStore.list_not_executor_deleted_by_task`: the owner probe
/// then the full subtask projection of the task's undeleted runtime rows.
async fn list_not_executor_deleted_by_task<T: MysqlTransaction>(
    transaction: &mut T,
    tables: Tables,
    task_id: i64,
    owner_user_id: i64,
) -> Vec<MysqlRow> {
    let owner: Option<MysqlRow> = transaction
        .fetch_optional(
            crate::task_store_statements::owner_matches_task_id_statement(tables.tasks),
            (task_id, owner_user_id),
        )
        .await
        .ok()
        .flatten();
    if owner.is_none() {
        // `_owner_matches_task_id`'s fallback: the one distinct subtask owner.
        let owners: Vec<MysqlRow> = transaction
            .fetch_all(
                crate::task_store_statements::distinct_subtask_owners_statement(tables.subtasks),
                (task_id,),
            )
            .await
            .unwrap_or_default();
        let matches = owners.len() == 1
            && owners[0].get_required::<i64>("user_id").ok() == Some(owner_user_id);
        if !matches {
            return Vec::new();
        }
    }
    transaction
        .fetch_all(
            sql::subtasks_not_executor_deleted_by_task(tables),
            (task_id,),
        )
        .await
        .unwrap_or_default()
}

/// Decode one column of a subtask projection positionally.
fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> Option<T> {
    let index = crate::task_store::subtask_column_index(column)?;
    row.get_at::<Option<T>>(index).ok().flatten()
}

#[cfg(test)]
mod tests;
