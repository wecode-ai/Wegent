//! Real InnoDB contracts; the fixture owns and removes one isolated schema.
use super::state;
use anyhow::{Context, Result};
use brz_mysql::{Json, MysqlService, MysqlTransaction};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::panic::AssertUnwindSafe;

#[tokio::test]
#[ignore = "requires SUBSCRIPTION_TEST_MYSQL_URL pointing to a disposable loopback MySQL 8 /mysql fixture"]
async fn terminal_projection_and_statistics_commit_exactly_once() -> Result<()> {
    let raw =
        std::env::var("SUBSCRIPTION_TEST_MYSQL_URL").context("Set disposable MySQL fixture URL")?;
    let mut url = url::Url::parse(&raw)?;
    assert_eq!(url.scheme(), "mysql");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/mysql");
    assert!(url.port().is_some());
    let admin = MysqlService::connect(url.as_str()).await?;
    let name = format!(
        "subscription_tx_{}",
        super::super::project::notifications::uuid().replace('-', "")
    );
    ddl(&admin, &format!("CREATE DATABASE {name}")).await?;
    url.set_path(&name);
    let mysql = MysqlService::connect(url.as_str()).await?;
    let result = AssertUnwindSafe(verify(&mysql)).catch_unwind().await;
    ddl(&admin, &format!("DROP DATABASE {name}")).await?;
    result.expect("subscription transaction contract panicked")
}
async fn ddl(mysql: &MysqlService, sql: &str) -> Result<()> {
    mysql
        .with_transaction(async |tx| {
            tx.execute(sql, ()).await?;
            Ok(())
        })
        .await?;
    Ok(())
}
async fn verify(mysql: &MysqlService) -> Result<()> {
    ddl(mysql,"CREATE TABLE kinds (id BIGINT PRIMARY KEY,user_id BIGINT NOT NULL,kind VARCHAR(64) NOT NULL,name VARCHAR(255) NOT NULL,namespace VARCHAR(255) NOT NULL,json JSON NOT NULL,is_active TINYINT NOT NULL DEFAULT 1,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB").await?;
    ddl(mysql,"CREATE TABLE background_executions (id BIGINT PRIMARY KEY,user_id BIGINT NOT NULL DEFAULT 7,subscription_id BIGINT NOT NULL DEFAULT 1,task_id BIGINT NOT NULL DEFAULT 10,inbox_message_id BIGINT NOT NULL DEFAULT 0,trigger_type VARCHAR(50) NOT NULL DEFAULT 'interval',trigger_reason VARCHAR(500) NOT NULL DEFAULT '',prompt TEXT NOT NULL,status VARCHAR(50) NOT NULL DEFAULT 'RUNNING',result_summary TEXT NOT NULL,error_message TEXT NOT NULL,retry_attempt INT NOT NULL DEFAULT 0,version INT NOT NULL DEFAULT 0,started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB").await?;
    mysql.execute("INSERT INTO kinds(id,user_id,kind,name,namespace,json) VALUES (1,7,'Subscription','ordinary','default',?),(2,7,'Subscription','wiki','default',?)",(Json(json!({"spec":{},"_internal":{"bound_task_id":99}})),Json(json!({"spec":{"codeWikiRef":{"id":9}},"_internal":{}})))).await?;
    for id in 1..=4 {
        mysql.execute("INSERT INTO background_executions(id,subscription_id,prompt,result_summary,error_message) VALUES (?,?,'prompt','','')",(id,if id==4{2}else{1})).await?;
    }
    let (completed, failed) = tokio::join!(
        state::transition::<_, brz_redis::RedisService>(
            mysql,
            None,
            1,
            "COMPLETED",
            Some("done"),
            None
        ),
        state::transition::<_, brz_redis::RedisService>(
            mysql,
            None,
            1,
            "FAILED",
            None,
            Some("failed")
        )
    );
    assert_ne!(
        completed?, failed?,
        "exactly one competing terminal callback must commit"
    );
    let stats = statistics(mysql, 1).await?;
    assert_eq!(stats["status"]["executionCount"], 1);
    assert_eq!(stats["_internal"]["execution_count"], 1);
    assert_eq!(stats["_internal"]["bound_task_id"], 99);
    assert!(
        !state::transition::<_, brz_redis::RedisService>(mysql, None, 1, "RUNNING", None, None)
            .await?
    );
    assert!(
        !state::transition::<_, brz_redis::RedisService>(
            mysql,
            None,
            1,
            "COMPLETED",
            Some("duplicate"),
            None
        )
        .await?
    );
    assert_eq!(statistics(mysql, 1).await?, stats);
    // A real constraint failure after the execution update must roll back both
    // writes. CREATE TRIGGER is unsupported by MySQL's prepared protocol.
    ddl(mysql,"ALTER TABLE kinds ADD CONSTRAINT reject_statistics CHECK (id<>1 OR JSON_EXTRACT(json,'$.status.executionCount')<=1)").await?;
    assert!(
        state::transition::<_, brz_redis::RedisService>(
            mysql,
            None,
            2,
            "FAILED",
            None,
            Some("error")
        )
        .await
        .is_err()
    );
    ddl(mysql, "ALTER TABLE kinds DROP CHECK reject_statistics").await?;
    let row: brz_mysql::MysqlRow = mysql
        .fetch_one(
            "SELECT status,version FROM background_executions WHERE id=2",
            (),
        )
        .await?;
    assert_eq!(row.get_at::<String>(0)?, "RUNNING");
    assert_eq!(
        row.get_at::<i64>(1)?,
        0,
        "execution mutation must roll back with its statistics"
    );
    assert!(
        state::transition::<_, brz_redis::RedisService>(
            mysql,
            None,
            3,
            "COMPLETED_SILENT",
            Some("silent"),
            None
        )
        .await?
    );
    assert_eq!(
        statistics(mysql, 1).await?,
        stats,
        "ordinary silent completion is excluded from statistics"
    );
    assert!(
        state::transition::<_, brz_redis::RedisService>(
            mysql,
            None,
            4,
            "COMPLETED_SILENT",
            Some("repository unchanged"),
            None
        )
        .await?
    );
    let stats = statistics(mysql, 2).await?;
    assert_eq!(stats["status"]["executionCount"], 1);
    assert_eq!(stats["status"]["lastExecutionStatus"], "COMPLETED_SILENT");
    assert!(stats["status"]["successCount"].is_null());
    Ok(())
}
async fn statistics(mysql: &MysqlService, id: i64) -> Result<Value> {
    let row: brz_mysql::MysqlRow = mysql
        .fetch_one("SELECT json FROM kinds WHERE id=?", (id,))
        .await?;
    Ok(row.get_at::<Json<Value>>(0)?.0)
}
