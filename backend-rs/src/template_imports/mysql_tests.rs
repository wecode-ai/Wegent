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

async fn operation(tx: &mut impl MysqlTransaction, id: &str) -> brz_mysql::MysqlResult<Operation> {
    tx.fetch_one(
        format!(
            "SELECT {OPERATION_COLUMNS} FROM loop_items WHERE id=? AND resource_type=? AND kind=? FOR UPDATE"
        ),
        (id, TEMPLATE_IMPORT_RESOURCE_TYPE, TEMPLATE_IMPORT_KIND),
    )
    .await
}

async fn record_receipt(
    tx: &mut impl MysqlTransaction,
    id: &str,
    step_key: &str,
    kind: StepKind,
    resource_id: &str,
) -> brz_mysql::MysqlResult<()> {
    let mut data = operation(tx, id).await?.data.0;
    data.receipts.insert(
        step_key.to_owned(),
        Receipt {
            kind,
            request_sha256: "c".repeat(64),
            resource_id: resource_id.to_owned(),
            completed_at: None,
        },
    );
    let status = if manifest_complete(&data.manifest, &data.receipts) {
        "completed"
    } else {
        "pending"
    };
    tx.execute(
        "UPDATE loop_items SET metadata=?,status=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='template_import' AND kind='template_import_operation'",
        (Json(data), status, id),
    )
    .await?;
    Ok(())
}

async fn add_receipt(
    mysql: &MysqlService,
    id: &str,
    step_key: &str,
    kind: StepKind,
    resource_id: &str,
) -> Result<()> {
    mysql
        .with_transaction(async |tx| {
            record_receipt(tx, id, step_key, kind, resource_id).await?;
            Ok(())
        })
        .await?;
    Ok(())
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
    let started = begin_import(state, actor(8), "1001", input("Atomic receipt"))
        .await
        .unwrap();
    let id = started["id"].as_str().unwrap();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let mutation = writer.with_transaction(async |tx| {
        operation(tx, id).await?;
        tx.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (3101,8,'Atomic group','CollaborationGroup','projects/1001',true,JSON_OBJECT())",()).await?;
        record_receipt(tx, id, "group:delivery", StepKind::Group, "3101").await?;
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
        wait_for_operation_lock(writer).await;
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
        operation(tx, rollback_id).await?;
        tx.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (3201,8,'Rollback group','CollaborationGroup','projects/1001',true,JSON_OBJECT())",()).await?;
        record_receipt(tx, rollback_id, "group:delivery", StepKind::Group, "3201").await?;
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

async fn wait_for_operation_lock(writer: &MysqlService) {
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let waiting:Count=writer.fetch_one("SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='loop_items' AND l.LOCK_TYPE='RECORD'",()).await.unwrap();
            if waiting.count > 0 { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("the second client must wait on the operation row's actual database lock");
}

async fn verify_unconfigured_encryption_writes_nothing(
    state: &AppState,
    writer: &MysqlService,
) -> Result<()> {
    for key in [None, Some("invalid-key".to_string())] {
        let result = begin_with_cipher(
            state,
            actor(8),
            "1001",
            input("Unconfigured encryption"),
            IntentCipher::from_material(key, Some("v".repeat(16))),
        )
        .await;
        assert_eq!(
            result.unwrap_err().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let operations: Count = writer
        .fetch_one(
            "SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='template_import'",
            (),
        )
        .await?;
    assert_eq!(operations.count, 0);
    Ok(())
}

async fn verify_revocation_while_waiting_rolls_back_begin(
    state: &AppState,
    writer: &MysqlService,
    original: &str,
) -> Result<()> {
    let body = repeat("Revoked while waiting", original);
    let checksum = digest(&body.intent, &body.steps).unwrap();
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let lock = writer.with_transaction(async |tx| {
        operation(tx, original).await?;
        ready.send(()).unwrap();
        released.await.unwrap();
        Ok(())
    });
    let begin = async {
        started.await.unwrap();
        begin_import(state, actor(8), "1001", body).await
    };
    let revoke = async {
        wait_for_operation_lock(writer).await;
        writer.execute("UPDATE resource_members SET status='rejected' WHERE resource_type='Workspace' AND entity_id='8'",()).await.unwrap();
        release.send(()).unwrap();
    };
    let (locked, denied, ()) = tokio::join!(lock, begin, revoke);
    locked?;
    assert_eq!(denied.unwrap_err().status(), StatusCode::NOT_FOUND);
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let successor:Count=writer.fetch_one("SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='template_import' AND kind='template_import_operation' AND created_by_user_id=8 AND cloud_project_id='1001' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.intentSha256'))=?",(checksum,)).await?;
    assert_eq!(
        successor.count, 0,
        "post-lock authorization denial must roll back the newly inserted operation"
    );
    let original: Count = writer
        .fetch_one(
            "SELECT COUNT(*) AS count FROM loop_items WHERE id=? AND resource_type='template_import'",
            (original,),
        )
        .await?;
    assert_eq!(
        original.count, 1,
        "denial must preserve previous operation receipts"
    );
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
    verify_unconfigured_encryption_writes_nothing(&state, &writer).await?;
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
            "SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='template_import'",
            (),
        )
        .await?;
    assert_eq!(count.count, 1);
    #[derive(FromMysqlRow)]
    struct Encrypted {
        metadata: Json<Value>,
    }
    let stored: Encrypted = mysql
        .fetch_one(
            "SELECT metadata FROM loop_items WHERE id=? AND resource_type='template_import'",
            (id,),
        )
        .await?;
    assert!(!stored.metadata.0.to_string().contains("secret-test-value"));
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
    add_receipt(
        &writer,
        id,
        "group:delivery",
        StepKind::Group,
        "confirmed-group",
    )
    .await?;
    let partial = import_status(&state, actor(8), "1001", id).await.unwrap();
    assert_eq!(partial["status"], "pending");
    assert_eq!(partial["steps"][0]["resourceId"], "confirmed-group");
    assert!(partial["steps"][1].get("resourceId").is_none());
    add_receipt(&writer, id, "board:project-board", StepKind::Board, "1001").await?;
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
    let pending = begin_import(
        &state,
        actor(8),
        "1001",
        input("Pending authority predecessor"),
    )
    .await
    .unwrap();
    verify_revocation_while_waiting_rolls_back_begin(
        &state,
        &writer,
        pending["id"].as_str().unwrap(),
    )
    .await?;
    writer.execute("UPDATE resource_members SET status='approved' WHERE resource_type='Workspace' AND entity_id='8'",()).await?;
    verify_revocation_while_waiting_rolls_back_begin(&state, &writer, id).await?;
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
