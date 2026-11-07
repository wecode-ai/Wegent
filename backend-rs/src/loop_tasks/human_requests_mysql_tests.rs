//! The recipient index and the canonical Issue question commit atomically.
use super::*;
use brz_mysql::MysqlService;
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn questions_and_recipient_index_survive_transfer_and_rollback() {
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture")
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback(), "use a disposable fixture");
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let database = format!(
        "human_requests_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    admin
        .execute(format!("CREATE DATABASE `{database}`"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&database)).await.unwrap();
    mysql
        .execute(
            include_str!("../../tests/fixtures/loop_items_nullable.sql"),
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,description,metadata,created_at,updated_at) VALUES ('issue','task','1','',JSON_OBJECT('unrelated',true),NOW(),NOW())",()).await.unwrap();
    let mut questions = vec![
        json!({"id":"question","status":"pending","recipient_user_id":7,"responsible_user_id":9,"version":1}),
        json!({"id":"resolved","status":"resolved","recipient_user_id":7}),
    ];
    mysql
        .with_transaction(async |tx| save_requests(tx, "issue", &questions).await)
        .await
        .unwrap();
    #[derive(FromMysqlRow)]
    struct Row {
        metadata: Json<Value>,
    }
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let row: Row = mysql
        .fetch_one("SELECT metadata FROM loop_items WHERE id='issue'", ())
        .await
        .unwrap();
    assert!(
        row.metadata.0["human_requests"].is_array(),
        "JSON_SET must store an array, not a JSON string"
    );
    assert_eq!(row.metadata.0["unrelated"], true);
    let count:Count = mysql.fetch_one("SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='human_request_index' AND assignee_user_id=7",()).await.unwrap();
    assert_eq!(count.count, 1);
    questions[0]["recipient_user_id"] = json!(8);
    questions[0]["version"] = json!(2);
    mysql
        .with_transaction(async |tx| save_requests(tx, "issue", &questions).await)
        .await
        .unwrap();
    let count:Count = mysql.fetch_one("SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='human_request_index' AND assignee_user_id=7",()).await.unwrap();
    assert_eq!(count.count, 0);
    let count:Count = mysql.fetch_one("SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='human_request_index' AND assignee_user_id=8",()).await.unwrap();
    assert_eq!(count.count, 1);
    let rollback = mysql
        .with_transaction(async |tx| {
            save_requests(tx, "issue", &[]).await?;
            tx.execute(
                "INSERT INTO deliberately_missing_handoff_table VALUES (1)",
                (),
            )
            .await?;
            Ok(())
        })
        .await;
    assert!(rollback.is_err());
    let row: Row = mysql
        .fetch_one("SELECT metadata FROM loop_items WHERE id='issue'", ())
        .await
        .unwrap();
    assert_eq!(row.metadata.0["human_requests"], json!(questions));
    let count:Count = mysql.fetch_one("SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='human_request_index' AND assignee_user_id=8",()).await.unwrap();
    assert_eq!(count.count, 1);
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE `{database}`"), ())
        .await
        .unwrap();
    admin.close().await;
}
