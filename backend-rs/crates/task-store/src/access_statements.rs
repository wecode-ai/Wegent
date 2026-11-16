// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL builders for `GET /api/tasks`'s accessible-task store reads.
//!
//! Both statements mirror the SQLAlchemy rendering of `_ACCESSIBLE_COUNT_SQL`
//! and `_ACCESSIBLE_IDS_SQL`
//! (`app/stores/tasks/sqlalchemy_task_store.py`), which
//! `task_store.list_accessible_task_ids` issues. The table is the routed
//! `{{tasks}}` token for a sharded store and `TASKS_TABLE` for the
//! single-table store. Bind order follows the parameter's first appearance in
//! the source text: `entity_id`, `is_active`, `user_id` (and then `limit`,
//! `offset` for the id page).

/// `_ACCESSIBLE_COUNT_SQL`: the distinct accessible active task count for one
/// user (owned or approved member).
#[must_use]
pub fn accessible_task_count_statement(table: &str) -> String {
    format!(
        "SELECT COUNT(DISTINCT k.id) AS count_1 \nFROM `{table}` k \nLEFT JOIN resource_members tm ON \
         k.id = tm.resource_id AND tm.resource_type = 'Task' AND tm.entity_type = 'user' AND \
         tm.entity_id = ? AND tm.status = 'approved' \nWHERE k.kind = 'Task' AND k.is_active = ? \
         AND k.namespace != 'system' AND (k.user_id = ? OR tm.id IS NOT NULL)"
    )
}

/// `_ACCESSIBLE_IDS_SQL`: the distinct accessible active task ids of one page,
/// newest `created_at` first, bounded by `LIMIT`/`OFFSET`.
#[must_use]
pub fn accessible_task_ids_statement(table: &str) -> String {
    format!(
        "SELECT DISTINCT k.id, k.created_at \nFROM `{table}` k \nLEFT JOIN resource_members tm ON \
         k.id = tm.resource_id AND tm.resource_type = 'Task' AND tm.entity_type = 'user' AND \
         tm.entity_id = ? AND tm.status = 'approved' \nWHERE k.kind = 'Task' AND k.is_active = ? \
         AND k.namespace != 'system' AND (k.user_id = ? OR tm.id IS NOT NULL) \nORDER BY \
         k.created_at DESC \n LIMIT ? OFFSET ?"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accessible_statements_bind_in_source_text_order() {
        let count = accessible_task_count_statement("tasks");
        assert!(count.contains("SELECT COUNT(DISTINCT k.id)"));
        assert!(count.contains("FROM `tasks` k"));
        assert!(count.contains("LEFT JOIN resource_members tm"));
        assert!(count.contains("(k.user_id = ? OR tm.id IS NOT NULL)"));
        assert_eq!(count.matches('?').count(), 3);

        let ids = accessible_task_ids_statement("tasks");
        assert!(ids.contains("SELECT DISTINCT k.id, k.created_at"));
        assert!(ids.contains("ORDER BY k.created_at DESC"));
        assert!(ids.ends_with(" LIMIT ? OFFSET ?"));
        assert_eq!(ids.matches('?').count(), 5);
    }
}
