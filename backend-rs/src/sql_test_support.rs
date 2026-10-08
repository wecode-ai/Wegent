// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Capture repository queries at the Mysql boundary without a database.
use brz_mysql::{
    FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
    MysqlService, MysqlTransactionService,
};

/// One captured statement: the SQL, its parameter count, and the first
/// parameter's integer value, so tests can assert integer-vs-string binding.
#[derive(Clone, Debug)]
pub struct Query {
    pub sql: String,
    pub args: usize,
    pub first_integer: Option<i64>,
}

/// Capture queries that carry no routing key (plain shared-table reads like
/// the `kinds` lookup). Records the SQL, parameter count, and the first
/// parameter's route value so tests can assert integer-vs-string binding.
#[derive(Clone, Default)]
pub struct KindQueryCapture {
    queries: std::sync::Arc<std::sync::Mutex<Vec<Query>>>,
    writes: std::sync::Arc<std::sync::Mutex<Vec<Query>>>,
    /// Whether `execute` records the write instead of rejecting it.
    allow_writes: bool,
}

impl KindQueryCapture {
    /// Capture `execute` writes instead of rejecting them. The default capture
    /// still panics on an unexpected write so a read-only test cannot silently
    /// accept one.
    pub fn writing() -> Self {
        Self {
            allow_writes: true,
            ..Self::default()
        }
    }

    pub fn queries(&self) -> Vec<Query> {
        self.queries.lock().unwrap().clone()
    }

    /// The captured `execute` writes, in call order.
    pub fn writes(&self) -> Vec<Query> {
        self.writes.lock().unwrap().clone()
    }

    fn capture(&self, sql: &str, args: impl MysqlArgs) -> Query {
        Query {
            sql: normalize_sql(sql),
            args: args.len(),
            first_integer: args
                .first_route_value()
                .and_then(|value| value.as_i64().ok()),
        }
    }
}

/// Collapse SQL whitespace so captured statements compare independent of the
/// exact rendering line breaks.
fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
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
        self.queries
            .lock()
            .unwrap()
            .push(self.capture(sql.as_ref(), args));
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.queries
            .lock()
            .unwrap()
            .push(self.capture(sql.as_ref(), args));
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        if !self.allow_writes {
            panic!("unexpected write");
        }
        self.writes
            .lock()
            .unwrap()
            .push(self.capture(sql.as_ref(), args));
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
