// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The physical table templates a deployment renders for `tasks` and
//! `subtasks`.
//!
//! Most callers read task and subtask rows through the statements
//! [`crate::task_store_statements`] renders, leaving the store to pick the
//! table. The execution callback's terminal completion also *writes* task and
//! subtask rows and needs the same table choice, so the store exposes the
//! deployment's templates instead of a second routing path existing beside it.
//!
//! The open-source default reads the base `tasks` / `subtasks` tables. A
//! deployment whose task storage is sharded returns its `{{tasks}}` /
//! `{{subtasks}}` templates instead; the handle that renders them carries the
//! deployment's brz-mysql routing policy, and each statement binds its routing
//! key explicitly.
use crate::task_store_statements::{SUBTASKS_TABLE, TASKS_TABLE};

/// The physical table templates for `tasks` and `subtasks`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TableTemplates {
    /// The template the `tasks` statements render, e.g. `tasks` or
    /// `{{tasks}}`.
    pub tasks: &'static str,
    /// The template the `subtasks` statements render.
    pub subtasks: &'static str,
}

/// One `subtasks` row as `socketio`'s streaming-status checks read it.
///
/// The statements project the full ORM column list, so every column is labeled
/// with its physical table prefix (`subtasks_…` or `subtasks_00NN_…`); the
/// decode resolves each field by that suffix.
/// One `subtasks` row as `socketio`'s streaming-status checks read it.
///
/// The statements project the full ORM column list, so every column is labeled
/// with its physical table prefix (`subtasks_…` or `subtasks_00NN_…`); the
/// decode resolves each field by that suffix. `executor_name` is carried for
/// `chat:cancel`'s device routing, which shares this full-row lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingSubtask {
    pub id: i64,
    pub task_id: i64,
    pub status: String,
    pub executor_name: Option<String>,
    pub created_at: Option<chrono::NaiveDateTime>,
}

impl StreamingSubtask {
    /// Decode the streaming fields from a projected subtask row.
    pub fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            id: field(row, "id")?,
            task_id: field(row, "task_id")?,
            status: field(row, "status")?,
            executor_name: optional_field(row, "executor_name")?,
            created_at: field(row, "created_at")?,
        })
    }
}

/// Resolve an optional `column` in a projection labeled
/// `<physical_table>_<column>`; a missing label or NULL value is `None`.
fn optional_field<T: brz_mysql::FromMysqlValue>(
    row: &brz_mysql::MysqlRow,
    column: &str,
) -> brz_mysql::MysqlResult<Option<T>> {
    let suffix = format!("_{column}");
    let Some(label) = row.columns().find(|name| name.ends_with(&suffix)) else {
        return Ok(None);
    };
    row.get::<T>(label)
}

/// Resolve `column` in a projection labeled `<physical_table>_<column>`.
fn field<T: brz_mysql::FromMysqlValue>(
    row: &brz_mysql::MysqlRow,
    column: &str,
) -> brz_mysql::MysqlResult<T> {
    let suffix = format!("_{column}");
    let label = row
        .columns()
        .find(|name| name.ends_with(&suffix))
        .ok_or_else(|| brz_mysql::MysqlError::ColumnNotFound(column.to_owned()))?;
    row.get::<T>(label)?
        .ok_or_else(|| brz_mysql::MysqlError::UnexpectedNull {
            column: column.to_owned(),
        })
}

/// The base-table templates of the open-source default store.
pub fn default_table_templates() -> TableTemplates {
    TableTemplates {
        tasks: TASKS_TABLE,
        subtasks: SUBTASKS_TABLE,
    }
}
