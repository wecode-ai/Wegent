// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The single-table [`DefaultTaskStore`]: every statement reads the base
//! `tasks` / `subtasks` tables on the handle it was built with. Extracted from
//! `task_store.rs` so that module stays within the source file-length limit.
use brz_mysql::Mysql;

#[cfg(feature = "test-support")]
use crate::task_store_tables::TableTemplates;

/// The single-table store: every statement reads the base `tasks` /
/// `subtasks` tables on the handle it was built with.
pub struct DefaultTaskStore<M: Mysql> {
    pub(crate) mysql: M,
    #[cfg(feature = "test-support")]
    pub(crate) migrated_tables: Option<TableTemplates>,
}

impl<M: Mysql> DefaultTaskStore<M> {
    pub fn new(mysql: M) -> Self {
        Self {
            mysql,
            #[cfg(feature = "test-support")]
            migrated_tables: None,
        }
    }

    /// Configure a migrated task's physical tables while keeping the base templates.
    #[cfg(feature = "test-support")]
    pub fn with_migrated_tables(mut self, tables: TableTemplates) -> Self {
        self.migrated_tables = Some(tables);
        self
    }
}
