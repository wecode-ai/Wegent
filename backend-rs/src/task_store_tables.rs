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

/// The base-table templates of the open-source default store.
pub fn default_table_templates() -> TableTemplates {
    TableTemplates {
        tasks: TASKS_TABLE,
        subtasks: SUBTASKS_TABLE,
    }
}
