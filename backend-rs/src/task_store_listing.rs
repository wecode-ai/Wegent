// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subtask-listing read model shared by the task store.
//!
//! The `subtask_contexts` labeling projection and the two listing result types
//! the [`crate::task_store::TaskStore`] methods return. Extracted from
//! `crate::task_store` to keep that module within the repository's file-size
//! bound; `task_store` re-exports these items.

use brz_mysql::MysqlRow;

/// The `subtask_contexts` labeling projection the context reads share
/// (`context_columns`): every column labelled with its own table name, in the
/// recorded order.
pub fn subtask_context_columns() -> String {
    [
        "id",
        "subtask_id",
        "user_id",
        "context_type",
        "name",
        "status",
        "error_message",
        "binary_data",
        "image_base64",
        "extracted_text",
        "text_length",
        "type_data",
        "created_at",
        "updated_at",
    ]
    .iter()
    .map(|column| format!("subtask_contexts.{column} AS subtask_contexts_{column}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// One subtask listing from `subtask_store.list_by_task_ordered`.
///
/// The source attaches the subtask contexts to a listing whose rows came from
/// a table the deployment resolved itself, so `contexts` carries that batch
/// there and is `None` on the path where the source leaves the contexts to be
/// loaded later. A caller that only reads the rows ignores it.
#[derive(Debug)]
pub struct SubtaskListing {
    pub rows: Vec<MysqlRow>,
    pub contexts: Option<Vec<MysqlRow>>,
}

/// One `task_store.list_owned_task_ids` page: the source total and the page's
/// task ids in the store's own order.
#[derive(Debug)]
pub struct OwnedTaskPage {
    pub total: i64,
    pub ids: Vec<i64>,
}
