// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Statements for the task cancel flow (`task_kinds_service.cancel_task`).
//!
//! `_cancel_chat_shell_task` reads the caller's running assistant subtask,
//! writes its terminal state and commits, then updates the task in a separate
//! transaction. These builders stay beside the store so the physical table
//! choice (`subtasks_0078` on a sharded deployment) remains one decision.

use crate::task_store_statements::SUBTASK_COLUMNS;

/// `subtask_store.get_running_assistant_for_user`: the caller's running
/// assistant subtask of `task_id`, read from `table`.
///
/// The source query has no `ORDER BY`; `first()` therefore keeps the row
/// order the database returns, which this statement preserves by ending in a
/// bare `LIMIT 1`.
pub fn running_assistant_for_user_statement(table: &str) -> String {
    format!(
        "SELECT {SUBTASK_COLUMNS} \nFROM `{table}` \n\
         WHERE task_id = ? AND user_id = ? AND `role` = 'ASSISTANT' \
         AND status = 'RUNNING' \n LIMIT 1"
    )
}

/// `subtask_store.update_fields` for `_cancel_chat_shell_task`: the columns
/// SQLAlchemy flushes for `status=CANCELLED, progress=100, completed_at=now,
/// error_message=""`.
///
/// The ORM only emits dirty columns, so `reset_error_message` includes
/// `error_message` exactly when the stored value differs from the empty string
/// the caller writes. The `SET` order follows the source model's mapped-column
/// order (`error_message` precedes `updated_at`).
pub fn update_subtask_cancelled_statement(table: &str, reset_error_message: bool) -> String {
    let error_message = if reset_error_message {
        "error_message=?, "
    } else {
        ""
    };
    format!(
        "UPDATE {table} SET status=?, progress=?, {error_message}updated_at=?, \
         completed_at=? WHERE {table}.id = ?"
    )
}
