// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Explicit InnoDB contract proof against a disposable loopback MySQL 8 fixture.
//! Set KNOWLEDGE_TEST_MYSQL_URL to its administrative /mysql URL and run
//! `cargo test knowledge::mysql_tests -- --ignored`.
use super::{snapshot::SNAPSHOT_KEY, store, sync};
use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    panic::AssertUnwindSafe,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

const SCHEMA: &[&str] = &[
    "CREATE TABLE kinds (id BIGINT PRIMARY KEY,kind VARCHAR(64) NOT NULL,json JSON NOT NULL,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB",
    "CREATE TABLE knowledge_documents (id BIGINT PRIMARY KEY AUTO_INCREMENT,kind_id BIGINT NOT NULL DEFAULT 1,user_id BIGINT NOT NULL DEFAULT 7,attachment_id BIGINT NOT NULL DEFAULT 10,file_extension VARCHAR(32) NOT NULL DEFAULT 'md',file_size BIGINT NOT NULL DEFAULT 42,is_active BOOLEAN NOT NULL DEFAULT TRUE,status VARCHAR(32) NOT NULL DEFAULT 'enabled',index_status VARCHAR(32) NOT NULL DEFAULT 'success',index_generation BIGINT NOT NULL DEFAULT 0,source_config JSON NULL,chunks JSON NULL,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB",
    "CREATE TABLE knowledge_document_external_sources (document_id BIGINT PRIMARY KEY,kind_id BIGINT NOT NULL DEFAULT 1,external_provider VARCHAR(64) NOT NULL DEFAULT 'wiki',external_resource_id VARCHAR(64) NOT NULL DEFAULT 'page',UNIQUE KEY source_identity (kind_id,external_provider,external_resource_id)) ENGINE=InnoDB",
];

#[tokio::test]
#[ignore = "requires explicit disposable local MySQL 8 fixture; creates and drops only its own schema"]
async fn generation_claims_and_snapshot_recovery_hold_under_real_row_locks() {
    let raw =
        std::env::var("KNOWLEDGE_TEST_MYSQL_URL").expect("set isolated loopback MySQL fixture URL");
    let mut url = url::Url::parse(&raw).expect("valid MySQL fixture URL");
    assert_eq!(url.scheme(), "mysql");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(url.port().is_some());
    assert_eq!(url.path(), "/mysql");
    let admin = MysqlService::connect(url.as_str())
        .await
        .expect("connect to local fixture");
    let name = format!(
        "knowledge_tx_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    ddl(&admin, &format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    url.set_path(&format!("/{name}"));
    let mysql = MysqlService::connect(url.as_str()).await.unwrap();
    let result = AssertUnwindSafe(async {
        for sql in SCHEMA {
            ddl(&mysql, sql).await?;
        }
        null_configs_and_count(&mysql).await?;
        concurrent_enqueue_and_claim(&mysql, &admin, &name).await?;
        native_import_claim_replays_only_its_own_active_generation(&mysql).await?;
        rollback_and_snapshot_generations(&mysql).await?;
        legacy_failure_and_timeout_recheck(&mysql).await?;
        import_failures_distinguish_unavailable_from_failed_version(&mysql).await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    ddl(&admin, &format!("DROP DATABASE {name}"))
        .await
        .expect("drop owned fixture schema");
    result
        .expect("knowledge transaction assertion")
        .expect("knowledge transaction contract");
}

async fn ddl(mysql: &MysqlService, sql: &str) -> brz_mysql::MysqlResult<()> {
    mysql
        .with_transaction(async |tx| {
            tx.execute(sql, ()).await?;
            Ok(())
        })
        .await
}

async fn seed(mysql: &MysqlService, id: i64, config: Option<Value>) -> Result<()> {
    mysql
        .execute(
            "INSERT INTO knowledge_documents (id,source_config) VALUES (?,?)",
            (id, config.map(Json)),
        )
        .await?;
    mysql.execute("INSERT INTO knowledge_document_external_sources (document_id,external_resource_id) VALUES (?,?)",(id,format!("page-{id}"))).await?;
    Ok(())
}

async fn null_configs_and_count(mysql: &MysqlService) -> Result<()> {
    seed(mysql, 1, Some(Value::Null)).await?;
    seed(mysql, 2, None).await?;
    for id in [1, 2] {
        let doc = store::load(mysql, id)
            .await?
            .context("null-config document")?;
        assert!(doc.source_config.is_empty());
    }
    mysql
        .execute(
            "INSERT INTO kinds(id,kind,json) VALUES (1,'KnowledgeBase',?)",
            (Json(json!({"spec":{"name":"fixture","document_count":99}})),),
        )
        .await?;
    mysql
        .with_transaction(async |tx| sync::update_document_count(tx, 1).await)
        .await?;
    #[derive(FromMysqlRow)]
    struct Kind {
        json: Json<Value>,
    }
    let kb: Kind = mysql
        .fetch_optional("SELECT json FROM kinds WHERE id=1", ())
        .await?
        .unwrap();
    assert_eq!(kb.json.0["spec"]["document_count"], 2);
    assert_eq!(kb.json.0["spec"]["name"], "fixture");
    Ok(())
}

async fn concurrent_enqueue_and_claim(
    mysql: &MysqlService,
    admin: &MysqlService,
    schema: &str,
) -> Result<()> {
    let holder = mysql.clone();
    let (locked_tx, locked_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let lock = tokio::spawn(async move {
        holder
            .with_transaction(async |tx| {
                #[derive(FromMysqlRow)]
                struct Row {
                    #[mysql(rename = "id")]
                    _id: i64,
                }
                tx.fetch_optional::<_, _, Row>(
                    "SELECT id FROM knowledge_documents WHERE id=1 FOR UPDATE",
                    (),
                )
                .await?;
                locked_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(())
            })
            .await
    });
    locked_rx.await?;
    let service = mysql.clone();
    let pending =
        tokio::spawn(async move { store::enqueue(&service, 1, Some(0), false, true).await });
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let observed=tokio::time::timeout(Duration::from_secs(10),async{
        loop{
            let waits:Count=admin.fetch_optional("SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=?",(schema,)).await?.unwrap();
            if waits.n>0{break Ok::<_,brz_mysql::MysqlError>(());}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await;
    // Always release the holder, including a failed lock-observation assertion.
    release_tx.send(()).unwrap();
    lock.await??;
    observed.context("InnoDB must expose the blocked row claim")??;
    let queued = pending.await??;
    assert!(queued.accepted);
    assert_eq!(queued.document.unwrap().generation, 1);
    let (a, b) = tokio::join!(
        store::claim_import(mysql, 1, 1),
        store::claim_import(mysql, 1, 1)
    );
    let (a, b) = (a?, b?);
    assert_ne!(
        a.accepted, b.accepted,
        "exactly one import must advance the generation"
    );
    let doc = store::load(mysql, 1).await?.unwrap();
    assert_eq!(doc.generation, 2);
    assert_eq!(doc.source_config[SNAPSHOT_KEY]["generation"], 2);
    assert!(!store::succeed(mysql, 1, 1, None, false).await?.accepted);
    Ok(())
}

async fn rollback_and_snapshot_generations(mysql: &MysqlService) -> Result<()> {
    let config = json!({"converted_attachment_id":101,"external":{"source_update_time":"v1","sync":{"enabled":true,"content_version":"v1","indexed_version":"v1"}}});
    for id in [3, 4] {
        seed(mysql, id, Some(config.clone())).await?;
        mysql
            .execute(
                "UPDATE knowledge_documents SET attachment_id=100,index_generation=5 WHERE id=?",
                (id,),
            )
            .await?;
    }
    let rollback: brz_mysql::MysqlResult<()> = mysql
        .with_transaction(async |tx| {
            tx.execute(
                "UPDATE knowledge_documents SET attachment_id=999 WHERE id=3",
                (),
            )
            .await?;
            Err(brz_mysql::MysqlError::InvalidQuery {
                reason: "injected fixture rollback".into(),
            })
        })
        .await;
    assert!(rollback.is_err());
    assert_eq!(store::load(mysql, 3).await?.unwrap().attachment_id, 100);
    for id in [3, 4] {
        let queued = store::enqueue(mysql, id, Some(5), false, true).await?;
        assert!(queued.accepted);
        let claimed = store::claim_import(mysql, id, 6).await?;
        assert!(claimed.accepted);
        assert_eq!(claimed.document.unwrap().generation, 7);
        mysql.execute("UPDATE knowledge_documents SET attachment_id=200,index_status='indexing',source_config=JSON_SET(source_config,'$.converted_attachment_id',201,'$._pending_external_refresh.staged_attachment_id',202,'$.external.sync.content_version','v2') WHERE id=?",(id,)).await?;
    }
    assert!(
        !store::fail(mysql, 3, 6, json!({"message":"stale"}), true, false)
            .await?
            .accepted
    );
    let failed = store::fail(
        mysql,
        3,
        7,
        json!({"code":"provider_timeout","message":"failed"}),
        true,
        false,
    )
    .await?;
    assert!(failed.accepted);
    assert_eq!(failed.cleanup, BTreeSet::from([200, 201, 202]));
    let doc = failed.document.unwrap();
    assert_eq!(doc.attachment_id, 100);
    assert_eq!(doc.converted_id(), Some(101));
    assert_eq!(doc.index_status, "success");
    assert!(doc.active);
    assert_eq!(
        doc.source_config["external"]["sync"]["content_version"],
        "v1"
    );
    assert!(!doc.source_config.contains_key(SNAPSHOT_KEY));
    let success = store::succeed(mysql, 4, 7, None, false).await?;
    assert!(success.accepted);
    assert_eq!(success.cleanup, BTreeSet::from([100, 101]));
    let doc = success.document.unwrap();
    assert_eq!(doc.attachment_id, 200);
    assert_eq!(doc.converted_id(), Some(201));
    assert!(!doc.source_config.contains_key(SNAPSHOT_KEY));
    Ok(())
}

async fn native_import_claim_replays_only_its_own_active_generation(
    mysql: &MysqlService,
) -> Result<()> {
    seed(mysql,12,Some(json!({"external":{"sync":{"enabled":true,"content_version":"v1","indexed_version":"v1"}}}))).await?;
    assert!(
        store::enqueue(mysql, 12, Some(0), false, true)
            .await?
            .accepted
    );
    let first = store::claim_import_for_job(mysql, 12, 1, "native-job-a").await?;
    assert!(first.accepted);
    assert_eq!(first.document.unwrap().generation, 2);
    let replay = store::claim_import_for_job(mysql, 12, 1, "native-job-a").await?;
    assert!(
        replay.accepted,
        "A crashed delivery resumes its original generation"
    );
    let document = replay.document.unwrap();
    assert_eq!(document.generation, 2);
    assert_eq!(document.source_config[SNAPSHOT_KEY]["generation"], 2);
    assert!(
        !store::claim_import_for_job(mysql, 12, 1, "native-job-b")
            .await?
            .accepted,
        "Another job cannot borrow the original job's claim"
    );
    let replacement = store::enqueue(mysql, 12, Some(2), true, true).await?;
    assert!(replacement.accepted);
    assert_eq!(replacement.document.unwrap().generation, 3);
    assert!(
        !store::load(mysql, 12)
            .await?
            .unwrap()
            .source_config
            .contains_key("_native_import_claim")
    );
    assert!(
        !store::claim_import_for_job(mysql, 12, 1, "native-job-a")
            .await?
            .accepted,
        "An old job cannot resume a superseding enqueue"
    );
    let next = store::claim_import_for_job(mysql, 12, 3, "native-job-c").await?;
    assert!(next.accepted);
    assert_eq!(next.document.unwrap().generation, 4);
    assert!(store::start(mysql, 12, 4).await?.accepted);
    assert!(
        !store::claim_import_for_job(mysql, 12, 3, "native-job-c")
            .await?
            .accepted,
        "A claimed import cannot replay once indexing starts"
    );
    assert!(store::succeed(mysql, 12, 4, None, false).await?.accepted);
    assert!(
        !store::load(mysql, 12)
            .await?
            .unwrap()
            .source_config
            .contains_key("_native_import_claim")
    );
    assert!(
        !store::claim_import_for_job(mysql, 12, 3, "native-job-c")
            .await?
            .accepted,
        "A terminal job is never reopened by redelivery"
    );
    seed(mysql, 13, None).await?;
    assert!(
        store::enqueue(mysql, 13, Some(0), false, false)
            .await?
            .accepted
    );
    assert!(
        store::claim_import_for_job(mysql, 13, 1, "native-job-d")
            .await?
            .accepted
    );
    let failure = store::fail(mysql, 13, 2, json!({"code":"failed"}), false, false).await?;
    assert!(failure.accepted);
    assert!(
        !failure
            .document
            .unwrap()
            .source_config
            .contains_key("_native_import_claim")
    );
    assert!(
        !store::claim_import_for_job(mysql, 13, 1, "native-job-d")
            .await?
            .accepted
    );
    Ok(())
}

async fn legacy_failure_and_timeout_recheck(mysql: &MysqlService) -> Result<()> {
    for (id, status) in [(7_i64, "success"), (8, "failed")] {
        seed(mysql, id, None).await?;
        mysql
            .execute(
                "UPDATE knowledge_documents SET index_status=? WHERE id=?",
                (status, id),
            )
            .await?;
        let queued = store::enqueue(mysql, id, Some(0), false, false).await?;
        let was_success = queued.previous_status.as_deref() == Some("success");
        sync::invalidate_refresh(mysql, id, 1, false, was_success).await?;
        let before = store::load(mysql, id).await?.unwrap();
        assert!(!before.active);
        assert!(before.source_config["external"]["source_update_time"].is_null());
        assert_eq!(
            before.source_config["external"]["last_success_attachment_id"].as_i64(),
            (status == "success").then_some(10)
        );
        let failed = store::fail(mysql, id, 1, json!({"code":"fetch_failed"}), true, false)
            .await?
            .document
            .unwrap();
        assert_eq!(
            failed.index_status,
            if status == "success" {
                "success"
            } else {
                "failed"
            }
        );
        assert_eq!(failed.active, status == "success");
    }
    seed(
        mysql,
        5,
        Some(json!({"external":{"last_success_attachment_id":300}})),
    )
    .await?;
    mysql.execute("UPDATE knowledge_documents SET attachment_id=300,index_status='queued',index_generation=9,is_active=false WHERE id=5",()).await?;
    let failure = store::fail(
        mysql,
        5,
        9,
        json!({"code":"fetch_failed","message":"unavailable"}),
        true,
        false,
    )
    .await?;
    let doc = failure.document.unwrap();
    assert_eq!(failure.reason, "served_body_kept");
    assert_eq!(doc.index_status, "success");
    assert_eq!(doc.attachment_id, 300);
    assert!(doc.active);
    seed(mysql, 6, None).await?;
    mysql
        .execute(
            "UPDATE knowledge_documents SET index_status='queued',is_active=false WHERE id=6",
            (),
        )
        .await?;
    assert!(
        !store::fail(mysql, 6, 0, json!({}), false, true)
            .await?
            .accepted
    );
    mysql
        .execute(
            "UPDATE knowledge_documents SET updated_at=DATE_SUB(NOW(),INTERVAL 10 DAY) WHERE id=6",
            (),
        )
        .await?;
    assert!(
        store::fail(mysql, 6, 0, json!({}), false, true)
            .await?
            .accepted
    );
    Ok(())
}

async fn import_failures_distinguish_unavailable_from_failed_version(
    mysql: &MysqlService,
) -> Result<()> {
    for (id, code, retryable) in [
        (9_i64, "external_source_missing", true),
        (10, "invalid_export", false),
        (11, "temporary_failure", true),
    ] {
        seed(mysql,id,Some(json!({"external":{"sync":{"enabled":true,"indexed_version":"v1","observed_version":"v2","failed_version":"old"}}}))).await?;
        mysql
            .execute(
                "UPDATE knowledge_documents SET index_status='queued' WHERE id=?",
                (id,),
            )
            .await?;
        let failure = store::fail_import(
            mysql,
            id,
            0,
            json!({"code":code,"message":"provider failure","retryable":retryable}),
        )
        .await?;
        assert!(failure.accepted);
        let doc = failure.document.unwrap();
        assert_eq!(doc.index_status, "success");
        assert!(doc.active);
        let external = doc.external();
        let sync = &external["sync"];
        if code == "external_source_missing" {
            assert_eq!(external["status"], "inaccessible");
            assert_eq!(sync["failed_version"], "old");
            assert!(sync.get("last_error_retryable").is_none());
        } else if retryable {
            assert!(sync.get("failed_version").is_none());
            assert_eq!(sync["last_error_retryable"], true);
        } else {
            assert_eq!(sync["failed_version"], "v2");
            assert_eq!(sync["last_error_retryable"], false);
        }
    }
    Ok(())
}
