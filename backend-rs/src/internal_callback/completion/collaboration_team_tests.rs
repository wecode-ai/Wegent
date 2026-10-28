// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused test for the Team read `CollaborationStrategyFactory` performs while
//! `_update_task_status_sync` derives the task status.
//!
//! `get_strategy_for_task` (`app/services/adapters/collaboration_strategy.py:
//! 405-440`) reads the task through `get_regular_active_task` and returns
//! `DefaultCollaborationStrategy` when that read finds no row; only then does
//! it resolve `_get_team_from_task_ref`. Recording `20261027105553` shows both
//! outcomes for the same route: case `a12c8e9d-d565-4246-aad1-2e567a8dafd1`
//! finds its regular active task (`is_active = 1`) and issues the Team read,
//! while case `f742360f-b080-4725-b980-6af764719500` is a subscription task the
//! regular-active predicate excludes and issues none.
#![cfg(test)]

use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

use super::sql;
use super::strategy_team;

/// Records the statements the strategy resolution prepares. The fake answers
/// every row read with SQL NULL-free success but no row, so the helper's own
/// decision is what the assertions observe.
#[derive(Default)]
struct StatementLog {
    statements: Vec<crate::sql_test_support::Query>,
}

impl StatementLog {
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

impl MysqlTransaction for StatementLog {
    async fn execute<S, A>(&mut self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!("the strategy resolution issues no write")
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, arguments: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql, arguments);
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the strategy resolution reads no single-row query")
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
        futures_util::stream::once(async { panic!("the strategy resolution does not stream") })
    }

    async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("the strategy resolution reads no listing")
    }
}

/// The recorded task CRD payload of case
/// `f742360f-b080-4725-b980-6af764719500`: `spec.teamRef` names the public
/// `wegent-wework` Team (`user_id = 0`) in `default`.
fn subscription_task_payload() -> serde_json::Map<String, Value> {
    let payload = json!({
        "spec": {
            "teamRef": {"name": "wegent-wework", "namespace": "default", "user_id": 0},
            "workspaceRef": {"name": "workspace-501652180355339", "namespace": "default"}
        },
        "status": {"status": "COMPLETED"}
    });
    match payload {
        Value::Object(map) => map,
        _ => unreachable!("the recorded payload is an object"),
    }
}

/// A task the regular-active predicate excludes never reaches
/// `_get_team_from_task_ref`, so the callback prepares no `kinds` statement for
/// it — the recorded `f742360f-b080-4725-b980-6af764719500` dependency stream
/// carries no Team read between `get_regular_active_task` and the task update.
#[tokio::test]
async fn a_non_regular_active_task_reads_no_team() {
    let mut transaction = StatementLog::default();
    let team = strategy_team(&mut transaction, false, &subscription_task_payload()).await;

    assert!(team.is_none(), "no Team resolves without the task read");
    assert!(
        transaction.statements.is_empty(),
        "no statement follows a missing regular active task: {:?}",
        transaction
            .statements
            .iter()
            .map(|statement| statement.sql.clone())
            .collect::<Vec<_>>()
    );
}

/// The same payload for a regular active task issues exactly the source's Team
/// read: `_get_team_from_task_ref` filters the ref's owner, kind, namespace and
/// name, and the `is_active IS true` filter SQLAlchemy renders for `.is_(True)`.
#[tokio::test]
async fn a_regular_active_task_reads_the_team_by_owner() {
    let mut transaction = StatementLog::default();
    let team = strategy_team(&mut transaction, true, &subscription_task_payload()).await;

    assert!(team.is_none(), "the fake read returns no row");
    assert_eq!(transaction.statements.len(), 1);
    let statement = &transaction.statements[0];
    assert_eq!(
        statement.sql,
        sql::team_by_owner()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    );
    assert!(
        statement.sql.contains("kinds.user_id = ?"),
        "{}",
        statement.sql
    );
    assert!(
        statement.sql.contains("kinds.is_active IS true"),
        "{}",
        statement.sql
    );
    assert_eq!(statement.args, 3, "owner, namespace and name bind");
    assert_eq!(
        statement.first_integer,
        Some(0),
        "the public Team's owner binds as the integer 0"
    );
}

/// `getattr(team_ref, "user_id", None)` answers `None` for a ref without an
/// owner, and `_get_team_from_task_ref` returns before querying.
#[tokio::test]
async fn a_team_ref_without_an_owner_reads_no_team() {
    let mut transaction = StatementLog::default();
    let payload = json!({"spec": {"teamRef": {"name": "wegent-chat", "namespace": "default"}}});
    let Value::Object(payload) = payload else {
        unreachable!("the payload is an object")
    };

    let team = strategy_team(&mut transaction, true, &payload).await;

    assert!(team.is_none());
    assert!(transaction.statements.is_empty());
}
