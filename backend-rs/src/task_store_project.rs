// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project-task link reads and writes shared by a deployment's `TaskStore`.
//!
//! `task_store.get_active_project_task` backs
//! `DELETE /api/projects/{project_id}/tasks/{task_id}`
//! (`app.services.project_service.remove_task_from_project`), and the matching
//! write clears the task's project link and rewrites its CRD JSON
//! (`task_store.update_fields(project_id = 0)` followed by `update_json`).
//!
//! The statements are table-parameterized so the single-table default store and
//! a sharded deployment render the same shape over their own physical table.
use brz_mysql::{Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;

/// `task_store.get_active_project_task`: the active task of `project_id` owned
/// by `owner_user_id`, optionally scoped to a client origin, read from `table`.
///
/// The predicate order mirrors the source's `db.query(model)` rendering (id,
/// project_id, kind, is_active, user_id, then the optional client origin).
pub fn active_project_task_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, \
         updated_at, project_id, client_origin, is_group_chat \nFROM {table} \n\
         WHERE id = ? AND project_id = ? AND kind = 'Task' AND is_active = 1 \
         AND user_id = ?"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" \n LIMIT 1");
    sql
}

/// `task_store.get_active_project_task` bound to its parameters.
pub async fn fetch_active_project_task<M: Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    project_id: i64,
    owner_user_id: i64,
    client_origin: Option<&str>,
) -> MysqlResult<Option<MysqlRow>> {
    let sql = active_project_task_statement(table, client_origin.is_some());
    match client_origin {
        Some(origin) => {
            mysql
                .fetch_optional(sql, (task_id, project_id, owner_user_id, origin))
                .await
        }
        None => {
            mysql
                .fetch_optional(sql, (task_id, project_id, owner_user_id))
                .await
        }
    }
}

/// `task_store.update_fields(project_id = 0)` then `task_store.update_json`:
/// the single flushed UPDATE that clears the project link and rewrites the
/// task's CRD JSON in `table`.
///
/// SQLAlchemy flushes the dirty columns in the mapper's column order
/// (`json`, `updated_at`, `project_id`), keyed by the primary key.
pub fn task_project_update_statement(table: &str) -> String {
    format!("UPDATE {table} \nSET json = ?, updated_at = ?, project_id = ? \nWHERE id = ?")
}

/// The project-link update bound to its parameters, followed by the source's
/// `db.commit()`. The SET order matches the statement's `json`, `updated_at`,
/// `project_id`.
pub async fn update_task_project_and_json<M: Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    project_id: i64,
    json: &str,
    updated_at: NaiveDateTime,
) -> MysqlResult<()> {
    mysql
        .execute(
            task_project_update_statement(table),
            (json, updated_at, project_id, task_id),
        )
        .await?;
    // `db.commit()`: the source commits the single flushed update.
    let _ = mysql.execute("COMMIT", ()).await;
    Ok(())
}
