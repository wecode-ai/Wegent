// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Caller-owned SQL handle for one request-scoped transaction.
//!
//! The source runs one ASGI request on one SQLAlchemy `Session`, so statements
//! issued by different services during that request share one connection and
//! one transaction. Rust services otherwise take their own pooled handle, so a
//! caller that must preserve the source's transaction hands them this handle
//! instead.
//!
//! A statement may additionally name the task shard it belongs to. The handle
//! resolves that key with the routing policy bound to it, so deployments keep
//! their `{{tasks}}`/`{{subtasks}}` template expansion inside the routing layer
//! and the store never sees a physical table name.
//!
//! The trait is object-safe: the platform keeps `&dyn` service fields, and the
//! concrete [`brz_mysql::MysqlTransactionService`] cannot be named through a
//! generic parameter without leaking `!Send` futures through a trait object.
//!
//! # Same-connection routing invariant
//!
//! Re-keying a statement (`RouteKey::User` before an insert, `RouteKey::Task`
//! once the id exists) must never move the statement off the transaction's
//! physical connection. [`brz_mysql::RoutedMysqlTransaction`] is a borrowed
//! *view*: it carries a routing key for template expansion and executes on the
//! transaction it borrows, which owns exactly one `sqlx` connection. A route
//! cannot open a pool connection or start a second transaction, and the routing
//! policy's output is a SQL replacement (`{{tasks}}` -> `tasks_0509`), not a
//! connection or database selector, so a cross-database crossing is not
//! expressible through this API and needs no runtime rejection.
//!
//! On the create path the owner key and the task key of one request resolve to
//! the same shard by construction: the task id encodes the owner uid
//! (the recorded task `69_956_427_469_753` encodes uid 509, both resolve to
//! shard `0509`), so the pre-insert and post-insert statements stay on the one
//! transaction. The pooled impl is not carrying a Source transaction and may
//! pick a connection per route.

use async_trait::async_trait;
use brz_mysql::{
    FromMysqlRow, Mysql, MysqlExecution, MysqlResult, MysqlRow, MysqlService, MysqlTransaction,
    MysqlTransactionService,
};

use crate::sql_support::StatementArg;
use crate::task_routing::{ByTaskId, ByUserId};

/// One owned statement parameter list shared by both handle kinds.
///
/// `Vec<StatementArg>` is `MysqlArgs`, so the pooled and transactional
/// implementations bind exactly the same values.
pub type StatementArgs = Vec<StatementArg>;

/// The shard key one statement belongs to.
///
/// `User` routes an owner-scoped statement (the placeholder Task insert and the
/// source-group lookup); `Task` routes a statement that already knows its task
/// id (the Task refresh, the subtask reads/writes). `None` runs the statement
/// on the handle's own route, which is what the source's unsharded `kinds` /
/// `projects` reads need.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKey {
    None,
    User(i64),
    Task(u64),
}

impl RouteKey {
    /// The owner-scoped key, when this statement routes by user.
    pub fn user_key(self) -> Option<ByUserId> {
        match self {
            Self::User(user_id) => Some(ByUserId(user_id.unsigned_abs())),
            Self::None | Self::Task(_) => None,
        }
    }

    /// The task-scoped key, when this statement routes by task.
    pub fn task_key(self) -> Option<ByTaskId> {
        match self {
            Self::Task(task_id) => Some(ByTaskId(task_id)),
            Self::None | Self::User(_) => None,
        }
    }
}

/// A caller-owned SQL handle: the pooled service or an open transaction.
#[async_trait]
pub trait RequestSql: Send {
    /// `Mysql::execute` / `MysqlTransaction::execute` on this handle.
    async fn execute_statement(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<MysqlExecution>;

    /// The first row of `sql`, decoded by the caller.
    async fn fetch_optional_row(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// Every row of `sql`, decoded by the caller.
    async fn fetch_all_rows(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Vec<MysqlRow>>;
}

#[async_trait]
impl RequestSql for &MysqlService {
    async fn execute_statement(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<MysqlExecution> {
        match route {
            RouteKey::None => Mysql::execute(*self, sql, arguments).await,
            RouteKey::User(user_id) => {
                Mysql::execute(
                    &self.route(ByUserId(user_id.unsigned_abs())),
                    sql,
                    arguments,
                )
                .await
            }
            RouteKey::Task(task_id) => {
                Mysql::execute(&self.route(ByTaskId(task_id)), sql, arguments).await
            }
        }
    }

    async fn fetch_optional_row(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Option<MysqlRow>> {
        match route {
            RouteKey::None => Mysql::fetch_optional(*self, sql, arguments).await,
            RouteKey::User(user_id) => {
                Mysql::fetch_optional(
                    &self.route(ByUserId(user_id.unsigned_abs())),
                    sql,
                    arguments,
                )
                .await
            }
            RouteKey::Task(task_id) => {
                Mysql::fetch_optional(&self.route(ByTaskId(task_id)), sql, arguments).await
            }
        }
    }

    async fn fetch_all_rows(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Vec<MysqlRow>> {
        match route {
            RouteKey::None => Mysql::fetch_all(*self, sql, arguments).await,
            RouteKey::User(user_id) => {
                Mysql::fetch_all(
                    &self.route(ByUserId(user_id.unsigned_abs())),
                    sql,
                    arguments,
                )
                .await
            }
            RouteKey::Task(task_id) => {
                Mysql::fetch_all(&self.route(ByTaskId(task_id)), sql, arguments).await
            }
        }
    }
}

#[async_trait]
impl RequestSql for &mut MysqlTransactionService {
    async fn execute_statement(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<MysqlExecution> {
        let mut routed = route_transaction(self, route);
        match routed.as_mut() {
            Some(transaction) => MysqlTransaction::execute(transaction, sql, arguments).await,
            None => MysqlTransaction::execute(*self, sql, arguments).await,
        }
    }

    async fn fetch_optional_row(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Option<MysqlRow>> {
        let mut routed = route_transaction(self, route);
        match routed.as_mut() {
            Some(transaction) => {
                MysqlTransaction::fetch_optional(transaction, sql, arguments).await
            }
            None => MysqlTransaction::fetch_optional(*self, sql, arguments).await,
        }
    }

    async fn fetch_all_rows(
        &mut self,
        route: RouteKey,
        sql: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Vec<MysqlRow>> {
        let mut routed = route_transaction(self, route);
        match routed.as_mut() {
            Some(transaction) => MysqlTransaction::fetch_all(transaction, sql, arguments).await,
            None => MysqlTransaction::fetch_all(*self, sql, arguments).await,
        }
    }
}

/// The routed view of one transaction statement, or `None` when the statement
/// keeps the transaction's own route.
fn route_transaction<'a>(
    transaction: &'a mut MysqlTransactionService,
    route: RouteKey,
) -> Option<brz_mysql::RoutedMysqlTransaction<'a>> {
    match route {
        RouteKey::None => None,
        RouteKey::User(_) => Some(transaction.route(route.user_key()?)),
        RouteKey::Task(_) => Some(transaction.route(route.task_key()?)),
    }
}

/// One typed optional row on a caller-owned handle.
pub async fn fetch_optional_as<T: FromMysqlRow>(
    sql: &mut dyn RequestSql,
    route: RouteKey,
    statement: &str,
    arguments: StatementArgs,
) -> MysqlResult<Option<T>> {
    sql.fetch_optional_row(route, statement, arguments)
        .await?
        .map(T::from_mysql_row)
        .transpose()
}

/// Every typed row of `statement` on a caller-owned handle.
pub async fn fetch_all_as<T: FromMysqlRow>(
    sql: &mut dyn RequestSql,
    route: RouteKey,
    statement: &str,
    arguments: StatementArgs,
) -> MysqlResult<Vec<T>> {
    sql.fetch_all_rows(route, statement, arguments)
        .await?
        .into_iter()
        .map(T::from_mysql_row)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_route_binds_the_owner_key() {
        assert_eq!(RouteKey::User(509).user_key(), Some(ByUserId(509)));
        assert_eq!(RouteKey::User(509).task_key(), None);
    }

    #[test]
    fn task_route_binds_the_task_key() {
        let recorded_task = 69_956_427_469_753_u64;
        assert_eq!(
            RouteKey::Task(recorded_task).task_key(),
            Some(ByTaskId(recorded_task))
        );
        assert_eq!(RouteKey::Task(recorded_task).user_key(), None);
    }

    #[test]
    fn no_route_keeps_the_handle_route() {
        assert_eq!(RouteKey::None.user_key(), None);
        assert_eq!(RouteKey::None.task_key(), None);
    }

    #[test]
    fn negative_owner_ids_route_by_magnitude() {
        assert_eq!(RouteKey::User(-509).user_key(), Some(ByUserId(509)));
    }
}
