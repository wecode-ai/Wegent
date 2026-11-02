// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The actual gateway checks Issue access before changing a subscription.
#[path = "support/assignments_fixture.rs"]
#[allow(dead_code)]
mod data;
#[allow(dead_code)]
#[path = "support/responses_mysql.rs"]
mod fixture;
#[path = "support/assignments_http.rs"]
#[allow(dead_code)]
mod http_e2e;

use brz_mysql::MysqlRow;
use serde_json::json;

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; explicitly run by Backend Rust CI"]
async fn follow_requires_current_issue_access_and_never_changes_assignment() {
    let fixture = fixture::Fixture::new().await;
    data::seed(&fixture.mysql).await;
    fixture.mysql.execute(
        "CREATE TABLE issue_followers (issue_id VARCHAR(64) NOT NULL, user_id INT NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY(issue_id,user_id)) ENGINE=InnoDB", (),
    ).await.unwrap();
    let server = http_e2e::Server::start(fixture.mysql.clone()).await;
    let viewer = http_e2e::token(8, 300);
    let outsider = http_e2e::token(9, 300);
    let call = |issue: &'static str, credential: &str, following| {
        let path = format!("{issue}/follow");
        let credential = credential.to_owned();
        let base = server.base.clone();
        async move {
            http_e2e::request(
                &base,
                "PUT",
                &path,
                Some(&credential),
                Some(json!({"following":following})),
            )
            .await
        }
    };
    assert_eq!(
        call("issue-1", &viewer, true).await,
        (200, json!({"following":true}))
    );
    let row: MysqlRow = fixture
        .mysql
        .fetch_one(
            "SELECT assignee_user_id FROM loop_items WHERE id='issue-1'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(row.get::<i32>("assignee_user_id").unwrap(), None);
    let count: i64 = fixture
        .mysql
        .fetch_one(
            "SELECT COUNT(*) FROM issue_followers WHERE issue_id='issue-1' AND user_id=8",
            (),
        )
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(call("issue-1", &viewer, true).await.0, 200);
    assert_eq!(call("private-issue", &viewer, true).await.0, 404);
    assert_eq!(call("issue-1", &outsider, true).await.0, 404);
    assert_eq!(
        call("issue-1", &viewer, false).await,
        (200, json!({"following":false}))
    );
    let count: i64 = fixture
        .mysql
        .fetch_one(
            "SELECT COUNT(*) FROM issue_followers WHERE issue_id='issue-1'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(count, 0);
    fixture
        .mysql
        .execute(
            "UPDATE loop_items SET deleted_at=NOW() WHERE id='issue-1'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(call("issue-1", &viewer, true).await.0, 404);
    server.close().await;
    fixture.close().await;
}
