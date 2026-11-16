// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Carry a business outcome out of `Mysql::with_transaction`.
//!
//! `Mysql::with_transaction` commits on `Ok` and rolls back on `Err`, so an
//! operation that ends in a non-database rejection must choose that end
//! explicitly. [`Completion`] names the choice and [`run`] performs it: a
//! [`Completion::Rollback`] outcome is still returned to the caller as its
//! value, but the transaction is rolled back first.
//!
//! Source SQLAlchemy sessions behave the same way: `db.commit()` keeps the
//! flushed writes, while an exception leaves the session to `db.rollback()`.
//! A rejection is not a database failure, so [`run`] carries it out of the
//! closure through a sentinel error that is recognised here and never reaches
//! the response.

use brz_mysql::{Mysql, MysqlError, MysqlResult};

use crate::http_compat::FastApiError;

/// What a transaction decided once its writes are done.
pub(crate) enum Completion<T> {
    /// `db.commit()`: keep the flushed writes and return `T`.
    Commit(T),
    /// `db.rollback()`: discard the writes and keep `T` as the outcome.
    Rollback(T),
}

/// Sentinel reason that ends a transaction with a rollback. [`run`] replaces it
/// with the stored outcome, so it is never rendered.
const ROLLBACK_REASON: &str = "transaction outcome rolled back";

/// Runs `operation` in one writer transaction.
///
/// [`Completion::Commit`] commits and returns its value;
/// [`Completion::Rollback`] rolls back and still returns its value; a
/// `FastApiError` from the operation rolls back and is returned unchanged; a
/// real database failure rolls back and is rendered by `database_error`.
pub(crate) async fn run<M, T, F>(
    mysql: &M,
    operation: F,
    database_error: fn() -> FastApiError,
) -> Result<T, FastApiError>
where
    M: Mysql,
    T: Send,
    F: for<'a> AsyncFnOnce(&'a mut M::Transaction) -> Result<Completion<T>, FastApiError> + Send,
{
    let mut outcome: Option<Result<T, FastApiError>> = None;
    let result = mysql
        .with_transaction(async |transaction| match operation(transaction).await {
            Ok(Completion::Commit(value)) => Ok(value),
            Ok(Completion::Rollback(value)) => {
                outcome = Some(Ok(value));
                Err(rollback())
            }
            Err(error) => {
                outcome = Some(Err(error));
                Err(rollback())
            }
        })
        .await;
    match result {
        Ok(value) => Ok(value),
        // A failed rollback surfaces as `MysqlError::TransactionRollback`,
        // which is a real database failure and takes the branch below.
        Err(error) if is_rollback(&error) => outcome.unwrap_or_else(|| {
            tracing::error!(%error, "transaction rollback outcome was lost");
            Err(database_error())
        }),
        Err(error) => {
            tracing::error!(%error, "transaction failed");
            Err(database_error())
        }
    }
}

pub(crate) async fn run_mysql_with_deadlock_retry<M, T, F>(
    mysql: &M,
    operation: F,
) -> MysqlResult<T>
where
    M: Mysql,
    T: Send,
    F: for<'a> AsyncFnOnce(&'a mut M::Transaction) -> MysqlResult<T> + Send + Copy,
{
    const MAX_ATTEMPTS: usize = 3;
    for attempt in 0..MAX_ATTEMPTS {
        match mysql.with_transaction(operation).await {
            Ok(value) => return Ok(value),
            Err(error) if error.database_code() == Some(1213) => {
                if attempt + 1 == MAX_ATTEMPTS {
                    tracing::error!(%error, "transaction failed after deadlock retries");
                    return Err(error);
                }
                tracing::warn!(
                    %error,
                    attempt = attempt + 1,
                    "restarting transaction after MySQL deadlock"
                );
            }
            Err(error) => {
                tracing::error!(%error, "transaction failed");
                return Err(error);
            }
        }
    }
    unreachable!("deadlock retry loop always returns")
}

/// The error that ends the transaction without a commit. A failed rollback is
/// reported as `MysqlError::TransactionRollback`, which is a real database
/// failure and is mapped by the caller instead.
fn rollback() -> MysqlError {
    MysqlError::InvalidQuery {
        reason: ROLLBACK_REASON.to_owned(),
    }
}

/// Whether `error` is [`run`]'s own rollback sentinel.
fn is_rollback(error: &MysqlError) -> bool {
    matches!(error, MysqlError::InvalidQuery { reason } if reason == ROLLBACK_REASON)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use brz_mysql::{
        FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
        MysqlService, MysqlTransaction,
    };

    #[test]
    fn the_rollback_sentinel_is_recognised_and_nothing_else_is() {
        assert!(is_rollback(&rollback()));
        assert!(!is_rollback(&MysqlError::InvalidQuery {
            reason: "FOR UPDATE is not allowed in fetch queries".to_owned(),
        }));
        assert!(!is_rollback(&MysqlError::RowNotFound));
        assert!(!is_rollback(&MysqlError::TransactionRollback {
            operation: Box::new(rollback()),
            rollback: Box::new(MysqlError::RowNotFound),
        }));
    }

    /// Records whether the transaction ended with a commit or a rollback, which
    /// is what `brz-mysql` decides from the closure's `Ok`/`Err`.
    #[derive(Clone, Default)]
    struct RecordingMysql {
        endings: Arc<Mutex<Vec<&'static str>>>,
        failures: Arc<Mutex<Vec<MysqlError>>>,
    }

    impl RecordingMysql {
        fn endings(&self) -> Vec<&'static str> {
            self.endings.lock().unwrap().clone()
        }
    }

    struct RecordingTransaction;

    impl Mysql for RecordingMysql {
        type Transaction = RecordingTransaction;

        fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
            panic!("the unit test has no pool")
        }

        fn route<K: MysqlRouteKey>(&self, _: K) -> Self {
            self.clone()
        }

        async fn fetch_optional<S, A, T>(&self, _: S, _: A) -> MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(None)
        }

        async fn fetch_all<S, A, T>(&self, _: S, _: A) -> MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(Vec::new())
        }

        async fn execute<S, A>(&self, _: S, _: A) -> MysqlResult<MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
        {
            Ok(MysqlExecution {
                rows_affected: 0,
                last_insert_id: 0,
            })
        }

        async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Err(MysqlError::RowNotFound)
        }

        fn fetch<'a, S, A, T>(
            &'a self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
        where
            S: AsRef<str> + Send + 'a,
            A: MysqlArgs + Send + 'a,
            T: FromMysqlRow + Send + 'a,
        {
            futures_util::stream::empty()
        }

        async fn with_transaction<T, F>(&self, operation: F) -> MysqlResult<T>
        where
            T: Send,
            F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
        {
            if let Some(error) = self.failures.lock().unwrap().pop() {
                self.endings.lock().unwrap().push("rollback");
                return Err(error);
            }
            let result = operation(&mut RecordingTransaction).await;
            self.endings
                .lock()
                .unwrap()
                .push(if result.is_ok() { "commit" } else { "rollback" });
            result
        }
    }

    impl MysqlTransaction for RecordingTransaction {
        async fn execute<S, A>(&mut self, _: S, _: A) -> MysqlResult<MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
        {
            Ok(MysqlExecution {
                rows_affected: 0,
                last_insert_id: 0,
            })
        }

        async fn fetch_optional<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(None)
        }

        async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Err(MysqlError::RowNotFound)
        }

        fn fetch<'a, S, A, T>(
            &'a mut self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
        where
            S: AsRef<str> + Send + 'a,
            A: MysqlArgs + Send + 'a,
            T: FromMysqlRow + Send + 'a,
        {
            futures_util::stream::empty()
        }

        async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn a_business_rejection_rolls_the_transaction_back() {
        // The create flow's scope resolution ends with `return Err(..)`; if it
        // were wrapped as `Ok(Err(..))`, `with_transaction` would commit the
        // partial transaction instead (the recorded `observed_end: commit`).
        let mysql = RecordingMysql::default();
        let result: Result<(), FastApiError> = run(
            &mysql,
            async |_transaction| Err(FastApiError::internal()),
            FastApiError::internal,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(mysql.endings(), ["rollback"]);
    }

    #[tokio::test]
    async fn a_completed_operation_commits() {
        let mysql = RecordingMysql::default();
        let value = run(
            &mysql,
            async |_transaction| Ok(Completion::Commit(7_u8)),
            FastApiError::internal,
        )
        .await
        .expect("commit");
        assert_eq!(value, 7);
        assert_eq!(mysql.endings(), ["commit"]);
    }

    #[tokio::test]
    async fn a_rollback_completion_still_returns_its_value() {
        let mysql = RecordingMysql::default();
        let value = run(
            &mysql,
            async |_transaction| Ok(Completion::Rollback(9_u8)),
            FastApiError::internal,
        )
        .await
        .expect("rollback outcome");
        assert_eq!(value, 9);
        assert_eq!(mysql.endings(), ["rollback"]);
    }

    #[tokio::test]
    async fn a_deadlock_restarts_the_whole_transaction() {
        let mysql = RecordingMysql::default();
        mysql.failures.lock().unwrap().push(MysqlError::Database {
            code: Some(1213),
            sql_state: Some("40001".to_owned()),
            message: "Deadlock found".to_owned(),
        });
        let value = run_mysql_with_deadlock_retry(&mysql, async |_transaction| Ok(7_u8))
            .await
            .expect("retry succeeds");
        assert_eq!(value, 7);
        assert_eq!(mysql.endings(), ["rollback", "commit"]);
    }

    #[tokio::test]
    async fn deadlock_retries_are_bounded() {
        let mysql = RecordingMysql::default();
        for _ in 0..3 {
            mysql.failures.lock().unwrap().push(MysqlError::Database {
                code: Some(1213),
                sql_state: Some("40001".to_owned()),
                message: "Deadlock found".to_owned(),
            });
        }
        let result = run_mysql_with_deadlock_retry(&mysql, async |_transaction| Ok(7_u8)).await;
        assert!(result.is_err());
        assert_eq!(mysql.endings(), ["rollback", "rollback", "rollback"]);
    }

    #[tokio::test]
    async fn other_database_failures_do_not_retry() {
        let mysql = RecordingMysql::default();
        mysql.failures.lock().unwrap().push(MysqlError::Database {
            code: Some(1146),
            sql_state: Some("42S02".to_owned()),
            message: "Table missing".to_owned(),
        });
        let result = run_mysql_with_deadlock_retry(&mysql, async |_transaction| Ok(7_u8)).await;
        assert!(result.is_err());
        assert_eq!(mysql.endings(), ["rollback"]);
    }
}
