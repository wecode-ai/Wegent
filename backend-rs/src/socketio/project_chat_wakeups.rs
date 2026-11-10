// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Durable recipient wakeups share the comment transaction, independently of reminders.
use brz_mysql::{MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::background_jobs::project::store;
use crate::json_compat::python_json_value;

fn event_id(user: i64, payload: &Value) -> String {
    let mut sorted = payload.clone();
    sorted
        .as_object_mut()
        .expect("wakeup payload is an object")
        .sort_keys();
    format!(
        "{:x}",
        Sha256::digest(format!("stand-in:{user}:{}", python_json_value(&sorted)))
    )
}

/// The caller locks the Issue first; both Backend writers then lock user and inbox.
#[tracing::instrument(skip(tx, payload))]
pub(super) async fn enqueue(
    tx: &mut impl MysqlTransaction,
    user: i64,
    payload: &Value,
) -> MysqlResult<()> {
    let owner: Option<(i64,)> = tx
        .fetch_optional("SELECT id FROM users WHERE id=? FOR UPDATE", (user,))
        .await?;
    if owner.is_none() {
        return Err(brz_mysql::MysqlError::InvalidQuery {
            reason: "Mention recipient no longer exists".to_owned(),
        });
    }
    let inbox = format!("stand-in-inbox:{user}");
    store::insert_once(
        tx,
        "stand_in_issue_inbox",
        json!({"id":inbox,"user_id":user,"next_item_number":1}),
    )
    .await?;
    let (sequence,): (i64,) = tx.fetch_one(
        "SELECT next_item_number FROM loop_items WHERE id=? AND resource_type='stand_in_issue_inbox' AND user_id=? FOR UPDATE",
        (inbox.as_str(), user),
    ).await?;
    tx.execute(
        "UPDATE loop_items SET next_item_number=? WHERE id=? AND user_id=?",
        (sequence + 1, inbox.as_str(), user),
    )
    .await?;
    let id = event_id(user, payload);
    store::insert_once(
        tx,
        "stand_in_issue_event",
        json!({
            "id":id,"parent_id":inbox,"user_id":user,"sort_order":sequence,"metadata":payload,
        }),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wakeup_identity_matches_python_and_separates_recipients() {
        let payload = json!({"projectId":"project","itemId":"issue","commentId":"comment"});
        let expected = Sha256::digest(
            br#"stand-in:7:{"commentId": "comment", "itemId": "issue", "projectId": "project"}"#,
        );
        assert_eq!(event_id(7, &payload), format!("{expected:x}"));
        assert_ne!(event_id(7, &payload), event_id(8, &payload));
        assert_ne!(
            event_id(7, &payload),
            event_id(
                7,
                &json!({"projectId":"project","itemId":"other","commentId":"comment"})
            )
        );
    }
}
