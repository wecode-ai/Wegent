// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The message-content subtask update: one dirty content column plus
//! `updated_at`, flushed and committed (`subtask_store.update_fields` followed
//! by `db.commit()`).
//!
//! Extracted from [`crate::task_store`] to keep that module within the
//! repository's file-size bound; `task_store` re-exports these items.
use brz_mysql::{Mysql, MysqlResult};

use crate::task_store_statements::subtask_content_update_statement;

/// The one subtask content column a message update writes and its new value
/// (`_build_subtask_content_fields`). A USER message updates `prompt`; any
/// other role updates the `result` JSON text. The variant carries the already
/// rendered value so the store owns only the statement, not the business
/// serialization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubtaskContentField {
    /// `Subtask.prompt` (USER role). Present only when the new prompt differs
    /// from the loaded one, matching SQLAlchemy's attribute history.
    Prompt(String),
    /// `Subtask.result` (any non-USER role). `flag_modified` always writes it.
    Result(String),
}

impl SubtaskContentField {
    /// The literal SQL column name the flush renders.
    pub fn column(&self) -> &'static str {
        match self {
            Self::Prompt(_) => "prompt",
            Self::Result(_) => "result",
        }
    }

    /// The column's value.
    pub fn value(&self) -> &str {
        match self {
            Self::Prompt(value) | Self::Result(value) => value,
        }
    }
}

/// `subtask_store.update_fields` then `db.commit()`: run the message-content
/// UPDATE with its optional content column, then commit. Shared by the single
/// table and sharded stores so both render the same statement and parameter
/// order.
pub async fn execute_subtask_content_update<M: Mysql>(
    mysql: &M,
    table: &str,
    subtask_id: i64,
    field: Option<&SubtaskContentField>,
    updated_at: &str,
) -> MysqlResult<()> {
    let sql = subtask_content_update_statement(table, field.map(SubtaskContentField::column));
    match field {
        Some(field) => mysql
            .execute(sql, (field.value(), updated_at, subtask_id))
            .await
            .map(|_| ()),
        None => mysql
            .execute(sql, (updated_at, subtask_id))
            .await
            .map(|_| ()),
    }?;
    // `db.commit()`: the source commits the single flushed update.
    mysql.execute("COMMIT", ()).await.map(|_| ())
}
