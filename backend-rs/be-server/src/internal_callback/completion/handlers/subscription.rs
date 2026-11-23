// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/subscription/task_completion_handler.py`.
//!
//! The handler links a completed task back to the `background_executions`
//! record of the subscription execution that created it. When no execution
//! exists, `_cleanup_auto_delete_task_executor` tears down the task's executor
//! runtime and marks the subtasks whose runtime was deleted.
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow, MysqlTransaction};
use brz_redis::Redis;
use serde_json::Value;

use crate::background_jobs::subscription::{
    completion,
    model::{self, Execution},
    state,
};
use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;
use crate::internal_callback::completion::sql;

#[path = "subscription_cleanup.rs"]
mod cleanup;
pub(crate) use cleanup::CleanupJob;

#[cfg(test)]
#[path = "subscription_boundary_tests.rs"]
pub(crate) mod boundary_tests;

/// `handle_task_completed`.
///
/// `on_task_completed` opens one `get_db_session()` block
/// (`task_completion_handler.py:78-181`) and resolves the execution, applies the
/// status CAS and writes the subscription statistics inside it; the source
/// commits at the end of `update_execution_status`, which closes that block. One
/// explicit transaction reproduces the boundary, so the lookup and the status
/// update are covered by the same commit.
pub(crate) async fn handle_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    // `on_task_completed` logs the event identity before the lookup
    // (`task_completion_handler.py:72-76`).
    tracing::info!(
        task_id = event.task_id,
        subtask_id = event.subtask_id,
        status = event.status,
        "TaskCompletedEvent received"
    );
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(event.task_id as u64));
    let mut reached_status_write = false;
    let mut selected_execution_id = None;
    let mut auto_delete = None;
    let outcome = mysql
        .with_transaction(async |transaction| {
            let Some(execution) = find_execution_by_task_id(transaction, event).await? else {
                auto_delete = cleanup::prepare_auto_delete(transaction, ctx.tables, event).await?;
                return Ok(None);
            };
            selected_execution_id = Some(execution.id);
            let result = completion::terminal_result(event);
            reached_status_write = true;
            let applied = completion::apply_status(transaction, event, &execution, &result).await?;
            Ok(Some((execution, applied, result)))
        })
        .await;
    let failure_message: String;
    let failed_event: TaskCompletedEvent<'_>;
    let (event, execution, result) = match outcome {
        Ok(Some((_, Some(applied), result))) => (event, applied, result),
        Ok(Some((execution, None, _))) => {
            release_after_status_noop(ctx, &mysql, execution, event).await;
            return;
        }
        Ok(None) => {
            if let Some(plan) = auto_delete {
                cleanup::submit(ctx, event, plan);
            }
            return;
        }
        Err(error) if reached_status_write => {
            // Left RUNNING, the execution would wait for the stale sweep, which
            // reports a timeout and sends nothing. Fail it with the real cause
            // so the failure notifications still go out.
            tracing::error!(%error, task_id=event.task_id, "could not save the run result");
            failure_message = unsaved_result_message(&error);
            let Some(execution) =
                fail_unsaved_result(ctx, &mysql, event, selected_execution_id, &failure_message)
                    .await
            else {
                return;
            };
            failed_event = TaskCompletedEvent {
                status: "FAILED",
                error: Some(&failure_message),
                ..*event
            };
            let result = completion::TerminalResult {
                status: "FAILED",
                silent: false,
                summary: None,
                notification_summary: None,
            };
            (&failed_event, execution, result)
        }
        Err(error) => {
            tracing::error!(%error, task_id=event.task_id, "task completion transaction failed; cleanup rolled back");
            return;
        }
    };
    // Admit cleanup after commit; slow runtime deletion must not delay inbox,
    // follower delivery or subsequent completion handlers.
    if releases_executor(result.status) {
        release_finished_executor(ctx, &mysql, &execution, event).await;
    }
    if let Err(error) = completion::after_status(ctx, event, &execution, &result).await {
        tracing::error!(%error, task_id=event.task_id, "subscription completion failed")
    }
}

/// A finished run never reuses its container, whatever its terminal status.
fn releases_executor(status: &str) -> bool {
    matches!(
        status,
        "COMPLETED" | "COMPLETED_SILENT" | "FAILED" | "CANCELLED"
    )
}

/// The error the execution is failed with when its result could not be saved;
/// the cause is cut to 300 characters.
fn unsaved_result_message(cause: &impl std::fmt::Display) -> String {
    let cause: String = cause.to_string().chars().take(300).collect();
    format!("The run finished but its result could not be saved: {cause}")
}

/// Fallback when the status write failed: mark the execution FAILED, without
/// the result, in a fresh transaction (`task_completion_handler.py`).
async fn fail_unsaved_result<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    mysql: &M,
    event: &TaskCompletedEvent<'_>,
    execution_id: Option<i64>,
    message: &str,
) -> Option<Execution> {
    let id = execution_id?;
    let outcome = mysql
        .with_transaction(async |transaction| {
            // Preserved-history subscriptions can bind a newer run to this task
            // while the failed write rolls back. Keep the original run identity.
            let execution: Option<Execution> = transaction
                .fetch_optional(format!("{} FOR UPDATE", model::execution_by_id()), (id,))
                .await?;
            let Some(mut execution) = execution else {
                return Ok(None);
            };
            if !bind_recovered_execution(transaction, &mut execution, event).await? {
                return Ok(None);
            }
            let applied = state::transition_execution_in(
                transaction,
                execution.id,
                "FAILED",
                None,
                Some(message),
            )
            .await?;
            Ok(Some((execution, applied)))
        })
        .await;
    match outcome {
        Ok(Some((_, Some(applied)))) => {
            // The guarded FAILED state is committed before retrying the CRD
            // write that may have caused the original result transaction to fail.
            if let Err(error) = mysql
                .with_transaction(async |tx| {
                    state::update_statistics_in(tx, &applied, "", message).await
                })
                .await
            {
                tracing::error!(%error, execution_id=applied.id, "FAILED run committed; subscription statistics reconciliation failed");
            }
            Some(applied)
        }
        Ok(Some((execution, None))) => {
            release_after_status_noop(ctx, mysql, execution, event).await;
            None
        }
        Ok(None) => None,
        Err(error) => {
            tracing::error!(%error, task_id=event.task_id, "could not mark the run FAILED");
            None
        }
    }
}

/// A status no-op can lose its CAS to a cancel after the execution lookup.
/// Reuse a known terminal snapshot; otherwise refresh the committed execution
/// before deciding whether cleanup is due.
async fn release_after_status_noop<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    mysql: &M,
    snapshot: Execution,
    event: &TaskCompletedEvent<'_>,
) {
    let execution = if model::terminal(&snapshot.status) {
        snapshot
    } else {
        // End the previous REPEATABLE READ view; a writer transaction avoids a
        // lagging replica and sees the committed winner of the status CAS.
        match mysql
            .with_transaction(async |tx| {
                tx.fetch_optional(model::execution_by_id(), (snapshot.id,))
                    .await
            })
            .await
        {
            Ok(Some(execution)) => execution,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, task_id = event.task_id, "could not reload the run after a lost status update");
                return;
            }
        }
    };
    if model::terminal(&execution.status) && releases_executor(event.status) {
        release_finished_executor(ctx, mysql, &execution, event).await;
    }
}

/// Prepare cleanup in a short transaction, then admit its owned HTTP job.
async fn release_finished_executor<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    mysql: &M,
    execution: &Execution,
    event: &TaskCompletedEvent<'_>,
) {
    match mysql
        .with_transaction(async |tx| {
            cleanup::prepare_subscription(
                tx,
                ctx.tables,
                execution,
                event.task_id,
                event.subtask_id,
            )
            .await
        })
        .await
    {
        Ok(Some(plan)) => cleanup::submit(ctx, event, plan),
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(%error, task_id = event.task_id, "runtime cleanup preparation failed; administrative cleanup may be required");
        }
    }
}
/// `_find_execution_by_task_id`: the active execution, the newest execution,
/// then the code-wiki scheduled-execution recovery read. The resolved row is
/// the handler's single read for the whole completion: the source keeps the ORM
/// entity and reuses it for the status update.
async fn find_execution_by_task_id<T: MysqlTransaction>(
    transaction: &mut T,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<Option<Execution>> {
    let running: Option<Execution> = transaction
        .fetch_optional(model::execution_running_by_task(), (event.task_id,))
        .await?;
    if running.is_some() {
        return Ok(running);
    }
    let latest: Option<Execution> = transaction
        .fetch_optional(model::execution_latest_by_task(), (event.task_id,))
        .await?;
    if latest.is_some() {
        return Ok(latest);
    }
    recover_scheduled_execution(transaction, event).await
}

/// `recover_scheduled_execution_for_task`
/// (`app/services/knowledge/code_wiki/subscription_integration.py:50-82`): the
/// launcher's Task can finish before it binds `BackgroundExecution.task_id`, so
/// the execution id stored on the task's newest wiki generation is bound here.
async fn recover_scheduled_execution<T: MysqlTransaction>(
    transaction: &mut T,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<Option<Execution>> {
    let generation: Option<MysqlRow> = transaction
        .fetch_optional(sql::wiki_generation_latest(), (event.task_id,))
        .await?;
    let Some(generation) = generation else {
        return Ok(None);
    };
    if generation.get::<i64>("wiki_generations_user_id")? != Some(event.user_id) {
        return Ok(None);
    }
    let ext = generation.get::<Json<Value>>("wiki_generations_ext")?;
    let Some(id) = ext.and_then(|v| v.0["backgroundExecutionId"].as_i64().filter(|id| *id > 0))
    else {
        return Ok(None);
    };
    let execution: Option<Execution> = transaction
        .fetch_optional(model::execution_by_id(), (id,))
        .await?;
    let Some(mut execution) = execution else {
        return Ok(None);
    };
    Ok(bind_recovered_execution(transaction, &mut execution, event)
        .await?
        .then_some(execution))
}

/// Preserve matching links and reject another task or owner before status CAS.
async fn bind_recovered_execution<T: MysqlTransaction>(
    tx: &mut T,
    execution: &mut Execution,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<bool> {
    if execution.user_id != event.user_id
        || (execution.task_id != 0 && execution.task_id != event.task_id)
    {
        return Ok(false);
    }
    if execution.task_id == 0 {
        if !matches!(execution.status.as_str(), "PENDING" | "RUNNING") {
            return Ok(false);
        }
        let bound = tx.execute(
            "UPDATE background_executions SET task_id=? WHERE id=? AND user_id=? AND task_id=0 AND status IN ('PENDING','RUNNING')",
            (event.task_id, execution.id, event.user_id),
        ).await?;
        if bound.rows_affected == 0 {
            return Ok(false);
        }
        execution.task_id = event.task_id;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::cleanup::{RuntimeReference, apply_executor_deleted_updates, deleted_statement};
    use super::*;
    use crate::internal_callback::completion::Tables;

    use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, RedisResult, RedisValues};

    /// Cancelled and failed runs release their container like completed ones;
    /// on a node with 2 to 4 slots, two cancelled runs left none free.
    #[test]
    fn every_terminal_status_releases_the_executor() {
        for status in ["COMPLETED", "COMPLETED_SILENT", "FAILED", "CANCELLED"] {
            assert!(releases_executor(status), "{status}");
        }
        for status in ["PENDING", "RUNNING", ""] {
            assert!(!releases_executor(status), "{status}");
        }
    }

    #[test]
    fn the_unsaved_result_error_keeps_300_characters_of_the_cause() {
        let message = unsaved_result_message(&"界".repeat(400));
        let cause = message
            .strip_prefix("The run finished but its result could not be saved: ")
            .expect("prefix");
        assert_eq!(cause.chars().count(), 300);
        assert_eq!(
            unsaved_result_message(&"Data too long for column 'result'"),
            "The run finished but its result could not be saved: \
             Data too long for column 'result'"
        );
    }

    /// The cleanup path issues no Redis command; the completion context still
    /// requires a Redis handle.
    struct NoRedis;

    impl Redis for NoRedis {
        async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            unreachable!("runtime cleanup issues no Redis read")
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            unreachable!("runtime cleanup issues no Redis write")
        }

        async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            unreachable!("runtime cleanup issues no Redis read")
        }

        async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            unreachable!("runtime cleanup issues no Redis write")
        }

        async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            unreachable!("runtime cleanup issues no Redis read")
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            unreachable!("runtime cleanup issues no Redis read")
        }

        async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            unreachable!("runtime cleanup issues no Redis read")
        }
    }

    fn tables() -> Tables {
        Tables {
            tasks: "tasks_0030",
            subtasks: "subtasks_0030",
        }
    }

    fn manager() -> crate::executor_manager::ExecutorManager {
        crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
            .expect("executor-manager client")
    }

    /// `on_task_completed`'s one `get_db_session()` block: the execution
    /// lookup and the auto-delete probe run inside the same transaction, and
    /// the probe keeps the source's two-state `is_active_query()` read.
    #[tokio::test]
    async fn the_task_completion_reads_run_inside_one_transaction() {
        let capture = TransactionCapture::default();
        let redis = NoRedis;
        let manager = manager();
        let ctx = Completion {
            app: None,
            mysql: &capture,
            redis: &redis,
            tables: tables(),
            executor_manager: &manager,
        };
        let event = TaskCompletedEvent {
            subtask_id: 0,
            result: None,
            error: None,
            task_id: 42,
            user_id: 7,
            status: "COMPLETED",
        };
        handle_task_completed(&ctx, &event).await;
        assert_eq!(capture.transaction_count(), 1);
        let statements = capture.statements();
        assert_eq!(statements.len(), 4, "{statements:?}");
        assert!(
            statements[0].sql.contains("background_executions"),
            "{statements:?}"
        );
        assert!(
            statements[3]
                .sql
                .contains("WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)"),
            "{statements:?}"
        );
    }

    /// A capture-only `Mysql` handle: the pool issues no statement directly,
    /// and `with_transaction` runs the closure against a transaction capture.
    #[derive(Clone, Default)]
    struct TransactionCapture {
        transactions: std::sync::Arc<std::sync::Mutex<usize>>,
        statements: std::sync::Arc<std::sync::Mutex<Vec<crate::sql_test_support::Query>>>,
        attempts: std::sync::Arc<std::sync::Mutex<usize>>,
        fail_at: Option<usize>,
        reader: Option<brz_mysql::MysqlService>,
        fail_statistics: bool,
        failed: std::sync::Arc<std::sync::atomic::AtomicBool>,
        bound: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl TransactionCapture {
        /// Fail the Nth update so the batch's abort behavior is observable.
        fn failing_at(attempt: usize) -> Self {
            Self {
                fail_at: Some(attempt),
                ..Self::default()
            }
        }

        fn transaction(&self) -> CapturedTransaction {
            CapturedTransaction {
                statements: std::sync::Arc::clone(&self.statements),
                attempts: std::sync::Arc::clone(&self.attempts),
                fail_at: self.fail_at,
                reader: self.reader.clone(),
                fail_runtime_page: false,
                fail_task_read: false,
                fail_statistics: self.fail_statistics,
                failed: self.failed.clone(),
                bound: self.bound.clone(),
            }
        }

        fn transaction_count(&self) -> usize {
            *self.transactions.lock().unwrap()
        }

        fn update_attempts(&self) -> usize {
            *self.attempts.lock().unwrap()
        }

        fn statements(&self) -> Vec<crate::sql_test_support::Query> {
            self.statements.lock().unwrap().clone()
        }
    }

    struct CapturedTransaction {
        statements: std::sync::Arc<std::sync::Mutex<Vec<crate::sql_test_support::Query>>>,
        attempts: std::sync::Arc<std::sync::Mutex<usize>>,
        fail_at: Option<usize>,
        reader: Option<brz_mysql::MysqlService>,
        fail_runtime_page: bool,
        fail_task_read: bool,
        fail_statistics: bool,
        failed: std::sync::Arc<std::sync::atomic::AtomicBool>,
        bound: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl CapturedTransaction {
        fn record<S: AsRef<str>, A: brz_mysql::MysqlArgs>(&self, sql: S, arguments: &A) {
            self.statements
                .lock()
                .unwrap()
                .push(crate::sql_test_support::Query {
                    sql: sql.as_ref().to_string(),
                    args: arguments.len(),
                    first_integer: arguments
                        .first_route_value()
                        .and_then(|value| value.as_i64().ok()),
                });
        }
    }

    impl MysqlTransaction for CapturedTransaction {
        async fn execute<S, A>(
            &mut self,
            sql: S,
            arguments: A,
        ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
        {
            let mut attempts = self.attempts.lock().unwrap();
            *attempts += 1;
            if self.fail_at == Some(*attempts) {
                return Err(brz_mysql::MysqlError::RowNotFound);
            }
            drop(attempts);
            self.record(sql.as_ref(), &arguments);
            if self.fail_statistics && sql.as_ref().starts_with("UPDATE kinds") {
                return Err(brz_mysql::MysqlError::RowNotFound);
            }
            if sql
                .as_ref()
                .starts_with("UPDATE background_executions SET status")
            {
                self.failed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            if sql
                .as_ref()
                .starts_with("UPDATE background_executions SET task_id")
            {
                self.bound.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(brz_mysql::MysqlExecution {
                rows_affected: 1,
                last_insert_id: 0,
            })
        }

        async fn fetch_optional<S, A, T>(
            &mut self,
            sql: S,
            arguments: A,
        ) -> brz_mysql::MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
            T: brz_mysql::FromMysqlRow + Send,
        {
            self.record(sql.as_ref(), &arguments);
            if self.fail_task_read {
                return Err(brz_mysql::MysqlError::RowNotFound);
            }
            if let Some(reader) = &self.reader {
                return reader.fetch_optional(sql, arguments).await;
            }
            Ok(None)
        }

        async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> brz_mysql::MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
            T: brz_mysql::FromMysqlRow + Send,
        {
            panic!("transaction capture does not serve single-row reads")
        }

        fn fetch<'transaction, S, A, T>(
            &'transaction mut self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = brz_mysql::MysqlResult<T>> + Send + 'transaction
        where
            S: AsRef<str> + Send + 'transaction,
            A: brz_mysql::MysqlArgs + Send + 'transaction,
            T: brz_mysql::FromMysqlRow + Send + 'transaction,
        {
            futures_util::stream::once(async { panic!("transaction capture does not stream") })
        }

        async fn fetch_all<S, A, T>(
            &mut self,
            sql: S,
            arguments: A,
        ) -> brz_mysql::MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
            T: brz_mysql::FromMysqlRow + Send,
        {
            self.record(sql, &arguments);
            if self.fail_runtime_page {
                return Err(brz_mysql::MysqlError::RowNotFound);
            }
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn unsaved_result_recovery_commits_failed_and_binding_despite_statistics_error() {
        use crate::internal_callback::completion::subscription::boundary_tests::{
            execution_row, subscription_row,
        };
        use crate::sql_test_support::mysql_rows::Value;
        use std::sync::atomic::Ordering;
        let mut capture = TransactionCapture {
            fail_statistics: true,
            ..Default::default()
        };
        let failed = capture.failed.clone();
        let bound = capture.bound.clone();
        let rows = crate::sql_test_support::mysql_rows::MysqlRows::start_results(move |sql| {
            let row = if sql.contains("FROM background_executions") {
                let mut row = execution_row(if failed.load(Ordering::SeqCst) {
                    "FAILED"
                } else {
                    "RUNNING"
                });
                for (name, value) in &mut row {
                    if *name == "task_id" {
                        *value = Value::I64(if bound.load(Ordering::SeqCst) {
                            501_652_180_355_339
                        } else {
                            0
                        });
                    }
                }
                row
            } else {
                subscription_row()
            };
            (row.clone(), vec![row])
        })
        .await;
        capture.reader = Some(rows.mysql.clone());
        let redis = NoRedis;
        let manager = manager();
        let ctx = Completion {
            app: None,
            mysql: &capture,
            redis: &redis,
            tables: tables(),
            executor_manager: &manager,
        };
        let event = TaskCompletedEvent {
            task_id: 501_652_180_355_339,
            subtask_id: 42,
            user_id: 3650,
            status: "COMPLETED",
            result: None,
            error: None,
        };
        let changed = fail_unsaved_result(&ctx, &capture, &event, Some(2_539_501), "Data too long")
            .await
            .expect("statistics cannot prevent committed failure");
        assert_eq!(changed.status, "FAILED");
        assert_eq!(changed.task_id, event.task_id);
        assert_eq!(
            capture.transaction_count(),
            2,
            "status and statistics use separate boundaries"
        );
        let statements = capture.statements();
        let bind = statements
            .iter()
            .position(|q| {
                q.sql
                    .starts_with("UPDATE background_executions SET task_id")
            })
            .unwrap();
        let status = statements
            .iter()
            .position(|q| q.sql.starts_with("UPDATE background_executions SET status"))
            .unwrap();
        let stats = statements
            .iter()
            .position(|q| q.sql.starts_with("UPDATE kinds"))
            .unwrap();
        assert!(bind < status && status < stats);
        assert!(statements[status].sql.contains("version = ?"));
        assert!(
            !statements.iter().any(|q| q.sql.contains("ORDER BY")),
            "never select a newer execution"
        );
        // Conflicting ownership and an unbound terminal row cannot be restored.
        let mut transaction = capture.transaction();
        for (task_id, user_id, status) in [
            (7, 3650, "RUNNING"),
            (0, 7, "RUNNING"),
            (0, 3650, "CANCELLED"),
        ] {
            let mut execution = changed.clone();
            execution.task_id = task_id;
            execution.user_id = user_id;
            execution.status = status.into();
            assert!(
                !bind_recovered_execution(&mut transaction, &mut execution, &event)
                    .await
                    .unwrap()
            );
        }
    }

    impl brz_mysql::Mysql for TransactionCapture {
        type Transaction = CapturedTransaction;

        fn with_route<R: brz_mysql::MysqlRouting + 'static>(
            &self,
            _: R,
        ) -> brz_mysql::MysqlService {
            panic!("the handler opens exactly one transaction")
        }

        fn route<K: brz_mysql::MysqlRouteKey>(&self, _: K) -> Self {
            self.clone()
        }

        async fn execute<S, A>(
            &self,
            _: S,
            _: A,
        ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
        {
            panic!("the executor updates must run inside the transaction")
        }

        async fn fetch_optional<S, A, T>(&self, _: S, _: A) -> brz_mysql::MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
            T: brz_mysql::FromMysqlRow + Send,
        {
            panic!("the handler reads inside the transaction")
        }

        async fn fetch_one<S, A, T>(&self, _: S, _: A) -> brz_mysql::MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
            T: brz_mysql::FromMysqlRow + Send,
        {
            panic!("the handler reads inside the transaction")
        }

        fn fetch<'service, S, A, T>(
            &'service self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = brz_mysql::MysqlResult<T>> + Send + 'service
        where
            S: AsRef<str> + Send + 'service,
            A: brz_mysql::MysqlArgs + Send + 'service,
            T: brz_mysql::FromMysqlRow + Send + 'service,
        {
            futures_util::stream::once(async { panic!("the handler reads inside the transaction") })
        }

        async fn fetch_all<S, A, T>(&self, _: S, _: A) -> brz_mysql::MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: brz_mysql::MysqlArgs + Send,
            T: brz_mysql::FromMysqlRow + Send,
        {
            panic!("the handler reads inside the transaction")
        }

        async fn with_transaction<T, F>(&self, operation: F) -> brz_mysql::MysqlResult<T>
        where
            T: Send,
            F: for<'transaction> AsyncFnOnce(
                    &'transaction mut Self::Transaction,
                ) -> brz_mysql::MysqlResult<T>
                + Send,
        {
            *self.transactions.lock().unwrap() += 1;
            let mut transaction = self.transaction();
            operation(&mut transaction).await
        }
    }

    /// `_db_session`'s flush: every selected subtask update joins the caller's
    /// transaction, and the helper never sends the old ad-hoc `COMMIT`.
    #[tokio::test]
    async fn the_executor_deleted_updates_join_the_session_transaction() {
        let capture = TransactionCapture::default();
        let sql = deleted_statement(tables());
        let updates = vec![
            (
                "2026-10-21 15:45:26.537475".to_string(),
                RuntimeReference {
                    id: 801406538589674,
                    name: Some("fixture-runtime".into()),
                    namespace: None,
                },
            ),
            (
                "2026-10-21 15:45:26.537475".to_string(),
                RuntimeReference {
                    id: 801406538589675,
                    name: Some("fixture-runtime".into()),
                    namespace: None,
                },
            ),
        ];

        let mut transaction = capture.transaction();
        apply_executor_deleted_updates(&mut transaction, &sql, &updates)
            .await
            .expect("batch applies");

        assert_eq!(capture.update_attempts(), 2);
        let statements = capture.statements();
        assert_eq!(statements.len(), 2, "{statements:?}");
        for statement in &statements {
            assert_eq!(statement.sql, sql, "{statement:?}");
            assert_eq!(statement.args, 5, "{statement:?}");
        }
        assert!(
            statements.iter().all(|statement| statement.sql != "COMMIT"),
            "{statements:?}"
        );
    }

    /// A failed update aborts the batch: the source `db_session` rolls the
    /// whole flush back, so no later subtask is updated.
    #[tokio::test]
    async fn a_failed_executor_deleted_update_aborts_the_batch() {
        let capture = TransactionCapture::failing_at(2);
        let sql = deleted_statement(tables());
        let updates = vec![
            (
                "2026-10-21 15:45:26.537475".to_string(),
                RuntimeReference {
                    id: 801406538589674,
                    name: Some("fixture-runtime".into()),
                    namespace: None,
                },
            ),
            (
                "2026-10-21 15:45:26.537475".to_string(),
                RuntimeReference {
                    id: 801406538589675,
                    name: Some("fixture-runtime".into()),
                    namespace: None,
                },
            ),
        ];

        let mut transaction = capture.transaction();
        let outcome = apply_executor_deleted_updates(&mut transaction, &sql, &updates).await;

        assert!(outcome.is_err(), "{outcome:?}");
        assert_eq!(capture.update_attempts(), 2);
        assert_eq!(capture.statements().len(), 1);

        // The first runtime-page failure must abort preparation too, rather
        // than pretending the eligible runtime list is successfully empty.
        let rows = crate::sql_test_support::mysql_rows::MysqlRows::start(|sql| {
            use crate::sql_test_support::mysql_rows::Value;
            if sql.starts_with("SELECT id FROM subtasks_0030") {
                return vec![("id", Value::I64(42))];
            }
            vec![
                ("id", Value::I64(42)),
                ("user_id", Value::I64(7)),
                ("kind", Value::Text("Task".into())),
                ("name", Value::Text("fixture-task".into())),
                ("namespace", Value::Text("default".into())),
                (
                    "json",
                    Value::Bytes(
                        br#"{"metadata":{"labels":{"autoDeleteExecutor":"true"}},"status":{"status":"COMPLETED"}}"#.to_vec(),
                    ),
                ),
                ("is_active", Value::I8(1)),
                ("created_at", Value::DateTime),
                ("updated_at", Value::DateTime),
                ("project_id", Value::Null),
                ("client_origin", Value::Null),
                ("is_group_chat", Value::I8(0)),
            ]
        })
        .await;
        let capture = TransactionCapture::default();
        let mut transaction = capture.transaction();
        transaction.reader = Some(rows.mysql.clone());
        transaction.fail_runtime_page = true;
        let event = TaskCompletedEvent {
            task_id: 42,
            user_id: 7,
            subtask_id: 0,
            status: "COMPLETED",
            result: None,
            error: None,
        };
        transaction.fail_task_read = true;
        assert!(matches!(
            cleanup::prepare_auto_delete(&mut transaction, tables(), &event).await,
            Err(brz_mysql::MysqlError::RowNotFound)
        ));
        assert_eq!(capture.update_attempts(), 0);
        transaction.fail_task_read = false;
        assert!(matches!(
            cleanup::prepare_auto_delete(&mut transaction, tables(), &event).await,
            Err(brz_mysql::MysqlError::RowNotFound)
        ));
        assert!(
            capture
                .statements()
                .last()
                .is_some_and(|query| query.sql.contains("executor_deleted_at")
                    && query.sql.contains("message_id <="))
        );
        assert_eq!(capture.update_attempts(), 0);
        transaction.fail_runtime_page = false;
        assert!(
            cleanup::prepare_auto_delete(&mut transaction, tables(), &event)
                .await
                .expect("a successful empty page remains a no-op")
                .is_none()
        );
    }
}
