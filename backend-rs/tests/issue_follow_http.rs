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
    fixture.mysql.execute("UPDATE loop_items SET metadata=JSON_OBJECT('reporter_user_id',7,'tags',JSON_ARRAY('retained')) WHERE id='issue-1'", ()).await.unwrap();
    let server = http_e2e::Server::start(fixture.mysql.clone()).await;
    let viewer = http_e2e::token(8, 300);
    let outsider = http_e2e::token(9, 300);
    let owner = http_e2e::token(7, 300);
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
            "SELECT JSON_LENGTH(JSON_EXTRACT(metadata,'$.follower_user_ids')) FROM loop_items WHERE id='issue-1'",
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
            "SELECT JSON_LENGTH(JSON_EXTRACT(metadata,'$.follower_user_ids')) FROM loop_items WHERE id='issue-1'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(count, 0);
    let row: MysqlRow = fixture
        .mysql
        .fetch_one("SELECT metadata FROM loop_items WHERE id='issue-1'", ())
        .await
        .unwrap();
    let metadata: brz_mysql::Json<serde_json::Value> = row.get_required("metadata").unwrap();
    assert_eq!(metadata.0["reporter_user_id"], 7);
    assert_eq!(metadata.0["tags"], json!(["retained"]));
    assert_eq!(metadata.0["follower_since"], json!({}));
    let (first, second) = tokio::join!(
        call("issue-1", &owner, true),
        call("issue-1", &viewer, true)
    );
    assert_eq!(first.0, 200);
    assert_eq!(second.0, 200);
    let row: MysqlRow = fixture
        .mysql
        .fetch_one("SELECT metadata FROM loop_items WHERE id='issue-1'", ())
        .await
        .unwrap();
    let both: brz_mysql::Json<serde_json::Value> = row.get_required("metadata").unwrap();
    let mut users = both.0["follower_user_ids"].as_array().unwrap().clone();
    users.sort_by_key(|user| user.as_i64());
    assert_eq!(users, vec![json!(7), json!(8)]);
    assert!(both.0["follower_since"]["7"].is_i64());
    assert!(both.0["follower_since"]["8"].is_i64());
    assert_eq!(call("issue-1", &viewer, true).await.0, 200);
    let row: MysqlRow = fixture
        .mysql
        .fetch_one("SELECT metadata FROM loop_items WHERE id='issue-1'", ())
        .await
        .unwrap();
    let repeated: brz_mysql::Json<serde_json::Value> = row.get_required("metadata").unwrap();
    assert_eq!(repeated.0, both.0);
    assert_eq!(call("issue-1", &viewer, false).await.0, 200);
    let row: MysqlRow = fixture
        .mysql
        .fetch_one("SELECT metadata FROM loop_items WHERE id='issue-1'", ())
        .await
        .unwrap();
    let remaining: brz_mysql::Json<serde_json::Value> = row.get_required("metadata").unwrap();
    assert_eq!(remaining.0["follower_user_ids"], json!([7]));
    assert_eq!(
        remaining.0["follower_since"]["7"],
        both.0["follower_since"]["7"]
    );
    assert!(remaining.0["follower_since"]["8"].is_null());
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
