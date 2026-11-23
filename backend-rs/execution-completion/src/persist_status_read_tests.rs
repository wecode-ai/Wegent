// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused test for the task read `_update_task_status_sync` issues.
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};

use super::update_task_status_on;
use crate::Tables;

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
    statements: Vec<wegent_backend_test_support::Query>,
    /// Return a store error from the task read when set.
    fail_reads: bool,
    allow_assistant_read: bool,
}

impl CapturedTransaction {
    fn record<S: AsRef<str>, A: MysqlArgs>(&mut self, sql: S, arguments: A) {
        self.statements.push(wegent_backend_test_support::Query {
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
            tables().subtasks,
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
        update_task_status_on(
            &mut transaction,
            tables().tasks,
            tables().subtasks,
            426335633820493,
            7
        )
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
        update_task_status_on(
            &mut transaction,
            tables().tasks,
            tables().subtasks,
            426335633820493,
            7
        )
        .await,
        Err(brz_mysql::MysqlError::RowNotFound)
    ));

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

/// Task model selection can differ from the assistant listing's table.
#[tokio::test]
async fn status_updates_read_and_write_the_resolved_task_table() {
    assert_status_update_tables("subtasks").await;
}

#[tokio::test]
async fn status_updates_aggregate_assistants_from_the_resolved_subtask_table() {
    assert_status_update_tables("subtasks_0030").await;
}

async fn assert_status_update_tables(subtask_table: &str) {
    use serde_json::json;
    use wegent_backend_test_support::mysql_rows::{MysqlRows, Value};

    let fixture = MysqlRows::start(move |sql| {
        if sql.contains("FROM subtasks ") || sql.contains("FROM subtasks_0030 ") {
            return vec![
                ("id", Value::I64(7)),
                ("user_id", Value::I64(30)),
                ("task_id", Value::I64(42)),
                ("team_id", Value::I64(0)),
                ("title", Value::Text(String::new())),
                ("bot_ids", Value::Text("[]".into())),
                ("role", Value::Text("ASSISTANT".into())),
                ("executor_namespace", Value::Text(String::new())),
                ("executor_name", Value::Text(String::new())),
                ("executor_deleted_at", Value::Null),
                ("prompt", Value::Text(String::new())),
                ("message_id", Value::I64(2)),
                ("parent_id", Value::I64(1)),
                ("status", Value::Text("COMPLETED".into())),
                ("progress", Value::I64(100)),
                (
                    "result",
                    Value::Text(json!({"value": "completed"}).to_string()),
                ),
                ("error_message", Value::Null),
                ("created_at", Value::DateTime),
                ("updated_at", Value::DateTime),
                ("completed_at", Value::DateTime),
            ];
        }
        vec![
            ("id", Value::I64(42)),
            ("user_id", Value::I64(30)),
            ("kind", Value::Text("Task".into())),
            ("name", Value::Text("test-task".into())),
            ("namespace", Value::Text("default".into())),
            (
                "json",
                Value::Text(json!({"status": {"status": "PENDING"}}).to_string()),
            ),
        ]
    })
    .await;

    fixture
        .mysql
        .with_transaction(async |transaction| {
            assert_eq!(
                update_task_status_on(transaction, "tasks_0030", subtask_table, 42, 7)
                    .await
                    .unwrap(),
                Some(false)
            );
            Ok(())
        })
        .await
        .unwrap();

    let queries = fixture.queries();
    assert!(queries[0].contains("FROM tasks_0030"), "{queries:?}");
    assert!(
        queries
            .iter()
            .any(|sql| sql.contains(&format!("FROM {subtask_table} "))),
        "{queries:?}"
    );
    assert!(
        queries
            .iter()
            .any(|sql| sql.contains("FROM `tasks_0030`") && sql.contains("namespace != 'system'")),
        "{queries:?}"
    );
    assert!(
        queries
            .last()
            .unwrap()
            .starts_with("UPDATE tasks_0030 SET json="),
        "{queries:?}"
    );
    assert!(
        !queries
            .iter()
            .any(|sql| sql.starts_with("UPDATE tasks SET")),
        "{queries:?}"
    );
}
