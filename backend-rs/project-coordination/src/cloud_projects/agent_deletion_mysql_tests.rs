//! Real permission and reference constraints for project Agent removal.
use super::agent_deletion::remove;
use brz_http_server::StatusCode;
use brz_mysql::MysqlService;
use std::time::{SystemTime, UNIX_EPOCH};

async fn verify(mysql: &MysqlService) {
    let columns = super::LOOP_ITEMS_COLUMNS
        .split(", ")
        .map(|column| {
            let name = column
                .split(" AS ")
                .next()
                .unwrap()
                .trim_start_matches("loop_items.");
            let kind = match name {
                "id" => "VARCHAR(64) PRIMARY KEY",
                "metadata" => "JSON",
                "version" | "created_by_user_id" | "sequence_number" | "next_item_number"
                | "user_id" => "BIGINT",
                "created_at" | "updated_at" | "deleted_at" => "DATETIME(6)",
                _ => "TEXT",
            };
            format!("{name} {kind}")
        })
        .collect::<Vec<_>>();
    mysql
        .execute(
            format!(
                "CREATE TABLE loop_items ({}) ENGINE=InnoDB",
                columns.join(",")
            ),
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "CREATE TABLE users (id INT PRIMARY KEY,user_name TEXT,is_active BOOL)",
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO users VALUES (7,'Owner',true),(8,'Viewer',true),(9,'Outsider',true),(10,'Maintainer',true)", ()).await.unwrap();
    mysql.execute("CREATE TABLE kinds (id BIGINT PRIMARY KEY,user_id INT,kind VARCHAR(50),name TEXT,namespace VARCHAR(100),json JSON,is_active BOOL)", ()).await.unwrap();
    mysql.execute("CREATE TABLE resource_members (id BIGINT PRIMARY KEY AUTO_INCREMENT,resource_type VARCHAR(50),resource_id BIGINT,entity_type VARCHAR(50),entity_id VARCHAR(100),role VARCHAR(50),status VARCHAR(50))", ()).await.unwrap();
    mysql.execute("INSERT INTO kinds VALUES (2001,7,'CollaborationWorkspace','Space','default',JSON_OBJECT(),true),(3001,7,'CollaborationGroup','Group','default',JSON_OBJECT('spec',JSON_OBJECT()),true),(4001,7,'Team','Shared source','default',JSON_OBJECT(),true)", ()).await.unwrap();
    mysql.execute("INSERT INTO loop_items (id,resource_type,name,status,metadata,version,created_by_user_id) VALUES ('1001','project','Project','active',JSON_OBJECT(),1,7),('agent','chat_agent','Reviewer','active',JSON_OBJECT('visibility','public','wegent_team_id',4001),1,7),('issue','task','Preserved work','in_progress',JSON_OBJECT(),1,7)", ()).await.unwrap();
    mysql.execute("UPDATE loop_items SET cloud_project_id='1001',assignee_agent_id='agent' WHERE id IN ('agent','issue')", ()).await.unwrap();
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,role,status) VALUES ('CloudProject',1001,'workspace','2001','Maintainer','approved'),('CloudProject',1001,'user','8','Viewer','approved'),('CloudProject',1001,'user','10','Maintainer','approved'),('CollaborationGroup',3001,'project','1001','Maintainer','approved')", ()).await.unwrap();
    assert_eq!(
        remove(mysql, "1001", "agent", 9, 1)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        remove(mysql, "1001", "agent", 8, 1)
            .await
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        remove(mysql, "1001", "agent", 7, 2)
            .await
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    mysql.execute("UPDATE loop_items SET metadata=JSON_SET(metadata,'$.visibility','private') WHERE id='agent'",()).await.unwrap();
    assert_eq!(
        remove(mysql, "1001", "agent", 10, 1)
            .await
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    mysql.execute("UPDATE loop_items SET metadata=JSON_SET(metadata,'$.visibility','public') WHERE id='agent'",()).await.unwrap();
    for reference_id in ["agent", "4001"] {
        for field in ["leader", "member", "stage"] {
            let spec = match field {
                "leader" => serde_json::json!({"leader":{"kind":"agent","id":reference_id}}),
                "member" => serde_json::json!({"members":[{"kind":"agent","id":reference_id}]}),
                _ => {
                    serde_json::json!({"stages":[{"assignee":{"kind":"agent","id":reference_id}}]})
                }
            };
            mysql
                .execute(
                    "UPDATE kinds SET json=JSON_OBJECT('spec',CAST(? AS JSON)) WHERE id=3001",
                    (spec.to_string(),),
                )
                .await
                .unwrap();
            let error = remove(mysql, "1001", "agent", 7, 1).await.unwrap_err();
            assert_eq!(error.status(), StatusCode::CONFLICT);
            assert!(
                error
                    .detail_message()
                    .unwrap()
                    .starts_with("PROJECT_AGENT_IN_USE")
            );
        }
    }
    mysql
        .execute(
            "UPDATE kinds SET json=JSON_OBJECT('spec',JSON_OBJECT()) WHERE id=3001",
            (),
        )
        .await
        .unwrap();
    remove(mysql, "1001", "agent", 7, 1).await.unwrap();
    let deleted: Option<(i64,)> = mysql
        .fetch_optional(
            "SELECT version FROM loop_items WHERE id='agent' AND deleted_at IS NOT NULL",
            (),
        )
        .await
        .unwrap();
    assert_eq!(deleted, Some((2,)));
    assert!(mysql.fetch_optional::<_,_,(i64,)>("SELECT version FROM loop_items WHERE id='issue' AND assignee_agent_id='agent' AND deleted_at IS NULL",()).await.unwrap().is_some());
    assert!(
        mysql
            .fetch_optional::<_, _, (i64,)>(
                "SELECT id FROM kinds WHERE id=4001 AND is_active=true",
                ()
            )
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
async fn deletion_enforces_permissions_dependencies_and_keeps_history() {
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("disposable MySQL address")
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback());
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let database = format!(
        "agent_delete_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    admin
        .execute(format!("CREATE DATABASE {database}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&database)).await.unwrap();
    let test_mysql = mysql.clone();
    let result = tokio::spawn(async move { verify(&test_mysql).await }).await;
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {database}"), ())
        .await
        .unwrap();
    result.unwrap();
}
