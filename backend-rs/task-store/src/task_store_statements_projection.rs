// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Labeled task/subtask projection statements.

use super::SUBTASK_MAPPED_COLUMNS;

/// The `tasks` columns in the ORM mapper's order (`TaskResource.__table__`),
/// as the task projections select them.
pub const TASK_MAPPED_COLUMNS: [&str; 12] = [
    "id",
    "user_id",
    "kind",
    "name",
    "namespace",
    "json",
    "is_active",
    "created_at",
    "updated_at",
    "project_id",
    "client_origin",
    "is_group_chat",
];

/// Zero-based position of `column` inside a task projection, so a caller can
/// decode a row positionally: the recorded source query aliases every column
/// with the resolved physical table name, which a caller cannot know.
pub fn task_column_index(column: &str) -> Option<usize> {
    TASK_MAPPED_COLUMNS.iter().position(|name| *name == column)
}

/// The `tasks` projection of one table, with every mapped column labeled
/// `{table}_{column}` in mapper order — the ORM rendering SQLAlchemy emits for
/// `db.query(TaskResource)`.
pub fn task_projection(table: &str) -> String {
    TASK_MAPPED_COLUMNS
        .iter()
        .map(|column| format!("{table}.{column} AS {table}_{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The active, non-system `Task` row of one id, read from `table`, matching
/// `app/stores/tasks/sqlalchemy_task_store.py`.
///
/// `CollaborationStrategyFactory.get_strategy_for_task`
/// (`app/services/adapters/collaboration_strategy.py:418`) issues this read on
/// every terminal status update.
pub fn regular_active_task_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \n\
         FROM `{table}` \n\
         WHERE id = ? AND kind = 'Task' AND namespace != 'system' AND is_active = 1 \n LIMIT 1"
    )
}

/// `task_store.get_task_by_states`
/// (`db.query(TaskResource).filter(id == task_id, kind == 'Task',
/// is_active.in_(TaskResource.is_active_query())).first()`): the active
/// (`IN (1, 2)`) task of one id, read from `table` through the ORM's labeled
/// projection. The source ends in `query.first()`, so the read takes no row
/// lock.
pub fn active_task_projection_statement(table: &str) -> String {
    format!(
        "SELECT {projection} \nFROM {table} \n\
         WHERE {table}.id = ? AND {table}.kind = 'Task' \
         AND {table}.is_active IN (1, 2) \n LIMIT 1",
        projection = task_projection(table)
    )
}

/// The completion flow emits [`owner_matches_task_id_statement`] before an
/// owner-scoped assistant-subtask listing.
///
/// The `subtasks` projection of one table, with every mapped column labeled
/// `{table}_{column}` in mapper order.
pub fn subtask_projection(table: &str) -> String {
    SUBTASK_MAPPED_COLUMNS
        .iter()
        .map(|column| {
            let qualified = if *column == "role" {
                format!("`{column}`")
            } else {
                (*column).to_owned()
            };
            format!("{table}.{qualified} AS {table}_{column}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `subtask_store.list_assistant_by_task`: read the task's ASSISTANT subtasks.
/// The caller restores message order without sending large JSON into filesort.
pub fn assistant_subtasks_by_task_statement(table: &str) -> String {
    let projection = subtask_projection(table);
    format!(
        "SELECT {projection} \nFROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.`role` = 'ASSISTANT'"
    )
}
