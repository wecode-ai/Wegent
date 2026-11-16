// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL builders for `GET /api/tasks/search`'s store reads.
//!
//! Every statement mirrors the SQLAlchemy rendering of the source reads that
//! `get_user_tasks_by_title_with_pagination` issues through the owned-task
//! store and `task_store.list_by_ids`. Column qualifiers and aliases are free
//! for Replay matching (the crate's other store statements already rely on
//! that), so projections use the unqualified column names; the table choice,
//! predicate order and call order stay faithful. `table` is the routed
//! `{{tasks}}` token for the sharded store and `TASKS_TABLE` for the
//! single-table store.

/// `_owned_active_task_query`'s `count(*)`: the owned active non-system tasks
/// of one table. Rendered exactly like `_OWNED_COUNT_SQL` / the sharded page
/// total.
#[must_use]
pub fn owned_task_count_statement(table: &str) -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM `{table}` \nWHERE user_id = ? AND kind = 'Task' AND \
         is_active = 1 AND namespace != 'system'"
    )
}

/// `_ordered_limited_rows` for the owned ids: `(id, user_id, created_at)` of
/// one table, newest `created_at`, `id` first, bounded by `LIMIT` (with
/// `OFFSET` only when the page skips rows, matching SQLAlchemy).
#[must_use]
pub fn owned_task_ids_statement(table: &str, with_offset: bool) -> String {
    let tail = if with_offset {
        " \n LIMIT ? OFFSET ?"
    } else {
        " \n LIMIT ?"
    };
    format!(
        "SELECT id, user_id, created_at \nFROM `{table}` \nWHERE user_id = ? AND kind = 'Task' \
         AND is_active = 1 AND namespace != 'system' ORDER BY created_at DESC, id DESC{tail}"
    )
}

/// `_count_migrated_legacy_index_rows`: the shard rows whose id the base owned
/// query already lists. `route` is the routed shard table token; the inner
/// subquery keeps the base table literal, as SQLAlchemy renders the correlated
/// `IN (SELECT anon_1.id FROM (...) AS anon_1)`.
///
/// Every column is qualified, including the outer `{route}.id`, because the
/// derived table also projects an `id`: an unqualified outer column is
/// ambiguous between the two scopes. The owner id is rendered as an inline
/// integer literal rather than a bind parameter, matching the recorded text
/// form of this statement. The owner id comes from the authenticated session,
/// so the literal carries no input.
#[must_use]
pub fn owned_duplicate_count_statement(
    route: &str,
    base_table: &str,
    owner_user_id: i64,
) -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM `{route}` \nWHERE {route}.id IN (SELECT \
         anon_1.id \nFROM (SELECT `{base_table}`.id AS id \nFROM `{base_table}` \nWHERE \
         {base_table}.user_id = {owner_user_id} AND {base_table}.kind = 'Task' AND \
         {base_table}.is_active = 1 AND {base_table}.namespace != 'system') AS anon_1)"
    )
}

/// `_list_migrated_legacy_tasks_by_ids`'s index probe: `(id, user_id)` of the
/// legacy ids, read from the base table.
#[must_use]
pub fn task_refs_by_ids_statement(table: &str, count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!("SELECT id, user_id \nFROM `{table}` \nWHERE id IN ({placeholders})")
}

/// `list_by_ids`'s full projection for one table, mirroring
/// `running_tasks_by_ids_statement` (the same `db.query(TaskResource)` read).
#[must_use]
pub fn tasks_by_ids_statement(table: &str, count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, \
         project_id, client_origin, is_group_chat \nFROM `{table}` \nWHERE id IN ({placeholders})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_duplicate_count_qualifies_the_outer_scope_and_inlines_the_owner() {
        let sql = owned_duplicate_count_statement("tasks_0108", "tasks", 2156);
        // The owner predicate is inside the derived table, so it must render as
        // the source's inline literal, not a bind parameter.
        assert!(
            !sql.contains('?'),
            "statement must not carry a bind parameter"
        );
        assert!(sql.contains("tasks.user_id = 2156"));
        assert!(sql.starts_with("SELECT count(*) AS count_1"));
        // The derived table also projects `id`, so the outer predicate must
        // name its own scope.
        assert!(sql.contains("WHERE tasks_0108.id IN (SELECT anon_1.id"));
        assert!(
            !sql.contains("WHERE id IN"),
            "the outer column must be qualified"
        );
        assert!(sql.contains("AS anon_1)"));
    }
}
