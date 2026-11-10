//! Real MySQL migration checks use a newly created schema, never a developer DB.

use super::*;

#[path = "historical_tests.rs"]
mod historical;

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; creates and drops an isolated migration_test_* schema"]
async fn fresh_schema_and_historical_upgrade_round_trip() -> Result<()> {
    isolated(verify).await
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
    let schema = format!("migration_test_{}", super::rows::uuid().replace('-', ""));
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
    assert_eq!(tables.len(), 52);
    upgrade(mysql).await?;
    // Exercise JSON/permission, plugin-publication, merge, notification and transcript migrations.
    downgrade(mysql, "d47dd270f4b6").await?;
    upgrade(mysql).await?;
    check(mysql).await?;
    verify_initialization(mysql).await?;
    verify_permission_data(mysql).await?;
    Ok(())
}

async fn verify_initialization(mysql: &MysqlService) -> Result<()> {
    use brz_mysql::Json;
    use serde_json::{Value, json};
    crate::initialization::yaml(mysql).await?;
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
        .with_transaction(async |tx| super::data_changes::project_permissions(tx, false).await)
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
        .with_transaction(async |tx| super::data_changes::project_permissions(tx, true).await)
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
