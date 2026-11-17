//! Protocol storage tests run against the existing isolated MySQL CI service.
use super::*;
use anyhow::Result;
use brz_mysql::MysqlService;
use tracing::instrument::WithSubscriber;

/// Keep storage failures visible without exposing import bodies or credentials.
struct StorageDiagnostics;

struct StorageFields(String);

impl tracing::field::Visit for StorageFields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        use std::fmt::Write;
        let _ = write!(self.0, " {}={value:?}", field.name());
    }
}

impl tracing::Subscriber for StorageDiagnostics {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata
            .target()
            .starts_with("wegent_backend_rs::template_imports")
            && *metadata.level() <= tracing::Level::WARN
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut fields = StorageFields(String::new());
        event.record(&mut fields);
        eprintln!("template import storage diagnostic:{}", fields.0);
    }
}

fn actor(id: i32) -> SessionUser {
    let now = chrono::Utc::now().naive_utc();
    SessionUser(crate::auth::UserRow {
        id,
        user_name: format!("user-{id}"),
        users_password_hash: String::new(),
        email: None,
        git_info: Json(brz_json::OpaqueJson::from(json!({}))),
        is_active: 1,
        role: "user".into(),
        auth_source: "password".into(),
        preferences: String::new(),
        created_at: now,
        updated_at: now,
    })
}

fn input(name: &str) -> Begin {
    serde_json::from_value(json!({
        "protocolVersion":1,
        "intent":{"document":{"name":name,"mcp":{"Authorization":"secret-test-value"}},"drafts":[]},
        "steps":[{"key":"group:delivery","kind":"group"},{"key":"board:project-board","kind":"board"}]
    }))
    .unwrap()
}

fn repeat(name: &str, previous: &str) -> Begin {
    let mut body = input(name);
    body.intent["previousImportId"] = json!(previous);
    body
}

async fn verify_explicit_repeat(state: &AppState, original: &str) -> Result<()> {
    let (first, second) = tokio::join!(
        begin_import(state, actor(8), "1001", repeat("Another group", original)),
        begin_import(state, actor(8), "1001", repeat("Another group", original))
    );
    let first = first.unwrap();
    assert_eq!(first, second.unwrap());
    assert_ne!(first["id"], original);
    assert_eq!(first["status"], "pending");
    assert_eq!(first["intent"]["previousImportId"], original);
    assert!(
        first["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|step| step.get("resourceId").is_none())
    );
    assert_eq!(
        import_status(state, actor(8), "1001", original)
            .await
            .unwrap()["status"],
        "completed"
    );
    let pending = first["id"].as_str().unwrap();
    assert_eq!(
        begin_import(
            state,
            actor(8),
            "1001",
            repeat("Pending predecessor", pending)
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        begin_import(state, actor(7), "1001", repeat("Other actor", original))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        begin_import(state, actor(8), "1002", repeat("Other project", original))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        begin_import(
            state,
            actor(8),
            "1001",
            repeat("Missing predecessor", "missing")
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::NOT_FOUND
    );
    Ok(())
}

async fn seed(mysql: &MysqlService) -> Result<()> {
    mysql.execute("INSERT INTO users (id,user_name,password_hash,is_active,role,auth_source,preferences) VALUES (7,'Owner','',1,'user','password',''),(8,'Maintainer','',1,'user','password',''),(9,'Viewer','',1,'user','password','')",()).await?;
    mysql.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (2001,7,'Space','CollaborationWorkspace','default',true,JSON_OBJECT())",()).await?;
    mysql
        .with_transaction(async |tx| {
            let required = crate::loop_node_storage::required_columns(tx).await?;
            let sql = crate::loop_node_storage::insert_sql(
                &[
                    "id",
                    "resource_type",
                    "name",
                    "title",
                    "description",
                    "status",
                    "metadata",
                    "version",
                    "next_item_number",
                    "sort_order",
                    "created_by_user_id",
                    "created_at",
                    "updated_at",
                ],
                &[
                    "?",
                    "'project'",
                    "'Project'",
                    "'Project'",
                    "''",
                    "'active'",
                    "?",
                    "1",
                    "1",
                    "0",
                    "7",
                    "UTC_TIMESTAMP(6)",
                    "UTC_TIMESTAMP(6)",
                ],
                &required,
            );
            for project in ["1001", "1002"] {
                tx.execute(
                    sql.clone(),
                    (
                        project,
                        Json(json!({"membership_mode":"inherit","task_provider":"backend"})),
                    ),
                )
                .await?;
            }
            Ok(())
        })
        .await?;
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,role,status,requested_at,created_at,updated_at) VALUES ('CloudProject',1001,'workspace','2001','Owner','approved',NOW(),NOW(),NOW()),('CloudProject',1002,'workspace','2001','Owner','approved',NOW(),NOW(),NOW()),('Workspace',2001,'user','8','Maintainer','approved',NOW(),NOW(),NOW()),('Workspace',2001,'user','9','Viewer','approved',NOW(),NOW(),NOW())",()).await?;
    Ok(())
}

async fn verify_atomic_receipt(state: &AppState, writer: &MysqlService) -> Result<()> {
    let operation = begin_import(state, actor(8), "1001", input("Atomic receipt"))
        .await
        .unwrap();
    let id = operation["id"].as_str().unwrap();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let mutation = writer.with_transaction(async |tx| {
        let _: Operation = tx.fetch_one("SELECT id,project_id,protocol_version,intent_sha256,intent_encrypted,manifest FROM template_import_operations WHERE id=? FOR UPDATE",(id,)).await?;
        tx.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (3101,8,'Atomic group','CollaborationGroup','projects/1001',true,JSON_OBJECT())",()).await?;
        tx.execute("INSERT INTO template_import_receipts VALUES (?,'group:delivery','group',REPEAT('c',64),'3101',UTC_TIMESTAMP(6))",(id,)).await?;
        ready.send(()).unwrap();
        released.await.unwrap();
        Ok(())
    });
    let recovery = async {
        started.await.unwrap();
        import_status(state, actor(8), "1001", id).await.unwrap()
    };
    let release_after_observed_lock = async {
        #[derive(FromMysqlRow)]
        struct Count {
            count: i64,
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let waiting:Count=writer.fetch_one("SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='template_import_operations'",()).await.unwrap();
                if waiting.count > 0 { break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("the second client must wait on the operation row's actual database lock");
        let visible: Count = writer
            .fetch_one("SELECT COUNT(*) AS count FROM kinds WHERE id=3101", ())
            .await
            .unwrap();
        assert_eq!(
            visible.count, 0,
            "uncommitted resources must not escape the receipt transaction"
        );
        release.send(()).unwrap();
    };
    let (committed, recovered, ()) = tokio::join!(mutation, recovery, release_after_observed_lock);
    committed?;
    assert_eq!(recovered["steps"][0]["resourceId"], "3101");
    let replay = begin_import(state, actor(8), "1001", input("Atomic receipt"))
        .await
        .unwrap();
    assert_eq!(
        replay, recovered,
        "lost commit responses recover the same receipt"
    );
    let rollback = begin_import(state, actor(8), "1001", input("Rollback receipt"))
        .await
        .unwrap();
    let rollback_id = rollback["id"].as_str().unwrap();
    let failed = writer.with_transaction(async |tx| {
        let _:Operation=tx.fetch_one("SELECT id,project_id,protocol_version,intent_sha256,intent_encrypted,manifest FROM template_import_operations WHERE id=? FOR UPDATE",(rollback_id,)).await?;
        tx.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (3201,8,'Rollback group','CollaborationGroup','projects/1001',true,JSON_OBJECT())",()).await?;
        tx.execute("INSERT INTO template_import_receipts VALUES (?,'group:delivery','group',REPEAT('d',64),'3201',UTC_TIMESTAMP(6))",(rollback_id,)).await?;
        tx.execute("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='rollback fixture'",()).await?;
        Ok(())
    }).await;
    assert!(failed.is_err());
    let unchanged = import_status(state, actor(8), "1001", rollback_id)
        .await
        .unwrap();
    assert!(unchanged["steps"][0].get("resourceId").is_none());
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let count: Count = writer
        .fetch_one("SELECT COUNT(*) AS count FROM kinds WHERE id=3201", ())
        .await?;
    assert_eq!(count.count, 0);
    Ok(())
}

async fn verify(mysql: &MysqlService) -> Result<()> {
    crate::migrations::upgrade(mysql).await?;
    seed(mysql).await?;
    #[derive(FromMysqlRow)]
    struct Name {
        name: String,
    }
    let database: Name = mysql.fetch_one("SELECT DATABASE() AS name", ()).await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    // Use a normal multi-connection pool so the two client requests really race.
    let writer = MysqlService::connect(&format!(
        "mysql://root@{address}/{}?ssl-mode=disabled",
        database.name
    ))
    .await?;
    let state = crate::app_test_support::app(writer.clone());
    let (first, second) = tokio::join!(
        begin_import(&state, actor(8), "1001", input("Group")),
        begin_import(&state, actor(8), "001001", input("Group"))
    );
    let first = first.expect("first concurrent client begin must succeed");
    assert_eq!(
        first,
        second.expect("second concurrent client begin must succeed")
    );
    let id = first["id"].as_str().unwrap();
    assert_eq!(first["status"], "pending");
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let count: Count = mysql
        .fetch_one(
            "SELECT COUNT(*) AS count FROM template_import_operations",
            (),
        )
        .await?;
    assert_eq!(count.count, 1);
    #[derive(FromMysqlRow)]
    struct Encrypted {
        intent_encrypted: String,
    }
    let stored: Encrypted = mysql
        .fetch_one(
            "SELECT intent_encrypted FROM template_import_operations WHERE id=?",
            (id,),
        )
        .await?;
    assert!(!stored.intent_encrypted.contains("secret-test-value"));
    assert_eq!(
        import_status(&state, actor(8), "1001", id).await.unwrap()["intent"],
        first["intent"]
    );
    let listed = list_imports(&state, actor(8), "1001").await.unwrap();
    assert_eq!(listed["items"][0]["id"], first["id"]);
    assert!(listed["items"][0].get("intent").is_none());
    assert_eq!(
        import_status(&state, actor(7), "1001", id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(
        list_imports(&state, actor(7), "1001").await.unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        import_status(&state, actor(8), "1002", id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        begin_import(&state, actor(9), "1001", input("Group"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let changed = begin_import(&state, actor(8), "1001", input("Different group"))
        .await
        .unwrap();
    assert_ne!(changed["id"], first["id"]);
    let other = begin_import(&state, actor(7), "1001", input("Group"))
        .await
        .unwrap();
    assert_ne!(other["id"], first["id"]);
    mysql.execute("INSERT INTO template_import_receipts (operation_id,step_key,kind,request_sha256,resource_id,completed_at) VALUES (?,'group:delivery','group',REPEAT('a',64),'confirmed-group',UTC_TIMESTAMP(6))",(id,)).await?;
    let partial = import_status(&state, actor(8), "1001", id).await.unwrap();
    assert_eq!(partial["status"], "pending");
    assert_eq!(partial["steps"][0]["resourceId"], "confirmed-group");
    assert!(partial["steps"][1].get("resourceId").is_none());
    mysql.execute("INSERT INTO template_import_receipts (operation_id,step_key,kind,request_sha256,resource_id,completed_at) VALUES (?,'board:project-board','board',REPEAT('b',64),'1001',UTC_TIMESTAMP(6))",(id,)).await?;
    let complete = import_status(&state, actor(8), "1001", id).await.unwrap();
    assert_eq!(complete["status"], "completed");
    assert_eq!(
        begin_import(&state, actor(8), "1001", input("Group"))
            .await
            .unwrap(),
        complete
    );
    verify_atomic_receipt(&state, &writer).await?;
    verify_explicit_repeat(&state, id).await?;
    mysql.execute("UPDATE resource_members SET status='rejected' WHERE resource_type='Workspace' AND entity_id='8'",()).await?;
    assert_eq!(
        import_status(&state, actor(8), "1001", id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        list_imports(&state, actor(8), "1001")
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        begin_import(&state, actor(8), "1001", input("Group"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    writer.close().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL and test encryption key/IV; CI invokes this suite"]
async fn current_authority_and_actor_private_cross_client_receipts() -> Result<()> {
    let _inactive = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    crate::migrations::mysql_tests::isolated(verify)
        .with_subscriber(StorageDiagnostics)
        .await
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; CI invokes this suite"]
async fn migration_upgrade_write_downgrade_and_upgrade() -> Result<()> {
    crate::migrations::mysql_tests::isolated(async |mysql| {
        crate::migrations::upgrade(mysql).await?;
        mysql.execute("INSERT INTO template_import_operations VALUES ('migration-op','1001',8,1,REPEAT('a',64),'encrypted',JSON_ARRAY(JSON_OBJECT('key','group:delivery','kind','group')),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",()).await?;
        mysql.execute("INSERT INTO template_import_receipts VALUES ('migration-op','group:delivery','group',REPEAT('b',64),'group',UTC_TIMESTAMP(6))",()).await?;
        crate::migrations::downgrade(mysql,"b1c2d3e4f5a6").await?;
        #[derive(FromMysqlRow)]
        struct Count { count: i64 }
        let count:Count=mysql.fetch_one("SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('template_import_operations','template_import_receipts')",()).await?;
        assert_eq!(count.count,0);
        crate::migrations::upgrade(mysql).await?;
        crate::migrations::check(mysql).await?;
        let count:Count=mysql.fetch_one("SELECT COUNT(*) AS count FROM template_import_operations",()).await?;
        assert_eq!(count.count,0);
        Ok(())
    }).await
}
