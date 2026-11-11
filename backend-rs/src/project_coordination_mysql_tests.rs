//! Bindings use the real project permission query and row lock, not a fake lease store.
use super::*;
use brz_mysql::MysqlService;

pub(super) async fn seed(mysql: &MysqlService) {
    let integers = [
        "sequence_number",
        "next_item_number",
        "created_by_user_id",
        "updated_by_user_id",
        "assignee_user_id",
        "user_id",
        "added_by_user_id",
        "task_user_id",
        "assignee_team_id",
        "local_project_id",
        "backend_task_id",
        "linked_by_user_id",
        "size_bytes",
        "current_delivery_id",
        "version",
    ];
    let dates = [
        "start_at",
        "due_at",
        "created_at",
        "updated_at",
        "completed_at",
        "delivered_at",
        "deleted_at",
        "linked_at",
        "unlinked_at",
    ];
    let columns: Vec<_> = crate::cloud_projects::LOOP_ITEMS_COLUMNS
        .split(", ")
        .map(|field| {
            let name = field
                .split(" AS ")
                .next()
                .unwrap()
                .trim_start_matches("loop_items.");
            let kind = if name == "id" {
                "VARCHAR(64) PRIMARY KEY"
            } else if name == "metadata" {
                "JSON"
            } else if integers.contains(&name) {
                "BIGINT"
            } else if dates.contains(&name) {
                "DATETIME(6)"
            } else {
                "TEXT"
            };
            format!("{name} {kind}")
        })
        .collect();
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
        .execute("CREATE TABLE users (id INT PRIMARY KEY,is_active BOOL)", ())
        .await
        .unwrap();
    mysql.execute("CREATE TABLE kinds (id BIGINT PRIMARY KEY,user_id INT,name TEXT,kind VARCHAR(50),is_active BOOL,json JSON)",()).await.unwrap();
    mysql.execute("CREATE TABLE resource_members (id BIGINT PRIMARY KEY AUTO_INCREMENT,resource_type VARCHAR(50),resource_id BIGINT,entity_type VARCHAR(50),entity_id VARCHAR(100),status VARCHAR(50),role VARCHAR(50))",()).await.unwrap();
    mysql
        .execute(
            "INSERT INTO users VALUES (1,true),(7,true),(8,true),(9,true)",
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "INSERT INTO kinds VALUES (2001,1,'Space','CollaborationWorkspace',true,JSON_OBJECT())",
            (),
        )
        .await
        .unwrap();
    for project in ["1001", "1002"] {
        mysql.execute("INSERT INTO loop_items (id,resource_type,status,name,description,metadata,version,created_by_user_id) VALUES (?,'project','active','Project','Preserve shared content',JSON_OBJECT('membership_mode','inherit'),1,1)",(project,)).await.unwrap();
        mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',?,'workspace','2001','approved','Owner')",(project,)).await.unwrap();
    }
    for (user, role) in [(7, "Developer"), (8, "Developer"), (9, "Viewer")] {
        mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('Workspace',2001,'user',?,'approved',?)",(user.to_string(),role)).await.unwrap();
    }
}

async fn verify(mysql: &MysqlService) {
    seed(mysql).await;
    let initial = json!({"enabled":true,"expectedGeneration":null});
    let (a, b) = tokio::join!(
        persist_binding(mysql, 7, "1001", "101", "device-a", &initial),
        persist_binding(mysql, 8, "1001", "101", "device-b", &initial)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let (first, loser) = if let Ok(value) = a {
        (value, b.unwrap_err())
    } else {
        (b.unwrap(), a.unwrap_err())
    };
    assert_eq!(loser.status(), StatusCode::CONFLICT);
    let saved = store::get(mysql, "project", "1001").await.unwrap().unwrap();
    assert_eq!(saved.version, 2);
    assert_eq!(saved.description, "Preserve shared content");
    assert_eq!(saved.metadata.0["membership_mode"], "inherit");
    assert_eq!(saved.metadata.0[FIELD]["101"], first["binding"]);
    // A normal admission read succeeds, then a direct Viewer grant overrides inheritance.
    let (_, role) = crate::cloud_projects::authorized_project(mysql, 1001, 7)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(role, "Developer");
    assert_eq!(
        crate::background_jobs::project::authority::execution_priority(mysql, "1001", 7)
            .await
            .unwrap(),
        2
    );
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',1001,'user','7','approved','Viewer')",()).await.unwrap();
    assert!(
        crate::background_jobs::project::authority::execution_priority(mysql, "1001", 7)
            .await
            .is_err()
    );
    let takeover =
        json!({"enabled":true,"expectedGeneration":first["binding"]["generation"],"takeover":true});
    let denied = persist_binding(mysql, 7, "1001", "101", "device-a", &takeover)
        .await
        .unwrap_err();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        store::get(mysql, "project", "1001")
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );
    // A space administrator can stop another member, without assuming their identity.
    let stopped = persist_binding(
        mysql,
        1,
        "1001",
        "101",
        "device-admin",
        &json!({"enabled":false,"expectedGeneration":first["binding"]["generation"]}),
    )
    .await
    .unwrap();
    assert_eq!(stopped["binding"]["enabled"], false);
    assert_eq!(stopped["binding"]["updatedBy"], 1);
    assert_eq!(stopped["binding"]["userId"], first["binding"]["userId"]);
    assert_ne!(
        stopped["binding"]["generation"],
        first["binding"]["generation"]
    );
    assert_eq!(
        persist_binding(mysql, 9, "1002", "101", "viewer", &initial)
            .await
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    let other = persist_binding(mysql, 8, "1002", "101", "device-b", &initial)
        .await
        .unwrap();
    assert_ne!(
        other["binding"]["generation"],
        first["binding"]["generation"]
    );
    let owned: Vec<OwnedProject> = mysql
        .fetch_all(owned_bindings_statement(8), ("8",))
        .await
        .unwrap();
    assert!(owned.iter().any(|row| row.id == "1002"));
    mysql
        .execute("UPDATE users SET is_active=false WHERE id=8", ())
        .await
        .unwrap();
    assert_eq!(
        persist_binding(
            mysql,
            8,
            "1002",
            "101",
            "device-b",
            &json!({"enabled":false,"expectedGeneration":other["binding"]["generation"]})
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn execution_bindings_preserve_database_generated_columns() {
    with_schema(1, |mysql| async move {
        mysql.execute(
            "CREATE TABLE loop_items (
                id VARCHAR(64) PRIMARY KEY,
                resource_type VARCHAR(32) NOT NULL,
                public_id VARCHAR(64) NULL,
                project_key VARCHAR(64) NULL,
                storage_prefix VARCHAR(64) NULL,
                unique_public_id VARCHAR(64) GENERATED ALWAYS AS (NULLIF(public_id,'')) STORED UNIQUE,
                unique_project_key VARCHAR(64) GENERATED ALWAYS AS (NULLIF(project_key,'')) VIRTUAL UNIQUE,
                unique_storage_prefix VARCHAR(64) GENERATED ALWAYS AS (NULLIF(storage_prefix,'')) STORED UNIQUE
            ) ENGINE=InnoDB",
            (),
        ).await.unwrap();
        for values in [
            json!({"public_id":"binding","project_key":"project","storage_prefix":"prefix"}),
            json!({}),
            json!({}),
        ] {
            let id = mysql.with_transaction(async |tx| {
                store::insert(tx, "execution", values.clone()).await
            }).await.unwrap();
            let row: brz_mysql::MysqlRow = mysql.fetch_one(
                "SELECT public_id,unique_public_id,project_key,unique_project_key,storage_prefix,unique_storage_prefix FROM loop_items WHERE id=?",
                (id,),
            ).await.unwrap();
            for (source, generated) in [
                ("public_id", "unique_public_id"),
                ("project_key", "unique_project_key"),
                ("storage_prefix", "unique_storage_prefix"),
            ] {
                let expected = values[source].as_str().map(str::to_owned);
                assert_eq!(row.get::<String>(source).unwrap(), expected);
                assert_eq!(row.get::<String>(generated).unwrap(), expected);
            }
        }
        mysql.with_transaction(async |tx| {
            let values = json!({"id":"once","public_id":"once"});
            store::insert_once(tx, "execution", values.clone()).await?;
            store::insert_once(tx, "execution", values).await
        }).await.unwrap();
        let row: brz_mysql::MysqlRow = mysql.fetch_one(
            "SELECT COUNT(*) AS count FROM loop_items WHERE unique_public_id='once'", (),
        ).await.unwrap();
        assert_eq!(row.get_required::<i64>("count").unwrap(), 1);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn binding_cas_and_immediate_role_revocation_use_the_project_contract() {
    with_schema(4, |mysql| async move { verify(&mysql).await }).await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn coordination_dispatch_is_atomic_idempotent_and_version_fenced() {
    with_schema(1, |mysql| async move {
        seed(&mysql).await;
        super::dispatch::verify_dispatch_transactions(&mysql).await;
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn issue_mention_wakeups_are_atomic_deduplicated_and_recipient_owned() {
    with_schema(4, |mysql| async move {
        seed(&mysql).await;
        let first_recipient = (7, "1001", "issue");
        let second_recipient = (8, "1002", "other-issue");
        for (_, project, issue) in [first_recipient, second_recipient] {
            mysql
                .execute(
                    "INSERT INTO loop_items (id,resource_type,cloud_project_id) VALUES (?,'task',?)",
                    (issue, project),
                )
                .await
                .unwrap();
        }
        let first_mentions = tokio::sync::Barrier::new(2);
        let enqueue = async |(user, project, issue): (i64, &str, &str), comment: &str, first| {
            mysql
                .with_transaction(async |tx| {
                    store::locked(tx, "task", issue)
                        .await?
                        .ok_or(brz_mysql::MysqlError::RowNotFound)?;
                    if first {
                        first_mentions.wait().await;
                    }
                    crate::stand_in_issue_events::enqueue_mention_on(
                        tx, user, project, issue, comment,
                    )
                    .await
                })
                .await
                .unwrap();
        };
        // Both first-time recipients start with no inbox in the same index gap.
        let ((), ()) = tokio::join!(
            enqueue(first_recipient, "first", true),
            enqueue(second_recipient, "first", true)
        );
        enqueue(first_recipient, "first", false).await;
        let ((), ()) = tokio::join!(
            enqueue(first_recipient, "second", false),
            enqueue(first_recipient, "third", false)
        );
        let rollback: brz_mysql::MysqlResult<()> = mysql
            .with_transaction(async |tx| {
                crate::stand_in_issue_events::enqueue_mention_on(
                    tx,
                    7,
                    "1001",
                    "issue",
                    "rolled-back-comment",
                )
                .await?;
                Err(brz_mysql::MysqlError::RowNotFound)
            })
            .await;
        assert!(rollback.is_err());
        verify_mention_inbox(&mysql, first_recipient, 3).await;
        verify_mention_inbox(&mysql, second_recipient, 1).await;
    })
    .await;
}

async fn verify_mention_inbox(
    mysql: &MysqlService,
    (user, project, issue): (i64, &str, &str),
    count: usize,
) {
    let inbox = store::get(
        mysql,
        "stand_in_issue_inbox",
        &format!("stand-in-inbox:{user}"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(inbox.next_item_number, count as i64 + 1);
    let events: Vec<brz_mysql::MysqlRow> = mysql.fetch_all(
        "SELECT id, CAST(sort_order AS SIGNED) AS sequence, metadata FROM loop_items WHERE resource_type='stand_in_issue_event' AND parent_id=? AND user_id=? ORDER BY sort_order",
        (inbox.id.as_str(), user),
    ).await.unwrap();
    assert_eq!(events.len(), count);
    for (index, event) in events.iter().enumerate() {
        assert_eq!(
            event.get_required::<i64>("sequence").unwrap(),
            index as i64 + 1
        );
        let payload = event.get_required::<Json<Value>>("metadata").unwrap().0;
        assert_eq!(payload["projectId"], project);
        assert_eq!(payload["itemId"], issue);
        assert_ne!(payload["commentId"], "rolled-back-comment");
        let canonical = json!({"commentId":payload["commentId"],"itemId":payload["itemId"],"projectId":payload["projectId"]});
        let expected = crate::hex_sha256(
            format!(
                "stand-in:{user}:{}",
                wegent_python_compat::py_json::python_dumps(&canonical)
            )
            .as_bytes(),
        );
        assert_eq!(event.get_required::<String>("id").unwrap(), expected);
        if user == 7 && payload["commentId"] == "first" {
            // hashlib.sha256 of Python json.dumps(payload, sort_keys=True).
            assert_eq!(
                expected,
                "7403d5fe82dab1af8038a7b94f960b5b6d7a04f1d3ac43b1a2a16b9c237799d8"
            );
        }
    }
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn group_notification_reads_recheck_current_membership() {
    with_schema(4, |mysql| async move {
        seed(&mysql).await;
        crate::wework_notifications::verify_group_notification_reads(&mysql).await;
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn thread_classification_reads_current_permission_facts() {
    with_schema(4, |mysql| async move {
        seed(&mysql).await;
        crate::chat_groups::verify_project_classification_facts(&mysql).await;
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn group_management_locks_shared_accounts_in_message_order() {
    with_schema(4, |mysql| async move {
        seed(&mysql).await;
        crate::chat_groups::verify_group_account_order(&mysql).await;
    })
    .await;
}

async fn with_schema<F, Fut>(capacity: u32, verify: F)
where
    F: FnOnce(MysqlService) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set disposable MySQL fixture address")
        .parse()
        .unwrap();
    assert!(
        address.ip().is_loopback(),
        "use a disposable loopback fixture"
    );
    let url = |name: &str| format!("mysql://root@{address}/{name}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let name = format!("coordination_{}", notifications::uuid().replace('-', ""));
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect_with_options(
        &url(&name),
        brz_mysql::MysqlServiceOptions::default().with_max_connections(capacity),
    )
    .await
    .unwrap();
    let outcome = tokio::spawn(verify(mysql)).await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    outcome.unwrap();
}
