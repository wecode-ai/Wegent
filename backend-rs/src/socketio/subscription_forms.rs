// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subscription sends inspect form candidates, never the whole conversation.

use brz_mysql::Json;
use serde_json::{Value, json};

use super::chat_send::{PendingInteractiveForm, pending_form_in_result};
use crate::request_sql::{RequestSql, RouteKey};
use crate::sql_support::StatementArg;

pub(super) async fn pending_form_on(
    sql: &mut dyn RequestSql,
    table: &str,
    task_id: i64,
) -> Result<Option<PendingInteractiveForm>, anyhow::Error> {
    let mut after: Option<(Option<i64>, i64)> = None;
    loop {
        let mut arguments = vec![StatementArg::Int(task_id), StatementArg::Int(task_id)];
        if let Some((message_id, id)) = after {
            if let Some(message_id) = message_id {
                arguments.extend([StatementArg::Int(message_id), StatementArg::Int(message_id)]);
            }
            arguments.push(StatementArg::Int(id));
        }
        let statement = crate::task_store_runtime_reads::pending_form_candidates_statement(
            table,
            after.map(|position| position.0),
        );
        let rows = sql
            .fetch_all_rows(RouteKey::Task(task_id as u64), &statement, arguments)
            .await?;
        if rows.is_empty() {
            return Ok(None);
        }
        let mut candidates = rows
            .into_iter()
            .map(|row| {
                Ok((
                    row.get::<i64>("message_id")?,
                    row.get_required::<i64>("id")?,
                    row.get::<Json<Value>>("blocks")?.map(|json| json.0),
                ))
            })
            .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
        // The outer join deliberately avoids sorting large blocks in MySQL.
        candidates.sort_by(|left, right| (right.0, right.1).cmp(&(left.0, left.1)));
        let last = candidates.last().expect("nonempty candidate page");
        after = Some((last.0, last.1));
        for (_, _, blocks) in candidates {
            if let Some(pending) = pending_form_in_result(&json!({"blocks": blocks})) {
                return Ok(Some(pending));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};

    fn candidate(id: i64, nullable_message: bool, valid: bool) -> Row {
        vec![
            ("id", SqlValue::I64(id)),
            (
                "message_id",
                if nullable_message {
                    SqlValue::Null
                } else {
                    SqlValue::I64(1)
                },
            ),
            (
                "blocks",
                SqlValue::Text(
                    json!([{
                        "tool_name": "interactive_form_question",
                        "tool_use_id": "old-pending-form",
                        "render_payload": {
                            "type": "interactive_form_question",
                            "questions": if valid { json!([{"id": "q"}]) } else { json!([]) },
                        }
                    }])
                    .to_string(),
                ),
            ),
        ]
    }

    #[tokio::test]
    async fn older_pending_forms_survive_invalid_candidates_and_nullable_keyset_pages() {
        for nullable_message in [false, true] {
            let fixture = MysqlRows::start_results(move |statement| {
                let columns = candidate(1, nullable_message, true);
                let rows = if statement.contains("form.id < ?") {
                    vec![columns.clone()]
                } else {
                    (2..=51)
                        .map(|id| candidate(id, nullable_message, false))
                        .collect()
                };
                (columns, rows)
            })
            .await;
            let pending = pending_form_on(&mut &fixture.mysql, "subtasks", 42)
                .await
                .expect("form candidates decode");
            assert!(pending.is_some());
            let queries = fixture.queries();
            assert_eq!(queries.len(), 2);
            assert!(queries.iter().all(|sql| sql.contains("LIMIT 50)")));
            assert!(
                queries
                    .iter()
                    .all(|sql| !sql.contains("candidate.result AS"))
            );
        }
    }
}
