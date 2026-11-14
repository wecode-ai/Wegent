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
    assert_pending_form_pages(mysql, task_id, table, user_id).await;
}

async fn assert_pending_form_pages(mysql: &MysqlService, task_id: i64, table: &str, user_id: i32) {
    use brz_mysql::{Json, MysqlRow};
    use wegent_backend_rs::task_store_runtime_reads::pending_form_candidates_statement;

    // Existing user turns resolve old forms even if many assistants follow.
    mysql.execute(format!("UPDATE {table} SET result=? WHERE task_id=? AND message_id=1"), (
        Json(json!({"value": "x".repeat(64 * 1024), "blocks": [{
            "tool_name": "interactive_form_question", "tool_use_id": "old-form",
            "render_payload": {"type": "interactive_form_question", "questions": [{"id": "q"}]},
        }]})), task_id,
    )).await.unwrap();
    let rows: Vec<MysqlRow> = mysql
        .fetch_all(
            pending_form_candidates_statement(table, None),
            (task_id, task_id),
        )
        .await
        .unwrap();
    assert!(rows.is_empty());

    mysql
        .execute(
            format!("UPDATE {table} SET role='ASSISTANT' WHERE task_id=?"),
            (task_id,),
        )
        .await
        .unwrap();
    mysql
        .execute(
            format!("UPDATE {table} SET message_id=NULL WHERE id=1001"),
            (),
        )
        .await
        .unwrap();
    for index in 1..=55_i64 {
        mysql
            .execute(
                format!(
                    "INSERT INTO {table} (id,user_id,task_id,message_id,role,result) \
             VALUES (?, ?, ?, ?, 'ASSISTANT', ?)"
                ),
                (
                    5000 + index,
                    user_id,
                    task_id,
                    100 + index,
                    Json(json!({
                        "value": "x".repeat(64 * 1024),
                        "blocks": [{"tool_name": "interactive_form_question"}],
                    })),
                ),
            )
            .await
            .unwrap();
    }
    let start = super::history_window::bytes_sent(mysql).await;
    let first: Vec<MysqlRow> = mysql
        .fetch_all(
            pending_form_candidates_statement(table, None),
            (task_id, task_id),
        )
        .await
        .unwrap();
    assert_eq!(first.len(), 50);
    let second: Vec<MysqlRow> = mysql
        .fetch_all(
            pending_form_candidates_statement(table, Some(Some(106))),
            (task_id, task_id, 106_i64, 106_i64, 5006_i64),
        )
        .await
        .unwrap();
    assert_eq!(second.len(), 6);
    assert!(
        second
            .iter()
            .any(|row| row.get_required::<i64>("id").unwrap() == 1001)
    );
    let transferred = super::history_window::bytes_sent(mysql).await - start;
    assert!(
        transferred < 64 * 1024,
        "form state transferred {transferred} bytes"
    );
    mysql.execute(format!(
        "INSERT INTO {table} (id,user_id,task_id,message_id,role) VALUES (10000, ?, ?, NULL, 'USER')"
    ), (user_id, task_id)).await.unwrap();
    let null_candidates: Vec<MysqlRow> = mysql
        .fetch_all(
            pending_form_candidates_statement(table, Some(None)),
            (task_id, task_id, 1002_i64),
        )
        .await
        .unwrap();
    assert!(
        null_candidates.is_empty(),
        "the nullable user boundary must resolve the old form"
    );
    assert_pipeline_handoff_reads(mysql, task_id, table, user_id).await;
}

async fn assert_pipeline_handoff_reads(
    mysql: &MysqlService,
    task_id: i64,
    table: &str,
    user_id: i32,
) {
    use brz_mysql::{Json, MysqlRow};
    use wegent_backend_rs::task_store_runtime_reads::{
        pipeline_latest_completed_statement, pipeline_original_prompt_statement,
    };

    mysql
        .execute(
            format!(
                "INSERT INTO {table} (id,user_id,task_id,message_id,role,prompt) \
         VALUES (10001, ?, ?, 1, 'USER', 'earliest user request')"
            ),
            (user_id, task_id),
        )
        .await
        .unwrap();
    let output: MysqlRow = mysql
        .fetch_optional(pipeline_latest_completed_statement(table), (task_id,))
        .await
        .unwrap()
        .expect("latest completed output");
    assert_eq!(output.get_required::<i64>("message_id").unwrap(), 155);
    assert_eq!(
        output.get_required::<Json<Value>>("result").unwrap().0["value"]
            .as_str()
            .unwrap()
            .len(),
        64 * 1024
    );
    let prompt: MysqlRow = mysql
        .fetch_optional(
            pipeline_original_prompt_statement(table),
            (task_id, 155_i64),
        )
        .await
        .unwrap()
        .expect("original user prompt");
    assert_eq!(
        prompt.get_required::<String>("prompt").unwrap(),
        "earliest user request"
    );
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
