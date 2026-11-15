//! Real storage and permission transactions; the existing backend MySQL CI job invokes this suite.
use super::*;
use brz_mysql::MysqlService;

fn user(id: i32) -> SessionUser {
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

fn input(title: &str, version: Option<i64>, participants: Vec<i32>) -> Input {
    serde_json::from_value(json!({"title":title,"version":version,"participants":participants}))
        .unwrap()
}

async fn seed(mysql: &MysqlService) {
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
    let columns = crate::cloud_projects::LOOP_ITEMS_COLUMNS
        .split(", ")
        .map(|column| {
            let name = column
                .split(" AS ")
                .next()
                .unwrap()
                .trim_start_matches("loop_items.");
            let kind = if name == "id" {
                "VARCHAR(64) PRIMARY KEY"
            } else if name == "resource_type" {
                "VARCHAR(24) NOT NULL"
            } else if name == "description" {
                "TEXT NOT NULL"
            } else if name == "metadata" {
                "JSON NOT NULL"
            } else if integers.contains(&name) {
                "BIGINT"
            } else if dates.contains(&name) {
                "DATETIME(6)"
            } else {
                "TEXT"
            };
            format!("{name} {kind}")
        })
        .collect::<Vec<_>>();
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
        .execute(
            "CREATE TABLE users (id INT PRIMARY KEY,user_name VARCHAR(100),is_active BOOL)",
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO users VALUES (7,'Owner',true),(8,'Participant',true),(9,'Outsider',true),(10,'Inactive',false)",()).await.unwrap();
    mysql.execute("CREATE TABLE kinds (id BIGINT PRIMARY KEY,user_id INT,name TEXT,kind VARCHAR(50),namespace VARCHAR(100),is_active BOOL,json JSON)",()).await.unwrap();
    mysql.execute("CREATE TABLE resource_members (id BIGINT PRIMARY KEY AUTO_INCREMENT,resource_type VARCHAR(50),resource_id BIGINT,entity_type VARCHAR(50),entity_id VARCHAR(100),status VARCHAR(50),role VARCHAR(50)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",()).await.unwrap();
    mysql.execute("INSERT INTO kinds VALUES (2001,7,'Project space','CollaborationWorkspace','default',true,JSON_OBJECT())",()).await.unwrap();
    mysql.execute("INSERT INTO loop_items (id,resource_type,status,name,title,description,metadata,version,next_item_number,created_by_user_id) VALUES ('1001','project','active','Project','Project','',JSON_OBJECT('membership_mode','inherit','task_provider','backend'),1,1,7)",()).await.unwrap();
    mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',1001,'workspace','2001','approved','Owner')",()).await.unwrap();
}

async fn verify(mysql: MysqlService) {
    seed(&mysql).await;
    let state = crate::app_test_support::app(mysql.clone());
    let private = create_issue(&state, user(7), input("Private by default", None, vec![]))
        .await
        .unwrap();
    assert!(private.metadata.0.participants.is_empty());
    assert_eq!(private.people.0["7"], "Owner");
    assert_eq!(
        get_issue(&state, user(8), &private.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let mut invite = input("Invited", Some(private.version), vec![8]);
    invite.assignee_id = Some(8);
    let invited = update_issue(&state, user(7), &private.id, invite)
        .await
        .unwrap();
    assert_eq!(
        get_issue(&state, user(8), &private.id)
            .await
            .unwrap()
            .people
            .0["8"],
        "Participant"
    );
    let assigned = list_issues(
        &state,
        user(8),
        Query(ListQuery {
            scope: "assigned".into(),
            include_completed: false,
            archived: false,
            cursor: None,
            order: "activity".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(assigned["items"][0]["id"], private.id);
    assert_eq!(
        update_issue(
            &state,
            user(8),
            &private.id,
            input("Escalate", Some(invited.version), vec![8, 9])
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::FORBIDDEN
    );
    comment(
        &state,
        user(8),
        &private.id,
        CommentInput {
            body: "A real participant update".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        list_comments(&state, user(7), &private.id).await.unwrap()[0].author_id,
        8
    );
    let current = get_issue(&state, user(7), &private.id).await.unwrap();
    let revoked = update_issue(
        &state,
        user(7),
        &private.id,
        input("Revoke access", Some(current.version), vec![]),
    )
    .await
    .unwrap();
    assert_eq!(
        get_issue(&state, user(8), &private.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        list_comments(&state, user(8), &private.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        comment(
            &state,
            user(8),
            &private.id,
            CommentInput {
                body: "After revocation".into()
            }
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::NOT_FOUND
    );
    let mut archive = input("Archived", Some(revoked.version), vec![]);
    archive.archived = true;
    let archived = update_issue(&state, user(7), &private.id, archive)
        .await
        .unwrap();
    for (archived_only, expected) in [(false, 0), (true, 1)] {
        let page = list_issues(
            &state,
            user(7),
            Query(ListQuery {
                scope: "created".into(),
                order: "attention".into(),
                include_completed: false,
                archived: archived_only,
                cursor: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), expected);
    }
    let revoked = update_issue(
        &state,
        user(7),
        &private.id,
        input("Restored", Some(archived.version), vec![]),
    )
    .await
    .unwrap();
    let (first, second) = tokio::join!(
        update_issue(
            &state,
            user(7),
            &private.id,
            input("Concurrent A", Some(revoked.version), vec![])
        ),
        update_issue(
            &state,
            user(7),
            &private.id,
            input("Concurrent B", Some(revoked.version), vec![])
        )
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert_eq!(
        first.err().or_else(|| second.err()).unwrap().status(),
        StatusCode::CONFLICT
    );
    assert!(
        create_issue(
            &state,
            user(7),
            input("Inactive invitation", None, vec![10])
        )
        .await
        .is_err()
    );
    let current = get_issue(&state, user(7), &private.id).await.unwrap();
    associate_project(
        &state,
        user(7),
        &private.id,
        ProjectInput {
            project_id: "1001".into(),
            version: current.version,
            status: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        get_issue(&state, user(7), &private.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    #[derive(FromMysqlRow)]
    struct Node {
        cloud_project_id: String,
        sequence_number: i32,
    }
    let node: Node = mysql
        .fetch_one(
            "SELECT cloud_project_id,sequence_number FROM loop_items WHERE id=?",
            (private.id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(node.cloud_project_id, "1001");
    assert_eq!(node.sequence_number, 1);
    let removable = create_issue(&state, user(7), input("Delete", None, vec![8]))
        .await
        .unwrap();
    assert_eq!(
        delete_issue(
            &state,
            user(8),
            &removable.id,
            Version {
                version: removable.version
            }
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::NOT_FOUND
    );
    delete_issue(
        &state,
        user(7),
        &removable.id,
        Version {
            version: removable.version,
        },
    )
    .await
    .unwrap();
    assert!(get_issue(&state, user(7), &removable.id).await.is_err());
    mysql.execute("UPDATE loop_items SET metadata=JSON_OBJECT('membership_mode','inherit','task_provider','backend','board_config',JSON_OBJECT('statuses',JSON_ARRAY())) WHERE id='1001'",()).await.unwrap();
    let no_status = create_issue(&state, user(7), input("No status board", None, vec![]))
        .await
        .unwrap();
    associate_project(
        &state,
        user(7),
        &no_status.id,
        ProjectInput {
            project_id: "1001".into(),
            version: no_status.version,
            status: Some(String::new()),
        },
    )
    .await
    .unwrap();
    let moved_status: String = mysql
        .fetch_one(
            "SELECT status FROM loop_items WHERE id=?",
            (no_status.id.as_str(),),
        )
        .await
        .unwrap();
    assert!(moved_status.is_empty());
    for index in 0..32 {
        let mut values = input(&format!("Page {index}"), None, vec![]);
        values.priority = if index % 2 == 0 { "urgent" } else { "low" }.into();
        let item = create_issue(&state, user(7), values).await.unwrap();
        mysql
            .execute(
                "UPDATE loop_items SET updated_at='2026-01-01 00:00:00' WHERE id=?",
                (item.id.as_str(),),
            )
            .await
            .unwrap();
    }
    for order in ["attention", "activity", "assignment", "priority"] {
        let query = |cursor| ListQuery {
            scope: "created".into(),
            order: order.into(),
            include_completed: false,
            archived: false,
            cursor,
        };
        let first = list_issues(&state, user(7), Query(query(None)))
            .await
            .unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 30);
        let cursor = first["next_cursor"].as_str().unwrap().to_string();
        assert!(
            list_issues(&state, user(8), Query(query(Some(cursor.clone()))))
                .await
                .is_err()
        );
        let second = list_issues(&state, user(7), Query(query(Some(cursor))))
            .await
            .unwrap();
        let ids = first["items"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["items"].as_array().unwrap())
            .map(|row| row["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 32, "{order}");
        assert!(second["next_cursor"].is_null());
        if matches!(order, "attention" | "priority") {
            assert_eq!(first["items"][0]["priority"], "urgent");
        }
    }
    verify_resource_invitations(&state).await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; explicitly run by backend Rust CI"]
async fn cp13_cp14_independent_issues_preserve_owner_invitation_and_transaction_boundaries() {
    let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set disposable MySQL fixture address")
        .parse()
        .unwrap();
    assert!(address.ip().is_loopback());
    let name = format!(
        "personal_issues_{}",
        crate::wework_auth_tokens::uuid4_hex()
            .unwrap()
            .replace('-', "")
    );
    let admin = MysqlService::connect(&format!("mysql://root@{address}/mysql?ssl-mode=disabled"))
        .await
        .unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&format!("mysql://root@{address}/{name}?ssl-mode=disabled"))
        .await
        .unwrap();
    let outcome = tokio::spawn(verify(mysql)).await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    outcome.unwrap();
}

async fn verify_resource_invitations(state: &AppState) {
    state.mysql.execute("INSERT INTO kinds VALUES (3001,7,'Coding Agent','Team','default',true,JSON_OBJECT()),(3002,9,'Private Agent','Team','default',true,JSON_OBJECT()),(4001,7,'Team','CollaborationGroup','workspaces/2001',true,JSON_OBJECT('spec',JSON_OBJECT('leader',JSON_OBJECT('kind','human','id','8'),'members',JSON_ARRAY())))",()).await.unwrap();
    state.mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CollaborationGroup',4001,'workspace','2001','approved','Developer')",()).await.unwrap();
    let mut body = input("Typed invitation", None, vec![]);
    body.resource_participants = vec![
        ResourceInvitation {
            kind: "agent".into(),
            id: 3001,
        },
        ResourceInvitation {
            kind: "group".into(),
            id: 4001,
        },
    ];
    body.assignee_resource = Some(body.resource_participants[0].clone());
    let row = create_issue(state, user(7), body).await.unwrap();
    assert_eq!(row.metadata.0.resource_participants.len(), 2);
    assert_eq!(row.metadata.0.participants, vec![8]);
    assert_eq!(row.metadata.0.resource_participants[0].team_id, Some(3001));
    assert!(get_issue(state, user(8), &row.id).await.is_ok());
    assert!(
        processing_resource(state, user(7), &row.id, "agent", "3001")
            .await
            .is_ok()
    );
    assert_eq!(
        processing_resource(state, user(8), &row.id, "agent", "3001")
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    state
        .mysql
        .execute("UPDATE kinds SET is_active=false WHERE id=3001", ())
        .await
        .unwrap();
    assert_eq!(
        processing_resource(state, user(7), &row.id, "agent", "3001")
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    state
        .mysql
        .execute("UPDATE kinds SET is_active=true WHERE id=3001", ())
        .await
        .unwrap();
    assert_eq!(
        get_issue(state, user(9), &row.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let mut forbidden = input("Unowned Agent", None, vec![]);
    forbidden.resource_participants = vec![ResourceInvitation {
        kind: "agent".into(),
        id: 3002,
    }];
    assert_eq!(
        create_issue(state, user(7), forbidden)
            .await
            .unwrap_err()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut remove = input("Typed invitation", Some(row.version), vec![]);
    remove.resource_participants = vec![ResourceInvitation {
        kind: "agent".into(),
        id: 3001,
    }];
    let updated = update_issue(state, user(7), &row.id, remove).await.unwrap();
    assert!(updated.metadata.0.participants.is_empty());
    assert_eq!(
        get_issue(state, user(8), &row.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
}
