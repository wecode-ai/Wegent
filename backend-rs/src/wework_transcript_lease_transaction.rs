// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Writer transactions for the Wework transcript lease APIs.
//!
//! `app.services.wework_transcript_service` runs every lease mutation in the
//! request-scoped SQLAlchemy session: `get_transcript(..., for_update=True)`
//! takes the row lock, the dirty flush updates the row, and `db.commit()` ends
//! the transaction, while a `WeworkTranscriptError` leaves the session to
//! `db.rollback()`. `brz-mysql` only accepts `FOR UPDATE` through
//! `Mysql::with_transaction` (`read-query-check` rejects a pool-level locking
//! read before it reaches MySQL), so the locking read and its write must stay
//! on one transaction connection.
//!
//! `Mysql::with_transaction` commits on `Ok` and rolls back on `Err`. A lease
//! rejection is not a database failure, so [`run`] carries it out of the
//! closure through a sentinel error that is recognised here and never reaches
//! the response.

use brz_mysql::{MysqlError, MysqlService, MysqlTransactionService};

use crate::http_compat::FastApiError;

/// What a lease transaction decided once its writes are done.
pub(crate) enum Completion<T> {
    /// `db.commit()`: keep the flushed writes and return `T`.
    Commit(T),
    /// `db.rollback()`: discard the writes and keep `T` as the outcome.
    Rollback(T),
}

/// Sentinel reason that ends a lease transaction with a rollback. [`run`]
/// replaces it with the stored outcome, so it is never rendered.
const ROLLBACK_REASON: &str = "wework transcript lease rolled back";

/// Runs `operation` in one writer transaction.
///
/// [`Completion::Commit`] commits and returns its value;
/// [`Completion::Rollback`] rolls back and still returns its value; a
/// `FastApiError` from the operation rolls back and is returned unchanged; a
/// real database failure rolls back and is rendered by `database_error`.
pub(crate) async fn run<T, F>(
    mysql: &MysqlService,
    operation: F,
    database_error: fn() -> FastApiError,
) -> Result<T, FastApiError>
where
    T: Send,
    F: for<'a> AsyncFnOnce(&'a mut MysqlTransactionService) -> Result<Completion<T>, FastApiError>
        + Send,
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
            tracing::error!(%error, "wework transcript lease rollback outcome was lost");
            Err(database_error())
        }),
        Err(error) => {
            tracing::error!(%error, "wework transcript lease transaction failed");
            Err(database_error())
        }
    }
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
}
