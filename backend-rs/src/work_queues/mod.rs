// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/work-queues/messages/unread-count` — unread message count.
//!
//! Mirrors `app.api.endpoints.work_queue.get_unread_message_count`
//! (registered under the `/work-queues` prefix):
//! `Depends(security.get_current_user)` then
//! `QueueMessageService.get_unread_counts` grouped by queue.
//!
//! The recorded case sends no `Authorization` header, so the OAuth2 scheme
//! rejects the request before any dependency SQL runs with
//! `401 {"detail":"Not authenticated"}` and `WWW-Authenticate: Bearer`.
use std::collections::BTreeMap;

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::auth::TeamsUser;
use crate::teams::auth_error::AuthError;

/// Grouped unread count row, in the source's SQLAlchemy label shape
/// (`SELECT queue_messages.queue_id AS queue_messages_queue_id,
/// count(queue_messages.id) AS count ...`).
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct UnreadCountRow {
    queue_messages_queue_id: i32,
    count: i64,
}

/// `UnreadCountResponse` (`app.schemas.work_queue`): `total` then `byQueue`,
/// in the pydantic model's serialization order. The `byQueue` keys render as
/// JSON strings, ascending by queue id.
#[derive(Debug, serde::Serialize)]
struct UnreadCountResponse {
    total: i64,
    #[serde(rename = "byQueue")]
    by_queue: BTreeMap<i64, i64>,
}

/// GET /api/work-queues/messages/unread-count: the work-queues free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/work-queues/messages/unread-count")]
async fn get_unread_message_count(
    #[inject(state)] state: &AppState,
    #[auth] current_user: TeamsUser,
) -> Result<UnreadCountResponse, FastApiError> {
    unread_count(state, current_user).await
}

/// Handler body for `GET /api/work-queues/messages/unread-count`.
async fn unread_count(
    state: &AppState,
    current_user: TeamsUser,
) -> Result<UnreadCountResponse, FastApiError> {
    let user_id = current_user.0.users_id;

    // Source: db.query(QueueMessage.queue_id,
    // func.count(QueueMessage.id).label("count")).filter(
    //     recipient_user_id == user_id, status == QueueMessageStatus.UNREAD
    // ).group_by(queue_id)
    //
    // SQLAlchemy renders this as one COM_QUERY text statement with the
    // `queue_messages_<column>` labels and inline literals. Replay keeps
    // aggregate/GROUP BY queries strict, so render the same text form
    // (like `get_document_counts`); the user id is an authenticated i32 and
    // the status is a constant enum value, so inlining is injection-safe.
    let rows: Result<Vec<UnreadCountRow>, brz_mysql::MysqlError> = state
        .mysql
        .fetch_all(
            &format!(
                "SELECT queue_messages.queue_id AS queue_messages_queue_id, \
                 count(queue_messages.id) AS count \nFROM queue_messages \n\
                 WHERE queue_messages.recipient_user_id = {user_id} \
                 AND queue_messages.status = 'unread' \
                 GROUP BY queue_messages.queue_id"
            ),
            (),
        )
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Err(FastApiError::from(AuthError::dependency(error))),
    };

    // Source builds `by_queue = {r.queue_id: r.count for r in results}` then
    // `total = sum(by_queue.values())`; GROUP BY makes the keys unique.
    let by_queue: BTreeMap<i64, i64> = rows
        .into_iter()
        .map(|row| (i64::from(row.queue_messages_queue_id), row.count))
        .collect();
    let total: i64 = by_queue.values().sum();

    Ok(UnreadCountResponse { total, by_queue })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_response_matches_recorded_body() {
        let response = UnreadCountResponse {
            total: 0,
            by_queue: BTreeMap::new(),
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"total":0,"byQueue":{}}"#
        );
    }

    #[test]
    fn grouped_response_renders_string_keys_ascending() {
        let mut by_queue = BTreeMap::new();
        by_queue.insert(265320_i64, 3_i64);
        by_queue.insert(42_i64, 7_i64);
        let response = UnreadCountResponse {
            total: 10,
            by_queue,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"total":10,"byQueue":{"42":7,"265320":3}}"#
        );
    }
}
