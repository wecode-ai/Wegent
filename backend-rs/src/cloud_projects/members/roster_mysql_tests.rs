//! Exercise the batched roster policy against populated MySQL tables.

use super::roster::list_project_members;
use brz_mysql::MysqlService;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

async fn verify(mysql: &MysqlService) {
    mysql.execute("CREATE TABLE kinds (id BIGINT PRIMARY KEY, user_id INT, kind VARCHAR(50), name VARCHAR(100), namespace VARCHAR(100), json JSON, is_active BOOL, created_at DATETIME, updated_at DATETIME)", ()).await.unwrap();
    mysql.execute("CREATE TABLE resource_members (id INT PRIMARY KEY AUTO_INCREMENT, resource_type VARCHAR(50), resource_id BIGINT, entity_type VARCHAR(20), entity_id VARCHAR(100), `role` VARCHAR(20), status VARCHAR(20))", ()).await.unwrap();
    mysql.execute("CREATE TABLE users (id INT PRIMARY KEY, user_name VARCHAR(100), email VARCHAR(100), is_active BOOL)", ()).await.unwrap();
    mysql.execute("INSERT INTO kinds VALUES (2001, 1, 'CollaborationWorkspace', 'Space', 'default', JSON_OBJECT(), true, NOW(), NOW())", ()).await.unwrap();
    for id in 1..=87 {
        mysql
            .execute(
                "INSERT INTO users VALUES (?, ?, ?, ?)",
                (
                    id,
                    format!("user-{id}"),
                    format!("user-{id}@example.org"),
                    id != 87,
                ),
            )
            .await
            .unwrap();
    }
    for (user, kind, resource, role, status) in [
        (1, "CloudProject", 1001, "Viewer", "approved"),
        (2, "Workspace", 2001, "Maintainer", "approved"),
        (2, "CloudProject", 1001, "Viewer", "approved"),
        (3, "Workspace", 2001, "Developer", "approved"),
        (3, "CloudProject", 1001, "Viewer", "approved"),
        (4, "Workspace", 2001, "Reporter", "approved"),
        (5, "CloudProject", 1001, "Owner", "approved"),
        (6, "CloudProject", 1001, "Developer", "pending"),
        (7, "Workspace", 2001, "Owner", "approved"),
        (7, "CloudProject", 1001, "Unknown", "pending"),
        (8, "Workspace", 2001, "Developer", "rejected"),
        (9, "CloudProject", 1001, "Unknown", "approved"),
        (10, "CloudProject", 9999, "Maintainer", "approved"),
        (87, "Workspace", 2001, "Maintainer", "approved"),
    ] {
        mysql.execute("INSERT INTO resource_members (resource_type, resource_id, entity_type, entity_id, `role`, status) VALUES (?, ?, 'user', ?, ?, ?)", (kind, resource, user.to_string(), role, status)).await.unwrap();
    }
    let capabilities = HashMap::from([("3".to_owned(), "Review".to_owned())]);
    for mode in ["inherit", "restricted"] {
        for caller in [1, 10] {
            let rows = list_project_members(mysql, 1001, Some(2001), mode, &capabilities, caller)
                .await
                .unwrap();
            let member = |id| rows.iter().find(|row| row.user_id == id).unwrap();
            assert_eq!(member(1).role, "Maintainer");
            assert_eq!(member(2).role, "Maintainer");
            assert_eq!(member(3).role, "Viewer");
            assert!(!member(3).can_be_assignee);
            assert_eq!(member(3).capability_description, "Review");
            assert_eq!(member(3).inherited_role.is_some(), mode == "inherit");
            assert_eq!(rows.iter().any(|row| row.user_id == 4), mode == "inherit");
            assert_eq!(member(5).role, "Maintainer");
            assert_eq!(member(7).role, "Maintainer");
            assert!(member(7).direct_role.is_none());
            assert_ne!(member(7).id, 7);
            for absent in [6, 8, 9, 10, 87] {
                assert!(!rows.iter().any(|row| row.user_id == absent));
            }
            assert!(rows.iter().all(|row| row.email.is_some() == (caller == 1)));
        }
    }
    // Add many distinct ordinary inherited members, then revoke one between reads.
    for id in 11..=86 {
        mysql.execute("INSERT INTO resource_members (resource_type, resource_id, entity_type, entity_id, `role`, status) VALUES ('Workspace', 2001, 'user', ?, 'Developer', 'approved')", (id.to_string(),)).await.unwrap();
    }
    let before = list_project_members(mysql, 1001, Some(2001), "inherit", &capabilities, 1)
        .await
        .unwrap();
    assert_eq!(before.len(), 82);
    mysql.execute("UPDATE resource_members SET status = 'rejected' WHERE resource_type = 'Workspace' AND entity_id = '86'", ()).await.unwrap();
    let after = list_project_members(mysql, 1001, Some(2001), "inherit", &capabilities, 1)
        .await
        .unwrap();
    assert_eq!(after.len(), 81);
    assert!(!after.iter().any(|row| row.user_id == 86));
    mysql
        .execute("UPDATE kinds SET is_active = false WHERE id = 2001", ())
        .await
        .unwrap();
    assert!(
        list_project_members(mysql, 1001, Some(2001), "inherit", &capabilities, 1)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn batched_roster_preserves_permission_contract_and_immediate_revocation() {
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set disposable MySQL fixture address")
        .parse()
        .unwrap();
    assert!(
        address.ip().is_loopback(),
        "use a disposable loopback fixture"
    );
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let database = format!(
        "roster_{}",
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
    admin.close().await;
    result.unwrap();
}
