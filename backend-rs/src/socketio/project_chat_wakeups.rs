//! Durable Issue intake is independent of human notification preferences and self mentions.
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde_json::json;
use sha2::{Digest, Sha256};

#[cfg(test)]
#[path = "project_chat_wakeups_tests.rs"]
mod tests;
#[cfg(test)]
pub(crate) use tests::verify;

#[derive(FromMysqlRow)]
struct Id {
    #[mysql(rename = "id")]
    _id: String,
}

#[derive(FromMysqlRow)]
struct Owner {
    #[mysql(rename = "users_id")]
    _id: i64,
}

#[derive(FromMysqlRow)]
struct Cursor {
    next_item_number: i64,
}

/// The caller has authorized every recipient against the current project and Issue.
pub(super) async fn enqueue(
    tx: &mut impl MysqlTransaction,
    recipients: &[i64],
    project: &str,
    issue: &str,
    comment: &str,
) -> MysqlResult<()> {
    if recipients.is_empty() {
        return Ok(());
    }
    // Match HTTP writers: Issue, sorted owner rows, then recipient inboxes.
    let indexed: Option<Id> = tx
        .fetch_optional("SELECT id FROM loop_items WHERE id=?", (issue,))
        .await?;
    // Provider-owned Issues may have no index. Locking an absent key would range-lock unrelated writes.
    if indexed.is_some() {
        let _: Option<Id> = tx
            .fetch_optional("SELECT id FROM loop_items WHERE id=? FOR UPDATE", (issue,))
            .await?;
    }
    let recipients = recipients
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    for user in recipients {
        let _: Option<Owner> = tx
            .fetch_optional(crate::device_records::LOCK_DEVICE_OWNER_QUERY, (user,))
            .await?;
        enqueue_recipient(tx, user, project, issue, comment).await?;
    }
    Ok(())
}

async fn enqueue_recipient(
    tx: &mut impl MysqlTransaction,
    user: i64,
    project: &str,
    issue: &str,
    comment: &str,
) -> MysqlResult<()> {
    let payload = json!({"commentId":comment,"itemId":issue,"projectId":project});
    // Preserve Python's sorted-key, ASCII-escaped identity across transports.
    let encoded = crate::json_compat::python_json_value(&payload);
    let event = format!("{:x}", Sha256::digest(format!("stand-in:{user}:{encoded}")));
    let inbox = format!("stand-in-inbox:{user}");
    tx.execute("INSERT INTO loop_items(id,resource_type,user_id,next_item_number,description,created_at,updated_at) VALUES (?,'stand_in_issue_inbox',?,1,'',NOW(),NOW()) ON DUPLICATE KEY UPDATE id=VALUES(id)", (inbox.as_str(),user)).await?;
    let cursor: Cursor = tx
        .fetch_one(
            "SELECT next_item_number FROM loop_items WHERE id=? FOR UPDATE",
            (inbox.as_str(),),
        )
        .await?;
    // Match HTTP's insert-once contract: duplicate events may consume a cursor position.
    tx.execute("INSERT INTO loop_items(id,resource_type,parent_id,user_id,sort_order,metadata,description,created_at,updated_at) VALUES (?,'stand_in_issue_event',?,?,?,?, '',NOW(),NOW()) ON DUPLICATE KEY UPDATE id=VALUES(id)", (event.as_str(),inbox.as_str(),user,cursor.next_item_number,Json(payload))).await?;
    tx.execute(
        "UPDATE loop_items SET next_item_number=next_item_number+1 WHERE id=?",
        (inbox.as_str(),),
    )
    .await?;
    Ok(())
}
