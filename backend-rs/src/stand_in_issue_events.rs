//! Recipient-owned durable Issue wakeups are independent of human notifications.
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{http_compat::FastApiError, state::AppState};

/// Commit a validated mention with its comment, after locking the owning Issue.
/// The user and inbox locks match Python's Issue -> recipient -> inbox order.
pub(crate) async fn enqueue_mention_on(
    tx: &mut impl MysqlTransaction,
    user: i64,
    project: &str,
    issue: &str,
    comment: &str,
) -> MysqlResult<()> {
    use crate::background_jobs::project::store;

    // Keep sorted keys and Python's default JSON spacing for cross-writer dedupe.
    let payload = json!({"commentId":comment,"itemId":issue,"projectId":project});
    let id = crate::hex_sha256(
        format!(
            "stand-in:{user}:{}",
            wegent_python_compat::py_json::python_dumps(&payload)
        )
        .as_bytes(),
    );
    let _: (i64,) = tx
        .fetch_optional("SELECT id FROM users WHERE id=? FOR UPDATE", (user,))
        .await?
        .ok_or(brz_mysql::MysqlError::RowNotFound)?;
    let inbox_id = format!("stand-in-inbox:{user}");
    // Insert before taking a current read to avoid locking an empty index gap
    // shared by first-time recipients.
    store::insert_once(
        tx,
        "stand_in_issue_inbox",
        json!({"id":inbox_id,"user_id":user,"next_item_number":1}),
    )
    .await?;
    let sequence = store::locked(tx, "stand_in_issue_inbox", &inbox_id)
        .await?
        .filter(|inbox| inbox.user_id == user)
        .ok_or(brz_mysql::MysqlError::RowNotFound)?
        .next_item_number;
    store::insert_once(
        tx,
        "stand_in_issue_event",
        json!({
            "id":id,"parent_id":inbox_id,"user_id":user,"sort_order":sequence,"metadata":payload
        }),
    )
    .await?;
    // The no-op upsert keeps the sequence of an existing event. Read the
    // current row because MySQL can report a no-op update as an affected row.
    let (event_sequence,): (i64,) = tx
        .fetch_optional(
            "SELECT CAST(sort_order AS SIGNED) FROM loop_items WHERE id=? AND parent_id=? AND resource_type='stand_in_issue_event' AND user_id=? FOR UPDATE",
            (id.as_str(), inbox_id.as_str(), user),
        )
        .await?
        .ok_or(brz_mysql::MysqlError::RowNotFound)?;
    if event_sequence != sequence {
        return Ok(());
    }
    tx.execute(
        "UPDATE loop_items SET next_item_number=? WHERE id=? AND resource_type='stand_in_issue_inbox' AND user_id=?",
        (sequence + 1, inbox_id.as_str(), user),
    ).await?;
    Ok(())
}

#[derive(Default, Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: i64,
}

#[derive(FromMysqlRow)]
struct EventRow {
    sequence: i64,
    payload: Json<Value>,
}

fn events_sql(user: i64, after: i64) -> String {
    format!(
        "SELECT sort_order AS sequence, metadata AS payload FROM loop_items WHERE parent_id='stand-in-inbox:{user}' AND resource_type='stand_in_issue_event' AND user_id={user} AND sort_order>{after} ORDER BY sort_order ASC LIMIT 101"
    )
}

fn page(rows: Vec<EventRow>, after: i64) -> Value {
    let has_more = rows.len() > 100;
    let events = rows
        .into_iter()
        .take(100)
        .map(|row| json!({"sequence":row.sequence,"payload":row.payload.0}))
        .collect::<Vec<_>>();
    let cursor = events
        .last()
        .and_then(|event| event["sequence"].as_i64())
        .unwrap_or(after);
    json!({"events":events,"cursor":cursor,"has_more":has_more})
}

#[brz_http_server::get("/api/v1/stand-in-issue-events")]
async fn list_stand_in_issue_events(
    #[inject(state)] state: &AppState,
    #[auth] user: crate::auth::SessionUser,
    query: brz_http_server::Query<EventQuery>,
) -> Result<Value, FastApiError> {
    if query.after < 0 {
        return Err(FastApiError::validation(
            json!([{"loc":["query","after"],"type":"greater_than_equal","msg":"after must be non-negative"}]),
        ));
    }
    let rows = state
        .mysql
        .fetch_all(&events_sql(i64::from(user.id), query.after), ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "Stand-in Issue event read failed");
            FastApiError::internal()
        })?;
    Ok(page(rows, query.after))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipient_and_sequence_are_exact_and_bounded() {
        let sql = events_sql(7, 31);
        assert!(sql.contains("parent_id='stand-in-inbox:7'"));
        assert!(sql.contains("user_id=7 AND sort_order>31"));
        assert!(sql.ends_with("ORDER BY sort_order ASC LIMIT 101"));
        assert!(!sql.contains("notifications"));
        assert_eq!(
            page(Vec::new(), 31),
            json!({"events":[],"cursor":31,"has_more":false})
        );
    }

    #[test]
    fn a_full_page_advances_only_to_the_last_delivered_event() {
        let rows = (41..142)
            .map(|sequence| EventRow {
                sequence,
                payload: Json(json!({"commentId":format!("comment-{sequence}")})),
            })
            .collect();
        let result = page(rows, 40);
        assert_eq!(result["events"].as_array().unwrap().len(), 100);
        assert_eq!(result["events"][0]["sequence"], 41);
        assert_eq!(result["cursor"], 140);
        assert_eq!(result["has_more"], true);
        let last = page(
            vec![EventRow {
                sequence: 141,
                payload: Json(json!({"commentId":"comment-141"})),
            }],
            140,
        );
        assert_eq!(last["cursor"], 141);
        assert_eq!(last["has_more"], false);
    }
}
