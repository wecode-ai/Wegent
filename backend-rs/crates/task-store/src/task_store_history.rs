// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded internal history reads: sort ids, then load only selected payloads.

use brz_mysql::{Mysql, MysqlResult, MysqlRow};

#[derive(Debug, Clone, Copy)]
pub struct SubtaskHistoryWindow {
    pub limit: i64,
    pub before_message_id: Option<i64>,
    pub summary_checkpoint_only: bool,
}

pub fn history_ids_statement(table: &str, window: SubtaskHistoryWindow) -> String {
    let mut statement = format!(
        "SELECT id FROM {table} WHERE task_id = ? \
         AND status IN ('COMPLETED', 'CANCELLED', 'FAILED')"
    );
    if window.before_message_id.is_some() {
        statement.push_str(" AND message_id < ?");
    }
    if window.summary_checkpoint_only {
        statement.push_str(&summary_checkpoint_predicate(table));
    }
    statement.push_str(" ORDER BY message_id DESC, created_at DESC, id DESC LIMIT ?");
    statement
}

fn summary_checkpoint_predicate(table: &str) -> String {
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
         AND EXISTS (SELECT 1 FROM JSON_TABLE(\
         CASE WHEN JSON_TYPE({result}) = 'OBJECT' \
         AND JSON_TYPE(JSON_EXTRACT({result}, '$.messages_chain')) = 'ARRAY' \
         THEN {result} ELSE JSON_OBJECT('messages_chain', JSON_ARRAY()) END, \
         '$.messages_chain[*]' COLUMNS(marker_index FOR ORDINALITY)) AS checkpoint_markers \
         WHERE JSON_TYPE({message}) = 'OBJECT' AND JSON_TYPE({kwargs}) = 'OBJECT' \
         AND JSON_TYPE({marker}) = 'BOOLEAN' \
         AND JSON_UNQUOTE({marker}) = 'true')"
    )
}

pub async fn history_window_by_task<M: Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    window: SubtaskHistoryWindow,
) -> MysqlResult<Vec<MysqlRow>> {
    if window.limit <= 0 {
        return Ok(Vec::new());
    }
    use crate::task_store_statements::StatementArg;
    let mut args = vec![StatementArg::Int(task_id)];
    if let Some(before) = window.before_message_id {
        args.push(StatementArg::Int(before));
    }
    args.push(StatementArg::Int(window.limit));
    let rows: Vec<MysqlRow> = mysql
        .fetch_all(history_ids_statement(table, window), args)
        .await?;
    let ids = rows
        .iter()
        .rev()
        .map(|row| row.get_required::<i64>("id"))
        .collect::<MysqlResult<Vec<_>>>()?;
    crate::task_store_listing::load_subtasks_by_ids(mysql, table, &ids).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn history_window_filters_before_sorting_ids_and_bounds_the_query() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for checkpoint_only in [false, true] {
            let window = SubtaskHistoryWindow {
                limit: 20,
                before_message_id: Some(30),
                summary_checkpoint_only: checkpoint_only,
            };
            assert!(
                history_window_by_task(&mysql, "subtasks_0001", 42, window)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
        for query in mysql.queries() {
            assert_eq!(query.args, 3);
            assert_eq!(query.first_integer, Some(42));
            assert!(query.sql.starts_with("SELECT id FROM subtasks_0001"));
            assert!(query.sql.contains("AND message_id < ?"));
            assert!(
                query
                    .sql
                    .ends_with("ORDER BY message_id DESC, created_at DESC, id DESC LIMIT ?")
            );
            assert!(!query.sql.split("FROM").next().unwrap().contains("result"));
        }
        let queries = mysql.queries();
        assert!(queries[1].sql.contains("JSON_TYPE"));
        assert!(queries[1].sql.contains("= 'BOOLEAN'"));
    }

    #[tokio::test]
    async fn disabled_history_does_not_read_the_database() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for limit in [0, -1] {
            assert!(
                history_window_by_task(
                    &mysql,
                    "subtasks",
                    42,
                    SubtaskHistoryWindow {
                        limit,
                        before_message_id: None,
                        summary_checkpoint_only: false,
                    }
                )
                .await
                .unwrap()
                .is_empty()
            );
        }
        assert!(mysql.queries().is_empty());
    }
}
