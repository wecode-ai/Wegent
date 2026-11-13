// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real MySQL store contracts used by native subscription preparation.

use brz_mysql::MysqlService;
use serde_json::{Value, json};
use wegent_backend_rs::message_pair::{next_message_ids, subtask_rows};
use wegent_backend_rs::task_store::{CreateSubtasksRequest, SubtaskHistoryWindow, TaskStore};
use wegent_backend_rs::task_store_history::HistorySelection;
use wegent_backend_rs::task_store_subscription_reads::recent_executor_sessions_statement;

pub(super) async fn assert_store_windows(
    mysql: &MysqlService,
    store: &dyn TaskStore,
    task_id: i64,
    table: &str,
    user_id: i32,
) {
    // SQL collation must not turn nonempty whitespace into an empty cache entry.
    mysql
        .execute(
            format!(
                "UPDATE {table} SET role='USER', prompt=' ', result=NULL \
                 WHERE task_id=? AND message_id=26"
            ),
            (task_id,),
        )
        .await
        .unwrap();
    mysql
        .execute(
            format!(
                "UPDATE {table} SET result=JSON_OBJECT('value',' ') \
                 WHERE task_id=? AND message_id=27"
            ),
            (task_id,),
        )
        .await
        .unwrap();
    let mut sql = mysql;
    let cache = store
        .list_subtasks_history_window_on(
            &mut sql,
            task_id,
            i64::from(user_id),
            SubtaskHistoryWindow {
                limit: 20,
                before_message_id: Some(30),
                summary_checkpoint_only: false,
                selection: HistorySelection::Cache,
            },
        )
        .await
        .unwrap();
    let messages: Vec<i64> = cache
        .iter()
        .map(|row| row.get_required("message_id").unwrap())
        .collect();
    assert_eq!(
        messages,
        (8..=27).collect::<Vec<_>>(),
        "cache eligibility must be applied before LIMIT and preserve whitespace content"
    );
    mysql
        .execute(
            format!(
                "ALTER TABLE {table} MODIFY id BIGINT NOT NULL AUTO_INCREMENT, \
                 MODIFY executor_deleted_at TINYINT NULL DEFAULT 0"
            ),
            (),
        )
        .await
        .unwrap();
    for (limit, next) in [(20, 31_i64), (0, 33)] {
        let start_bytes = super::history_window::bytes_sent(mysql).await;
        let (history, next_message) = mysql
            .with_transaction(async |mut tx| {
                let history = store
                    .list_subtasks_history_window_on(
                        &mut tx,
                        task_id,
                        i64::from(user_id),
                        SubtaskHistoryWindow {
                            limit,
                            before_message_id: None,
                            summary_checkpoint_only: false,
                            selection: HistorySelection::All,
                        },
                    )
                    .await?;
                let ids = next_message_ids(store.max_subtask_message_id(&mut tx, task_id).await?);
                let executor = store.resolve_task_executor_on(&mut tx, task_id).await?;
                let (user_subtask, assistant_subtask) = subtask_rows(
                    i64::from(user_id),
                    task_id,
                    1,
                    "[1]",
                    "bounded subscription preparation",
                    "1970-01-01 00:00:00",
                    ids,
                );
                store
                    .create_subtasks_with_executor(
                        &mut tx,
                        &CreateSubtasksRequest {
                            user_subtask,
                            assistant_subtask,
                        },
                        &executor,
                    )
                    .await?;
                Ok((history, ids.next_message_id))
            })
            .await
            .unwrap();
        let transferred = super::history_window::bytes_sent(mysql).await - start_bytes;
        let budget = if limit == 0 {
            32 * 1024
        } else {
            23 * 64 * 1024
        };
        assert!(
            transferred < budget,
            "native preparation transferred {transferred} bytes for limit={limit}"
        );
        assert_eq!(history.len(), limit as usize);
        assert_eq!(next_message, next);
        let rows: Vec<brz_mysql::MysqlRow> = mysql.fetch_all(
            format!("SELECT message_id,role,status FROM {table} WHERE task_id=? AND message_id>=? ORDER BY message_id"),
            (task_id, next),
        ).await.unwrap();
        assert_eq!(
            rows.len(),
            2,
            "the bounded read must preserve the committed message pair"
        );
        assert_eq!(rows[0].get_required::<String>("role").unwrap(), "USER");
        assert_eq!(rows[0].get_required::<i64>("message_id").unwrap(), next);
        assert_eq!(
            rows[0].get_required::<String>("status").unwrap(),
            "COMPLETED"
        );
        assert_eq!(rows[1].get_required::<String>("role").unwrap(), "ASSISTANT");
        assert_eq!(rows[1].get_required::<i64>("message_id").unwrap(), next + 1);
        assert_eq!(rows[1].get_required::<String>("status").unwrap(), "PENDING");
    }
    assert_session_identifiers(mysql, task_id, table).await;
}

async fn assert_session_identifiers(mysql: &MysqlService, task_id: i64, table: &str) {
    let sessions = [
        json!({"agent": "Codex", "botId": 23, "threadId": "", "thread_id": "legacy-1"}),
        json!({"agent": "Codex", "botId": 23, "threadId": "", "thread_id": "legacy-2"}),
        json!({"agent": "ClaudeCode", "botId": 23, "sessionId": false, "session_id": "legacy-3"}),
        json!({"agent": "ClaudeCode", "botId": 23, "sessionId": false, "session_id": "legacy-4"}),
        json!({"agent": "Codex", "botId": null, "bot_id": 24, "threadId": "generic-session"}),
        json!({"agent": "Codex", "botId": "null", "threadId": "literal-null-bot"}),
        json!({"agent": "Codex", "botId": 24, "threadId": "other-bot"}),
        json!({"agent": "Codex", "botId": 23, "threadId": true}),
        json!({"agent": "Codex", "botId": "23", "threadId": "True"}),
        json!({"agent": "Codex", "botId": 23, "threadId": 1}),
        json!({"agent": "Codex", "botId": "23", "threadId": "1"}),
    ];
    for (index, session) in sessions.iter().enumerate() {
        mysql
            .execute(
                format!("UPDATE {table} SET result=? WHERE task_id=? AND message_id=?"),
                (
                    brz_mysql::Json(json!({
                        "value": "large-answer".repeat(6000),
                        "executor_session": session,
                    })),
                    task_id,
                    index as i64 + 1,
                ),
            )
            .await
            .unwrap();
    }
    let start = super::history_window::bytes_sent(mysql).await;
    let rows: Vec<brz_mysql::MysqlRow> = mysql
        .fetch_all(
            recent_executor_sessions_statement(table, 1),
            (task_id, "23"),
        )
        .await
        .unwrap();
    let actual: Vec<Value> = rows
        .iter()
        .map(|row| {
            row.get_required::<brz_mysql::Json<Value>>("executor_session")
                .unwrap()
                .0
        })
        .collect();
    let expected: Vec<Value> = [sessions[10].clone(), sessions[8].clone()]
        .into_iter()
        .chain(sessions[..5].iter().rev().cloned())
        .collect();
    assert_eq!(actual, expected);
    let transferred = super::history_window::bytes_sent(mysql).await - start;
    assert!(
        transferred < 16 * 1024,
        "session recovery must not transfer complete results: {transferred}"
    );
}
