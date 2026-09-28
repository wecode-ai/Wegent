// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Capture repository queries at the Mysql boundary without a database.
use std::sync::{Arc, Mutex};

use brz_mysql::{
    FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
    MysqlService, MysqlTransactionService,
};

use crate::task_routing::{ByTaskId, ByUserId};

#[derive(Clone, Debug, PartialEq)]
pub enum Route {
    Task(u64),
    User(u64),
}

#[derive(Clone, Debug)]
pub struct Query {
    pub sql: String,
    pub args: usize,
    pub first_integer: Option<i64>,
    pub route: Route,
}

#[derive(Clone, Default)]
pub struct QueryCapture {
    queries: Arc<Mutex<Vec<Query>>>,
    route: Option<Route>,
}

impl QueryCapture {
    pub fn queries(&self) -> Vec<Query> {
        self.queries.lock().unwrap().clone()
    }

    fn capture(&self, sql: &str, args: impl MysqlArgs) {
        assert_routed_sql(sql, args.len());
        self.queries.lock().unwrap().push(Query {
            sql: sql.split_whitespace().collect::<Vec<_>>().join(" "),
            args: args.len(),
            first_integer: args
                .first_route_value()
                .and_then(|value| value.as_i64().ok()),
            route: self.route.clone().expect("query must bind a routing key"),
        });
    }
}

pub fn assert_routed_sql(sql: &str, args: usize) {
    assert!(
        sql.contains("{{tasks}}") || sql.contains("{{subtasks}}"),
        "{sql}"
    );
    let remainder = sql.replace("{{tasks}}", "").replace("{{subtasks}}", "");
    assert!(!remainder.contains(['{', '}']), "unexpanded SQL: {sql}");
    assert_eq!(sql.matches('?').count(), args, "parameter count: {sql}");
}

/// Capture queries that carry no routing key (plain shared-table reads like
/// the `kinds` lookup). Records the SQL, parameter count, and the first
/// parameter's route value so tests can assert integer-vs-string binding.
#[derive(Clone, Default)]
pub struct KindQueryCapture {
    queries: std::sync::Arc<std::sync::Mutex<Vec<Query>>>,
}

impl KindQueryCapture {
    pub fn queries(&self) -> Vec<Query> {
        self.queries.lock().unwrap().clone()
    }

    fn capture(&self, sql: &str, args: impl MysqlArgs) {
        self.queries.lock().unwrap().push(Query {
            sql: sql.split_whitespace().collect::<Vec<_>>().join(" "),
            args: args.len(),
            first_integer: args
                .first_route_value()
                .and_then(|value| value.as_i64().ok()),
            route: Route::User(0),
        });
    }
}

impl Mysql for KindQueryCapture {
    type Transaction = MysqlTransactionService;

    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        panic!("plain queries must reuse the configured service")
    }

    fn route<K: MysqlRouteKey>(&self, _key: K) -> Self {
        panic!("kinds lookups carry no routing key")
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.capture(sql.as_ref(), args);
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.capture(sql.as_ref(), args);
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!("unexpected write")
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
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
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }

    async fn with_transaction<T, F>(&self, _: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        panic!("unexpected transaction")
    }
}

impl Mysql for QueryCapture {
    type Transaction = MysqlTransactionService;

    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        panic!("repositories must reuse the configured service")
    }

    fn route<K: MysqlRouteKey>(&self, key: K) -> Self {
        let key = &key as &dyn MysqlRouteKey;
        let route = if let Some(key) = key.downcast_ref::<ByTaskId>() {
            Route::Task(key.0)
        } else if let Some(key) = key.downcast_ref::<ByUserId>() {
            Route::User(key.0)
        } else {
            panic!("unexpected routing key")
        };
        Self {
            route: Some(route),
            ..self.clone()
        }
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.capture(sql.as_ref(), args);
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.capture(sql.as_ref(), args);
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!("unexpected write")
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
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
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }

    async fn with_transaction<T, F>(&self, _: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        panic!("unexpected transaction")
    }
}
