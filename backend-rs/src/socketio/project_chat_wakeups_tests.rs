//! Real migration-schema transactions cover cursor allocation, idempotence and rollback.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlError};
use serde_json::{Value, json};

use super::enqueue;

#[derive(FromMysqlRow)]
struct Event {
    user_id: i64,
    sort_order: i64,
    metadata: Json<Value>,
}

pub(crate) async fn verify(mysql: &impl Mysql) -> anyhow::Result<()> {
    mysql.execute("INSERT INTO users(id,user_name,password_hash,`role`,auth_source,preferences) VALUES (7001,'mention-owner-a','','user','password','{}'),(7002,'mention-owner-b','','user','password','{}')",()).await?;
    mysql.execute("INSERT INTO loop_items(id,resource_type,description,created_at,updated_at) VALUES ('mention-issue-a','task','',NOW(),NOW()),('mention-issue-b','task','',NOW(),NOW())",()).await?;
    let write = |issue: &'static str, comment: &'static str| async move {
        mysql
            .with_transaction(async |tx| {
                enqueue(tx, &[7002, 7001, 7001], "mention-project", issue, comment).await
            })
            .await
    };
    let (a, b) = tokio::join!(
        write("mention-issue-a", "first"),
        write("mention-issue-b", "second")
    );
    a?;
    b?;
    write("mention-issue-a", "first").await?;
    let rolled_back: brz_mysql::MysqlResult<()> = mysql
        .with_transaction(async |tx| {
            enqueue(
                tx,
                &[7001],
                "mention-project",
                "mention-issue-a",
                "rolled-back",
            )
            .await?;
            Err(MysqlError::InvalidQuery {
                reason: "deliberate rollback".into(),
            })
        })
        .await;
    assert!(rolled_back.is_err());
    // A provider-owned Issue can have no local index row.
    write("provider-owned-issue", "third").await?;
    let events: Vec<Event> = mysql.fetch_all("SELECT user_id,sort_order,metadata FROM loop_items WHERE resource_type='stand_in_issue_event' AND user_id IN (7001,7002) ORDER BY user_id,sort_order",()).await?;
    assert_eq!(
        events.len(),
        6,
        "each recipient gets exactly one durable event per comment"
    );
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.user_id, if index < 3 { 7001 } else { 7002 });
        assert_eq!(event.sort_order, [1, 2, 4][index % 3]);
        assert_ne!(event.metadata.0["commentId"], "rolled-back");
        assert_eq!(event.metadata.0["projectId"], "mention-project");
    }
    assert_eq!(
        events[2].metadata.0,
        json!({"projectId":"mention-project","itemId":"provider-owned-issue","commentId":"third"})
    );
    Ok(())
}
