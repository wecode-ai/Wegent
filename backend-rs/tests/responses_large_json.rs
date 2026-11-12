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

use brz_mysql::{Json, MysqlResult, MysqlRow};
use std::{path::Path, sync::Arc};
use wegent_backend_rs::task_store::{
    DefaultTaskStore, TaskStore, assistant_subtasks_by_task_statement, order_assistant_subtasks,
    subtask_column_index,
};

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
                .with_routes_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"))
                .unwrap(),
            &[42],
            7,
            false,
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
                .with_routes_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"))
                .unwrap(),
            &[42],
            7,
            true,
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
