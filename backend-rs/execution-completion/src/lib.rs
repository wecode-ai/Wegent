// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Collect results and commit execution lifecycle changes before delivery.

#![forbid(unsafe_code)]

use std::borrow::Cow;

use brz_mysql::{Mysql, MysqlResult, MysqlTransaction};
use brz_redis::Redis;
use serde_json::Value;
use wegent_task_store::projection::task_column;
use wegent_task_store::task_store::TaskStore;

pub mod chat_metrics;
pub mod collect;
pub mod delivery;
pub mod lease_receipt;
pub mod metrics;
pub mod persist;
pub mod sql;
mod text_value;

use crate::delivery::Delivery;
use crate::lease_receipt::LeaseReceipt;
pub use crate::sql::Tables;

/// Storage capabilities needed for one committed execution transition.
pub struct CompletionStore<'a, M: Mysql, R: Redis> {
    pub mysql: &'a M,
    pub redis: &'a R,
    pub tables: Tables,
    pub task_store: Option<&'a dyn TaskStore>,
}

pub async fn resolve_tables(
    task_store: Option<&dyn TaskStore>,
    templates: Tables,
    task_id: i64,
) -> MysqlResult<(Cow<'static, str>, Cow<'static, str>)> {
    match task_store {
        Some(task_store) => {
            let tables = task_store.message_edit_tables(task_id).await?;
            Ok((Cow::Owned(tables.tasks), Cow::Owned(tables.subtasks)))
        }
        None => Ok((
            Cow::Borrowed(templates.tasks),
            Cow::Borrowed(templates.subtasks),
        )),
    }
}

/// Device binding observed by the heartbeat scan and rechecked under the writer lock.
pub struct DeviceAttempt<'a> {
    pub owner_id: i64,
    pub name: &'a str,
    pub namespace: &'a str,
}

/// `_get_task_status_user_id`: the owner of one active task, read before the
/// event is emitted so the Socket.IO status frame can address `user:{id}`.
pub async fn task_status_user_id<M: Mysql>(
    mysql: &M,
    task_table: &str,
    task_id: i64,
) -> Option<i64> {
    let sql = sql::active_task_statement_single_state(task_table);
    let row: brz_mysql::MysqlRow = mysql
        .route(wegent_backend_persistence::task_routing::ByTaskId(
            task_id as u64,
        ))
        .fetch_optional(sql, (task_id,))
        .await
        .ok()
        .flatten()?;
    task_column::<i64>(&row, "user_id")
}

pub struct StoredTerminal {
    pub status: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// Read the winning terminal result on the writer after a competing commit.
pub async fn read_terminal_result<M: Mysql>(
    mysql: &M,
    subtask_table: &str,
    task_id: i64,
    subtask_id: i64,
) -> MysqlResult<Option<StoredTerminal>> {
    let mysql = mysql.route(wegent_backend_persistence::task_routing::ByTaskId(
        task_id as u64,
    ));
    mysql.with_transaction(async |tx| {
        let row: Option<(String, Option<brz_mysql::Json<Value>>, Option<String>)> = tx
            .fetch_optional(
                format!("SELECT status, result, error_message FROM {subtask_table} WHERE id = ? AND task_id = ? AND status IN ('COMPLETED','FAILED','CANCELLED')"),
                (subtask_id, task_id),
            )
            .await?;
        Ok(row.map(|(status, result, error)| StoredTerminal {
            status,
            result: result.map(|json| json.0),
            error,
        }))
    }).await
}
