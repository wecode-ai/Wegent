// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Borrowed plugin queries on a pool or an existing writer transaction.
use brz_mysql::{FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};

/// Share catalog SQL without changing the caller's pool or transaction ownership.
pub(crate) trait PluginQuery: Send {
    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send;

    async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send;

    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send;
}

impl<M: Mysql> PluginQuery for &M {
    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Mysql::fetch_all(*self, sql, args).await
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Mysql::fetch_optional(*self, sql, args).await
    }

    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        Mysql::execute(*self, sql, args).await
    }
}

impl<Tx: MysqlTransaction> PluginQuery for &mut Tx {
    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        MysqlTransaction::fetch_all(*self, sql, args).await
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        MysqlTransaction::fetch_optional(*self, sql, args).await
    }

    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        MysqlTransaction::execute(*self, sql, args).await
    }
}
