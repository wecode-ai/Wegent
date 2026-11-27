//! Real MySQL migration checks use a newly created schema, never a developer DB.

use super::*;
use anyhow::{Result, ensure};
use brz_mysql::{FromMysqlRow, MysqlService, MysqlTransaction};
use wegent_database_migrations::test_support::{VERSION_TABLE, migrate};

#[derive(FromMysqlRow)]
struct Name {
    name: String,
}

#[path = "historical_tests.rs"]
mod historical;

#[path = "../task_continuation_mysql_tests.rs"]
mod task_continuation;

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; creates and drops an isolated migration_test_* schema"]
async fn fresh_schema_and_historical_upgrade_round_trip() -> Result<()> {
    isolated(verify).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn assistant_shares_preserve_cross_account_boundaries() -> Result<()> {
    isolated(async |mysql| {
        upgrade(mysql).await?;
        crate::assistant_shares::mysql_tests::verify(mysql).await
    })
    .await
}

pub(crate) async fn isolated(test: impl AsyncFnOnce(&MysqlService) -> Result<()>) -> Result<()> {
    // Share the existing service without multiplying simultaneous DDL workloads.
    static DATABASE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = DATABASE.acquire().await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    ensure!(
        address.starts_with("127.0.0.1:"),
        "test fixture must use loopback"
    );
    let admin = super::connect(&format!("mysql://root@{address}/mysql?ssl-mode=disabled")).unwrap();
    let schema = format!(
        "migration_test_{}",
        wegent_database_migrations::test_support::uuid().replace('-', "")
    );
    admin
        .with_transaction(async |tx| {
            tx.execute(
                format!(
                    "CREATE DATABASE {schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                ),
                (),
            )
            .await?;
            Ok(())
        })
        .await?;
    let mysql = super::connect(&format!(
        "mysql://root@{address}/{schema}?ssl-mode=disabled"
    ))
    .unwrap();
    let outcome = test(&mysql).await;
    mysql.close().await;
    admin
        .with_transaction(async |tx| {
            tx.execute(format!("DROP DATABASE {schema}"), ()).await?;
            Ok(())
        })
        .await?;
    outcome
}

async fn verify(mysql: &MysqlService) -> Result<()> {
    upgrade(mysql).await?;
    check(mysql).await?;
    let tables: Vec<Name> = mysql.fetch_all("SELECT CAST(TABLE_NAME AS CHAR) AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()", ()).await?;
    assert_eq!(tables.len(), 51);
    assert!(
        !tables
            .iter()
            .any(|table| table.name == "plugin_local_sync_operations")
    );
    assert!(
        !tables
            .iter()
            .any(|table| table.name == "plugin_sync_outbox")
    );
    upgrade(mysql).await?;
    // Exercise JSON/permission, plugin-publication, merge, notification and transcript migrations.
    use wegent_task_store::task_store_pipeline::{managed_strategy, save_strategy};
    let waiting = serde_json::json!({"collaborationModel":"pipeline","members":[{"requireConfirmation":true}]});
    let global_id: i64 = 7_000_000_000;
    mysql
        .execute("CREATE TABLE tasks_007 LIKE tasks", ())
        .await?;
    mysql.with_transaction(async |tx| {
        let mut task = serde_json::json!({"spec":{}, "status":{"status":"PENDING_CONFIRMATION"}});
        save_strategy(tx, global_id, &waiting, &mut task).await?;
        tx.execute("INSERT INTO tasks_007(id,user_id,kind,name,namespace,json,is_active,created_at,updated_at,project_id,is_group_chat) VALUES (?,7,'Task','waiting','default',?,1,NOW(),NOW(),0,0)",
            (global_id, brz_mysql::Json(task))).await?;
        Ok(())
    }).await?;
    downgrade(mysql, "d47dd270f4b6").await?;
    upgrade(mysql).await?;
    check(mysql).await?;
    let (brz_mysql::Json(mut restored),): (brz_mysql::Json<serde_json::Value>,) = mysql
        .fetch_one("SELECT json FROM tasks_007 WHERE id=?", (global_id,))
        .await?;
    restored["spec"]
        .as_object_mut()
        .unwrap()
        .remove("currentStage");
    assert_eq!(restored["status"]["status"], "PENDING_CONFIRMATION");
    assert_eq!(
        managed_strategy(&mut &*mysql, restored.as_object(), global_id).await?,
        Some(waiting)
    );
    historical::project_agent_teams_round_trip(mysql).await?;
    verify_initialization(mysql).await?;
    verify_permission_data(mysql).await?;
    crate::socketio::issue_timestamp_tests::verify(mysql).await?;
    crate::socketio::project_chat_messages::verify_source_resolution(mysql).await?;
    crate::background_jobs::robot::verify_issue_activity_projection(mysql).await?;
    crate::socketio::verify_reconnect_projection(mysql).await?;
    crate::socketio::verify_late_human_reply_projection(mysql).await?;
    crate::stand_in_issue_events::verify_mentions(mysql).await?;
    crate::stand_in_account::verify_concurrent_initialization(mysql).await?;
    Ok(())
}

async fn verify_initialization(mysql: &MysqlService) -> Result<()> {
    use brz_mysql::Json;
    use serde_json::{Value, json};
    crate::initialization::yaml(mysql).await?;
    verify_connector_failure_recovery(mysql).await?;
    crate::initialization::connectors(mysql).await?;
    verify_connector_initialization(mysql).await?;
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let count:Count=mysql.fetch_one("SELECT COUNT(*) AS n FROM kinds WHERE kind='Skill' AND user_id=0 AND namespace='default' AND is_active=1",()).await?;
    let skill_dirs = std::fs::read_dir(crate::initialization::resource_directory().join("skills"))?
        .filter_map(std::result::Result::ok)
        .filter(|p| p.path().join("SKILL.md").is_file())
        .count();
    assert_eq!(
        count.n, skill_dirs as i64,
        "every bundled Skill must initialize successfully"
    );
    #[derive(FromMysqlRow)]
    struct Config {
        value: String,
    }
    let config:Config=mysql.fetch_one("SELECT config_value AS value FROM system_configs WHERE config_key='admin_password_initialized'",()).await?;
    assert_eq!(
        serde_json::from_str::<Value>(&config.value)?,
        json!({"completed":false})
    );
    #[derive(FromMysqlRow)]
    struct Skill {
        payload: Json<Value>,
        package_bytes: Vec<u8>,
    }
    let before:Skill=mysql.fetch_one("SELECT k.json AS payload,b.binary_data AS package_bytes FROM kinds k JOIN skill_binaries b ON b.kind_id=k.id WHERE k.user_id=0 AND k.namespace='default' AND k.kind='Skill' AND k.name='wegent-knowledge'",()).await?;
    assert!(before.payload.0["spec"]["mcpServers"].is_object());
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&before.package_bytes))?;
    use std::io::Read;
    let mut text = String::new();
    archive
        .by_name("wegent-knowledge/SKILL.md")?
        .read_to_string(&mut text)?;
    assert!(!text.contains("mcpServers"));
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.testUserEdit',true) WHERE kind='Shell' AND name='Codex' AND user_id=0 AND namespace='default'",()).await?;
    crate::initialization::yaml(mysql).await?;
    #[derive(FromMysqlRow)]
    struct Payload {
        payload: Json<Value>,
    }
    let shell:Payload=mysql.fetch_one("SELECT json AS payload FROM kinds WHERE kind='Shell' AND name='Codex' AND user_id=0 AND namespace='default' LIMIT 1",()).await?;
    assert_eq!(shell.payload.0["spec"]["testUserEdit"], json!(true));
    let after:Skill=mysql.fetch_one("SELECT k.json AS payload,b.binary_data AS package_bytes FROM kinds k JOIN skill_binaries b ON b.kind_id=k.id WHERE k.user_id=0 AND k.namespace='default' AND k.kind='Skill' AND k.name='wegent-knowledge'",()).await?;
    assert_eq!(before.payload.0, after.payload.0);
    assert_eq!(before.package_bytes, after.package_bytes);
    Ok(())
}

async fn verify_connector_initialization(mysql: &MysqlService) -> Result<()> {
    use brz_mysql::Json;
    use serde_json::{Value, json};
    #[derive(FromMysqlRow)]
    struct App {
        name: String,
        payload: Json<Value>,
    }
    let read = async || -> Result<Vec<App>> {
        Ok(mysql.fetch_all("SELECT name,json AS payload FROM kinds WHERE kind='ConnectorApp' AND namespace='system' AND user_id=0 ORDER BY name", ()).await?)
    };
    let before = read().await?;
    assert_eq!(before.len(), 4);
    for app in &before {
        assert_eq!(app.payload.0["spec"]["enabled"], true);
        assert_eq!(app.payload.0["spec"]["authType"], "oauth2");
        assert_eq!(app.payload.0["spec"]["toolLoadingMode"], "lazy");
    }
    crate::initialization::verify_admin_edits_during_backfill(mysql).await?;
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.enabled',false,'$.spec.toolLoadingMode','static','$.spec.keywords',JSON_ARRAY('custom')) WHERE kind='ConnectorApp' AND namespace='system' AND user_id=0 AND name='dingtalk_docs'", ()).await?;
    crate::initialization::connectors(mysql).await?;
    let after = read().await?;
    assert_eq!(after.len(), 4);
    let docs = after
        .iter()
        .find(|app| app.name == "dingtalk_docs")
        .unwrap();
    assert_eq!(docs.payload.0["spec"]["enabled"], false);
    assert_eq!(docs.payload.0["spec"]["toolLoadingMode"], "static");
    assert_eq!(docs.payload.0["spec"]["keywords"], json!(["custom"]));
    mysql.execute("DELETE FROM kinds WHERE kind='ConnectorApp' AND namespace='system' AND user_id=0 AND name='dingtalk_docs'", ()).await?;
    crate::initialization::connectors(mysql).await?;
    let deleted = read().await?;
    assert_eq!(deleted.len(), 3);
    assert!(deleted.iter().all(|app| app.name != "dingtalk_docs"));
    // A new bootstrap still scopes catalog identity to the system owner.
    mysql
        .execute(
            "DELETE FROM system_configs WHERE config_key='builtin_connector_apps_initialized'",
            (),
        )
        .await?;
    mysql.execute("INSERT INTO kinds (kind,name,namespace,user_id,json,is_active,created_at,updated_at) VALUES ('ConnectorApp','dingtalk_docs','system',7,?,1,NOW(),NOW())", (Json(json!({"spec":{"mcpUrl":"https://foreign.example/mcp"}})),)).await?;
    crate::initialization::connectors(mysql).await?;
    let restored = read().await?;
    assert_eq!(restored.len(), 4);
    let docs = restored
        .iter()
        .find(|app| app.name == "dingtalk_docs")
        .unwrap();
    assert_eq!(docs.payload.0["spec"]["enabled"], true);
    assert_eq!(docs.payload.0["spec"]["toolLoadingMode"], "lazy");
    Ok(())
}

async fn verify_connector_failure_recovery(mysql: &MysqlService) -> Result<()> {
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    // Fail the third app after two inserts to verify the production rollback.
    mysql.execute("CREATE TRIGGER reject_builtin_connector BEFORE INSERT ON kinds FOR EACH ROW BEGIN IF NEW.kind='ConnectorApp' AND NEW.name='dingtalk_aitable' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test connector publication failure'; END IF; END", ()).await?;
    assert!(crate::initialization::connectors(mysql).await.is_err());
    let count: Count = mysql.fetch_one("SELECT COUNT(*) AS n FROM kinds WHERE kind='ConnectorApp' AND namespace='system' AND user_id=0", ()).await?;
    assert_eq!(count.n, 0);
    let marker: Count = mysql.fetch_one("SELECT COUNT(*) AS n FROM system_configs WHERE config_key='builtin_connector_apps_initialized'", ()).await?;
    assert_eq!(marker.n, 0);
    mysql
        .execute("DROP TRIGGER reject_builtin_connector", ())
        .await?;
    crate::initialization::verify_concurrent_completion(mysql).await?;
    let marker: Count = mysql.fetch_one("SELECT COUNT(*) AS n FROM system_configs WHERE config_key='builtin_connector_apps_initialized' AND JSON_EXTRACT(config_value,'$.completed')=true", ()).await?;
    assert_eq!(marker.n, 1);
    Ok(())
}

async fn verify_permission_data(mysql: &MysqlService) -> Result<()> {
    use brz_mysql::Json;
    use serde_json::{Value, json};
    mysql.execute("INSERT INTO loop_items (id,resource_type,description,metadata,created_at,updated_at) VALUES ('101','project','',?,NOW(),NOW())",(Json(json!({"visibility":"public_restricted","default_issue_security":"open"})),)).await?;
    for (id, metadata) in [
        ("102", json!({})),
        ("103", json!({"security_level":"private"})),
    ] {
        mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,description,metadata,created_at,updated_at) VALUES (?,'task','101','',?,NOW(),NOW())",(id,Json(metadata))).await?;
    }
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,role,status,user_id,requested_at,created_at,updated_at) VALUES ('CloudProject',101,'user','7','Reporter','pending',7,NOW(),NOW(),NOW())",()).await?;
    mysql
        .with_transaction(async |tx| {
            wegent_database_migrations::test_support::project_permissions(tx, false).await
        })
        .await?;
    #[derive(FromMysqlRow)]
    struct Item {
        id: String,
        payload: Json<Value>,
    }
    let nodes:Vec<Item>=mysql.fetch_all("SELECT id,metadata AS payload FROM loop_items WHERE id IN ('101','102','103') ORDER BY id",()).await?;
    assert_eq!(
        nodes.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["101", "102", "103"]
    );
    assert!(nodes[0].payload.0.get("visibility").is_none());
    assert_eq!(
        nodes[0].payload.0["default_issue_security"],
        json!("related")
    );
    assert_eq!(nodes[1].payload.0["security_level"], json!("related"));
    assert_eq!(nodes[2].payload.0["security_level"], json!("private"));
    #[derive(FromMysqlRow)]
    struct Member {
        role: String,
        status: String,
    }
    let member:Member=mysql.fetch_one("SELECT role,status FROM resource_members WHERE resource_type='CloudProject' AND resource_id=101 AND entity_type='user' AND entity_id='7'",()).await?;
    assert_eq!(
        (member.role.as_str(), member.status.as_str()),
        ("Viewer", "pending")
    );
    let grant:Member=mysql.fetch_one("SELECT role,status FROM resource_members WHERE resource_type='CloudProject' AND resource_id=101 AND entity_type='authenticated_users' AND entity_id='*'",()).await?;
    assert_eq!(
        (grant.role.as_str(), grant.status.as_str()),
        ("Viewer", "approved")
    );
    mysql
        .with_transaction(async |tx| {
            wegent_database_migrations::test_support::project_permissions(tx, true).await
        })
        .await?;
    let nodes:Vec<Item>=mysql.fetch_all("SELECT id,metadata AS payload FROM loop_items WHERE id IN ('101','102','103') ORDER BY id",()).await?;
    assert_eq!(
        nodes[0].payload.0,
        json!({"visibility":"public_restricted","default_issue_security":"open"})
    );
    assert_eq!(nodes[1].payload.0, json!({}));
    assert_eq!(nodes[2].payload.0, json!({"security_level":"private"}));
    let member:Member=mysql.fetch_one("SELECT role,status FROM resource_members WHERE resource_type='CloudProject' AND resource_id=101 AND entity_type='user' AND entity_id='7'",()).await?;
    assert_eq!(
        (member.role.as_str(), member.status.as_str()),
        ("Reporter", "pending")
    );
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let grants:Count=mysql.fetch_one("SELECT COUNT(*) AS n FROM resource_members WHERE resource_type='CloudProject' AND resource_id=101 AND entity_type='authenticated_users' AND entity_id='*'",()).await?;
    assert_eq!(grants.n, 0);
    Ok(())
}

/// Exercise collaboration writes against the checked-in deployment schema.
pub(crate) async fn seed_collaboration(mysql: &MysqlService) -> Result<()> {
    upgrade(mysql).await?;
    mysql.execute("INSERT INTO users (id,user_name,password_hash,role,auth_source,preferences,is_active) VALUES (7,'qa-owner','fixture','user','local','{}',true),(8,'qa-observer','fixture','user','local','{}',true)", ()).await?;
    mysql.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,json,is_active) VALUES (2001,7,'qa-space','CollaborationWorkspace','default',JSON_OBJECT(),true)", ()).await?;
    mysql.execute("INSERT INTO loop_items (id,resource_type,description,status,metadata,created_at,updated_at) VALUES ('1001','project','','active',JSON_OBJECT('membership_mode','direct'),NOW(),NOW()),('root','task','','pending',JSON_OBJECT('security_level','open'),NOW(),NOW())", ()).await?;
    mysql
        .execute(
            "UPDATE loop_items SET cloud_project_id='1001',created_by_user_id=7 WHERE id='root'",
            (),
        )
        .await?;
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,role,status,requested_at,created_at,updated_at) VALUES ('CloudProject',1001,'workspace','2001','Owner','approved',NOW(),NOW(),NOW()),('CloudProject',1001,'user','7','Maintainer','approved',NOW(),NOW(),NOW()),('CloudProject',1001,'user','8','Developer','approved',NOW(),NOW(),NOW())", ()).await?;
    Ok(())
}
