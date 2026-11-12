//! Real MySQL coverage reuses the CI coordination schema and production inbox queries.
use super::*;
use brz_mysql::MysqlService;

async fn assert_visible(mysql: &MysqlService, expected: &[&str]) {
    let rows: Vec<NotificationRow> = mysql.fetch_all(list_sql(7, 0, 50, None), ()).await.unwrap();
    let mut ids: Vec<_> = rows.iter().map(|row| row.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, expected);
    let unread: UnreadCountRow = mysql
        .fetch_one(unread_count_sql(7, None), ())
        .await
        .unwrap();
    assert_eq!(unread.count_1, expected.len() as i64);
}

pub(crate) async fn verify_group_notification_reads(mysql: &MysqlService) {
    mysql.execute("ALTER TABLE resource_members CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",()).await.unwrap();
    mysql.execute("CREATE TABLE wework_notifications (id VARCHAR(36) PRIMARY KEY,user_id INT,actor_user_id INT,kind VARCHAR(64),title VARCHAR(256),body TEXT,url TEXT,payload JSON,created_at DATETIME(6),is_read BOOL,read_status_changed_at DATETIME(6))",()).await.unwrap();
    for id in ["9001", "9002"] {
        mysql
            .execute(
                "INSERT INTO loop_items (id,resource_type,status) VALUES (?,'chat_group','active')",
                (id,),
            )
            .await
            .unwrap();
    }
    for (id, group) in [("group-thread", "9001"), ("foreign-thread", "9002")] {
        mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,status) VALUES (?,'task',?,'completed')",(id,group)).await.unwrap();
    }
    for (id, payload) in [
        ("personal", json!({})),
        ("project", json!({"projectId":"1001"})),
        ("root", json!({"projectId":"9001","groupId":"9001"})),
        (
            "thread",
            json!({"projectId":"9001","groupId":"9001","itemId":"group-thread"}),
        ),
        ("old-root", json!({"projectId":"9001"})),
        (
            "foreign",
            json!({"projectId":"9001","groupId":"9001","itemId":"foreign-thread"}),
        ),
        ("missing", json!({"projectId":"9003","groupId":"9003"})),
    ] {
        mysql.execute("INSERT INTO wework_notifications VALUES (?,7,1,'thread_message','Title','Private preview','',?,NOW(),false,NOW())",(id,Json(payload))).await.unwrap();
    }
    // Existing project/workspace authority is not group authority.
    assert_visible(mysql, &["personal", "project"]).await;
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CollaborationChatGroup',9001,'user','7','approved','Viewer')",()).await.unwrap();
    for sentinel in ["1970-01-01 00:00:00", "1970-01-01 00:00:01"] {
        mysql
            .execute(
                "UPDATE loop_items SET deleted_at=? WHERE id IN ('9001','group-thread')",
                (sentinel,),
            )
            .await
            .unwrap();
        assert_visible(
            mysql,
            &["old-root", "personal", "project", "root", "thread"],
        )
        .await;
    }
    assert_visible(
        mysql,
        &["old-root", "personal", "project", "root", "thread"],
    )
    .await;
    mysql
        .execute(
            "UPDATE loop_items SET status='archived' WHERE id='9001'",
            (),
        )
        .await
        .unwrap();
    assert_visible(
        mysql,
        &["old-root", "personal", "project", "root", "thread"],
    )
    .await;
    mysql
        .execute(
            "UPDATE loop_items SET deleted_at=NOW() WHERE id='group-thread'",
            (),
        )
        .await
        .unwrap();
    assert_visible(mysql, &["old-root", "personal", "project", "root"]).await;
    mysql.execute("UPDATE resource_members SET status='rejected' WHERE resource_type='CollaborationChatGroup' AND resource_id=9001",()).await.unwrap();
    assert_visible(mysql, &["personal", "project"]).await;
    mysql.execute("UPDATE resource_members SET status='approved' WHERE resource_type='CollaborationChatGroup' AND resource_id=9001",()).await.unwrap();
    mysql
        .execute("UPDATE users SET is_active=0 WHERE id=7", ())
        .await
        .unwrap();
    assert_visible(mysql, &["personal", "project"]).await;
    mysql
        .execute("UPDATE users SET is_active=1 WHERE id=7", ())
        .await
        .unwrap();
    mysql
        .execute("UPDATE loop_items SET deleted_at=NOW() WHERE id='9001'", ())
        .await
        .unwrap();
    assert_visible(mysql, &["personal", "project"]).await;
}
