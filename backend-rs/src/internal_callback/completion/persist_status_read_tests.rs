// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused test for the task read `_update_task_status_sync` issues.
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
use brz_redis::{EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, Redis, RedisResult, RedisValues};

use super::update_task_status_on;
use crate::internal_callback::completion::{Completion, Tables};

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0030",
        subtasks: "subtasks_0030",
    }
}

/// The status-update read issues no Redis command; the completion context
/// still requires a Redis handle.
struct NoRedis;

impl Redis for NoRedis {
    async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the task status read issues no Redis read")
    }

    async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
    where
        K: EncodeRedisArg + Send,
        V: EncodeRedisArg + Send,
    {
        unreachable!("the task status read issues no Redis write")
    }

    async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
    where
        K: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the task status read issues no Redis read")
    }

    async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("the task status read issues no Redis write")
    }

    async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
    where
        K: EncodeRedisArgs + Send,
    {
        unreachable!("the task status read issues no Redis read")
    }

    async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArg + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the task status read issues no Redis read")
    }

    async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
    where
        K: EncodeRedisArg + Send,
        F: EncodeRedisArgs + Send,
        R: FromRedisBulk + Send,
    {
        unreachable!("the task status read issues no Redis read")
    }
}

/// Records the transaction statements the callback issues; the task read
/// returns no row so the callback stops after it.
#[derive(Default)]
struct CapturedTransaction {
    statements: Vec<crate::sql_test_support::Query>,
    /// Return a store error from the task read when set.
    fail_reads: bool,
}

impl CapturedTransaction {
    fn record<S: AsRef<str>, A: MysqlArgs>(&mut self, sql: S, arguments: A) {
        self.statements.push(crate::sql_test_support::Query {
            sql: sql
                .as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            args: arguments.len(),
            first_integer: arguments
                .first_route_value()
                .and_then(|value| value.as_i64().ok()),
        });
    }
}

impl MysqlTransaction for CapturedTransaction {
    async fn execute<S, A>(&mut self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!("the task read is missing, so no write follows")
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, arguments: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql, arguments);
        if self.fail_reads {
            return Err(brz_mysql::MysqlError::RowNotFound);
        }
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the task status read is not a single-row fetch")
    }

    fn fetch<'transaction, S, A, T>(
        &'transaction mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'transaction
    where
        S: AsRef<str> + Send + 'transaction,
        A: MysqlArgs + Send + 'transaction,
        T: FromMysqlRow + Send + 'transaction,
    {
        futures_util::stream::once(async { panic!("the task status read does not stream") })
    }

    async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the task read is missing, so no listing follows")
    }
}

/// `_update_task_status_sync` -> `task_store.get_task_by_states(...).first()`:
/// the recorded reads of case `f0a9b48f-8875-436e-958a-5361a7817bc1`
/// (`query_sequence` 80, 95, 159, 173, 174, 201, 218) are the ORM's labeled
/// active-task projection with no `FOR UPDATE`.
#[tokio::test]
async fn the_task_status_read_is_the_labeled_active_task_projection_without_a_lock() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let redis = NoRedis;
    let manager = crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
        .expect("executor-manager client");
    let ctx = Completion {
        app: None,
        mysql: &mysql,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
    };
    let mut transaction = CapturedTransaction::default();
    update_task_status_on(&ctx, &mut transaction, 426335633820493, 7).await;

    let statement = transaction
        .statements
        .first()
        .expect("the task status read is issued");
    assert!(
        statement.sql.contains("tasks_0030.id AS tasks_0030_id"),
        "{}",
        statement.sql
    );
    assert!(
        statement.sql.contains(
            "WHERE tasks_0030.id = ? AND tasks_0030.kind = 'Task' \
             AND tasks_0030.is_active IN (1, 2)"
        ),
        "{}",
        statement.sql
    );
    assert!(!statement.sql.contains("FOR UPDATE"), "{}", statement.sql);
    assert!(
        !statement.sql.contains("SELECT id, user_id"),
        "{}",
        statement.sql
    );
}

/// `_update_task_status_sync` catches and logs a store failure instead of
/// propagating it into the request path.
#[tokio::test]
async fn a_failed_task_status_read_is_logged_and_swallowed() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let redis = NoRedis;
    let manager = crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
        .expect("executor-manager client");
    let ctx = Completion {
        app: None,
        mysql: &mysql,
        redis: &redis,
        tables: tables(),
        executor_manager: &manager,
    };
    let mut transaction = CapturedTransaction {
        fail_reads: true,
        ..CapturedTransaction::default()
    };
    update_task_status_on(&ctx, &mut transaction, 426335633820493, 7).await;

    assert_eq!(transaction.statements.len(), 1);
}

/// `_update_task_status_sync`'s `try/except` covers every status read, not
/// only the task read: a failed later read yields no value, so the caller
/// returns before performing the task-update write. Treating the failure as an
/// empty result (`unwrap_or_default`) is exactly what the alias repair removed.
#[tokio::test]
async fn a_failed_later_status_read_aborts_before_any_write() {
    let failed: MysqlResult<Vec<brz_mysql::MysqlRow>> = Err(brz_mysql::MysqlError::RowNotFound);
    assert!(super::read_status(failed, 426335633820493, "assistant_subtasks").is_none());

    let empty: MysqlResult<Vec<brz_mysql::MysqlRow>> = Ok(Vec::new());
    assert_eq!(
        super::read_status(empty, 426335633820493, "assistant_subtasks").map(|rows| rows.len()),
        Some(0)
    );
}
