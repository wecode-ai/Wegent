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
    mysql
        .execute(crate::app_test_support::PROJECT_CHAT_MESSAGES_DDL, ())
        .await
        .unwrap();
    mysql
        .execute(
            "CREATE TABLE wework_notifications (
                id VARCHAR(36) PRIMARY KEY,
                user_id BIGINT NOT NULL,
                actor_user_id BIGINT NOT NULL,
                kind VARCHAR(64) NOT NULL,
                title VARCHAR(256) NOT NULL,
                body TEXT NOT NULL,
                url VARCHAR(2048) NOT NULL,
                payload JSON NOT NULL,
                created_at DATETIME(6) NOT NULL,
                is_read BOOLEAN NOT NULL,
                read_status_changed_at DATETIME(6) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            (),
        )
        .await
        .unwrap();
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
            } else if name == "cloud_project_id" {
                "VARCHAR(64)"
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
                "CREATE TABLE loop_items ({}, FOREIGN KEY (cloud_project_id)
                    REFERENCES loop_items(id) ON DELETE CASCADE) ENGINE=InnoDB",
                columns.join(",")
            ),
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "CREATE TABLE users (id INT PRIMARY KEY,user_name VARCHAR(100),is_active BOOL,preferences TEXT)",
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO users(id,user_name,is_active) VALUES (7,'Owner',true),(8,'Participant',true),(9,'Outsider',true),(10,'Inactive',false)",()).await.unwrap();
    mysql.execute("CREATE TABLE kinds (id BIGINT PRIMARY KEY,user_id INT,name TEXT,kind VARCHAR(50),namespace VARCHAR(100),is_active BOOL,json JSON,created_at DATETIME,updated_at DATETIME)",()).await.unwrap();
    mysql
        .execute(
            "CREATE TABLE resource_members (
                id BIGINT PRIMARY KEY AUTO_INCREMENT, resource_type VARCHAR(50), resource_id BIGINT,
                entity_type VARCHAR(50), entity_id VARCHAR(100), entity_display_name TEXT,
                user_id BIGINT, role VARCHAR(50), status VARCHAR(50), invited_by_user_id BIGINT,
                share_link_id BIGINT, reviewed_by_user_id BIGINT, reviewed_at DATETIME,
                copied_resource_id BIGINT, requested_at DATETIME, created_at DATETIME, updated_at DATETIME
             ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (2001,7,'Project space','CollaborationWorkspace','default',true,JSON_OBJECT())",()).await.unwrap();
    mysql.execute("INSERT INTO loop_items (id,resource_type,status,name,title,description,metadata,version,next_item_number,created_by_user_id) VALUES ('1001','project','active','Project','Project','',JSON_OBJECT('membership_mode','inherit','task_provider','backend'),1,1,7)",()).await.unwrap();
    mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',1001,'workspace','2001','approved','Owner')",()).await.unwrap();
}

async fn discussion_ids(mut mysql: &MysqlService, project_id: &str, issue_id: &str) -> Vec<String> {
    fetch_history(
        &mut mysql,
        project_id,
        Some(issue_id),
        None,
        HistoryPage::All,
    )
    .await
    .unwrap()
    .into_iter()
    .map(|row| row.message_id)
    .collect()
}

async fn active_assignment_ids(mysql: &MysqlService, issue_id: &str) -> Vec<String> {
    let comments = crate::loop_tasks::loop_repository::LoopItemRepository::new(mysql)
        .list_assignment_comments(issue_id)
        .await
        .unwrap();
    crate::loop_tasks::assignments::active_events(&comments)
        .into_iter()
        .map(|event| event.comment.id.clone())
        .collect()
}

async fn collaborators(mysql: &MysqlService, issue_id: &str) -> Vec<(String, i32, Option<String>)> {
    mysql.fetch_all(
        "SELECT id,user_id,NULLIF(cloud_project_id,'') FROM loop_items WHERE resource_type='collaborator' AND loop_item_id=? ORDER BY user_id",
        (issue_id,),
    ).await.unwrap()
}

async fn verify(mysql: MysqlService) {
    seed(&mysql).await;
    let state = crate::app_test_support::app(mysql.clone());
    let private = create_issue(&state, user(7), input("Private by default", None, vec![]))
        .await
        .unwrap();
    let (stored_project, age_seconds, standalone_marker): (Option<String>, i64, Option<String>) = mysql
        .fetch_one(
            "SELECT NULLIF(cloud_project_id,''), TIMESTAMPDIFF(SECOND, created_at, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 8 HOUR)), \
             CAST(JSON_EXTRACT(metadata,'$.standalone') AS CHAR) \
             FROM loop_items WHERE id=? AND resource_type='task'",
            (private.id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(stored_project, None);
    assert_eq!(standalone_marker, None);
    assert!(
        age_seconds.abs() < 60,
        "Issue timestamps must use the same database clock as project Issues"
    );
    assert!(private.metadata.0.participants.is_empty());
    assert_eq!(private.people.0["7"], "Owner");
    let participation = state.participation_state();
    assert_eq!(
        participation
            .support
            .require_issue_read(&private.id, 7)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
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
    let direct = collaborators(&mysql, &private.id).await;
    assert_eq!(direct.len(), 1);
    assert_eq!((direct[0].1, direct[0].2.as_deref()), (8, None));
    assert_eq!(invited.metadata.0.direct_people(), &[8]);
    let (metadata,): (Json<Value>,) = mysql
        .fetch_one(
            "SELECT metadata FROM loop_items WHERE id=?",
            (private.id.as_str(),),
        )
        .await
        .unwrap();
    assert!(metadata.0.get("direct_participants").is_none());
    assert!(metadata.0.get("participants").is_none());
    for (id, user_id) in [("owner-task", 7), ("guest-task", 8)] {
        crate::loop_tasks::assignments::require_issue_read_for_user(&state, &private.id, user_id)
            .await
            .unwrap();
        mysql.execute(
            "INSERT INTO loop_items (id,resource_type,loop_item_id,description,metadata,task_user_id,linked_by_user_id,device_id,task_id)
             VALUES (?,'execution',?,'','{}',?,?,'test-device',?)",
            (id, private.id.as_str(), user_id, user_id, id),
        ).await.unwrap();
        let bindings = crate::loop_tasks::handler::loop_item_tasks(&state, &private.id, user_id)
            .await
            .unwrap();
        let response = serde_json::to_value(bindings).unwrap();
        assert_eq!(response.as_array().unwrap().len(), 1);
        assert_eq!(response[0]["id"], id);
    }
    let (recipient, event): (i64, Json<Value>) = mysql
        .fetch_one(
            "SELECT user_id,metadata FROM loop_items WHERE resource_type='stand_in_issue_event'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(recipient, 8);
    assert_eq!(
        event.0,
        json!({"personalIssueId":private.id,"assignmentId":invited.metadata.0.assignment_id})
    );
    assert_eq!(
        active_assignment_ids(&mysql, &private.id).await,
        vec![invited.metadata.0.assignment_id.clone().unwrap()]
    );
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
    mysql.execute(
        "INSERT INTO loop_items (id,resource_type,loop_item_id,description,created_by_user_id,metadata,created_at,updated_at)
         VALUES ('legacy-discussion','comment',?,'An existing discussion post',7,'{}','2026-01-01 01:02:03','2026-01-01 01:02:04')",
        (private.id.as_str(),),
    ).await.unwrap();
    let message_view = || {
        Query(DiscussionQuery {
            view: DiscussionView::Message,
        })
    };
    let before = list_comments(&state, user(7), &private.id, message_view())
        .await
        .unwrap();
    assert_eq!(before, json!([]));
    let forbidden_mention = comment(
        &state,
        user(8),
        &private.id,
        CommentInput {
            body: "Outside this Issue".into(),
            mentioned_user_ids: vec![9],
        },
    )
    .await
    .unwrap_err();
    assert_eq!(forbidden_mention.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(discussion_ids(&mysql, "", &private.id).await.is_empty());
    mysql.execute(
        "UPDATE users SET preferences=? WHERE id=7",
        (json!({"wework_notification_preferences":{"collaboration":{"system":false,"im":false}}}).to_string(),),
    ).await.unwrap();
    let posted = comment(
        &state,
        user(8),
        &private.id,
        CommentInput {
            body: "A real participant update".into(),
            mentioned_user_ids: vec![7, 7, 8],
        },
    )
    .await
    .unwrap();
    let discussion = list_comments(&state, user(7), &private.id, message_view())
        .await
        .unwrap();
    assert_eq!(discussion.as_array().unwrap().len(), 1);
    assert_eq!(discussion[0]["sender"]["id"], "8");
    assert_eq!(discussion[0]["messageId"], posted["id"]);
    let notices: Vec<(i64, Json<Value>)> = mysql
        .fetch_all(
            "SELECT user_id,payload FROM wework_notifications WHERE kind='mention' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.commentId'))=?",
            (posted["id"].as_str().unwrap(),),
        )
        .await
        .unwrap();
    assert_eq!(notices.len(), 1);
    let (recipient, Json(payload)) = &notices[0];
    assert_eq!(*recipient, 7);
    assert_eq!(payload["personalIssueId"], private.id);
    assert_eq!(payload["commentPreview"], "A real participant update");
    let (Json(metadata),): (Json<Value>,) = mysql
        .fetch_one(
            "SELECT metadata FROM loop_items WHERE id=?",
            (private.id.as_str(),),
        )
        .await
        .unwrap();
    assert!(
        metadata["content_revision"]
            .as_i64()
            .is_some_and(|revision| revision > 1)
    );
    assert_eq!(
        metadata["read_revisions"]["8"],
        metadata["content_revision"]
    );
    let message_ids = discussion_ids(&mysql, "", &private.id).await;
    assert_eq!(message_ids, [posted["id"].as_str().unwrap()]);
    let assignment = invited.metadata.0.assignment_id.as_deref().unwrap();
    let device = verify_assistant_reservation(&state, &private.id, assignment).await;
    let current = get_issue(&state, user(7), &private.id).await.unwrap();
    for (actor, status) in [(8, StatusCode::FORBIDDEN), (9, StatusCode::NOT_FOUND)] {
        assert_eq!(
            invitations::remove_collaborator(&state, user(actor), &private.id, 8)
                .await
                .err()
                .unwrap()
                .status(),
            status
        );
    }
    let removed = invitations::remove_collaborator(&state, user(7), &private.id, 8)
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NO_CONTENT);
    let revoked = get_issue(&state, user(7), &private.id).await.unwrap();
    assert_eq!(revoked.version, current.version + 1);
    assert_eq!(revoked.title, current.title);
    assert!(revoked.assignee_id.is_none());
    assert!(collaborators(&mysql, &private.id).await.is_empty());
    assert!(active_assignment_ids(&mysql, &private.id).await.is_empty());
    let reserved: (i64,) = mysql
        .fetch_one(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type='execution' AND loop_item_id=?
             AND task_id='stand-in-issue-runtime' AND unlinked_at IS NOT NULL",
            (private.id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(reserved.0, 1);
    assert_eq!(
        crate::loop_tasks::assignments::require_issue_read_for_user(&state, &private.id, 8)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        crate::loop_tasks::handler::loop_item_tasks(&state, &private.id, 8)
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        assistant::reply(
            &state,
            user(8),
            &private.id,
            assistant_reply(assignment, device)
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get_issue(&state, user(8), &private.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        list_comments(&state, user(8), &private.id, message_view())
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
                body: "After revocation".into(),
                ..Default::default()
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
    let mut current = get_issue(&state, user(7), &private.id).await.unwrap();
    for status in ["in_progress", "completed"] {
        let mut body = input("Updated status", Some(current.version), vec![]);
        body.status = status.into();
        current = update_issue(&state, user(7), &private.id, body)
            .await
            .unwrap();
    }
    assert_eq!(current.metadata.0.status_history.len(), 3);
    assert_eq!(
        current.metadata.0.status_history[2]["from_status"],
        "in_progress"
    );
    assert_eq!(
        current.metadata.0.status_history[2]["to_status"],
        "completed"
    );
    let mut grant = input(&current.title, Some(current.version), vec![8]);
    grant.status = current.status.clone();
    let current = update_issue(&state, user(7), &private.id, grant)
        .await
        .unwrap();
    let direct = collaborators(&mysql, &private.id).await;
    associate_project(
        &state,
        user(7),
        &private.id,
        ProjectInput {
            project_id: "1001".into(),
            version: current.version,
            status: Some("pending".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        collaborators(&mysql, &private.id).await,
        vec![(direct[0].0.clone(), 8, Some("1001".into()))],
    );
    assert!(discussion_ids(&mysql, "", &private.id).await.is_empty());
    let migrated = discussion_ids(&mysql, "1001", &private.id).await;
    assert_eq!(migrated.len(), 2);
    assert_eq!(&migrated[..1], &message_ids);
    let mut publication = issue_message(
        &private,
        "project-comment-after-association",
        ("7", "user", "Owner"),
        "A project discussion update",
        None,
    );
    let old_scope = mysql
        .with_transaction(async |tx| {
            let issue = locked_issue_node(tx, &private.id).await?;
            publish_comment_on(tx, &publication, 7, Some(&issue), &[], json!({})).await
        })
        .await;
    assert!(matches!(old_scope, Err(brz_mysql::MysqlError::RowNotFound)));
    assert!(discussion_ids(&mysql, "", &private.id).await.is_empty());
    crate::loop_tasks::assignments::require_issue_read_for_user(&state, &private.id, 7)
        .await
        .unwrap();
    participation
        .support
        .require_issue_read(&private.id, 7)
        .await
        .unwrap();
    let owner_bindings = crate::loop_tasks::handler::loop_item_tasks(&state, &private.id, 7)
        .await
        .unwrap();
    let response = serde_json::to_value(owner_bindings).unwrap();
    assert_eq!(response.as_array().unwrap().len(), 1);
    assert_eq!(response[0]["id"], "owner-task");
    assert_eq!(response[0]["cloud_project_id"], "1001");
    let mut query = &mysql;
    let page = fetch_history(
        &mut query,
        "1001",
        Some(&private.id),
        None,
        HistoryPage::Latest { limit: 2 },
    )
    .await
    .unwrap();
    assert_eq!(
        [&page[0].message_id, &page[1].message_id],
        [&migrated[0], &migrated[1]]
    );
    let next = fetch_history(
        &mut query,
        "1001",
        Some(&private.id),
        None,
        HistoryPage::After {
            sequence: page[0].id,
            limit: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].message_id, migrated[1]);
    assert!(
        fetch_history(
            &mut query,
            "1001",
            Some("another-issue"),
            Some(&migrated[1]),
            HistoryPage::Latest { limit: 1 },
        )
        .await
        .unwrap()
        .is_empty()
    );
    let (history,): (Json<Vec<Value>>,) = mysql
        .fetch_one(
            "SELECT JSON_EXTRACT(metadata,'$.status_history') FROM loop_items WHERE id=?",
            (private.id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(
        &history.0[..3],
        current.metadata.0.status_history.as_slice()
    );
    assert_eq!(history.0[3]["from_status"], "completed");
    assert_eq!(history.0[3]["to_status"], "pending");
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
    publication.project_id = "1001";
    mysql
        .with_transaction(async |tx| {
            let issue = locked_issue_node(tx, &private.id).await?;
            publish_comment_on(tx, &publication, 7, Some(&issue), &[], json!({})).await
        })
        .await
        .unwrap();
    assert_eq!(
        discussion_ids(&mysql, "1001", &private.id)
            .await
            .last()
            .map(String::as_str),
        Some("project-comment-after-association")
    );
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
    verify_shared_attachment_record(&state).await;
    verify_shared_due_dates(&state, &mysql).await;
    verify_child_creation(&state).await;
    verify_assistant_reply_requires_execution_binding(&state).await;
    verify_project_collaborator_removal(&state).await;
}

async fn verify_project_collaborator_removal(state: &AppState) {
    let mysql = &state.mysql;
    let fixture = json!({"loop_item_id":"project-guest-issue","user_id":8,"added_by_user_id":7,"source":"manual"});
    mysql.with_transaction(async |tx| {
        tx.execute("UPDATE loop_items SET metadata=JSON_SET(metadata,'$.task_provider','local') WHERE id='1001'", ()).await?;
        wegent_project_coordination::project_store::insert(
            tx,
            "task",
            json!({"id":"project-guest-issue","cloud_project_id":"1001","title":"Project guest Issue","metadata":{"security_level":"open"},"created_by_user_id":7}),
        ).await?;
        wegent_project_coordination::project_store::insert(tx, "collaborator", fixture.clone()).await?;
        Ok(())
    }).await.unwrap();
    let revoke =
        |actor| invitations::remove_collaborator(state, user(actor), "project-guest-issue", 8);
    assert_eq!(
        revoke(9).await.err().unwrap().status(),
        StatusCode::NOT_FOUND
    );
    mysql.execute(
        "INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,status,role)
         VALUES ('CloudProject',1001,'user','9','approved','Viewer')",
        (),
    ).await.unwrap();
    assert_eq!(
        revoke(9).await.err().unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(collaborators(mysql, "project-guest-issue").await.len(), 1);
    assert_eq!(revoke(8).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(collaborators(mysql, "project-guest-issue").await.is_empty());
    assert_eq!(
        revoke(8).await.err().unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        revoke(7).await.err().unwrap().status(),
        StatusCode::NOT_FOUND
    );
    mysql
        .execute(
            "UPDATE loop_items SET assignee_user_id=8 WHERE id='project-guest-issue'",
            (),
        )
        .await
        .unwrap();
    mysql
        .with_transaction(async |tx| {
            wegent_project_coordination::project_store::insert(tx, "collaborator", fixture).await
        })
        .await
        .unwrap();
    assert_eq!(revoke(7).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(collaborators(mysql, "project-guest-issue").await.is_empty());
    crate::loop_tasks::assignments::require_issue_read_for_user(state, "project-guest-issue", 8)
        .await
        .unwrap();
}

async fn verify_child_creation(state: &AppState) {
    let parent = create_issue(state, user(7), input("Parent Issue", None, vec![8]))
        .await
        .unwrap();
    let child_input = |assignee| {
        let mut child = input("Child from discussion", None, vec![]);
        child.parent_id = Some(parent.id.clone());
        child.request_id = Some("9db41086-69e9-4c5a-b7cc-49113667a5c0".into());
        child.assignee_id = Some(assignee);
        child
    };
    assert_eq!(
        create_issue(state, user(9), child_input(9))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let child = create_issue(state, user(7), child_input(7)).await.unwrap();
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    let retry = create_issue(state, user(7), child_input(7)).await.unwrap();
    assert_eq!(retry.id, child.id);
    assert_eq!(
        retry.metadata.0.assignment_id,
        child.metadata.0.assignment_id
    );
    assert_eq!(
        active_assignment_ids(&state.mysql, &child.id).await,
        vec![child.metadata.0.assignment_id.unwrap()]
    );
    assert_eq!(
        get_issue(state, user(8), &child.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
}

async fn verify_shared_attachment_record(state: &AppState) {
    let id = share::random_id();
    let attachment_id = share::random_id();
    let share = share::NewShare {
        source: serde_json::from_value(json!({
            "device_id": "test-device",
            "task_id": "test-shared-attachment",
            "title": "Shared conversation",
        }))
        .unwrap(),
        files: vec![
            serde_json::from_value(json!({
                "id": attachment_id,
                "filename": "discussion.txt",
                "size": 4,
                "object_key": format!("issue-share/{attachment_id}"),
                "sha256": "test-digest",
            }))
            .unwrap(),
        ],
        project: None,
    };
    let mut issue_input = input("Shared attachment", None, vec![]);
    issue_input.assignee_id = Some(7);
    create_issue_record(state, 7, issue_input, &id, Some(&share))
        .await
        .unwrap();
    let created = get_issue(state, user(7), &id).await.unwrap();
    let mut invited = input("Shared attachment", Some(created.version), vec![8]);
    invited.assignee_id = Some(7);
    update_issue(state, user(7), &id, invited).await.unwrap();
    state
        .mysql
        .execute(
            "UPDATE loop_items SET metadata=JSON_SET(metadata,'$.share.files',?)
             WHERE id=?",
            (
                Json(json!([{
                    "id": "legacy-share-file",
                    "filename": "old.txt",
                    "size": 1,
                    "object_key": "issue-share/legacy-share-file",
                    "sha256": "legacy-digest",
                }])),
                id.as_str(),
            ),
        )
        .await
        .unwrap();
    let row = get_issue(state, user(7), &id).await.unwrap();
    let response = serde_json::to_value(&row).unwrap();
    let files = response["metadata"]["share"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    let file = &files[0];
    assert_eq!(file["id"], attachment_id);
    assert_eq!(file["issue_attachment"], true);
    assert!(file.get("object_key").is_none());
    let listed = list_issues(
        state,
        user(7),
        Query(ListQuery {
            scope: "created".into(),
            order: "activity".into(),
            include_completed: false,
            archived: false,
            cursor: None,
        }),
    )
    .await
    .unwrap();
    let listed_issue = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|issue| issue["id"] == id)
        .unwrap();
    assert_eq!(&listed_issue["metadata"]["share"]["files"][0], file);
    use brz_http_server::IntoHttpResponse;
    let redirect = share::redirect_shared_attachment(state, user(8), &id, &attachment_id)
        .await
        .unwrap();
    let arena = brz_http_server::EphemeralBytesArena::new(256);
    assert_eq!(
        redirect.into_http_response(&arena).status(),
        StatusCode::TEMPORARY_REDIRECT
    );
    assert_eq!(
        share::redirect_shared_attachment(state, user(9), &id, &attachment_id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let different = create_issue(state, user(7), input("Another Issue", None, vec![]))
        .await
        .unwrap();
    assert_eq!(
        share::redirect_shared_attachment(state, user(7), &different.id, &attachment_id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    associate_project(
        state,
        user(7),
        &id,
        ProjectInput {
            project_id: "1001".into(),
            version: row.version,
            status: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        share::redirect_shared_attachment(state, user(7), &id, &attachment_id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let assignment_id = row.metadata.0.assignment_id.unwrap();
    assert_eq!(
        active_assignment_ids(&state.mysql, &id).await,
        vec![assignment_id.clone()]
    );
    let (assignment_project,): (String,) = state
        .mysql
        .fetch_one(
            "SELECT cloud_project_id FROM loop_items WHERE id=? AND resource_type='comment'",
            (assignment_id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(assignment_project, "1001");
    let records: Vec<(String,)> = state
        .mysql
        .fetch_all(
            "SELECT id FROM loop_items WHERE loop_item_id=? AND resource_type='attachment'",
            (id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(records, vec![(attachment_id,)]);
}

async fn verify_shared_due_dates(state: &AppState, mysql: &MysqlService) {
    for nullable in [true, false] {
        if !nullable {
            mysql
                .execute(
                    "UPDATE loop_items SET due_at='1970-01-01 00:00:01' WHERE due_at IS NULL",
                    (),
                )
                .await
                .unwrap();
            mysql
                .execute(
                    "ALTER TABLE loop_items MODIFY due_at DATETIME(6) NOT NULL",
                    (),
                )
                .await
                .unwrap();
        }
        let mut body = input("Scheduled issue", None, vec![]);
        body.due_at = Some("2026-12-04".into());
        let row = create_issue(state, user(7), body).await.unwrap();
        assert_eq!(row.metadata.0.due_at.as_deref(), Some("2026-12-04"));
        mysql.execute(
            "UPDATE loop_items SET metadata=JSON_SET(metadata,'$.content_revision',4,'$.read_revisions',JSON_OBJECT('7',4)) WHERE id=?",
            (row.id.as_str(),),
        ).await.unwrap();
        let update = |version, due_at: Option<&str>| {
            let mut body = input("Renamed", Some(version), vec![]);
            body.due_at = due_at.map(str::to_owned);
            body
        };
        let changed = update_issue(
            state,
            user(7),
            &row.id,
            update(row.version, Some("2026-12-04")),
        )
        .await
        .unwrap();
        assert_eq!(changed.metadata.0.due_at.as_deref(), Some("2026-12-04"));
        let (Json(revisions),): (Json<Value>,) = mysql
            .fetch_one(
                "SELECT JSON_EXTRACT(metadata,'$.read_revisions') FROM loop_items WHERE id=?",
                (row.id.as_str(),),
            )
            .await
            .unwrap();
        assert_eq!(revisions, json!({"7":4}));
        assert_eq!(
            update_issue(state, user(7), &row.id, update(row.version, None))
                .await
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        let cleared = update_issue(state, user(7), &row.id, update(changed.version, None))
            .await
            .unwrap();
        assert!(cleared.metadata.0.due_at.is_none());
        let row = update_issue(
            state,
            user(7),
            &row.id,
            update(cleared.version, Some("2026-12-04")),
        )
        .await
        .unwrap();
        let stored: (String, bool) = mysql
            .fetch_one(
                "SELECT DATE_FORMAT(due_at,'%Y-%m-%d'), JSON_CONTAINS_PATH(metadata,'one','$.due_at') \
                 FROM loop_items WHERE id=?",
                (row.id.as_str(),),
            )
            .await
            .unwrap();
        assert_eq!(stored, ("2026-12-04".into(), false));

        let cleared = update_issue(
            state,
            user(7),
            &row.id,
            input("Scheduled issue", Some(row.version), vec![]),
        )
        .await
        .unwrap();
        assert_eq!(cleared.metadata.0.due_at, None);
        let stored: (Option<String>,) = mysql
            .fetch_one(
                "SELECT CAST(due_at AS CHAR) FROM loop_items WHERE id=?",
                (row.id.as_str(),),
            )
            .await
            .unwrap();
        assert_eq!(
            stored.0.as_deref().map(|date| &date[..19]),
            (!nullable).then_some("1970-01-01 00:00:01")
        );

        mysql.execute(
            "UPDATE loop_items SET metadata=JSON_SET(metadata,'$.due_at','2026-12-05') WHERE id=?",
            (row.id.as_str(),),
        ).await.unwrap();
        let legacy = get_issue(state, user(7), &row.id).await.unwrap();
        assert_eq!(legacy.metadata.0.due_at.as_deref(), Some("2026-12-05"));
        associate_project(
            state,
            user(7),
            &row.id,
            ProjectInput {
                project_id: "1001".into(),
                version: legacy.version,
                status: None,
            },
        )
        .await
        .unwrap();
        let stored: (String,) = mysql
            .fetch_one(
                "SELECT DATE_FORMAT(due_at,'%Y-%m-%d') FROM loop_items WHERE id=?",
                (row.id.as_str(),),
            )
            .await
            .unwrap();
        assert_eq!(stored.0, "2026-12-05");

        for (due_date, expected) in [
            (None, (!nullable).then_some("1970-01-01 00:00:01")),
            (Some("2026-12-04"), Some("2026-12-04 00:00:00")),
        ] {
            let id = share::random_id();
            let mut body = input("Shared issue", None, vec![]);
            body.due_at = due_date.map(str::to_owned);
            let share = share::NewShare {
                source: serde_json::from_value(json!({
                    "device_id": "test-device",
                    "task_id": "test-task",
                    "title": "Shared conversation",
                }))
                .unwrap(),
                files: vec![],
                project: Some(ProjectInput {
                    project_id: "1001".into(),
                    version: 1,
                    status: None,
                }),
            };
            create_issue_record(state, 7, body, &id, Some(&share))
                .await
                .unwrap();
            let (project_id, stored_due_at): (String, Option<String>) = mysql
                .fetch_one(
                    "SELECT cloud_project_id,DATE_FORMAT(due_at,'%Y-%m-%d %H:%i:%s') \
                     FROM loop_items WHERE id=?",
                    (id.as_str(),),
                )
                .await
                .unwrap();
            assert_eq!(project_id, "1001");
            assert_eq!(stored_due_at.as_deref(), expected, "nullable={nullable}");
        }
    }
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

fn assistant_address(assignment: &str, device: &str) -> Value {
    json!({"assignment_id":assignment,"device_id":device,"task_id":"stand-in-issue-runtime"})
}

fn assistant_reply(assignment: &str, device: &str) -> assistant::Reply {
    serde_json::from_value(json!({
        "assignment":assistant_address(assignment, device),
        "message_id":"completed-turn","body":"Verified by the reviewer",
    }))
    .unwrap()
}

async fn verify_assistant_reservation(
    state: &AppState,
    id: &str,
    assignment: &str,
) -> &'static str {
    state.mysql.execute(
        "INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (9001,8,'mac-a','Device','default',true,JSON_OBJECT('spec',JSON_OBJECT('deviceType','app','deviceId','mac-a'))),(9002,8,'mac-b','Device','default',true,JSON_OBJECT('spec',JSON_OBJECT('deviceType','app','deviceId','mac-b'))),(9003,7,'owner-mac','Device','default',true,JSON_OBJECT('spec',JSON_OBJECT('deviceType','app','deviceId','owner-mac')))",
        (),
    ).await.unwrap();
    let claim = |device| {
        serde_json::from_value(json!({
            "assignment":assistant_address(assignment, device),
            "role_id":"review","role_name":"Release reviewer",
        }))
        .unwrap()
    };
    assert_eq!(
        assistant::claim(state, user(7), id, claim("owner-mac"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        assistant::claim(state, user(8), id, claim("owner-mac"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    let (a, b) = tokio::join!(
        assistant::claim(state, user(8), id, claim("mac-a")),
        assistant::claim(state, user(8), id, claim("mac-b")),
    );
    let a_claimed = a.unwrap()["claimed"] == true;
    assert_ne!(a_claimed, b.unwrap()["claimed"] == true);
    let (active, other) = if a_claimed {
        ("mac-a", "mac-b")
    } else {
        ("mac-b", "mac-a")
    };
    assert_eq!(
        assistant::claim(state, user(8), id, claim(active))
            .await
            .unwrap()["claimed"],
        true
    );
    for (actor, visible) in [(7, false), (8, true)] {
        let bindings = crate::loop_tasks::handler::loop_item_tasks(state, id, actor)
            .await
            .unwrap();
        let response = serde_json::to_value(bindings).unwrap();
        assert_eq!(
            response
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["task_id"] == "stand-in-issue-runtime"),
            visible
        );
    }
    assert_eq!(
        assistant::reply(state, user(8), id, assistant_reply(assignment, other))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let first = assistant::reply(state, user(8), id, assistant_reply(assignment, active))
        .await
        .unwrap();
    let retry = assistant::reply(state, user(8), id, assistant_reply(assignment, active))
        .await
        .unwrap();
    assert_eq!(first, retry);
    let replies = list_comments(state, user(7), id, Query(DiscussionQuery::default()))
        .await
        .unwrap();
    let replies = replies.as_array().unwrap();
    assert_eq!(replies.len(), 2);
    let reply = replies
        .iter()
        .find(|reply| reply["assistant_name"].is_string())
        .unwrap();
    assert_eq!(reply["assistant_name"], "Release reviewer");
    assert_eq!(reply["author_id"], 8);
    active
}

async fn verify_assistant_reply_requires_execution_binding(state: &AppState) {
    let mut assigned = input("Legacy reservation", None, vec![8]);
    assigned.assignee_id = Some(8);
    let issue = create_issue(state, user(7), assigned).await.unwrap();
    let assignment = issue.metadata.0.assignment_id.as_deref().unwrap();
    state
        .mysql
        .execute(
            "UPDATE loop_items SET metadata=JSON_SET(metadata,'$.assistant_binding',
          JSON_OBJECT('device_record_id',9001,'task_id','stand-in-issue-runtime',
                      'role_id','review','role_name','Legacy reviewer')) WHERE id=?",
            (issue.id.as_str(),),
        )
        .await
        .unwrap();
    let public = serde_json::to_value(get_issue(state, user(7), &issue.id).await.unwrap()).unwrap();
    assert!(public["metadata"].get("assistant_binding").is_none());
    assert_eq!(
        assistant::reply(
            state,
            user(8),
            &issue.id,
            assistant_reply(assignment, "mac-a"),
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::NOT_FOUND
    );
    assert!(discussion_ids(&state.mysql, "", &issue.id).await.is_empty());
    let claim = serde_json::from_value(json!({
        "assignment": assistant_address(assignment, "mac-a"),
        "role_id": "review",
        "role_name": "Release reviewer",
    }))
    .unwrap();
    assert_eq!(
        assistant::claim(state, user(8), &issue.id, claim)
            .await
            .unwrap()["claimed"],
        true
    );
    let result = assistant::reply(
        state,
        user(8),
        &issue.id,
        assistant_reply(assignment, "mac-a"),
    )
    .await
    .unwrap();
    let retry = assistant::reply(
        state,
        user(8),
        &issue.id,
        assistant_reply(assignment, "mac-a"),
    )
    .await
    .unwrap();
    assert_eq!(result, retry);
    let stored = get_issue(state, user(7), &issue.id).await.unwrap();
    let comments = list_comments(
        state,
        user(7),
        &issue.id,
        Query(DiscussionQuery {
            view: DiscussionView::Message,
        }),
    )
    .await
    .unwrap();
    assert_eq!(comments.as_array().unwrap().len(), 1);
    assert_eq!(comments[0]["sender"]["name"], "Release reviewer");
    assert_eq!(comments[0]["sender"]["type"], "agent");
    assert!(comments[0]["runtimeAddress"].is_null());
    associate_project(
        state,
        user(7),
        &issue.id,
        ProjectInput {
            project_id: "1001".into(),
            version: stored.version,
            status: None,
        },
    )
    .await
    .unwrap();
    let (active,): (i64,) = state
        .mysql
        .fetch_one(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type='execution' AND loop_item_id=?
         AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",
            (issue.id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(active, 0);
}

async fn verify_resource_invitations(state: &AppState) {
    state.mysql.execute("INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (3001,7,'Coding Agent','Team','default',true,JSON_OBJECT()),(3002,9,'Private Agent','Team','default',true,JSON_OBJECT()),(4001,7,'Team','CollaborationGroup','workspaces/2001',true,JSON_OBJECT('spec',JSON_OBJECT('leader',JSON_OBJECT('kind','human','id','8'),'members',JSON_ARRAY())))",()).await.unwrap();
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
    let team_invitation = collaborators(&state.mysql, &row.id).await;
    assert_eq!(team_invitation.len(), 1);
    let mut grant = input(&row.title, Some(row.version), vec![8]);
    grant.resource_participants = participants::references(&row.metadata.0.resource_participants);
    grant.assignee_resource = row.metadata.0.assignee_resource.clone();
    let direct = update_issue(state, user(7), &row.id, grant).await.unwrap();
    assert_eq!(direct.metadata.0.direct_people(), &[8]);
    assert_eq!(collaborators(&state.mysql, &row.id).await, team_invitation);
    invitations::remove_collaborator(state, user(7), &row.id, 8)
        .await
        .unwrap();
    let row = get_issue(state, user(7), &row.id).await.unwrap();
    assert_eq!(row.version, direct.version + 1);
    assert!(row.metadata.0.direct_people().is_empty());
    assert_eq!(row.metadata.0.participants, vec![8]);
    assert_eq!(row.metadata.0.resource_participants.len(), 2);
    assert_eq!(collaborators(&state.mysql, &row.id).await, team_invitation);
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
    assert!(collaborators(&state.mysql, &row.id).await.is_empty());
    assert_eq!(
        get_issue(state, user(8), &row.id)
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
}
