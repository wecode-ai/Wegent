// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded pipeline context reads after the subscription's owner guard.

use brz_mysql::{Json, MysqlResult};
use serde_json::Value;

use crate::request_sql::{RequestSql, RouteKey};
use crate::sql_support::StatementArg;
use crate::task_store_runtime_reads::{
    pipeline_latest_completed_statement, pipeline_original_prompt_statement,
};

pub(super) async fn load_message_on(
    sql: &mut dyn RequestSql,
    table: &str,
    task_id: i64,
    mode: &str,
) -> MysqlResult<String> {
    let route = RouteKey::Task(task_id as u64);
    let Some(completed) = sql
        .fetch_optional_row(
            route,
            &pipeline_latest_completed_statement(table),
            vec![StatementArg::Int(task_id)],
        )
        .await?
    else {
        return Ok(String::new());
    };
    let before = completed.get::<i64>("message_id")?.unwrap_or_default();
    let original = sql
        .fetch_optional_row(
            route,
            &pipeline_original_prompt_statement(table),
            vec![StatementArg::Int(task_id), StatementArg::Int(before)],
        )
        .await?
        .map(|row| row.get::<String>("prompt"))
        .transpose()?
        .flatten();
    let prompt =
        wegent_task_store::prompt::extract_display_prompt(original.as_deref()).unwrap_or_default();
    let result = completed
        .get::<Json<Value>>("result")?
        .map_or(Value::Null, |json| json.0);
    Ok(crate::task_store::handoff_message(mode, &prompt, &result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as SqlValue};
    use serde_json::json;

    #[tokio::test]
    async fn bounded_handoff_keeps_the_original_request_and_nullable_output() {
        for nullable in [false, true] {
            let fixture = MysqlRows::start_results(move |statement| {
                let row = if statement.starts_with("SELECT original.prompt") {
                    vec![("prompt", SqlValue::Text("original request".into()))]
                } else {
                    vec![
                        (
                            "message_id",
                            if nullable {
                                SqlValue::Null
                            } else {
                                SqlValue::I64(10)
                            },
                        ),
                        (
                            "result",
                            if nullable {
                                SqlValue::Null
                            } else {
                                SqlValue::Text(json!({"value": "latest output"}).to_string())
                            },
                        ),
                    ]
                };
                (row.clone(), vec![row])
            })
            .await;
            let message =
                load_message_on(&mut &fixture.mysql, "subtasks", 42, "original_and_previous")
                    .await
                    .unwrap();
            let expected = if nullable {
                "Original user request:\noriginal request"
            } else {
                "Original user request:\noriginal request\n\nPrevious stage output:\nlatest output"
            };
            assert_eq!(message, expected);
            let queries = fixture.queries();
            assert_eq!(queries.len(), 2);
            assert!(
                queries
                    .iter()
                    .all(|statement| statement.contains("LIMIT 1)"))
            );
        }
    }
}
