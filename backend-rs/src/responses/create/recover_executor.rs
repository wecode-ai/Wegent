// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `ExecutionDispatcher._recover_executor_if_needed`
//! (`app/services/execution/dispatcher.py:238-333`).
//!
//! The dispatcher runs this before every execution mode (`:117`), ahead of the
//! RUNNING transition at `:166`. For coding shells it re-reads the assistant
//! subtask, with its eager-loaded contexts, to decide whether a deleted
//! executor needs workspace recovery. The read is observable even when the
//! early return skips recovery: the recorded create flow issues
//! `SELECT ... FROM subtasks_0711 WHERE subtasks_0711.id = ? LIMIT 1` and the
//! `subtask_contexts ... WHERE subtask_id IN (?) ORDER BY id ASC` load before
//! the RUNNING read/update pair.
//!
//! Documented gap: `recovery_service.recover` itself is not reproduced. Every
//! recorded create case inserts a fresh subtask (`executor_deleted_at = 0`)
//! without a fork workspace archive, so the source takes the early return; the
//! recovery branch is reported but not executed.
use brz_mysql::{Mysql, MysqlResult, MysqlRow};
use serde_json::Value;

use crate::chat_repository::contexts_by_subtask_ids_statement;
use crate::state::AppState;
use crate::task_routing::ByTaskId;
use crate::task_store::TableTemplates;
use crate::task_store_statements::{subtask_by_id_statement, subtask_column_index};

use super::dispatch::ExecutionRequest;
use super::streaming::request_shell_type;

/// `_recover_executor_if_needed`'s shell gate:
/// `shell_type in {"ClaudeCode", "Agno", "CodeX", "Codex"}`.
pub(crate) fn shell_supports_recovery(shell_type: &str) -> bool {
    matches!(shell_type, "ClaudeCode" | "Agno" | "CodeX" | "Codex")
}

/// `_has_fork_workspace_archive`: a non-blank `workspaceArchive.storageKey` in
/// the request's fork runtime.
pub(crate) fn has_fork_workspace_archive(fork_runtime: Option<&Value>) -> bool {
    fork_runtime
        .and_then(|runtime| runtime.get("workspaceArchive"))
        .and_then(Value::as_object)
        .and_then(|archive| archive.get("storageKey"))
        .and_then(Value::as_str)
        .is_some_and(|storage_key| !storage_key.trim().is_empty())
}

/// What the recovery decision reads from `subtask_store.get_by_id`.
pub(crate) struct RecoverySubtask {
    pub(crate) executor_deleted: bool,
    pub(crate) task_id: i64,
}

/// `subtask_store.get_by_id` with the ORM's eager `Subtask.contexts` load
/// (`_attach_contexts`), read from the subtask's shard table.
///
/// The read is the same statement the RUNNING transition issues later; the
/// source performs it twice (recovery decision, then the status update).
pub(crate) async fn read_subtask_with_contexts<M: Mysql>(
    mysql: &M,
    templates: TableTemplates,
    subtask_id: i64,
) -> MysqlResult<Option<RecoverySubtask>> {
    let routed = mysql.route(ByTaskId(subtask_id as u64));
    let row: Option<MysqlRow> = routed
        .fetch_optional(subtask_by_id_statement(templates.subtasks), (subtask_id,))
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    // `_attach_contexts`: every context of the subtask in ascending id order.
    routed
        .fetch_all::<_, _, MysqlRow>(contexts_by_subtask_ids_statement(1), vec![subtask_id])
        .await?;
    let column = |name: &str| {
        subtask_column_index(name).and_then(|index| row.get_at::<Option<i64>>(index).ok().flatten())
    };
    Ok(Some(RecoverySubtask {
        executor_deleted: column("executor_deleted_at").is_some_and(|value| value != 0),
        task_id: column("task_id").unwrap_or(0),
    }))
}

/// `_recover_executor_if_needed`: the observable read and the early returns.
///
/// The source runs this as part of the dispatch, so a store failure is logged
/// by the caller and never changes the create response. The workspace recovery
/// branch itself is not reproduced (see the module note).
pub(crate) async fn recover_executor_if_needed(state: &AppState, request: &ExecutionRequest) {
    if !shell_supports_recovery(&request_shell_type(request)) {
        return;
    }
    // The create path dispatches without a device, so the source's
    // `if device_id and has_fork_workspace_archive(request)` guard cannot fire.
    let restore_fork_workspace = has_fork_workspace_archive(request.fork_runtime.as_ref());
    let subtask = match read_subtask_with_contexts(
        &state.mysql,
        state.task_store.table_templates(),
        request.subtask_id,
    )
    .await
    {
        Ok(subtask) => subtask,
        Err(error) => {
            tracing::warn!(%error, "executor recovery read failed");
            return;
        }
    };
    // `if not subtask: return`, then `if not subtask.executor_deleted_at and not
    // restore_fork_workspace: return` — the recorded create path always takes
    // this branch, after issuing the read and contexts load.
    let Some(subtask) = subtask else {
        return;
    };
    if !subtask.executor_deleted && !restore_fork_workspace {
        return;
    }
    tracing::warn!(
        task_id = subtask.task_id,
        subtask_id = request.subtask_id,
        "executor workspace recovery is not reproduced"
    );
}

#[cfg(test)]
#[path = "recover_executor_tests.rs"]
mod tests;
