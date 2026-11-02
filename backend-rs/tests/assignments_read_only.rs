// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Assignment reads through the real hybrid gateway, authentication and stores.

#[path = "support/assignments_fixture.rs"]
mod data;
#[allow(dead_code)]
#[path = "support/responses_mysql.rs"]
mod fixture;
#[path = "support/assignments_http.rs"]
mod http_e2e;

use brz_mysql::{MysqlRow, MysqlService, MysqlTransaction};
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; explicitly run by Backend Rust CI"]
async fn assignments_http_preserves_access_and_results_without_index_writes() {
    let log_dir = std::env::var_os("WEGENT_E2E_LOG_DIRECTORY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("assignment-http-{}", std::process::id()))
        });
    let _logs = brz_logs::init(
        brz_logs::LogsConfig::default()
            .with_directory(&log_dir)
            .with_flush_policy(brz_logs::FlushPolicy::EveryLine),
    )
    .unwrap();
    eprintln!("Assignment E2E logs: {}", log_dir.display());
    let fixture = fixture::Fixture::new().await;
    data::seed(&fixture.mysql).await;
    let reader = data::ReadOnlyMysql::new(&fixture.mysql).await;
    let writer = data::writer(&fixture.mysql).await;
    let server = http_e2e::Server::start(reader.mysql.clone()).await;
    let receipt_server = http_e2e::Server::start(fixture.mysql.clone()).await;
    let mysql = server.mysql.clone();
    let base = server.base.clone();
    let receipt_base = receipt_server.base.clone();
    let lock_writer = writer.clone();
    let result = tokio::spawn(async move {
        assert_scenario(&base, &receipt_base, &mysql, &lock_writer).await;
    })
    .await;
    server.close().await;
    receipt_server.close().await;
    reader.close(&fixture.mysql).await;
    writer.close().await;
    fixture.close().await;
    result.unwrap();
}

async fn assert_scenario(
    base: &str,
    receipt_base: &str,
    mysql: &MysqlService,
    writer: &MysqlService,
) {
    assert_writes_denied(mysql).await;
    assert_access(base).await;
    let expected = data::expected();
    let listed = http_e2e::get(base, "issue-1", Some(7)).await;
    assert_eq!(listed, (200, expected.clone()));
    assert_eq!(http_e2e::get(base, "issue-1", Some(8)).await, listed);
    assert_eq!(
        http_e2e::get(base, "empty-issue", Some(7)).await,
        (200, json!({"items":[]}))
    );
    assert_no_index(mysql).await;
    assert_nonblocking_read(base, mysql, writer, &expected).await;
    assert_receipts(base, receipt_base, mysql, &expected).await;
    assert_writes_denied(mysql).await;
    eprintln!(
        "Assignment HTTP E2E: authentication, access, locked read, no index writes, receipt parity passed"
    );
}

async fn assert_writes_denied(mysql: &MysqlService) {
    let account: String = mysql.fetch_one("SELECT CURRENT_USER()", ()).await.unwrap();
    assert!(
        account.starts_with("assign_ro_"),
        "HTTP pool account: {account}"
    );
    for sql in [
        "INSERT INTO loop_items (id,resource_type,description,created_at,updated_at) \
         VALUES ('read-only-write-probe','comment','probe',NOW(),NOW())",
        "UPDATE loop_items SET description = description WHERE id = 'issue-1'",
        "DELETE FROM loop_items WHERE id = 'read-only-write-probe'",
    ] {
        let error = mysql
            .execute(sql, ())
            .await
            .expect_err("HTTP pool must reject writes");
        assert_eq!(error.database_code(), Some(1142), "{error}");
        eprintln!(
            "Assignment HTTP pool negative control: {} denied with MySQL 1142",
            sql.split_whitespace().next().unwrap()
        );
    }
}

async fn assert_access(base: &str) {
    assert_eq!(
        http_e2e::get(base, "issue-1", None).await,
        (401, json!({"detail":"Missing authentication credentials"}))
    );
    for credential in ["invalid-session".to_owned(), http_e2e::token(7, -3600)] {
        let response = http_e2e::request(base, "GET", "issue-1", Some(&credential), None).await;
        assert_eq!(response.0, 401);
    }
    for (issue, user, detail) in [
        ("issue-1", 9, "Cloud project not found"),
        ("private-issue", 8, "Issue not found"),
        ("missing-issue", 7, "Issue not found"),
    ] {
        assert_eq!(
            http_e2e::get(base, issue, Some(user)).await,
            (404, json!({"detail":detail}))
        );
    }
    assert_eq!(
        http_e2e::get(base, "private-issue", Some(7)).await,
        (200, json!({"items":[]}))
    );
}

async fn assert_no_index(mysql: &MysqlService) {
    let row: MysqlRow = mysql
        .fetch_one(
            "SELECT COUNT(*) AS n FROM loop_items WHERE resource_type = 'assignment_index'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(
        row.get_required::<i64>("n").unwrap(),
        0,
        "GET must not initialize persistent index nodes"
    );
}

async fn assert_nonblocking_read(
    base: &str,
    mysql: &MysqlService,
    writer: &MysqlService,
    expected: &Value,
) {
    writer.with_transaction(async |tx| {
        let _: Vec<MysqlRow> = tx.fetch_all(
            "SELECT id FROM loop_items WHERE id = 'issue-1' OR loop_item_id = 'issue-1' FOR UPDATE", (),
        ).await?;
        // This HTTP response must finish before the writer releases its locks.
        assert_eq!(http_e2e::get(base, "issue-1", Some(7)).await, (200, expected.clone()));
        assert_no_index(mysql).await;
        Ok(())
    }).await.unwrap();
}

async fn assert_receipts(base: &str, receipt_base: &str, mysql: &MysqlService, expected: &Value) {
    let receipt = http_e2e::request(
        receipt_base,
        "POST",
        "issue-1/assignments/102/receipt",
        Some(&http_e2e::token(7, 300)),
        Some(json!({"kind":"human_read"})),
    )
    .await;
    assert_eq!(receipt, (200, json!({"acknowledged":true})));
    let row: MysqlRow = mysql
        .fetch_one(
            "SELECT COUNT(*) AS n FROM loop_items WHERE resource_type = 'assignment_index'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(
        row.get_required::<i64>("n").unwrap(),
        3,
        "receipt writes still initialize the active index"
    );
    let denied = http_e2e::request(
        receipt_base,
        "POST",
        "issue-1/assignments/102/receipt",
        Some(&http_e2e::token(8, 300)),
        Some(json!({"kind":"human_read"})),
    )
    .await;
    assert_eq!(
        denied,
        (
            403,
            json!({"detail":"Only the recipient can acknowledge an assignment"})
        )
    );
    assert_eq!(
        http_e2e::get(base, "issue-1", Some(7)).await,
        (200, expected.clone()),
        "initialized and legacy Issues preserve the full response and first receipt timestamps"
    );
}
