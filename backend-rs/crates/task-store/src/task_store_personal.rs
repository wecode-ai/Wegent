// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded, ID-ordered personal-task history shared by task stores.

use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::task_store_statements::StatementArg;

/// The most recently allocated personal tasks available to one owner and origin.
pub const PERSONAL_TASK_HISTORY_LIMIT: i64 = 10_000;

/// Existing deployment indexes used to keep candidate scans off large JSON rows.
#[derive(Clone, Copy)]
pub struct PersonalTaskIndexes {
    pub owner: &'static str,
    pub kind: &'static str,
    pub group_chat: &'static str,
}

fn personal_task_filters(client_origin: bool, namespace: bool) -> String {
    let mut filters = String::from("user_id = ? AND kind = 'Task' AND is_active = 1");
    if namespace {
        filters.push_str(" AND namespace != 'system'");
    }
    filters.push_str(" AND is_group_chat = false");
    if client_origin {
        filters.push_str(" AND client_origin = ?");
    }
    filters.push_str(" AND project_id = 0");
    filters
}

fn personal_task_window(
    table: &str,
    client_origin: bool,
    indexes: Option<PersonalTaskIndexes>,
) -> String {
    if let Some(indexes) = indexes {
        // Materialize ID-only sets before applying namespace and history
        // ordering. Sparse Task accounts must not read Workspace JSON while
        // searching for 10,000 matches. Each source is covered by its indexes.
        let filters = personal_task_filters(client_origin, false);
        return format!(
            "SELECT eligible.id FROM (SELECT /*+ INDEX_MERGE(candidate {}, {}, {}) */ \
             id FROM `{table}` AS candidate WHERE {filters} \
             LIMIT 18446744073709551615) AS eligible \
             STRAIGHT_JOIN (SELECT id FROM `{table}` WHERE user_id = ? \
             AND kind = 'Task' AND namespace != 'system' \
             LIMIT 18446744073709551615) AS namespace_ids \
             ON namespace_ids.id = eligible.id \
             ORDER BY eligible.id DESC LIMIT {PERSONAL_TASK_HISTORY_LIMIT}",
            indexes.owner, indexes.kind, indexes.group_chat,
        );
    }
    let filters = personal_task_filters(client_origin, true);
    format!(
        "SELECT id FROM `{table}` WHERE {filters} \
         ORDER BY id DESC LIMIT {PERSONAL_TASK_HISTORY_LIMIT}"
    )
}

/// Apply the history window before the cursor, then read only the requested rows.
/// The derived LIMIT prevents a cursor from opening an older history window.
pub fn personal_task_candidates_statement(
    table: &str,
    client_origin: bool,
    cursor: bool,
    indexes: Option<PersonalTaskIndexes>,
) -> String {
    let window = personal_task_window(table, client_origin, indexes);
    let mut sql = format!(
        "SELECT task.id, task.user_id, task.kind, task.name, task.namespace, \
         task.json, task.is_active, task.created_at, task.updated_at, \
         task.project_id, task.client_origin, task.is_group_chat \
         FROM ({window}) AS recent \
         JOIN `{table}` AS task ON task.id = recent.id"
    );
    if cursor {
        sql.push_str(" WHERE recent.id < ?");
    }
    sql.push_str(" ORDER BY recent.id DESC LIMIT ?");
    sql
}

fn personal_task_arguments(
    user_id: i64,
    limit: i64,
    cursor: Option<i64>,
    client_origin: Option<&str>,
    indexed: bool,
) -> Vec<StatementArg> {
    let mut args = Vec::new();
    args.push(StatementArg::Int(user_id));
    if let Some(origin) = client_origin {
        args.push(StatementArg::Str(origin.to_string()));
    }
    if indexed {
        args.push(StatementArg::Int(user_id));
    }
    if let Some(id) = cursor {
        args.push(StatementArg::Int(id));
    }
    args.push(StatementArg::Int(limit.min(PERSONAL_TASK_HISTORY_LIMIT)));
    args
}

/// Load a page using the same bindings for the single-table and routed stores.
pub async fn personal_task_candidates<M: Mysql>(
    mysql: &M,
    table: &str,
    user_id: i64,
    limit: i64,
    cursor: Option<i64>,
    client_origin: Option<&str>,
    indexes: Option<PersonalTaskIndexes>,
) -> MysqlResult<Vec<MysqlRow>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let args = personal_task_arguments(user_id, limit, cursor, client_origin, indexes.is_some());
    mysql
        .fetch_all(
            personal_task_candidates_statement(
                table,
                client_origin.is_some(),
                cursor.is_some(),
                indexes,
            ),
            args,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_page_binds_both_owner_scopes_and_caps_large_reads() {
        let args = personal_task_arguments(7, i64::MAX, Some(41), Some("wework"), true);
        assert!(matches!(
            args.as_slice(),
            [StatementArg::Int(7), StatementArg::Str(window_origin),
             StatementArg::Int(7),
             StatementArg::Int(41), StatementArg::Int(10_000)]
             if window_origin == "wework"
        ));
    }

    #[test]
    fn cursor_predicate_cannot_move_the_history_window() {
        let sql = personal_task_candidates_statement("tasks", true, true, None);
        let boundary = sql.find("LIMIT 10000) AS recent").unwrap();
        assert!(sql.find("recent.id < ?").unwrap() > boundary);
        assert_eq!(sql.matches("user_id = ?").count(), 1);
        assert!(!sql.contains("created_at <"));
    }

    #[tokio::test]
    async fn zero_limit_does_not_issue_a_query() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert!(
            personal_task_candidates(&mysql, "tasks", 7, 0, None, None, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(mysql.queries().is_empty());
    }
}
