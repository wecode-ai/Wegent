// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded subscription status and executor-session reads.

use crate::task_store_statements::subtask_projection;

/// Session recovery remains available even when chat history is disabled.
pub const SUBSCRIPTION_SESSION_LIMIT: i64 = 50;

/// Sort only the primary-key candidate, never the full result payload.
pub fn latest_assistant_statement(table: &str) -> String {
    format!(
        "SELECT {projection} FROM {table} \
         JOIN (SELECT id FROM {table} WHERE task_id = ? AND `role` = 'ASSISTANT' \
         ORDER BY message_id DESC, created_at DESC, id DESC LIMIT 1) AS latest \
         ON {table}.id = latest.id",
        projection = subtask_projection(table),
    )
}

/// Scalar membership check preserves the completion result fallback contract.
pub fn assistant_membership_statement(table: &str) -> String {
    format!(
        "SELECT id FROM {table} WHERE id = ? AND task_id = ? \
         AND `role` = 'ASSISTANT' LIMIT 1"
    )
}

fn json_truthy(result: &str, path: &str) -> String {
    let value = format!("JSON_EXTRACT({result}, '{path}')");
    format!(
        "(CASE JSON_TYPE({value}) \
         WHEN 'BOOLEAN' THEN JSON_UNQUOTE({value}) = 'true' \
         WHEN 'INTEGER' THEN {value} != 0 \
         WHEN 'DOUBLE' THEN {value} != 0 \
         WHEN 'STRING' THEN LENGTH(JSON_UNQUOTE({value})) > 0 \
         WHEN 'ARRAY' THEN JSON_LENGTH({value}) > 0 \
         WHEN 'OBJECT' THEN JSON_LENGTH({value}) > 0 ELSE false END)"
    )
}

/// Project only sessions and filter missing sessions before applying the cap.
pub fn recent_executor_sessions_statement(table: &str, bot_count: usize) -> String {
    let result = format!("{table}.result");
    let session = format!("JSON_EXTRACT({result}, '$.executor_session')");
    let agent = json_truthy(&result, "$.executor_session.agent");
    let identifiers = ["sessionId", "session_id", "threadId", "thread_id"]
        .map(|key| json_truthy(&result, &format!("$.executor_session.{key}")))
        .join(" OR ");
    let text = |key: &str| {
        let value = format!("JSON_EXTRACT({session}, '$.{key}')");
        format!(
            "(CASE WHEN JSON_TYPE({value}) = 'NULL' THEN NULL \
             WHEN JSON_TYPE({value}) = 'BOOLEAN' THEN \
             CASE WHEN JSON_UNQUOTE({value}) = 'true' THEN 'True' ELSE 'False' END \
             ELSE JSON_UNQUOTE({value}) END)"
        )
    };
    let identifier = |camel: &str, legacy: &str| {
        format!(
            "(CASE WHEN {} THEN {} WHEN {} THEN {} ELSE NULL END)",
            json_truthy(&result, &format!("$.executor_session.{camel}")),
            text(camel),
            json_truthy(&result, &format!("$.executor_session.{legacy}")),
            text(legacy),
        )
    };
    let bot = format!(
        "(CASE WHEN JSON_CONTAINS_PATH({session}, 'one', '$.botId') THEN {} ELSE {} END)",
        text("botId"),
        text("bot_id")
    );
    let identity = format!(
        "{}, {bot}, {}, {}",
        text("agent"),
        identifier("sessionId", "session_id"),
        identifier("threadId", "thread_id")
    );
    let bot_filter = if bot_count == 0 {
        String::new()
    } else {
        format!(
            " AND ({bot} IS NULL OR {bot} IN ({}))",
            vec!["?"; bot_count].join(", ")
        )
    };
    format!(
        "SELECT executor_session FROM (SELECT {session} AS executor_session, \
         message_id, created_at, id, ROW_NUMBER() OVER (PARTITION BY {identity} \
         ORDER BY message_id DESC, created_at DESC, id DESC) AS session_rank FROM {table} \
         WHERE {table}.task_id = ? AND {table}.`role` = 'ASSISTANT' \
         AND JSON_TYPE({result}) = 'OBJECT' AND JSON_TYPE({session}) = 'OBJECT' \
         AND {agent} AND ({identifiers}){bot_filter}) AS sessions \
         WHERE session_rank = 1 \
         ORDER BY message_id DESC, created_at DESC, id DESC \
         LIMIT {SUBSCRIPTION_SESSION_LIMIT}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_queries_preserve_physical_tables_and_do_not_sort_full_results() {
        for table in ["subtasks", "subtasks_0001"] {
            let latest = latest_assistant_statement(table);
            assert!(latest.contains(&format!("JOIN (SELECT id FROM {table}")));
            assert!(latest.contains("DESC LIMIT 1) AS latest"));
            let sessions = recent_executor_sessions_statement(table, 1);
            assert!(sessions.starts_with("SELECT executor_session FROM (SELECT JSON_EXTRACT("));
            assert!(sessions.contains("ROW_NUMBER() OVER (PARTITION BY"));
            assert!(sessions.contains("WHERE session_rank = 1"));
            assert!(sessions.contains("IN (?)"));
            assert!(!sessions.contains(&format!("{table}.result AS")));
            assert!(sessions.ends_with("LIMIT 50"));
            assert!(sessions.contains("'$.executor_session.session_id'"));
            assert!(sessions.contains("'$.executor_session.thread_id'"));
            assert!(assistant_membership_statement(table).ends_with("LIMIT 1"));
        }
    }

    #[test]
    fn session_identity_preserves_falsey_fallback_and_explicit_null_bots() {
        let sql = recent_executor_sessions_statement("subtasks", 1);
        assert!(sql.contains("JSON_CONTAINS_PATH("));
        assert!(sql.contains("'one', '$.botId'"));
        assert!(sql.contains(" = 'NULL' THEN NULL"));
        assert!(sql.contains("THEN 'True' ELSE 'False' END"));
        for key in ["sessionId", "session_id", "threadId", "thread_id"] {
            assert!(sql.contains(&json_truthy(
                "subtasks.result",
                &format!("$.executor_session.{key}")
            )));
        }
        assert!(!sql.contains("COALESCE("));
        assert!(!sql.contains("NULLIF("));
        assert!(sql.ends_with("LIMIT 50"));
    }
}
