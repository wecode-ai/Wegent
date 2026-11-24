// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Statements for the execution callback's terminal task-completion flow.
//!
//! The task and subtask statements render the deployment's table templates
//! ([`wegent_task_store::task_store::TableTemplates`]); the `kinds`, `background_executions`
//! and `wiki_generations` tables are not sharded, so those statements carry
//! literal table names.
use wegent_task_store::task_store_listing::subtask_context_columns;
use wegent_task_store::task_store_statements::{
    subtask_by_id_statement, update_subtask_running_statement, update_subtask_terminal_statement,
};

pub use wegent_task_store::task_store_statements::{
    active_task_projection_statement, owner_matches_task_id_statement,
    regular_active_task_statement, update_task_json_statement,
};

/// `StatusUpdatingEmitter._resolve_owner_user_id`
/// (`app/services/execution/emitters/status_updating.py:125-136`) ->
/// `task_store.get_task_by_states(states=TaskResource.is_active_query())`: the
/// two-state (`is_active IN (1, 2)`) no-owner read the workspace archive also
/// issues, so it reuses that statement.
///
/// The event's owner is a *different* read from
/// [`active_task_statement_single_state`]: the handler reads the single active
/// state before emitting, the emitter resolves the two-state owner before
/// publishing `TaskCompletedEvent`.
pub use wegent_task_store::task_store_statements::active_task_no_owner_statement as resolve_owner_statement;

/// `_get_task_status_user_id`'s read
/// (`app/api/endpoints/internal/callback.py:58-69` ->
/// `task_store.get_task_by_states(states=[TaskResource.STATE_ACTIVE])`): the
/// 12-column task projection for the single active state, with no owner filter.
///
/// This is deliberately not
/// [`wegent_task_store::task_store_statements::active_task_no_owner_statement`]: that
/// statement carries the workspace-archive `is_active_query()` predicate
/// (`IN (1, 2)`, active *and* subscription), while the callback's owner read is
/// the single-state `IN (1)`.
pub fn active_task_statement_single_state(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \n    FROM `{table}` \n    \
        WHERE id = ? AND kind = 'Task' AND is_active IN (1) \n LIMIT 1"
    )
}

/// The physical table templates one completion flow renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tables {
    pub tasks: &'static str,
    pub subtasks: &'static str,
}

pub fn is_active_task(task: &brz_mysql::MysqlRow) -> bool {
    super::task_column::<i64>(task, "is_active").is_some_and(|state| matches!(state, 1 | 2))
        && super::task_column::<String>(task, "kind").as_deref() == Some("Task")
}

pub use wegent_task_store::dispatchable_task_status;

pub async fn latest_assistant_id(
    tx: &mut impl brz_mysql::MysqlTransaction,
    table: &str,
    task_id: i64,
) -> brz_mysql::MysqlResult<Option<i64>> {
    tx.fetch_optional(
        format!(
            "SELECT id FROM {table} WHERE task_id = ? AND role = 'ASSISTANT' \
                 ORDER BY message_id DESC, id DESC LIMIT 1"
        ),
        (task_id,),
    )
    .await
}

/// One subtask row (`subtask_store.get_by_id`).
pub fn subtask_by_id(tables: Tables) -> String {
    subtask_by_id_statement(tables.subtasks)
}

/// `SubtaskStore.get_by_id`'s `subqueryload(Subtask.contexts)`.
pub fn contexts_by_subtask() -> String {
    format!(
        "SELECT {} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id IN (?) \n\
         ORDER BY subtask_contexts.id ASC",
        subtask_context_columns()
    )
}

/// `subtask_store.update_fields` flush for the RUNNING status transition
/// (`execution/dispatcher.py:_update_subtask_to_running`).
pub fn update_subtask_running(tables: Tables) -> String {
    update_subtask_running_statement(tables.subtasks)
}

/// `subtask_store.update_fields` flush for a terminal subtask update.
///
/// `with_result` follows the source's `if result is not None` guard
/// (`db.py:136`): a terminal error that carries no collected result writes no
/// `result` column and leaves the stored value untouched.
pub fn update_subtask_terminal(
    subtask_table: &str,
    with_result: bool,
    with_error: bool,
    with_executor: bool,
) -> String {
    update_subtask_terminal_statement(subtask_table, with_result, with_error, with_executor)
}

/// `_get_team_from_task_ref` / `CollaborationStrategyFactory`: the Task CRD's
/// `teamRef` Team Kind, read directly from `kinds`.
pub fn team_by_owner() -> &'static str {
    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.user_id = ? AND kinds.kind = 'Team' AND kinds.namespace = ? \
     AND kinds.name = ? AND kinds.is_active IS true \n LIMIT 1"
}
