// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Statements owned by the completion event handlers.

pub(crate) use wegent_execution_completion::sql::*;

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
    "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())"
}

/// `add_chat_experience`'s `db.refresh(pet)`
/// (`app/services/pet/manager.py:659-660`) after the commit: the ORM
/// primary-key load, which renders the mapped columns unlabeled.
pub(crate) fn kind_refresh_by_id() -> &'static str {
    "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
     kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \n\
     FROM kinds WHERE kinds.id = ?"
}

/// Cleanup needs only executor references, read in bounded keyset pages.
pub(crate) fn subtasks_not_executor_deleted_by_task(tables: Tables) -> String {
    let table = tables.subtasks;
    format!(
        "SELECT id, executor_name, executor_namespace FROM {table} \
         WHERE {table}.task_id = ? AND {table}.executor_deleted_at = false \
         AND id > ? ORDER BY id LIMIT 100"
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
