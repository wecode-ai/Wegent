// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded internal history reads: sort ids, then load only selected payloads.

use brz_mysql::{MysqlResult, MysqlRow};

#[derive(Debug, Clone, Copy)]
pub struct SubtaskHistoryWindow {
    pub limit: i64,
    pub before_message_id: Option<i64>,
    pub summary_checkpoint_only: bool,
    pub selection: HistorySelection,
}

#[derive(Debug, Clone, Copy)]
pub enum HistorySelection {
    Ready,
    All,
    Cache,
}

#[derive(Debug, Clone)]
pub struct HistoryCandidate {
    pub id: i64,
    pub message_id: Option<i64>,
    pub created_at: Option<chrono::NaiveDateTime>,
}

impl HistoryCandidate {
    pub fn key(&self) -> (Option<i64>, Option<chrono::NaiveDateTime>, i64) {
        (self.message_id, self.created_at, self.id)
    }
}

pub fn history_ids_statement(table: &str, window: SubtaskHistoryWindow) -> String {
    let mut statement = format!("SELECT id FROM {table} WHERE task_id = ?");
    match window.selection {
        HistorySelection::Ready => {
            statement.push_str(" AND status IN ('COMPLETED', 'CANCELLED', 'FAILED')");
        }
        HistorySelection::All => {}
        HistorySelection::Cache => {
            statement.push_str(
                " AND status = 'COMPLETED' AND \
                 ((role = 'USER' AND OCTET_LENGTH(prompt) > 0) OR \
                 (role = 'ASSISTANT' AND JSON_TYPE(JSON_EXTRACT(result, '$.value')) = 'STRING' \
                 AND OCTET_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(result, '$.value'))) > 0))",
            );
        }
    }
    if window.before_message_id.is_some() {
        statement.push_str(" AND message_id < ?");
    }
    if window.summary_checkpoint_only {
        statement.push_str(&summary_checkpoint_predicate(table));
    }
    statement.push_str(" ORDER BY message_id DESC, created_at DESC, id DESC LIMIT ?");
    statement
}

/// Keep narrow candidate reads and selected payload reads on the caller's route.
pub async fn history_candidates_on(
    sql: &mut dyn crate::request_sql::RequestSql,
    tables: crate::task_store_tables::TableTemplates,
    task_id: i64,
    owner_user_id: Option<i64>,
    window: SubtaskHistoryWindow,
    route: crate::request_sql::RouteKey,
) -> MysqlResult<Vec<HistoryCandidate>> {
    if window.limit <= 0 {
        return Ok(Vec::new());
    }
    use crate::task_store_statements::StatementArg;
    let mut statement = history_ids_statement(tables.subtasks, window).replacen(
        "SELECT id FROM",
        "SELECT id, message_id, created_at FROM",
        1,
    );
    let mut args = vec![StatementArg::Int(task_id)];
    if let Some(owner_user_id) = owner_user_id {
        statement = statement.replacen(
            "WHERE task_id = ?",
            &format!(
                "WHERE task_id = ? AND task_id IN \
                 (SELECT id FROM {} WHERE id = ? AND user_id = ?)",
                tables.tasks
            ),
            1,
        );
        args.extend([StatementArg::Int(task_id), StatementArg::Int(owner_user_id)]);
    }
    if let Some(before) = window.before_message_id {
        args.push(StatementArg::Int(before));
    }
    args.push(StatementArg::Int(window.limit));
    sql.fetch_all_rows(route, &statement, args)
        .await?
        .iter()
        .map(|row| {
            Ok(HistoryCandidate {
                id: row.get_required("id")?,
                message_id: row.get("message_id")?,
                created_at: row.get("created_at")?,
            })
        })
        .collect()
}

pub async fn history_payloads_on(
    sql: &mut dyn crate::request_sql::RequestSql,
    tables: crate::task_store_tables::TableTemplates,
    task_id: i64,
    owner_user_id: Option<i64>,
    ids: &[i64],
    route: crate::request_sql::RouteKey,
) -> MysqlResult<Vec<MysqlRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    use crate::task_store_statements::StatementArg;
    let mut statement = format!(
        "{} AND {}.task_id = ?",
        crate::task_store_statements::subtasks_by_ids_statement(tables.subtasks, ids.len()),
        tables.subtasks
    );
    let mut args: Vec<_> = ids.iter().copied().map(StatementArg::Int).collect();
    args.push(StatementArg::Int(task_id));
    if let Some(owner_user_id) = owner_user_id {
        statement.push_str(&format!(
            " AND {}.task_id IN (SELECT id FROM {} WHERE id = ? AND user_id = ?)",
            tables.subtasks, tables.tasks
        ));
        args.extend([StatementArg::Int(task_id), StatementArg::Int(owner_user_id)]);
    }
    let rows = sql.fetch_all_rows(route, &statement, args).await?;
    let mut by_id: std::collections::HashMap<_, _> = rows
        .into_iter()
        .map(|row| Ok((row.get_required::<i64>("id")?, row)))
        .collect::<MysqlResult<_>>()?;
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

fn summary_checkpoint_predicate(table: &str) -> String {
    // A scalar lookup keeps JSON_TABLE out of MySQL's semijoin rewrite:
    // that rewrite can sort full payloads or lose correlated summary markers.
    let result = format!("{table}.result");
    let message =
        format!("JSON_EXTRACT({result}, CONCAT('$.messages_chain[', marker_index - 1, ']'))");
    let kwargs = format!(
        "JSON_EXTRACT({result}, CONCAT('$.messages_chain[', marker_index - 1, \
         '].additional_kwargs'))"
    );
    let marker = format!(
        "JSON_EXTRACT({result}, CONCAT('$.messages_chain[', marker_index - 1, \
         '].additional_kwargs.summary_compacted'))"
    );
    format!(
        " AND role = 'ASSISTANT' AND status = 'COMPLETED' \
         AND (SELECT 1 FROM JSON_TABLE(\
         CASE WHEN JSON_TYPE({result}) = 'OBJECT' \
         AND JSON_TYPE(JSON_EXTRACT({result}, '$.messages_chain')) = 'ARRAY' \
         THEN {result} ELSE JSON_OBJECT('messages_chain', JSON_ARRAY()) END, \
         '$.messages_chain[*]' COLUMNS(marker_index FOR ORDINALITY)) AS checkpoint_markers \
         WHERE JSON_TYPE({message}) = 'OBJECT' AND JSON_TYPE({kwargs}) = 'OBJECT' \
         AND JSON_TYPE({marker}) = 'BOOLEAN' \
         AND JSON_UNQUOTE({marker}) = 'true' LIMIT 1) = 1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_window_filters_before_sorting_ids_and_bounds_the_query() {
        let mut queries = Vec::new();
        for checkpoint_only in [false, true] {
            let window = SubtaskHistoryWindow {
                limit: 20,
                before_message_id: Some(30),
                summary_checkpoint_only: checkpoint_only,
                selection: HistorySelection::Ready,
            };
            queries.push(history_ids_statement("subtasks_0001", window));
        }
        for query in &queries {
            assert!(query.starts_with("SELECT id FROM subtasks_0001"));
            assert!(query.contains("AND message_id < ?"));
            assert!(query.ends_with("ORDER BY message_id DESC, created_at DESC, id DESC LIMIT ?"));
            assert!(!query.split("FROM").next().unwrap().contains("result"));
        }
        assert!(queries[1].contains("JSON_TYPE"));
        assert!(queries[1].contains("= 'BOOLEAN'"));
        assert!(queries[1].contains("'true' LIMIT 1) = 1"));
        assert!(!queries[1].contains("EXISTS"));
    }

    #[test]
    fn preparation_and_cache_keep_their_distinct_eligibility_filters() {
        let window = SubtaskHistoryWindow {
            limit: 20,
            before_message_id: Some(30),
            summary_checkpoint_only: false,
            selection: HistorySelection::All,
        };
        let all = history_ids_statement("subtasks", window);
        assert!(!all.contains("status"));
        let cache = history_ids_statement(
            "subtasks",
            SubtaskHistoryWindow {
                selection: HistorySelection::Cache,
                ..window
            },
        );
        assert!(cache.contains("status = 'COMPLETED'"));
        assert!(cache.contains("role = 'USER' AND OCTET_LENGTH(prompt) > 0"));
        assert!(cache.contains("JSON_TYPE(JSON_EXTRACT(result, '$.value')) = 'STRING'"));
        assert!(cache.contains("OCTET_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(result, '$.value'))) > 0"));
        assert!(cache.ends_with("id DESC LIMIT ?"));
    }
}
