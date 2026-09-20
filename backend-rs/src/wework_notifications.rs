// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/wework-notifications` — the Wework inbox list.
//!
//! Mirrors `app.api.endpoints.wework_notifications.list_notifications`
//! (router prefix `/v1/wework-notifications`, mounted under the app prefix
//! `/api`): authenticate the bearer token, load the user's notification rows
//! ordered by `created_at DESC, id DESC` with `LIMIT offset, limit + 1`, count
//! the unread rows, and render `InboxView` (`items`, `unread_count`,
//! `next_offset`).
//!
//! Source authentication is `Depends(get_current_user)` — the same OAuth2
//! Bearer JWT path used by the other user-scoped endpoints.
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{AuthFailure, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// FastAPI `Query(default=50, ge=1, le=100)` default for `limit`.
const DEFAULT_LIMIT: i64 = 50;
/// FastAPI `Query(default=0, ge=0)` default for `offset`.
const DEFAULT_OFFSET: i64 = 0;

/// Query parameters (`offset >= 0` default 0, `limit >= 1` and `<= 100`
/// default 50). FastAPI renders validation failures as 422 before the handler
/// body runs.
#[derive(Debug, Default, Deserialize)]
pub struct InboxQuery {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

/// FastAPI-style 422 validation error body (`Query(...)` constraints).
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    let detail = json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": crate::json_compat::JsonNull,
        }
    ]);
    FastApiError::validation(detail)
}

impl InboxQuery {
    /// Validate the FastAPI query contract: `offset >= 0`,
    /// `1 <= limit <= 100`. Returns the effective `(offset, limit)`.
    fn validated(&self) -> Result<(i64, i64), FastApiError> {
        let offset = match self.offset {
            None => DEFAULT_OFFSET,
            Some(offset) if offset >= 0 => offset,
            Some(_) => {
                return Err(validation_error(
                    "offset",
                    "greater_than_equal",
                    "Input should be greater than or equal to 0",
                ));
            }
        };
        let limit = match self.limit {
            None => DEFAULT_LIMIT,
            Some(limit) if (1..=100).contains(&limit) => limit,
            Some(limit) if limit < 1 => {
                return Err(validation_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                ));
            }
            Some(_) => {
                return Err(validation_error(
                    "limit",
                    "less_than_equal",
                    "Input should be less than or equal to 100",
                ));
            }
        };
        Ok((offset, limit))
    }
}

/// `wework_notifications` row, selected with the full labeled source column
/// list (`wework_notifications.<column> AS wework_notifications_<column>`)
/// so the prepared statement matches the recorded exchange for replay. Only
/// the response fields are consumed; the rest carry `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
struct NotificationRow {
    #[mysql(rename = "wework_notifications_id")]
    id: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "wework_notifications_user_id")]
    user_id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "wework_notifications_actor_user_id")]
    actor_user_id: i32,
    #[mysql(rename = "wework_notifications_kind")]
    kind: String,
    #[mysql(rename = "wework_notifications_title")]
    title: String,
    #[mysql(rename = "wework_notifications_body")]
    body: String,
    #[mysql(rename = "wework_notifications_url")]
    url: String,
    #[mysql(rename = "wework_notifications_payload")]
    payload: Json<crate::json_compat::OpaqueJson>,
    #[mysql(rename = "wework_notifications_created_at")]
    created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "wework_notifications_is_read")]
    is_read: i8,
    #[mysql(rename = "wework_notifications_read_status_changed_at")]
    read_status_changed_at: NaiveDateTime,
}

/// Unread-count row: the source renders `SELECT count(*) AS count_1 FROM
/// (SELECT ... WHERE user_id = ? AND is_read IS false) AS anon_1`.
#[derive(Debug, FromMysqlRow)]
struct UnreadCountRow {
    count_1: i64,
}

/// The source `WeworkNotification` column projection, labeled like
/// SQLAlchemy's query rendering (`<table>_<column>`).
const NOTIFICATION_COLUMNS: &str = "wework_notifications.id AS wework_notifications_id, \
     wework_notifications.user_id AS wework_notifications_user_id, \
     wework_notifications.actor_user_id AS wework_notifications_actor_user_id, \
     wework_notifications.kind AS wework_notifications_kind, \
     wework_notifications.title AS wework_notifications_title, \
     wework_notifications.body AS wework_notifications_body, \
     wework_notifications.url AS wework_notifications_url, \
     wework_notifications.payload AS wework_notifications_payload, \
     wework_notifications.created_at AS wework_notifications_created_at, \
     wework_notifications.is_read AS wework_notifications_is_read, \
     wework_notifications.read_status_changed_at AS wework_notifications_read_status_changed_at";

/// `NotificationView` serialized timestamp: the source
/// `field_serializer("created_at", "read_at")` renders
/// `value.replace(tzinfo=timezone.utc).isoformat()` for a naive datetime,
/// producing `YYYY-MM-DDTHH:MM:SS+00:00` (microseconds appended only when
/// non-zero).
fn pydantic_timestamp(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.f+00:00").to_string()
    }
}

/// `NotificationView.serialize_destination`: `value or None` — an empty
/// string renders as JSON `null`.
fn serialize_url(url: &str) -> Option<String> {
    (!url.is_empty()).then(|| url.to_owned())
}

#[derive(Serialize)]
struct NotificationView {
    id: String,
    kind: String,
    title: String,
    body: String,
    url: Option<String>,
    // Notification kinds own their payload schemas; preserve their JSON verbatim.
    payload: Box<serde_json::value::RawValue>,
    created_at: String,
    read_at: Option<String>,
}

#[derive(Serialize)]
struct InboxView {
    items: Vec<NotificationView>,
    unread_count: i64,
    next_offset: Option<i64>,
}

fn notification_view(row: &NotificationRow) -> NotificationView {
    NotificationView {
        id: row.id.clone(),
        kind: row.kind.clone(),
        title: row.title.clone(),
        body: row.body.clone(),
        url: serialize_url(&row.url),
        payload: serde_json::value::to_raw_value(&row.payload.0).expect("JSON value serializes"),
        created_at: pydantic_timestamp(row.created_at),
        read_at: (row.is_read != 0).then(|| pydantic_timestamp(row.read_status_changed_at)),
    }
}

fn inbox_view(
    items: Vec<NotificationView>,
    unread_count: i64,
    next_offset: Option<i64>,
) -> InboxView {
    InboxView {
        items,
        unread_count,
        next_offset,
    }
}

/// GET /api/v1/wework-notifications: the wework-inbox free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/v1/wework-notifications")]
async fn list_notifications(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<InboxQuery>,
) -> Result<InboxView, FastApiError> {
    inbox(state, authorization, &query).await
}

/// Handler body for `GET /api/v1/wework-notifications`.
async fn inbox(
    state: &AppState,
    authorization: Option<&str>,
    query: &InboxQuery,
) -> Result<InboxView, FastApiError> {
    let (offset, limit) = query.validated()?;
    let user = match get_current_user(&state.auth, &state.mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };
    let user_id = i64::from(user.id);
    let limit_plus_one = limit + 1;

    // Source: db.query(WeworkNotification).filter(user_id == user.id)
    //   .order_by(created_at DESC, id DESC).offset(offset).limit(limit + 1)
    // SQLAlchemy renders the labeled projection with inline literals for
    // offset/limit. Replay matches the text form; the user id, offset, and
    // limit are authenticated integers, so inlining is injection-safe.
    let rows: Vec<NotificationRow> = match state
        .mysql
        .fetch_all(
            &format!(
                "SELECT {NOTIFICATION_COLUMNS} \nFROM wework_notifications \n\
                 WHERE wework_notifications.user_id = {user_id} \
                 ORDER BY wework_notifications.created_at DESC, \
                 wework_notifications.id DESC \n LIMIT {offset}, {limit_plus_one}",
            ),
            (),
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "wework_notifications list database failure");
            return Err(FastApiError::internal());
        }
    };

    let has_more = rows.len() as i64 > limit;
    let items: Vec<NotificationView> = rows
        .iter()
        .take(limit as usize)
        .map(notification_view)
        .collect();

    // Source: query.filter(is_read.is_(False)).count() renders a subquery
    // `SELECT count(*) AS count_1 FROM (SELECT ... WHERE user_id = ? AND
    // is_read IS false) AS anon_1`.
    let unread_row: Option<UnreadCountRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT count(*) AS count_1 \nFROM (SELECT {NOTIFICATION_COLUMNS} \n\
                 FROM wework_notifications \n\
                 WHERE wework_notifications.user_id = {user_id} \
                 AND wework_notifications.is_read IS false) AS anon_1",
            ),
            (),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "wework_notifications unread-count database failure");
            FastApiError::internal()
        })?;
    let unread_count: i64 = unread_row.map(|row| row.count_1).unwrap_or(0);

    let next_offset = if has_more { Some(offset + limit) } else { None };

    Ok(inbox_view(items, unread_count, next_offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn inbox_query_defaults_when_absent() {
        let query = InboxQuery {
            offset: None,
            limit: None,
        };
        assert_eq!(query.validated().unwrap(), (0, 50));
    }

    #[test]
    fn inbox_query_accepts_explicit_values() {
        let query = InboxQuery {
            offset: Some(10),
            limit: Some(25),
        };
        assert_eq!(query.validated().unwrap(), (10, 25));
    }

    #[test]
    fn inbox_query_rejects_negative_offset() {
        let query = InboxQuery {
            offset: Some(-1),
            limit: None,
        };
        assert!(query.validated().is_err());
    }

    #[test]
    fn inbox_query_rejects_zero_limit() {
        let query = InboxQuery {
            offset: None,
            limit: Some(0),
        };
        assert!(query.validated().is_err());
    }

    #[test]
    fn inbox_query_rejects_limit_over_100() {
        let query = InboxQuery {
            offset: None,
            limit: Some(101),
        };
        assert!(query.validated().is_err());
    }

    #[test]
    fn empty_url_serializes_as_null() {
        assert_eq!(serialize_url(""), None);
    }

    #[test]
    fn non_empty_url_serializes_as_string() {
        assert_eq!(
            serialize_url("wework://boards/1"),
            Some("wework://boards/1".to_string())
        );
    }

    #[test]
    fn timestamp_renders_utc_isoformat() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_opt(10, 50, 56)
            .unwrap();
        assert_eq!(pydantic_timestamp(dt), "2026-09-10T10:50:56+00:00");
    }

    #[test]
    fn empty_inbox_matches_recorded_body() {
        let body = inbox_view(Vec::new(), 0, None);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"items":[],"unread_count":0,"next_offset":null}"#
        );
    }

    #[test]
    fn next_offset_present_when_more_rows() {
        let body = inbox_view(Vec::new(), 0, Some(50));
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"items":[],"unread_count":0,"next_offset":50}"#
        );
    }

    #[test]
    fn notification_view_renders_unread_row() {
        let row = NotificationRow {
            id: "abc".to_string(),
            user_id: 151,
            actor_user_id: 0,
            kind: "message".to_string(),
            title: "Title".to_string(),
            body: "Body".to_string(),
            url: String::new(),
            payload: Json(json!({}).into()),
            created_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(10, 50, 56)
                .unwrap(),
            is_read: 0,
            read_status_changed_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(10, 50, 56)
                .unwrap(),
        };
        let view = crate::json_contract_tests::serialized(notification_view(&row)).unwrap();
        let expected = json!({
            "id": "abc",
            "kind": "message",
            "title": "Title",
            "body": "Body",
            "url": null,
            "payload": {},
            "created_at": "2026-09-10T10:50:56+00:00",
            "read_at": null,
        });
        assert_eq!(view, expected);
    }

    #[test]
    fn notification_view_renders_read_row() {
        let row = NotificationRow {
            id: "abc".to_string(),
            user_id: 151,
            actor_user_id: 0,
            kind: "message".to_string(),
            title: "Title".to_string(),
            body: "Body".to_string(),
            url: "wework://boards/1".to_string(),
            payload: Json(json!({"k": "v"}).into()),
            created_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(10, 50, 56)
                .unwrap(),
            is_read: 1,
            read_status_changed_at: NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(11, 0, 0)
                .unwrap(),
        };
        let view = crate::json_contract_tests::serialized(notification_view(&row)).unwrap();
        let expected = json!({
            "id": "abc",
            "kind": "message",
            "title": "Title",
            "body": "Body",
            "url": "wework://boards/1",
            "payload": {"k": "v"},
            "created_at": "2026-09-10T10:50:56+00:00",
            "read_at": "2026-09-10T11:00:00+00:00",
        });
        assert_eq!(view, expected);
    }
}
