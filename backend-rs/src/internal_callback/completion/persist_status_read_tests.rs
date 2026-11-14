// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused test for the task read `_update_task_status_sync` issues.
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};

use super::update_task_status_on;
use crate::internal_callback::completion::Tables;

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0030",
        subtasks: "subtasks_0030",
    }
}

/// Records the transaction statements the callback issues; the task read
/// returns no row so the callback stops after it.
#[derive(Default)]
struct CapturedTransaction {
    statements: Vec<crate::sql_test_support::Query>,
    /// Return a store error from the task read when set.
    fail_reads: bool,
    allow_assistant_read: bool,
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

    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        assert!(
            self.allow_assistant_read,
            "a missing task must stop all listings"
        );
        self.record(sql, args);
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn status_assistant_read_is_bounded_only_for_subscriptions() {
    for is_subscription in [false, true] {
        let mut transaction = CapturedTransaction {
            allow_assistant_read: true,
            ..Default::default()
        };
        let rows = super::persist_status::read_assistants(
            &mut transaction,
            tables(),
            123,
            is_subscription,
        )
        .await
        .unwrap();
        assert!(rows.is_empty());
        assert_eq!(transaction.statements.len(), 1);
        let statement = &transaction.statements[0];
        assert_eq!(statement.first_integer, Some(123));
        assert_eq!(statement.sql.contains("LIMIT 1"), is_subscription);
        assert_eq!(statement.sql.contains("JOIN (SELECT id"), is_subscription);
        assert!(statement.sql.contains("FROM subtasks_0030"));
    }
}

/// `_update_task_status_sync` -> `task_store.get_task_by_states(...).first()`:
/// the recorded reads of case `f0a9b48f-8875-436e-958a-5361a7817bc1`
/// (`query_sequence` 80, 95, 159, 173, 174, 201, 218) are the ORM's labeled
/// active-task projection. The writer now locks it against cancellation.
#[tokio::test]
async fn the_task_status_read_locks_the_labeled_active_task_projection() {
    let mut transaction = CapturedTransaction::default();
    assert!(
        update_task_status_on(tables(), &mut transaction, 426335633820493, 7)
            .await
            .unwrap()
            .is_none()
    );

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
    assert!(statement.sql.ends_with("FOR UPDATE"), "{}", statement.sql);
    assert!(
        !statement.sql.contains("SELECT id, user_id"),
        "{}",
        statement.sql
    );
}

#[tokio::test]
async fn a_failed_task_status_read_reaches_the_transaction_caller() {
    let mut transaction = CapturedTransaction {
        fail_reads: true,
        ..CapturedTransaction::default()
    };
    assert!(matches!(
        update_task_status_on(tables(), &mut transaction, 426335633820493, 7).await,
        Err(brz_mysql::MysqlError::RowNotFound)
    ));

    assert_eq!(transaction.statements.len(), 1);
}
