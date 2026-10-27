// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real MySQL coverage for handoff title search across owned-task pages.

use std::time::{SystemTime, UNIX_EPOCH};

use brz_mysql::MysqlService;

use super::*;
use crate::task_store::DefaultTaskStore;

async fn create_tasks_table(mysql: &MysqlService) {
    mysql
        .execute(
            "CREATE TABLE tasks (
                id BIGINT NOT NULL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                kind VARCHAR(32) NOT NULL,
                name VARCHAR(255) NOT NULL,
                namespace VARCHAR(64) NOT NULL,
                json JSON NOT NULL,
                is_active TINYINT NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                project_id BIGINT NOT NULL DEFAULT 0,
                client_origin VARCHAR(32) NULL,
                is_group_chat TINYINT NOT NULL DEFAULT 0
            )",
            (),
        )
        .await
        .unwrap();
}

/// Inserts one owned task. `age` orders `created_at`, so a larger age is older.
async fn insert_task(mysql: &MysqlService, id: i64, user_id: i64, title: &str, age_seconds: i64) {
    let document = json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": format!("task-{id}"),
            "namespace": "default",
            "labels": { "type": "online", "taskType": "chat" }
        },
        "spec": { "title": title },
        "status": { "status": "COMPLETED" }
    })
    .to_string();
    let created_at = chrono::DateTime::from_timestamp(1_700_000_000 - age_seconds, 0)
        .expect("fixed timestamp")
        .naive_utc();
    mysql
        .execute(
            "INSERT INTO tasks
                (id, user_id, kind, name, namespace, json, is_active,
                 created_at, updated_at, project_id, client_origin, is_group_chat)
             VALUES (?, ?, 'Task', ?, 'default', ?, 1, ?, ?, 0, 'frontend', 0)",
            (
                id,
                user_id,
                format!("task-{id}"),
                document,
                created_at,
                created_at,
            ),
        )
        .await
        .unwrap();
}

async fn with_disposable_database<F, Fut>(run: F)
where
    F: FnOnce(MysqlService) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let name = format!(
        "tasks_search_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&name)).await.unwrap();
    create_tasks_table(&mysql).await;

    let test_mysql = mysql.clone();
    let result = tokio::spawn(async move {
        run(test_mysql).await;
    })
    .await;

    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    admin.close().await;
    result.unwrap();
}

/// The reported case: one thousand-plus owned conversations, and the match sits
/// beyond the first scanned page. The store returns rows in id order, so the
/// title match must still be found and selected.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn finds_a_title_match_beyond_the_first_owned_page() {
    with_disposable_database(|mysql| async move {
        for index in 0..206 {
            let id = 1_000 + index;
            let title = if index == 0 {
                "handoff history token"
            } else {
                "filler conversation"
            };
            insert_task(&mysql, id, 7, title, 10_000 - index).await;
        }
        let store = DefaultTaskStore::new(mysql);
        let source = StoreOwnedTaskSearchSource { store: &store };

        let found = search_owned_task_ids(&source, 7, "handoff history token", 0, 20)
            .await
            .unwrap();

        assert_eq!(found.total, 1);
        assert_eq!(found.ids, vec![1_000]);
    })
    .await;
}

/// `list_tasks_by_ids` only filters by id, so MySQL hands back ascending ids.
/// The requested page must still be the newest matches from the id page.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn selects_the_newest_matches_when_storage_order_is_ascending() {
    with_disposable_database(|mysql| async move {
        for index in 0..30 {
            let id = 2_000 + index;
            insert_task(&mysql, id, 7, "cloud host install", 10_000 - index).await;
        }
        let store = DefaultTaskStore::new(mysql);
        let source = StoreOwnedTaskSearchSource { store: &store };

        let first = search_owned_task_ids(&source, 7, "cloud host install", 0, 20)
            .await
            .unwrap();
        assert_eq!(first.total, 30);
        assert_eq!(
            first.ids,
            (0..20).rev().map(|index| 2_010 + index).collect::<Vec<_>>()
        );

        let second = search_owned_task_ids(&source, 7, "cloud host install", 20, 20)
            .await
            .unwrap();
        assert_eq!(
            second.ids,
            (0..10).rev().map(|index| 2_000 + index).collect::<Vec<_>>()
        );
    })
    .await;
}
