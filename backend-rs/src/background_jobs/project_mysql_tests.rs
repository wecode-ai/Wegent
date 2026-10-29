// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Explicit integration checks use only a newly created disposable schema.

use super::{completion, notifications, store};
use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "requires PROJECT_TEST_MYSQL_URL and PROJECT_TEST_REDIS_ENDPOINT; creates and drops an isolated project_tx_* schema"]
async fn real_mysql_completion_is_atomic_idempotent_and_fenced() -> Result<()> {
    let connection =
        std::env::var("PROJECT_TEST_MYSQL_URL").context("Set the disposable MySQL fixture URL")?;
    let endpoint = std::env::var("PROJECT_TEST_REDIS_ENDPOINT")
        .context("Set the disposable Redis endpoint")?;
    let mut url = url::Url::parse(&connection)?;
    assert!(
        matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        "Integration fixture must use loopback"
    );
    let admin = MysqlService::connect_lazy(url.as_str())?;
    let schema = format!("project_tx_{}", notifications::uuid().replace('-', ""));
    ddl(
        &admin,
        format!("CREATE DATABASE `{schema}` CHARACTER SET utf8mb4"),
    )
    .await?;
    url.set_path(&schema);
    let mysql = MysqlService::connect_lazy(url.as_str())?;
    let redis = brz_redis::RedisService::single(endpoint).await?;
    let result = verify(&mysql, &redis).await;
    let cleanup = ddl(&admin, format!("DROP DATABASE `{schema}`")).await;
    result?;
    cleanup?;
    Ok(())
}

async fn verify(mysql: &MysqlService, redis: &brz_redis::RedisService) -> Result<()> {
    for statement in DDL {
        ddl(mysql, statement).await?;
    }
    let tables = crate::task_store::TableTemplates {
        tasks: "tasks",
        subtasks: "subtasks",
    };
    let (first, second) = mysql
        .with_transaction(async |tx| {
            let first = store::insert(
                tx,
                "automation_run",
                json!({"title":"first","status":"pending"}),
            )
            .await?;
            let second = store::insert(
                tx,
                "automation_run",
                json!({"title":"second","status":"pending"}),
            )
            .await?;
            Ok((first, second))
        })
        .await?;
    #[derive(FromMysqlRow)]
    struct Nullable {
        public_id: Option<String>,
        project_key: Option<String>,
        storage_prefix: Option<String>,
    }
    for id in [first, second] {
        let row: Nullable = mysql
            .fetch_one(
                "SELECT public_id,project_key,storage_prefix FROM loop_items WHERE id=?",
                (id,),
            )
            .await?;
        assert!(
            row.public_id.is_none() && row.project_key.is_none() && row.storage_prefix.is_none()
        );
    }
    seed(mysql, 101, "run-a", "message-a").await?;
    assert!(!completion::complete(mysql, redis, tables, 101, 999, "COMPLETED", None).await?);
    assert!(completion::started(mysql, redis, tables, 101, 7).await?);
    let (left, right) = tokio::join!(
        completion::complete(mysql, redis, tables, 101, 7, "COMPLETED", None),
        completion::complete(mysql, redis, tables, 101, 7, "FAILED", Some("Failure")),
    );
    let (left, right) = (left?, right?);
    assert_ne!(
        left, right,
        "Only one competing terminal callback may commit"
    );
    let state = projection(mysql, "run-a", "message-a").await?;
    assert_eq!(state.version, 3);
    if left {
        assert_eq!(state.run_status, "succeeded");
        assert_eq!(state.message_status, "completed");
        assert_eq!(state.content, "Done");
        assert!(state.metadata.0.get("error").is_none());
    } else {
        assert_eq!(state.run_status, "failed");
        assert_eq!(state.message_status, "failed");
        assert_eq!(state.content, "Failure");
        assert_eq!(state.metadata.0["error"], "Failure");
    }
    assert_eq!(state.metadata.0["backend_task_id"], 101);
    assert!(!completion::complete(mysql, redis, tables, 101, 7, "COMPLETED", None).await?);
    assert!(
        !completion::complete(mysql, redis, tables, 101, 7, "FAILED", Some("late failure")).await?
    );
    assert_eq!(
        projection(mysql, "run-a", "message-a").await?.content,
        state.content
    );

    seed(mysql, 102, "run-b", "message-b").await?;
    mysql.execute("UPDATE project_chat_messages SET metadata=JSON_SET(metadata,'$.backend_task_id',999) WHERE message_id='message-b'",()).await?;
    assert!(!completion::complete(mysql, redis, tables, 102, 7, "COMPLETED", None).await?);
    assert_eq!(
        projection(mysql, "run-b", "message-b").await?.run_status,
        "pending"
    );

    seed(mysql, 103, "run-c", "message-c").await?;
    // CHECK constraints execute inside the real write transaction and are
    // supported by the driver's prepared protocol, unlike CREATE TRIGGER.
    ddl(mysql,"ALTER TABLE loop_items ADD CONSTRAINT reject_run_update CHECK (id <> 'run-c' OR status = 'pending')").await?;
    let failure = completion::complete(mysql, redis, tables, 103, 7, "COMPLETED", None).await;
    ddl(mysql, "ALTER TABLE loop_items DROP CHECK reject_run_update").await?;
    assert!(failure.is_err());
    let state = projection(mysql, "run-c", "message-c").await?;
    assert_eq!(state.run_status, "pending");
    assert_eq!(state.message_status, "queued");
    assert_eq!(state.content, "");
    assert_eq!(state.version, 1);
    Ok(())
}

async fn ddl(mysql: &MysqlService, statement: impl Into<String>) -> Result<()> {
    let statement = statement.into();
    mysql
        .with_transaction(async |tx| {
            tx.execute(statement.as_str(), ()).await?;
            Ok(())
        })
        .await?;
    Ok(())
}

async fn seed(mysql: &MysqlService, task: i64, run: &str, message: &str) -> Result<()> {
    let subtask = task * 10;
    let labels = json!({"source":"project_automation","projectAutomationSubtaskId":subtask.to_string(),"projectAutomationRunId":run,"projectChatMessageId":message,"weworkSpaceProjectId":"project-1","weworkSpaceTaskId":"issue-1"});
    mysql
        .execute(
            "INSERT INTO tasks(id,user_id,kind,json)VALUES(?,7,'Task',?)",
            (task, Json(json!({"metadata":{"labels":labels}}))),
        )
        .await?;
    mysql
        .execute(
            "INSERT INTO subtasks(id,task_id,user_id,role,result)VALUES(?,?,7,'ASSISTANT',?)",
            (subtask, task, Json(json!({"value":"Done"}))),
        )
        .await?;
    mysql.execute("INSERT INTO loop_items(id,resource_type,cloud_project_id,created_by_user_id,backend_task_id,status,metadata,description,completed_at)VALUES(?,'automation_run','project-1',7,?,'pending',JSON_OBJECT(),'','1970-01-01 00:00:01')",(run,task)).await?;
    mysql.execute("INSERT INTO project_chat_messages(message_id,project_id,task_id,status,metadata,content)VALUES(?,'project-1','issue-1','queued',?,'')",(message,Json(json!({"automation_run_id":run,"backend_task_id":task,"error":"old"})))).await?;
    Ok(())
}

#[derive(FromMysqlRow)]
struct Projection {
    run_status: String,
    message_status: String,
    content: String,
    metadata: Json<Value>,
    version: i64,
}
async fn projection(mysql: &MysqlService, run: &str, message: &str) -> Result<Projection> {
    Ok(mysql.fetch_one("SELECT r.status AS run_status,m.status AS message_status,m.content,m.metadata,r.version FROM loop_items r JOIN project_chat_messages m ON m.message_id=? WHERE r.id=?",(message,run)).await?)
}

const DDL: [&str; 4] = [
    "CREATE TABLE loop_items(id VARCHAR(64) PRIMARY KEY,resource_type VARCHAR(32) NOT NULL,public_id VARCHAR(64) NULL UNIQUE,project_key VARCHAR(64) NULL UNIQUE,storage_prefix VARCHAR(64) NULL UNIQUE,cloud_project_id VARCHAR(64),created_by_user_id BIGINT,backend_task_id BIGINT,status VARCHAR(32),title VARCHAR(255) NOT NULL DEFAULT '',description TEXT NOT NULL,metadata JSON NOT NULL,completed_at DATETIME(6) NOT NULL,version BIGINT NOT NULL DEFAULT 1,created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB",
    "CREATE TABLE tasks(id BIGINT PRIMARY KEY,user_id BIGINT NOT NULL,kind VARCHAR(32) NOT NULL,name VARCHAR(255) NOT NULL DEFAULT '',namespace VARCHAR(255) NOT NULL DEFAULT 'default',json JSON NOT NULL,is_active INT NOT NULL DEFAULT 1,created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),project_id BIGINT NULL,client_origin VARCHAR(64) NOT NULL DEFAULT '',is_group_chat TINYINT(1) NOT NULL DEFAULT 0) ENGINE=InnoDB",
    "CREATE TABLE subtasks(id BIGINT PRIMARY KEY,task_id BIGINT NOT NULL,user_id BIGINT NOT NULL,role VARCHAR(32) NOT NULL,result JSON,error_message TEXT) ENGINE=InnoDB",
    "CREATE TABLE project_chat_messages(id BIGINT AUTO_INCREMENT PRIMARY KEY,message_id VARCHAR(64) NOT NULL UNIQUE,client_message_id VARCHAR(64) NOT NULL DEFAULT '',project_id VARCHAR(64) NOT NULL,task_id VARCHAR(64) NOT NULL,sender_type VARCHAR(32) NOT NULL DEFAULT 'agent',sender_id VARCHAR(64) NOT NULL DEFAULT '',sender_name VARCHAR(64) NOT NULL DEFAULT '',message_type VARCHAR(32) NOT NULL DEFAULT 'run',content TEXT NOT NULL,metadata JSON NOT NULL,trigger_message_id VARCHAR(64) NOT NULL DEFAULT '',reply_to_message_id VARCHAR(64) NOT NULL DEFAULT '',thread_root_message_id VARCHAR(64) NOT NULL DEFAULT '',agent_id VARCHAR(64) NOT NULL DEFAULT '',runtime_device_id VARCHAR(64) NOT NULL DEFAULT '',runtime_task_id VARCHAR(64) NOT NULL DEFAULT '',status VARCHAR(32) NOT NULL,created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB",
];
