//! The recipient index and the canonical Issue question commit atomically.
use super::*;
use brz_mysql::MysqlService;
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn report_and_flag_require_a_real_caller_owned_source_device() {
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture")
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback(), "use a disposable fixture");
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let database = format!(
        "human_requests_source_{}",
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
    mysql.execute(
        "CREATE TABLE kinds (id BIGINT PRIMARY KEY,user_id INT,kind VARCHAR(64),name VARCHAR(100),namespace VARCHAR(100),json JSON,is_active TINYINT,created_at DATETIME,updated_at DATETIME)",
        (),
    ).await.unwrap();
    mysql.execute(
        "INSERT INTO kinds VALUES (1,9,'Device','reporter-device','default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','app','appDeviceId','reporter-route')),1,NOW(),NOW()),(2,7,'Device','foreign-device','default',JSON_OBJECT(),1,NOW(),NOW()),(3,9,'Device','inactive-device','default',JSON_OBJECT(),0,NOW(),NOW()),(4,9,'Device','other-namespace','other',JSON_OBJECT(),1,NOW(),NOW())",
        (),
    ).await.unwrap();
    // Both HTTP mutation branches call this guard before matching source strings.
    for (user, device) in [
        (9, "missing-device"),
        (9, "foreign-device"),
        (7, "reporter-device"),
        (9, "inactive-device"),
        (9, "other-namespace"),
    ] {
        let failure = owned_source_devices(&mysql, user, device)
            .await
            .unwrap_err();
        assert_eq!(failure.status(), StatusCode::FORBIDDEN);
    }
    let aliases = owned_source_devices(&mysql, 9, "reporter-route")
        .await
        .unwrap();
    assert!(aliases.iter().any(|id| id == "app-record-1"));
    assert!(aliases.iter().any(|id| id == "reporter-device"));
    mysql.execute(
        "CREATE TABLE loop_item_executions (id BIGINT PRIMARY KEY,cloud_project_id VARCHAR(64),loop_item_id VARCHAR(64),executor_owner_user_id BIGINT,runtime_device_id VARCHAR(100),runtime_task_id VARCHAR(100))",
        (),
    ).await.unwrap();
    mysql.execute(
        "INSERT INTO loop_item_executions VALUES (1,'project','issue',9,'app-record-1','task'),(2,'project','issue',7,'reporter-device','task'),(3,'project','issue',9,'foreign-device','task')",
        (),
    ).await.unwrap();
    for (execution_id, project_id, issue_id, task_id, device_id, status) in [
        (
            Some(2),
            "project",
            "issue",
            "task",
            "reporter-device",
            StatusCode::FORBIDDEN,
        ),
        (
            Some(1),
            "other-project",
            "issue",
            "task",
            "reporter-device",
            StatusCode::CONFLICT,
        ),
        (
            Some(1),
            "project",
            "other-issue",
            "task",
            "reporter-device",
            StatusCode::CONFLICT,
        ),
        (
            Some(1),
            "project",
            "issue",
            "other-task",
            "reporter-device",
            StatusCode::CONFLICT,
        ),
        (
            Some(1),
            "project",
            "issue",
            "task",
            "foreign-device",
            StatusCode::CONFLICT,
        ),
        (
            Some(3),
            "project",
            "issue",
            "task",
            "reporter-device",
            StatusCode::CONFLICT,
        ),
        (
            None,
            "project",
            "issue",
            "task",
            "reporter-device",
            StatusCode::CONFLICT,
        ),
    ] {
        let failure = require_runtime(
            &mysql,
            9,
            RuntimeEvidence {
                execution_id,
                project_id,
                issue_id,
                task_id,
                device_id,
            },
            &aliases,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.status(), status);
    }
    let source_execution_id = require_runtime(
        &mysql,
        9,
        RuntimeEvidence {
            execution_id: Some(1),
            project_id: "project",
            issue_id: "issue",
            task_id: "task",
            device_id: "reporter-device",
        },
        &aliases,
    )
    .await
    .unwrap();
    let payload: BlockingUpdate = serde_json::from_value(json!({
        "operation":"set_blocking","version":3,"blocks_progress":true,
        "runtime_device_id":"reporter-route","runtime_task_id":"task",
    }))
    .unwrap();
    let mut question = json!({
        "reported_by_user_id":9,"runtime_device_id":"app-record-1","runtime_task_id":"task",
        "status":"pending","version":3,"recipient_user_id":7,"waiting_since":"original-handoff",
        "source_execution_id":source_execution_id,
    });
    assert!(update_blocking(&mut question, 9, &payload, &aliases, "now"));
    assert_eq!(question["recipient_user_id"], 7);
    assert_eq!(question["waiting_since"], "original-handoff");
    assert_eq!(question["blocks_progress"], true);
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE `{database}`"), ())
        .await
        .unwrap();
    admin.close().await;
}

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
    mysql.execute("CREATE TABLE wework_notifications (id INT PRIMARY KEY,user_id BIGINT NOT NULL,is_read BOOLEAN NOT NULL DEFAULT FALSE,read_status_changed_at DATETIME,payload JSON,created_at DATETIME,INDEX idx_wework_notifications_inbox(user_id,created_at,id))",()).await.unwrap();
    mysql.execute("INSERT INTO wework_notifications(id,user_id,is_read,payload) VALUES (1,7,FALSE,JSON_OBJECT('humanRequestId','question')),(2,8,FALSE,JSON_OBJECT('humanRequestId','question')),(3,7,FALSE,JSON_OBJECT('humanRequestId','other-question'))",()).await.unwrap();
    mysql
        .with_transaction(async |tx| acknowledge_previous_recipient(tx, 7, "question").await)
        .await
        .unwrap();
    let count: Count = mysql
        .fetch_one(
            "SELECT COUNT(*) AS count FROM wework_notifications WHERE id=1 AND is_read=true",
            (),
        )
        .await
        .unwrap();
    assert_eq!(count.count, 1);
    let count:Count = mysql.fetch_one("SELECT COUNT(*) AS count FROM wework_notifications WHERE id IN (2,3) AND is_read=false",()).await.unwrap();
    assert_eq!(count.count, 2);
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE `{database}`"), ())
        .await
        .unwrap();
    admin.close().await;
}
