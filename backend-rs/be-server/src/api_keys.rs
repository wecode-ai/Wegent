// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/api-keys` — the current user's personal API-key listing.
//!
//! Mirrors `app.api.endpoints.api_keys.list_api_keys`: verify the bearer JWT
//! via `get_current_user`, then load every `personal` key owned by the current
//! user, newest first, and render `APIKeyListResponse(items, total)`.
//!
//! The listing never exposes key material. The stored `key_hash` is selected to
//! keep the statement identical to the recorded exchange but is not projected
//! into the response; `key_prefix` is the already-masked display value
//! (`wg-<8 chars>...`) the source persists at creation time.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `app.models.api_key.KEY_TYPE_PERSONAL`: the only `key_type` this listing
/// returns.
const KEY_TYPE_PERSONAL: &str = "personal";

/// GET /api/api-keys: the personal API-key listing for the authenticated user.
#[brz_http_server::get("/api/api-keys")]
async fn list_api_keys(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<APIKeyListResponse, FastApiError> {
    api_keys(state, user.0.id).await
}

/// Handler body for `GET /api/api-keys`.
async fn api_keys(state: &AppState, user_id: i32) -> Result<APIKeyListResponse, FastApiError> {
    let rows = fetch_api_keys(&state.mysql, user_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "api-keys database dependency failure");
            FastApiError::unhandled()
        })?;
    let items: Vec<APIKeyItem> = rows.iter().map(api_key_item).collect();
    let total = items.len() as i64;
    Ok(APIKeyListResponse { items, total })
}

/// `db.query(APIKey).filter(APIKey.user_id == current_user.id,
/// APIKey.key_type == KEY_TYPE_PERSONAL).order_by(APIKey.created_at.desc())
/// .all()`: every mapped column, aliased `api_keys_<column>` like SQLAlchemy's
/// labeled rendering. Only the projected columns are decoded; `user_id`,
/// `key_hash`, `key_type`, and `updated_at` are selected to keep the statement
/// identical to the recorded exchange.
const API_KEYS_QUERY: &str = "SELECT api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at \
     FROM api_keys \
     WHERE api_keys.user_id = ? AND api_keys.key_type = ? \
     ORDER BY api_keys.created_at DESC";

/// One `api_keys` row, projected to the columns the response reads.
#[derive(Debug, FromMysqlRow)]
struct APIKeyRow {
    #[mysql(rename = "api_keys_id")]
    id: i32,
    #[mysql(rename = "api_keys_name")]
    name: String,
    #[mysql(rename = "api_keys_key_prefix")]
    key_prefix: String,
    #[mysql(rename = "api_keys_description")]
    description: Option<String>,
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: chrono::NaiveDateTime,
    #[mysql(rename = "api_keys_last_used_at")]
    last_used_at: chrono::NaiveDateTime,
    #[mysql(rename = "api_keys_created_at")]
    created_at: chrono::NaiveDateTime,
    #[mysql(rename = "api_keys_is_active")]
    is_active: i8,
}

/// `APIKeyResponse` (`app.schemas.api_key`): field order follows the pydantic
/// model declaration. The stored key hash is never part of this projection.
#[derive(Debug, Serialize)]
pub struct APIKeyItem {
    pub id: i32,
    pub name: String,
    pub key_prefix: String,
    pub description: Option<String>,
    pub expires_at: String,
    pub last_used_at: String,
    pub created_at: String,
    pub is_active: bool,
}

/// `APIKeyListResponse` (`app.schemas.api_key`): `items` precedes `total`.
#[derive(Debug, Serialize)]
pub struct APIKeyListResponse {
    pub items: Vec<APIKeyItem>,
    pub total: i64,
}

/// Project one row into the response item, mirroring the source loop that
/// validates each `APIKey` through `APIKeyResponse`.
fn api_key_item(row: &APIKeyRow) -> APIKeyItem {
    APIKeyItem {
        id: row.id,
        name: row.name.clone(),
        key_prefix: row.key_prefix.clone(),
        description: row.description.clone(),
        expires_at: pydantic_datetime(row.expires_at),
        last_used_at: pydantic_datetime(row.last_used_at),
        created_at: pydantic_datetime(row.created_at),
        is_active: row.is_active != 0,
    }
}

/// Run the personal API-key listing query.
async fn fetch_api_keys<M>(mysql: &M, user_id: i32) -> MysqlResult<Vec<APIKeyRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(API_KEYS_QUERY, (user_id, KEY_TYPE_PERSONAL))
        .await
}

/// pydantic serializes a DB `datetime` as `YYYY-MM-DDTHH:MM:SS`, plus
/// six-digit microseconds when the stored value has a fractional part.
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!(
            "{}.{:06}",
            value.format("%Y-%m-%dT%H:%M:%S"),
            value.and_utc().timestamp_subsec_micros()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn naive(month: u32, day: u32, hour: u32, minute: u32, second: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, second)
            .unwrap()
    }

    fn row() -> APIKeyRow {
        APIKeyRow {
            id: 5212,
            name: "example-user-remote-device".to_string(),
            key_prefix: "wg-TeQeG2kw...".to_string(),
            description: Some("Auto-generated for remote Docker device".to_string()),
            expires_at: NaiveDate::from_ymd_opt(9999, 12, 31)
                .unwrap()
                .and_hms_opt(23, 59, 59)
                .unwrap(),
            last_used_at: naive(9, 22, 15, 39, 57),
            created_at: naive(9, 22, 15, 39, 57),
            is_active: 1,
        }
    }

    #[test]
    fn response_shape_matches_pydantic_model() {
        let response = APIKeyListResponse {
            items: vec![api_key_item(&row())],
            total: 1,
        };
        let body = serde_json::to_string(&response).unwrap();
        assert_eq!(
            body,
            "{\"items\":[{\"id\":5212,\"name\":\"example-user-remote-device\",\
             \"key_prefix\":\"wg-TeQeG2kw...\",\
             \"description\":\"Auto-generated for remote Docker device\",\
             \"expires_at\":\"9999-12-31T23:59:59\",\
             \"last_used_at\":\"2026-09-22T15:39:57\",\
             \"created_at\":\"2026-09-22T15:39:57\",\"is_active\":true}],\"total\":1}"
        );
    }

    #[test]
    fn empty_description_and_inactive_key_serialize_like_the_model() {
        let mut row = row();
        row.description = Some(String::new());
        row.is_active = 0;
        let item = api_key_item(&row);
        assert_eq!(item.description, Some(String::new()));
        assert!(!item.is_active);
        let body = serde_json::to_string(&item).unwrap();
        assert!(body.contains("\"description\":\"\""), "{body}");
        assert!(body.contains("\"is_active\":false"), "{body}");
    }

    #[test]
    fn pydantic_datetime_has_no_fraction_for_second_precision() {
        let dt = naive(9, 22, 15, 39, 57);
        assert_eq!(pydantic_datetime(dt), "2026-09-22T15:39:57");
    }

    #[test]
    fn pydantic_datetime_renders_microseconds_when_present() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 22)
            .unwrap()
            .and_hms_micro_opt(15, 39, 57, 123456)
            .unwrap();
        assert_eq!(pydantic_datetime(dt), "2026-09-22T15:39:57.123456");
    }

    /// The recorded statement inlines the bound values; the target binds them
    /// as parameters, so the SQL must stay token-identical after whitespace
    /// normalization once the literals are replaced by `?`.
    #[test]
    fn api_keys_query_matches_recorded_statement() {
        let recorded = "SELECT api_keys.id AS api_keys_id, api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, api_keys.updated_at AS api_keys_updated_at \nFROM api_keys \nWHERE api_keys.user_id = 157 AND api_keys.key_type = 'personal' ORDER BY api_keys.created_at DESC";
        fn tokens(sql: &str) -> Vec<String> {
            sql.split_whitespace()
                .map(|token| match token {
                    "157" => "?".to_string(),
                    "'personal'" => "?".to_string(),
                    other => other.to_string(),
                })
                .collect()
        }
        assert_eq!(tokens(API_KEYS_QUERY), tokens(recorded));
    }

    #[tokio::test]
    async fn list_binds_the_user_id_and_personal_key_type() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let rows = fetch_api_keys(&mysql, 157).await.unwrap();
        assert!(rows.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 2);
        // The user id binds as an integer; the key type as a string.
        assert_eq!(queries[0].first_integer, Some(157));
        assert!(
            queries[0]
                .sql
                .contains("WHERE api_keys.user_id = ? AND api_keys.key_type = ?"),
            "{}",
            queries[0].sql
        );
        assert!(
            queries[0]
                .sql
                .ends_with("ORDER BY api_keys.created_at DESC"),
            "the recorded ordering is preserved: {}",
            queries[0].sql
        );
    }
}
