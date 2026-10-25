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

/// `handle_task_completed`.
///
/// `on_task_completed` wraps the execution lookup and the auto-delete cleanup
/// in one `get_db_session()` block (`task_completion_handler.py:78-90`), so
/// the first read opens the connection transaction and the cleanup
/// `db.commit()` ends it. One explicit transaction reproduces that boundary:
/// every read and the cleanup update share one connection, and it commits only
/// after the cleanup succeeds.
pub(crate) async fn handle_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(event.task_id as u64));
    let outcome = mysql
        .with_transaction(async |transaction| {
            if let Some(execution) = find_execution_by_task_id(transaction, event.task_id).await {
                // An execution exists: the terminal-status update, inbox
                // write-back and notification fan-out that follow are outside
                // this callback's recorded traffic and are not reproduced
                // here.
                tracing::debug!(
                    execution_id = execution,
                    task_id = event.task_id,
                    "subscription execution found for completed task"
                );
                return Ok(());
            }
            cleanup_auto_delete_task_executor(transaction, ctx.tables, ctx.executor_manager, event)
                .await
        })
        .await;
    if let Err(error) = outcome {
        // `on_task_completed`'s outer handler logs the failure after
        // `_db_session` rolled the session back.
        tracing::error!(
            task_id = event.task_id,
            %error,
            "task completion transaction failed; cleanup rolled back"
        );
    }
}

/// `_find_execution_by_task_id`: the active execution, the newest execution,
/// then the code-wiki scheduled-execution recovery read.
async fn find_execution_by_task_id<T: MysqlTransaction>(
    transaction: &mut T,
    task_id: i64,
) -> Option<i64> {
    let running: Option<MysqlRow> = transaction
        .fetch_optional(sql::background_execution_running(), (task_id,))
        .await
        .ok()
        .flatten();
    if let Some(row) = running {
        return row.get::<i64>("background_executions_id").ok().flatten();
    }
    let latest: Option<MysqlRow> = transaction
        .fetch_optional(sql::background_execution_latest(), (task_id,))
        .await
        .ok()
        .flatten();
    if let Some(row) = latest {
        return row.get::<i64>("background_executions_id").ok().flatten();
    }
    // `recover_scheduled_execution_for_task`: the code-wiki integration reads
    // the task's newest wiki generation before giving up.
    let generation: Option<MysqlRow> = transaction
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
                        %error,
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
mod tests {
    use super::*;

    use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, RedisResult, RedisValues};

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
            mysql: &capture,
            redis: &redis,
            tables: tables(),
            executor_manager: &manager,
        };
        let event = TaskCompletedEvent {
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
    }

    impl CapturedTransaction {
        fn record<S: AsRef<str>, A: brz_mysql::MysqlArgs>(&self, sql: S, arguments: A) {
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
            self.record(sql, arguments);
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
            self.record(sql, arguments);
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
            self.record(sql, arguments);
            Ok(Vec::new())
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
        let sql = sql::update_subtask_executor_deleted(tables());
        let updates = vec![
            ("2026-10-21 15:45:26.537475".to_string(), 801406538589674),
            ("2026-10-21 15:45:26.537475".to_string(), 801406538589675),
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
            assert_eq!(statement.args, 3, "{statement:?}");
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
        let sql = sql::update_subtask_executor_deleted(tables());
        let updates = vec![
            ("2026-10-21 15:45:26.537475".to_string(), 801406538589674),
            ("2026-10-21 15:45:26.537475".to_string(), 801406538589675),
        ];

        let mut transaction = capture.transaction();
        let outcome = apply_executor_deleted_updates(&mut transaction, &sql, &updates).await;

        assert!(outcome.is_err(), "{outcome:?}");
        assert_eq!(capture.update_attempts(), 2);
        assert_eq!(capture.statements().len(), 1);
    }
}
