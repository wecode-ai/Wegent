// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Caller-owned row reads for entity resolvers.
//!
//! The source resolver methods receive the caller's session
//! (`ErpEntityResolver.get_resource_ids_by_entity(db, ...)`), so their profile
//! lookups join the caller's transaction. The trait is object-safe because the
//! registry keeps `Arc<dyn EntityResolver>`, and the generic `fetch_optional`
//! call stays inside the implementation instead of crossing the trait.

use brz_mysql::{Mysql, MysqlResult, MysqlRow, MysqlTransaction, MysqlTransactionService};

/// One `user_id`-scoped row read on whichever handle the caller owns.
#[async_trait::async_trait]
pub trait EntityQuery: Send {
    /// `db.query(Model).filter(Model.user_id == user_id).first()`.
    async fn fetch_optional_row(
        &mut self,
        sql: &str,
        user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>>;
}

/// The shared pool handle used by the HTTP-driven callers.
#[async_trait::async_trait]
impl<M: Mysql> EntityQuery for &M {
    async fn fetch_optional_row(
        &mut self,
        sql: &str,
        user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        Mysql::fetch_optional(*self, sql, (user_id,)).await
    }
}

/// An open writer transaction: the resolver read joins the caller's statement
/// group instead of taking another pooled connection.
///
/// The concrete transaction type is named because the generic
/// `MysqlTransaction` trait method cannot promise a `Send` future.
#[async_trait::async_trait]
impl EntityQuery for &mut MysqlTransactionService {
    async fn fetch_optional_row(
        &mut self,
        sql: &str,
        user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        MysqlTransaction::fetch_optional(*self, sql, (user_id,)).await
    }
}
