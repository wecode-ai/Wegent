// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Statements for the execution callback's terminal task-completion flow.
//!
//! The task and subtask statements render the deployment's table templates
//! ([`crate::task_store::TableTemplates`]); the `kinds`, `background_executions`
//! and `wiki_generations` tables are not sharded, so those statements carry
//! literal table names.
use crate::task_store_listing::subtask_context_columns;
use crate::task_store_statements::{
    assistant_subtasks_by_task_statement, subtask_by_id_statement,
    update_subtask_running_statement, update_subtask_terminal_statement,
};

pub(crate) use crate::task_store_statements::{
    active_task_statement, owner_matches_task_id_statement, regular_active_task_statement,
    task_by_id_statement, update_task_json_statement,
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
pub(crate) use crate::task_store_statements::active_task_no_owner_statement as resolve_owner_statement;

/// `_get_task_status_user_id`'s read
/// (`app/api/endpoints/internal/callback.py:58-69` ->
/// `task_store.get_task_by_states(states=[TaskResource.STATE_ACTIVE])`): the
/// 12-column task projection for the single active state, with no owner filter.
///
/// This is deliberately not
/// [`crate::task_store_statements::active_task_no_owner_statement`]: that
/// statement carries the workspace-archive `is_active_query()` predicate
/// (`IN (1, 2)`, active *and* subscription), while the callback's owner read is
/// the single-state `IN (1)`.
pub(crate) fn active_task_statement_single_state(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \n    FROM `{table}` \n    \
        WHERE id = ? AND kind = 'Task' AND is_active IN (1) \n LIMIT 1"
    )
}

/// The physical table templates one completion flow renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Tables {
    pub(crate) tasks: &'static str,
    pub(crate) subtasks: &'static str,
}

/// One subtask row (`subtask_store.get_by_id`).
pub(crate) fn subtask_by_id(tables: Tables) -> String {
    subtask_by_id_statement(tables.subtasks)
}

/// `SubtaskStore.get_by_id`'s `subqueryload(Subtask.contexts)`.
pub(crate) fn contexts_by_subtask() -> String {
    format!(
        "SELECT {} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id IN (?) \n\
         ORDER BY subtask_contexts.id ASC",
        subtask_context_columns()
    )
}

/// `subtask_store.list_assistant_by_task`.
pub(crate) fn assistant_subtasks(tables: Tables) -> String {
    assistant_subtasks_by_task_statement(tables.subtasks)
}

/// `subtask_store.update_fields` flush for the RUNNING status transition
/// (`execution/dispatcher.py:_update_subtask_to_running`).
pub(crate) fn update_subtask_running(tables: Tables) -> String {
    update_subtask_running_statement(tables.subtasks)
}

/// `subtask_store.update_fields` flush for a terminal subtask update.
pub(crate) fn update_subtask_terminal(
    tables: Tables,
    with_error: bool,
    with_executor: bool,
) -> String {
    update_subtask_terminal_statement(tables.subtasks, with_error, with_executor)
}

/// `_get_team_from_task_ref` / `CollaborationStrategyFactory`: the Task CRD's
/// `teamRef` Team Kind, read directly from `kinds`.
pub(crate) fn team_by_owner() -> &'static str {
    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.user_id = ? AND kinds.kind = 'Team' AND kinds.namespace = ? \
     AND kinds.name = ? AND kinds.is_active IS true \n LIMIT 1"
}

/// `_get_pet_kind`: the user's Pet Kind.
pub(crate) fn pet_kind() -> &'static str {
    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.user_id = ? AND kinds.kind = 'Pet' AND kinds.name = 'my-pet' \
     AND kinds.namespace = 'default' AND kinds.is_active = true \n LIMIT 1"
}

/// `pet_service.add_chat_experience` / `_update_subscription_statistics`:
/// rewrite one Kind row's json and stamp `updated_at`.
pub(crate) fn update_kind_json() -> &'static str {
    "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?"
}

/// `create_pet`: insert a new Pet Kind row for a user.
pub(crate) fn insert_pet_kind() -> &'static str {
    "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active) \
     VALUES (?, ?, ?, ?, ?, ?)"
}

/// `add_chat_experience`'s `db.refresh(pet)`
/// (`app/services/pet/manager.py:659-660`) after the commit: the ORM
/// primary-key load, which renders the mapped columns unlabeled.
pub(crate) fn kind_refresh_by_id() -> &'static str {
    "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
     kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \n\
     FROM kinds WHERE kinds.id = ?"
}

/// `subtask_store.list_not_executor_deleted_by_task`: the full subtask
/// projection of one task whose executor runtime is still recorded as alive.
pub(crate) fn subtasks_not_executor_deleted_by_task(tables: Tables) -> String {
    let table = tables.subtasks;
    format!(
        "SELECT {} \nFROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.executor_deleted_at = false",
        crate::task_store_statements::subtask_projection(table)
    )
}

/// `subtask_store.update_fields(subtask, executor_deleted_at=True)`'s flush:
/// the mapper orders `executor_deleted_at` before the `updated_at` audit clock.
pub(crate) fn update_subtask_executor_deleted(tables: Tables) -> String {
    let table = tables.subtasks;
    format!("UPDATE {table} SET executor_deleted_at=?, updated_at=? WHERE {table}.id = ?")
}

/// The `wiki_generations` column projection `db.query(WikiGeneration)` renders,
/// in the model's mapped order.
pub(crate) const WIKI_GENERATION_COLUMNS: &str = "wiki_generations.id AS wiki_generations_id, \
     wiki_generations.project_id AS wiki_generations_project_id, \
     wiki_generations.kind_id AS wiki_generations_kind_id, \
     wiki_generations.user_id AS wiki_generations_user_id, \
     wiki_generations.task_id AS wiki_generations_task_id, \
     wiki_generations.team_id AS wiki_generations_team_id, \
     wiki_generations.generation_type AS wiki_generations_generation_type, \
     wiki_generations.source_snapshot AS wiki_generations_source_snapshot, \
     wiki_generations.status AS wiki_generations_status, \
     wiki_generations.ext AS wiki_generations_ext, \
     wiki_generations.created_at AS wiki_generations_created_at, \
     wiki_generations.updated_at AS wiki_generations_updated_at, \
     wiki_generations.completed_at AS wiki_generations_completed_at";

/// `recover_scheduled_execution_for_task`'s latest-generation read.
pub(crate) fn wiki_generation_latest() -> String {
    format!(
        "SELECT {WIKI_GENERATION_COLUMNS} \nFROM wiki_generations \n\
         WHERE wiki_generations.task_id = ? \n\
         ORDER BY wiki_generations.id DESC \n LIMIT 1"
    )
}

/// `conclude_code_wiki_run`'s running-generation read.
pub(crate) fn wiki_generation_running() -> String {
    format!(
        "SELECT {WIKI_GENERATION_COLUMNS} \nFROM wiki_generations \n\
         WHERE wiki_generations.task_id = ? AND wiki_generations.status = 'RUNNING' \n LIMIT 1"
    )
}
