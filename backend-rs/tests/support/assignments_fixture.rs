// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Small assignment and permission fixtures on the existing disposable database.

use brz_mysql::{MysqlRow, MysqlService, MysqlServiceOptions};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct ReadOnlyMysql {
    pub mysql: MysqlService,
    user: String,
}

impl ReadOnlyMysql {
    pub async fn new(admin: &MysqlService) -> Self {
        let database = database_name(admin).await;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let user = format!("assign_ro_{unique:x}");
        admin
            .execute(format!("CREATE USER '{user}'@'%'"), ())
            .await
            .unwrap();
        admin
            .execute(format!("GRANT SELECT ON {database}.* TO '{user}'@'%'"), ())
            .await
            .unwrap();
        let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
        // Every connection authenticates as this SELECT-only account, including
        // replacement connections. No session setting or pool scheduling is assumed.
        let mysql = MysqlService::connect_lazy_with_options(
            &format!("mysql://{user}@{address}/{database}?ssl-mode=disabled"),
            MysqlServiceOptions::default()
                .with_max_connections(4)
                .with_query_timeout(Duration::from_secs(10)),
        )
        .unwrap();
        Self { mysql, user }
    }

    pub async fn close(self, admin: &MysqlService) {
        self.mysql.close().await;
        admin
            .execute(format!("DROP USER '{}'@'%'", self.user), ())
            .await
            .unwrap();
    }
}

pub async fn seed(mysql: &MysqlService) {
    mysql
        .execute(include_str!("../fixtures/loop_items_nullable.sql"), ())
        .await
        .unwrap();
    for statement in include_str!("../fixtures/assignment_access.sql")
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        mysql.execute(statement, ()).await.unwrap();
    }
    for (id, resource, security) in [
        ("1001", "project", "open"),
        ("issue-1", "task", "open"),
        ("empty-issue", "task", "open"),
        ("private-issue", "task", "related"),
    ] {
        mysql.execute(
            "INSERT INTO loop_items
             (id,resource_type,cloud_project_id,description,created_by_user_id,status,metadata,created_at,updated_at)
             VALUES (?,?,'1001','',7,'active',?,'2026-10-27 08:00:00','2026-10-27 08:00:00')",
            (id,resource,json!({"task_provider":"local","default_issue_security":"open","security_level":security}).to_string()),
        ).await.unwrap();
    }
    seed_comments(mysql).await;
}

async fn seed_comments(mysql: &MysqlService) {
    for (id, issue, creator, metadata, deleted) in [
        ("101", "issue-1", 7, assign("human", "7"), false),
        (
            "102",
            "issue-1",
            8,
            json!({"event_type":"assignment","action":"assign","target_type":"human","target_id":"7","target_name":"Fixture human","receipt_tracking":true,"human_read_at":"2026-10-27T00:05:00Z","stand_in_received_at":"2026-10-27T00:06:00Z"}),
            false,
        ),
        ("103", "issue-1", 7, assign("agent", "42"), false),
        ("104", "issue-1", 7, assign("human", "9"), false),
        (
            "105",
            "issue-1",
            7,
            json!({"event_type":"assignment","action":"unassign","assignment_event_id":"104"}),
            false,
        ),
        ("106", "issue-1", 7, assign("human", "8"), true),
        (
            "107",
            "issue-1",
            7,
            json!({"event_type":"discussion"}),
            false,
        ),
        (
            "108",
            "private-issue",
            7,
            json!({"event_type":"discussion"}),
            false,
        ),
    ] {
        mysql.execute(
            "INSERT INTO loop_items
             (id,resource_type,cloud_project_id,loop_item_id,description,created_by_user_id,metadata,deleted_at,created_at,updated_at)
             VALUES (?,'comment','1001',?,'assignment body',?,?,?,'2026-10-27 08:00:00','2026-10-27 08:00:00')",
            (id,issue,creator,metadata.to_string(),if deleted {Some("2026-10-28 08:00:00")} else {None}),
        ).await.unwrap();
    }
}

fn assign(target: &str, id: &str) -> Value {
    json!({"event_type":"assignment","action":"assign","target_type":target,"target_id":id,"target_name":"Fixture human"})
}

pub async fn writer(mysql: &MysqlService) -> MysqlService {
    let name = database_name(mysql).await;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    MysqlService::connect_lazy_with_options(
        &format!("mysql://root@{address}/{name}?ssl-mode=disabled"),
        MysqlServiceOptions::default()
            .with_max_connections(1)
            .with_query_timeout(Duration::from_secs(10)),
    )
    .unwrap()
}

async fn database_name(mysql: &MysqlService) -> String {
    let row: MysqlRow = mysql
        .fetch_one("SELECT DATABASE() AS name", ())
        .await
        .unwrap();
    let name: String = row.get_required("name").unwrap();
    assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    name
}

pub fn expected() -> Value {
    let mut human = item("102", "human", "7", 8);
    human["receipt_tracking"] = json!(true);
    human["human_read_at"] = json!("2026-10-27T00:05:00Z");
    human["stand_in_received_at"] = json!("2026-10-27T00:06:00Z");
    json!({"items":[human,item("103","agent","42",7)]})
}

fn item(id: &str, target: &str, target_id: &str, creator: i32) -> Value {
    json!({
        "id":id,"issue_id":"issue-1","target_type":target,"target_id":target_id,
        "target_name":"Fixture human","workflow_step":null,"body":"assignment body",
        "comment_id":id,"created_by_user_id":creator,
        "created_by_user_name":format!("assignment-e2e-{creator}"),"status":"active",
        "created_at":"2026-10-27T00:00:00Z","updated_at":"2026-10-27T00:00:00Z",
        "receipt_tracking":false,"human_read_at":null,"stand_in_received_at":null
    })
}
