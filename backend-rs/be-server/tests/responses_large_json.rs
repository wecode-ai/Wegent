// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[path = "support/responses_mysql.rs"]
mod fixture;
#[path = "support/responses_http.rs"]
mod http_e2e;
#[path = "support/llm_proxy_deadlines.rs"]
mod llm_proxy_deadlines;
#[path = "support/llm_proxy_timeouts.rs"]
mod llm_proxy_timeouts;
#[path = "support/streaming_block_index_http.rs"]
mod streaming_block_index;
#[path = "support/responses_terminal_storage.rs"]
mod terminal_storage;

use brz_mysql::{Json, MysqlResult, MysqlRow};
use std::{path::Path, sync::Arc};
use wegent_backend_rs::task_store::{
    DefaultTaskStore, TaskStore, TaskStoreCreate, assistant_subtasks_by_task_statement,
    order_assistant_subtasks, subtask_column_index,
};

#[tokio::test]
#[ignore = "requires disposable MySQL 8 and Redis; CI runs the Responses HTTP E2E suite"]
async fn long_streaming_turn_preserves_indexed_blocks_through_http_completion() {
    let fixture = fixture::Fixture::new().await;
    streaming_block_index::verify(&fixture).await;
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn assistant_subtasks_preserve_large_results_and_nullable_message_order() {
    let fixture = fixture::Fixture::new().await;
    for table in ["subtasks", "subtasks_0007"] {
        fixture.seed(table, 42, 7).await;
        fixture
            .mysql
            .execute(
                format!(
                    "INSERT INTO {table} (id,user_id,task_id,message_id,role,result,created_at) VALUES \
                     (50,7,42,NULL,'ASSISTANT',JSON_OBJECT('value','null message'),'2026-01-01'), \
                     (60,7,42,1,'ASSISTANT',JSON_OBJECT('value','same message'),'2026-01-02'), \
                     (70,7,42,-1,'USER',JSON_OBJECT('value','excluded role'),'2026-01-01'), \
                     (80,7,42,1,'ASSISTANT',JSON_OBJECT('value','null created'),NULL)"
                ),
                (),
            )
            .await
            .unwrap();
        fixture
            .mysql
            .execute(
                format!("UPDATE {table} SET created_at='2026-01-03' WHERE id=20"),
                (),
            )
            .await
            .unwrap();
        let statement = assistant_subtasks_by_task_statement(table);
        let original: MysqlResult<Vec<MysqlRow>> = fixture
            .mysql
            .fetch_all(
                format!("{statement} ORDER BY {table}.message_id ASC"),
                (42_i64,),
            )
            .await;
        let error = original.expect_err("full JSON filesort must reproduce MySQL 1038");
        assert!(error.to_string().contains("1038"), "{error}");
        let rows: Vec<MysqlRow> = fixture.mysql.fetch_all(statement, (42_i64,)).await.unwrap();
        let id_index = subtask_column_index("id").unwrap();
        let message_index = subtask_column_index("message_id").unwrap();
        let duplicate_order: Vec<i64> = rows
            .iter()
            .filter(|row| row.get_at::<Option<i64>>(message_index).unwrap() == Some(1))
            .map(|row| row.get_at(id_index).unwrap())
            .collect();
        let rows = order_assistant_subtasks(rows).unwrap();
        let ids: Vec<i64> = rows
            .iter()
            .map(|row| row.get_at(id_index).unwrap())
            .collect();
        let mut expected = vec![50, 30];
        expected.extend(duplicate_order);
        expected.push(10);
        assert_eq!(ids, expected);
        let result: Json<serde_json::Value> = rows
            .last()
            .unwrap()
            .get_at(subtask_column_index("result").unwrap())
            .unwrap();
        assert_eq!(
            result.0["value"].as_str().unwrap().len(),
            fixture::LARGE_RESULT_BYTES
        );
    }
    let store = DefaultTaskStore::new(fixture.mysql.clone());
    let listing = store.list_subtasks_by_task_ordered(42, 7).await.unwrap();
    assert_task_detail_message_order(&listing.rows);
    fixture
        .mysql
        .with_transaction(async |mut transaction| {
            let listing = store
                .list_subtasks_by_task_ordered_on(&mut transaction, 42, 7)
                .await?;
            assert_task_detail_message_order(&listing.rows);
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn history_candidates_materialize_keys_before_sorting_large_json() {
    use wegent_backend_rs::task_store::SubtaskHistoryWindow;
    use wegent_backend_rs::task_store_history::HistorySelection;

    let fixture = fixture::Fixture::new().await;
    http_e2e::seed_task(&fixture.mysql, "tasks", 42, 7).await;
    let store = DefaultTaskStore::new(fixture.mysql.clone());
    for table in ["subtasks", "subtasks_0007"] {
        fixture.seed(table, 42, 7).await;
        fixture
            .mysql
            .execute(
                format!(
                    "ALTER TABLE {table} DROP INDEX idx_task_id, \
             ADD INDEX idx_task_message (task_id, message_id)"
                ),
                (),
            )
            .await
            .unwrap();
        let tables = wegent_backend_rs::task_store_tables::TableTemplates {
            tasks: "tasks",
            subtasks: table,
        };
        for selection in [
            HistorySelection::Ready,
            HistorySelection::All,
            HistorySelection::Cache,
        ] {
            let window = SubtaskHistoryWindow {
                limit: 2,
                before_message_id: Some(3),
                summary_checkpoint_only: false,
                selection,
            };
            let start = history_candidate_bytes_sent(&fixture.mysql).await;
            let mut sql = &fixture.mysql;
            let candidates = wegent_backend_rs::task_store_history::history_candidates_on(
                &mut sql,
                tables,
                42,
                Some(7),
                window,
                wegent_backend_rs::request_sql::RouteKey::Task(42),
            )
            .await
            .unwrap();
            assert_eq!(
                candidates.iter().map(|row| row.id).collect::<Vec<_>>(),
                [10, 20]
            );
            let bytes = history_candidate_bytes_sent(&fixture.mysql).await - start;
            assert!(
                bytes < 32 * 1024,
                "candidate query transferred {bytes} bytes"
            );
        }
    }
    // The production store must retain its task ownership guard.
    let mut sql = &fixture.mysql;
    let rows = store
        .list_subtasks_history_window_on(
            &mut sql,
            42,
            8,
            SubtaskHistoryWindow {
                limit: 2,
                before_message_id: Some(3),
                summary_checkpoint_only: false,
                selection: HistorySelection::Cache,
            },
        )
        .await
        .unwrap();
    assert!(rows.is_empty());
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn executor_sessions_rank_metadata_without_sorting_large_results() {
    let fixture = fixture::Fixture::new().await;
    for table in ["subtasks", "subtasks_0007"] {
        fixture.seed(table, 42, 7).await;
        for message in 3..=11_i64 {
            fixture
                .mysql
                .execute(
                    format!(
                        "INSERT INTO {table} (id,user_id,task_id,message_id) VALUES (?,7,42,?)"
                    ),
                    (2000 + message, message),
                )
                .await
                .unwrap();
        }
        // An older duplicate must be excluded after ranking even when its
        // conversation result is larger than MySQL's session sort buffer.
        fixture
            .mysql
            .execute(
                format!("UPDATE {table} SET result=? WHERE task_id=42 AND message_id=0"),
                (Json(serde_json::json!({
                    "value": "x".repeat(fixture::LARGE_RESULT_BYTES),
                    "executor_session": {
                        "agent": "Codex", "botId": 23, "thread_id": "legacy-2",
                    },
                })),),
            )
            .await
            .unwrap();
        http_e2e::subscription_history_window::assert_session_identifiers(
            &fixture.mysql,
            42,
            table,
        )
        .await;
    }
    fixture.close().await;
}

async fn history_candidate_bytes_sent(mysql: &brz_mysql::MysqlService) -> u64 {
    let rows: Vec<MysqlRow> = mysql
        .fetch_all("SHOW SESSION STATUS LIKE 'Bytes_sent'", ())
        .await
        .unwrap();
    rows[0]
        .get_required::<String>("Value")
        .unwrap()
        .parse()
        .unwrap()
}

fn assert_task_detail_message_order(rows: &[MysqlRow]) {
    let ids: Vec<i64> = rows
        .iter()
        .map(|row| row.get_required("id").unwrap())
        .collect();
    assert_eq!(ids, [50, 70, 30, 80, 60, 20, 10]);
    let result: Json<serde_json::Value> = rows.last().unwrap().get_required("result").unwrap();
    assert_eq!(
        result.0["value"].as_str().unwrap().len(),
        fixture::LARGE_RESULT_BYTES
    );
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn responses_mysql_large_json_preserves_message_order_and_owner_filter() {
    let fixture = fixture::Fixture::new().await;
    fixture.seed("subtasks", 42, 7).await;
    fixture.assert_original_query_fails("subtasks", 42, 7).await;
    let store = Arc::new(DefaultTaskStore::new(fixture.mysql.clone()));
    let result = fixture::assert_large_json_read(store.as_ref(), 42, 7).await;
    if result.is_ok() {
        http_e2e::seed_task(&fixture.mysql, "tasks", 42, 7).await;
        http_e2e::assert_http_reads(
            fixture.mysql.clone(),
            store,
            http_e2e::runtime_config()
                .with_routes_file(
                    &Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml"),
                )
                .unwrap(),
            &[42],
            7,
            false,
            &["subtasks"],
        )
        .await;
    }
    fixture.close().await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn responses_mysql_long_conversation_exceeds_prepared_statement_limit() {
    let fixture = fixture::Fixture::new().await;
    fixture.seed_long_conversation("subtasks", 42, 7).await;
    let store = Arc::new(DefaultTaskStore::new(fixture.mysql.clone()));
    let result = fixture::assert_long_conversation_read(store.as_ref(), 42, 7).await;
    if result.is_ok() {
        http_e2e::seed_task(&fixture.mysql, "tasks", 42, 7).await;
        http_e2e::assert_http_reads(
            fixture.mysql.clone(),
            store,
            http_e2e::runtime_config()
                .with_routes_file(
                    &Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml"),
                )
                .unwrap(),
            &[42],
            7,
            true,
            &["subtasks"],
        )
        .await;
    }
    fixture.close().await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8 and Redis; run explicitly in the Backend Rust CI job"]
async fn terminal_callback_rolls_back_retries_and_ignores_a_late_error() {
    let fixture = fixture::Fixture::new().await;
    let (task_id, subtask_id, user_id) = (141, 142, 7);
    http_e2e::seed_task(&fixture.mysql, "tasks", task_id, user_id).await;
    fixture
        .seed_running_subtask(task_id, subtask_id, user_id)
        .await;
    fixture
        .mysql
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'RUNNING') WHERE id = ?",
            (task_id,),
        )
        .await
        .unwrap();
    http_e2e::assert_terminal_callback_atomic(&fixture.mysql, task_id, subtask_id).await;
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8 and Redis; run explicitly in the Backend Rust CI job"]
async fn terminal_callbacks_and_recovery_use_the_migrated_tables() {
    let fixture = fixture::Fixture::new().await;
    terminal_storage::verify(&fixture).await;
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn pipeline_retry_resumes_the_committed_pair_without_inserting_again() {
    let fixture = fixture::Fixture::new().await;
    let mysql = &fixture.mysql;
    let (task_id, subtask_id, user_id) = (151, 152, 7);
    http_e2e::seed_task(mysql, "tasks", task_id, user_id).await;
    fixture
        .seed_running_subtask(task_id, subtask_id, user_id)
        .await;
    mysql
        .execute(
            "CREATE TABLE kinds (
            id BIGINT PRIMARY KEY, user_id INT, kind VARCHAR(20), name VARCHAR(100),
            namespace VARCHAR(100), json JSON, is_active TINYINT,
            created_at DATETIME, updated_at DATETIME)",
            (),
        )
        .await
        .unwrap();
    let team = serde_json::json!({"spec":{
        "collaborationModel":"pipeline",
        "members":[
            {"botRef":{"name":"stage-one"},"contextPassing":"previous_bot"},
            {"botRef":{"name":"stage-two"}}
        ]
    }});
    mysql
        .execute(
            "INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active) VALUES
         (81,?,'Team','fixture-pipeline','default',?,1),
         (82,?,'Bot','stage-one','default',JSON_OBJECT(),1),
         (83,?,'Bot','stage-two','default',JSON_OBJECT(),1)",
            (user_id, team.to_string(), user_id, user_id),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "UPDATE tasks SET json = JSON_SET(json, '$.status.status', 'PENDING', '$.spec', JSON_OBJECT(
            'teamRef',JSON_OBJECT('name','fixture-pipeline','namespace','default','user_id',?),
            'currentStage',0)) WHERE id = ?",
            (user_id, task_id),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "UPDATE subtasks SET status='COMPLETED',bot_ids=JSON_ARRAY(82),
            result=JSON_OBJECT('value','first stage output') WHERE id=?",
            (subtask_id,),
        )
        .await
        .unwrap();
    let store = DefaultTaskStore::new(mysql.clone());
    let advance = async || {
        store
            .advance_pipeline_stage(mysql, task_id, subtask_id)
            .await
            .unwrap()
    };
    let first = advance().await.unwrap();
    let retry = advance().await.unwrap();
    assert_eq!(first.pair.user_subtask_id, retry.pair.user_subtask_id);
    assert_eq!(
        first.pair.assistant_subtask_id,
        retry.pair.assistant_subtask_id
    );
    assert_eq!(first.message, "Previous stage output:\nfirst stage output");
    assert_eq!(first.message, retry.message);
    assert_eq!(retry.task_json["spec"]["currentStage"], 1);
    let count: i64 = mysql
        .fetch_one("SELECT COUNT(*) FROM subtasks WHERE task_id=?", (task_id,))
        .await
        .unwrap();
    assert_eq!(count, 3);
    mysql
        .execute(
            "UPDATE subtasks SET status='RUNNING' WHERE id=?",
            (retry.pair.assistant_subtask_id,),
        )
        .await
        .unwrap();
    let after_claim = advance()
        .await
        .expect("recover after committed RUNNING claim");
    assert_eq!(
        first.pair.assistant_subtask_id,
        after_claim.pair.assistant_subtask_id
    );
    mysql
        .execute(
            "UPDATE subtasks SET status='COMPLETED' WHERE id=?",
            (after_claim.pair.assistant_subtask_id,),
        )
        .await
        .unwrap();
    assert!(advance().await.is_none());
    fixture.close().await;
}
