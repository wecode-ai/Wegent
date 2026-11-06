// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The single-table [`DefaultTaskStore`]: every statement reads the base
//! `tasks` / `subtasks` tables on the handle it was built with. Extracted from
//! `task_store.rs` so that module stays within the source file-length limit.
use brz_mysql::Mysql;

/// The single-table store: every statement reads the base `tasks` /
/// `subtasks` tables on the handle it was built with.
pub struct DefaultTaskStore<M: Mysql> {
    pub(crate) mysql: M,
}

impl<M: Mysql> DefaultTaskStore<M> {
    pub fn new(mysql: M) -> Self {
        Self { mysql }
    }
}
