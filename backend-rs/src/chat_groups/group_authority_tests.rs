//! Actual group-management account locking uses the message protocol's user order.
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlService};
use serde_json::{Value, json};

use super::repository::{lock_access, lock_group_users};

pub(crate) async fn verify_group_account_order(mysql: &MysqlService) {
    mysql
        .execute("ALTER TABLE users ADD COLUMN user_name VARCHAR(255)", ())
        .await
        .unwrap();
    mysql
        .execute("UPDATE users SET user_name=CONCAT('member-',id)", ())
        .await
        .unwrap();
    mysql.execute("ALTER TABLE resource_members CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",()).await.unwrap();
    mysql.execute("CREATE INDEX group_identity ON resource_members(resource_type,resource_id,entity_type,entity_id)",()).await.unwrap();
    for (group, owner) in [(1101, 7), (1102, 8)] {
        mysql.execute("INSERT INTO loop_items(id,resource_type,project_key,status,name,description,metadata,version,created_at,updated_at) VALUES(?,'chat_group',?,'active','Group','',JSON_OBJECT(),1,UTC_TIMESTAMP(),UTC_TIMESTAMP())",(group.to_string(),format!("G{group}"))).await.unwrap();
        for user in [7, 8] {
            mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,status,role) VALUES('CollaborationChatGroup',?,'user',?,'approved',?)",(group,user.to_string(),if user==owner {"Owner"} else {"Developer"})).await.unwrap();
        }
    }
    for alias in ["07", "09"] {
        mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,status,role) VALUES('CollaborationChatGroup',1101,'user',?,'approved','Maintainer')",(alias,)).await.unwrap();
    }
    assert_eq!(
        super::repository::members(mysql, "1101")
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        super::repository::access(mysql, "1101", 9)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let first_mysql = mysql.clone();
    let first = tokio::spawn(async move {
        first_mysql
            .with_transaction(async |tx| {
                assert_eq!(
                    lock_group_users(tx, "1101", 7, [8]).await?,
                    [7, 8].into_iter().collect()
                );
                assert!(lock_access(tx, "1101", 7).await?.can_manage());
                ready_tx.send(()).unwrap();
                released.await.unwrap();
                Ok(())
            })
            .await
    });
    if ready.await.is_err() {
        panic!(
            "First group authority transaction failed before its barrier: {:?}",
            first.await
        );
    }
    let second_mysql = mysql.clone();
    let second = tokio::spawn(async move {
        second_mysql
            .with_transaction(async |tx| {
                assert_eq!(
                    lock_group_users(tx, "1102", 8, [7]).await?,
                    [7, 8].into_iter().collect()
                );
                assert!(lock_access(tx, "1102", 8).await?.can_manage());
                Ok(())
            })
            .await
    });
    #[derive(FromMysqlRow)]
    struct Waits {
        count: i64,
    }
    let observed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let waits: Option<Waits> = mysql.fetch_optional("SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='users' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='7'",()).await.unwrap();
            if waits.is_some_and(|waits| waits.count > 0) { break; }
            assert!(!second.is_finished(), "Management completed before the account lock barrier");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await;
    release.send(()).unwrap();
    observed.expect("Management did not wait for the lowest shared account ID");
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    let denied: MysqlResult<()> = mysql
        .with_transaction(async |tx| {
            lock_group_users(tx, "1101", 9, [7]).await?;
            Ok(())
        })
        .await;
    assert!(denied.unwrap_err().to_string().contains("chat-group:404:"));
    verify_participation_preferences(mysql).await;
    verify_group_publication_audience(mysql).await;
}

async fn verify_group_publication_audience(mysql: &MysqlService) {
    use crate::socketio::{chat_audience, project_chat_snapshot::changed_item_recipients};
    let rooms = chat_audience::rooms(mysql, "1101", None).await.unwrap();
    assert_eq!(rooms.len(), 2);
    assert!(rooms.iter().all(|room| room.contains(":user:")));
    let payload = json!({"groupId":"1101","projectId":"1101","itemId":"preference-thread"});
    assert!(
        chat_audience::notification_allowed(mysql, 7, &payload)
            .await
            .unwrap()
    );
    let participant = super::participant_id("preference-thread", 7);
    mysql.execute("UPDATE loop_items SET metadata=JSON_SET(metadata,'$.notifications','muted') WHERE id=?",(participant.as_str(),)).await.unwrap();
    assert!(
        !chat_audience::notification_allowed(mysql, 7, &payload)
            .await
            .unwrap()
    );
    mysql.execute("UPDATE loop_items SET metadata=JSON_SET(metadata,'$.notifications','all'),status='left' WHERE id=?",(participant.as_str(),)).await.unwrap();
    assert!(
        !chat_audience::notification_allowed(mysql, 7, &payload)
            .await
            .unwrap()
    );
    mysql
        .execute(
            "UPDATE loop_items SET status='active' WHERE id=?",
            (participant.as_str(),),
        )
        .await
        .unwrap();
    mysql
        .with_transaction(async |tx| {
            let (_, members) = super::repository::lock_message_authority(tx, "1101", 7).await?;
            assert_eq!(members, [7, 8].into_iter().collect());
            Ok(())
        })
        .await
        .unwrap();
    let denied = mysql
        .with_transaction(async |tx| {
            super::repository::lock_message_authority(tx, "1101", 8).await?;
            Ok(())
        })
        .await;
    assert!(denied.unwrap_err().to_string().contains("chat-group:403:"));
    assert!(
        chat_audience::rooms(mysql, "1101", Some("missing-thread"))
            .await
            .unwrap()
            .is_empty()
    );
    for user in [8, 7] {
        mysql.execute("DELETE FROM resource_members WHERE resource_type='CollaborationChatGroup' AND resource_id=1101 AND entity_id=?",(user.to_string(),)).await.unwrap();
    }
    assert!(
        !chat_audience::notification_allowed(mysql, 7, &payload)
            .await
            .unwrap()
    );
    // Owner metadata and malformed aliases are not current grants.
    assert!(
        chat_audience::rooms(mysql, "1101", Some("preference-thread"))
            .await
            .unwrap()
            .is_empty()
    );
    mysql
        .with_transaction(async |tx| {
            let change = changed_item_recipients(tx, "preference-thread", 8)
                .await?
                .unwrap();
            assert!(change.users.is_empty());
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        chat_audience::rooms(mysql, "missing-container", None)
            .await
            .unwrap()
            .is_empty()
    );
    mysql.execute("INSERT INTO loop_items(id,resource_type,status,version,metadata) VALUES('120001','project','active',1,JSON_OBJECT())",()).await.unwrap();
    assert_eq!(
        chat_audience::rooms(mysql, "120001", None).await.unwrap(),
        vec![crate::socketio::device_runtime_event::project_chat_room(
            "120001", None
        )]
    );
}

async fn verify_participation_preferences(mysql: &MysqlService) {
    use super::participation::{apply_change, participant_id};
    mysql.execute("INSERT INTO loop_items(id,resource_type,cloud_project_id,status,version,metadata) VALUES('preference-thread','task','1101','completed',1,JSON_OBJECT())",()).await.unwrap();
    mysql
        .with_transaction(async |tx| {
            apply_change(tx, "1101", "preference-thread", 7, true, Some("muted")).await
        })
        .await
        .unwrap();
    let id = participant_id("preference-thread", 7);
    mysql
        .execute(
            "UPDATE loop_items SET metadata=JSON_SET(metadata,'$.retained','choice') WHERE id=?",
            (id.as_str(),),
        )
        .await
        .unwrap();
    #[derive(FromMysqlRow)]
    struct Saved {
        status: String,
        metadata: Json<Value>,
    }
    for joined in [false, true] {
        mysql
            .with_transaction(async |tx| {
                apply_change(tx, "1101", "preference-thread", 7, joined, None).await
            })
            .await
            .unwrap();
        let row: Option<Saved> = mysql
            .fetch_optional(
                "SELECT status,metadata FROM loop_items WHERE id=?",
                (id.as_str(),),
            )
            .await
            .unwrap();
        let row = row.unwrap();
        assert_eq!(row.status, if joined { "active" } else { "left" });
        assert_eq!(
            row.metadata.0,
            json!({"notifications":"muted","retained":"choice"})
        );
    }
    mysql
        .with_transaction(async |tx| {
            apply_change(tx, "1101", "preference-thread", 7, true, Some("all")).await
        })
        .await
        .unwrap();
    let row: Option<Saved> = mysql
        .fetch_optional(
            "SELECT status,metadata FROM loop_items WHERE id=?",
            (id.as_str(),),
        )
        .await
        .unwrap();
    assert_eq!(
        row.unwrap().metadata.0,
        json!({"notifications":"all","retained":"choice"})
    );
    mysql.execute("UPDATE resource_members SET role='Viewer' WHERE resource_type='CollaborationChatGroup' AND resource_id=1101 AND entity_id='8'",()).await.unwrap();
    mysql
        .with_transaction(async |tx| {
            apply_change(tx, "1101", "preference-thread", 8, true, None).await
        })
        .await
        .unwrap();
    let row: Option<Saved> = mysql
        .fetch_optional(
            "SELECT status,metadata FROM loop_items WHERE id=?",
            (participant_id("preference-thread", 8),),
        )
        .await
        .unwrap();
    assert_eq!(row.unwrap().status, "active");
}
