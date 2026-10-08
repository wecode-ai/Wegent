// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project-scoped `TaskStore` statements.
//!
//! The per-project task list read (`list_active_project_tasks`) and the
//! project detachment write (`clear_project_for_owned_tasks`) share the
//! `project_id` / `user_id` / optional `client_origin` predicate. Extracted
//! from [`crate::task_store`] to keep that module within the repository's
//! file-size bound; `task_store` re-exports these builders.

/// `SqlAlchemyTaskStore.list_active_project_tasks`: the active project tasks
/// owned by `owner_user_id`, newest `updated_at` first, read from `table`.
///
/// The recorded rendering qualifies every column with the table name and binds
/// the project id and owner as integers; the optional origin binds as a string.
pub fn project_tasks_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {table}
         WHERE project_id = ? AND kind = 'Task' AND is_active = 1 AND user_id = ?"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" ORDER BY updated_at DESC");
    sql
}

/// `SqlAlchemyTaskStore.clear_project_for_owned_tasks` under
/// `synchronize_session="fetch"`: the ORM reads the matching primary keys
/// before its bulk update. `table` is the rendered physical `tasks` table and
/// the optional origin binds as a string.
pub fn clear_project_ids_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT {table}.id \nFROM {table} \n\
         WHERE {table}.project_id = ? AND {table}.user_id = ?"
    );
    if client_origin {
        sql.push_str(&format!(" AND {table}.client_origin = ?"));
    }
    sql
}

/// `SqlAlchemyTaskStore.clear_project_for_owned_tasks`: the bulk update that
/// detaches one project's owned tasks by setting `project_id = 0`. The
/// `updated_at` column's Python-side `onupdate` renders first, before the
/// assignment; the optional origin binds as a string.
pub fn clear_project_update_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "UPDATE {table} SET updated_at = ?, project_id=0 \n\
         WHERE {table}.project_id = ? AND {table}.user_id = ?"
    );
    if client_origin {
        sql.push_str(&format!(" AND {table}.client_origin = ?"));
    }
    sql
}

/// `TaskResource.updated_at`'s Python-side `onupdate=datetime.now` value: the
/// local microsecond timestamp the flush binds.
pub fn task_update_timestamp() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}
