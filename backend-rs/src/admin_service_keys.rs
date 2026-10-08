// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/service-keys` — the admin service-key listing.
//!
//! Mirrors `app.api.endpoints.admin.api_keys.list_service_keys`: authenticate
//! the session, require the `admin` role (`get_admin_user`), then load every
//! service key joined to its creator and render
//! `ServiceKeyListResponse(items, total)`.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;

use crate::auth::{AppAuthenticator, UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `app.models.api_key.KEY_TYPE_SERVICE`: the only `key_type` this listing
/// returns.
const KEY_TYPE_SERVICE: &str = "service";

/// The admin principal: a valid session user whose role is `admin`.
///
/// The source `get_admin_user` runs after `get_current_user`; a session that
/// is not an administrator is rejected with `403`. Authentication failures
/// keep the standard session 401 mapping.
struct AdminUser(UserRow);

/// The challenge marker that distinguishes the admin rejection from a session
/// authentication failure inside `reject`.
const ADMIN_REQUIRED: &str = "Wegent-Admin-Required";

impl brz_http_server::Authenticator<AdminUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<AdminUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        let user = get_current_user(&self.state().auth, &self.state().mysql, authorization)
            .await
            .map_err(crate::auth::session_auth_failure)?;
        if user.role != "admin" {
            return Err(brz_http_server::AuthFailure::invalid_credentials(
                ADMIN_REQUIRED,
            ));
        }
        Ok(AdminUser(user))
    }

    fn api_log_id<'a>(&'a self, principal: &'a AdminUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        // `get_admin_user` raises `403 {"detail": "Permission denied. Admin
        // access required."}`; every session-level failure keeps the standard
        // 401 detail.
        if matches!(
            failure,
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: ADMIN_REQUIRED
            }
        ) {
            return FastApiError::forbidden("Permission denied. Admin access required.")
                .into_http_error(arena);
        }
        FastApiError::unauthorized(crate::auth::session_auth_detail(failure)).into_http_error(arena)
    }
}

/// GET /api/admin/service-keys: the admin service-key listing.
#[brz_http_server::get("/api/admin/service-keys")]
async fn list_service_keys(
    #[inject(state)] state: &AppState,
    #[auth] _admin: AdminUser,
) -> Result<ServiceKeyListResponse, FastApiError> {
    service_keys_list(state).await
}

/// Handler body for `GET /api/admin/service-keys`.
async fn service_keys_list(state: &AppState) -> Result<ServiceKeyListResponse, FastApiError> {
    let rows = fetch_service_keys(&state.mysql).await.map_err(|error| {
        tracing::error!(%error, "admin service-keys database dependency failure");
        FastApiError::internal()
    })?;
    let items: Vec<ServiceKeyItem> = rows.iter().map(service_key_item).collect();
    let total = items.len() as i64;
    Ok(ServiceKeyListResponse { items, total })
}

/// `db.query(APIKey, User).outerjoin(User, APIKey.user_id == User.id)
/// .filter(APIKey.key_type == KEY_TYPE_SERVICE)
/// .order_by(APIKey.created_at.desc()).all()`: every mapped column of both
/// entities, aliased `<table>_<column>` like SQLAlchemy's labeled rendering.
/// Only the projected columns are decoded; the remaining selected columns keep
/// the statement identical to the recorded exchange.
const SERVICE_KEYS_QUERY: &str = "SELECT api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at, \
     users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM api_keys LEFT OUTER JOIN users ON api_keys.user_id = users.id \
     WHERE api_keys.key_type = ? ORDER BY api_keys.created_at DESC";

/// One joined `(api_keys, users)` row, projected to the columns the response
/// reads. The `users_*` columns are nullable because the join is a LEFT OUTER
/// JOIN.
#[derive(Debug, FromMysqlRow)]
struct ServiceKeyRow {
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
    #[mysql(rename = "users_user_name")]
    creator_name: Option<String>,
}

/// `ServiceKeyResponse` (`app.schemas.api_key`): field order follows the
/// pydantic model declaration.
#[derive(Debug, Serialize)]
pub struct ServiceKeyItem {
    pub id: i32,
    pub name: String,
    pub key_prefix: String,
    pub description: Option<String>,
    pub expires_at: String,
    pub last_used_at: String,
    pub created_at: String,
    pub is_active: bool,
    pub created_by: Option<String>,
}

/// `ServiceKeyListResponse` (`app.schemas.api_key`): `items` precedes `total`.
#[derive(Debug, Serialize)]
pub struct ServiceKeyListResponse {
    pub items: Vec<ServiceKeyItem>,
    pub total: i64,
}

/// Project one joined row into the response item, mirroring the source loop
/// (`created_by=creator.user_name if creator else None`).
fn service_key_item(row: &ServiceKeyRow) -> ServiceKeyItem {
    ServiceKeyItem {
        id: row.id,
        name: row.name.clone(),
        key_prefix: row.key_prefix.clone(),
        description: row.description.clone(),
        expires_at: pydantic_datetime(row.expires_at),
        last_used_at: pydantic_datetime(row.last_used_at),
        created_at: pydantic_datetime(row.created_at),
        is_active: row.is_active != 0,
        created_by: row.creator_name.clone(),
    }
}

/// Run the service-key listing query.
async fn fetch_service_keys<M>(mysql: &M) -> MysqlResult<Vec<ServiceKeyRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(SERVICE_KEYS_QUERY, (KEY_TYPE_SERVICE,))
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

    fn naive(hour: u32, minute: u32, second: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, 21)
            .unwrap()
            .and_hms_opt(hour, minute, second)
            .unwrap()
    }

    fn row() -> ServiceKeyRow {
        ServiceKeyRow {
            id: 5175,
            name: "audio_biz".to_string(),
            key_prefix: "wg-09zAFAhN...".to_string(),
            description: Some("desc".to_string()),
            expires_at: NaiveDate::from_ymd_opt(9999, 12, 31)
                .unwrap()
                .and_hms_opt(23, 59, 59)
                .unwrap(),
            last_used_at: naive(6, 24, 47),
            created_at: naive(11, 28, 59),
            is_active: 1,
            creator_name: Some("wenbo17".to_string()),
        }
    }

    #[test]
    fn response_shape_matches_pydantic_model() {
        let response = ServiceKeyListResponse {
            items: vec![service_key_item(&row())],
            total: 1,
        };
        let body = serde_json::to_string(&response).unwrap();
        assert_eq!(
            body,
            "{\"items\":[{\"id\":5175,\"name\":\"audio_biz\",\"key_prefix\":\"wg-09zAFAhN...\",\
             \"description\":\"desc\",\"expires_at\":\"9999-12-31T23:59:59\",\
             \"last_used_at\":\"2026-09-21T06:24:47\",\"created_at\":\"2026-09-21T11:28:59\",\
             \"is_active\":true,\"created_by\":\"wenbo17\"}],\"total\":1}"
        );
    }

    #[test]
    fn absent_creator_and_description_serialize_as_null() {
        let mut row = row();
        row.creator_name = None;
        row.description = None;
        row.is_active = 0;
        let item = service_key_item(&row);
        assert_eq!(item.created_by, None);
        assert_eq!(item.description, None);
        assert!(!item.is_active);
        let body = serde_json::to_string(&item).unwrap();
        assert!(body.contains("\"description\":null"));
        assert!(body.contains("\"is_active\":false"));
        assert!(body.contains("\"created_by\":null"));
    }

    #[test]
    fn pydantic_datetime_has_no_fraction_for_second_precision() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 21)
            .unwrap()
            .and_hms_micro_opt(11, 28, 59, 0)
            .unwrap();
        assert_eq!(pydantic_datetime(dt), "2026-09-21T11:28:59");
    }

    #[test]
    fn pydantic_datetime_renders_microseconds_when_present() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 21)
            .unwrap()
            .and_hms_micro_opt(11, 28, 59, 123456)
            .unwrap();
        assert_eq!(pydantic_datetime(dt), "2026-09-21T11:28:59.123456");
    }

    /// A recorded statement with the inline `'service'` literal swapped for a
    /// bound parameter: the target SQL must stay token-identical after
    /// whitespace normalization.
    #[test]
    fn service_keys_query_matches_recorded_statement() {
        let recorded = "SELECT api_keys.id AS api_keys_id, api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, api_keys.updated_at AS api_keys_updated_at, users.id AS users_id, users.user_name AS users_user_name, users.password_hash AS users_password_hash, users.email AS users_email, users.git_info AS users_git_info, users.is_active AS users_is_active, users.`role` AS users_role, users.auth_source AS users_auth_source, users.preferences AS users_preferences, users.created_at AS users_created_at, users.updated_at AS users_updated_at \nFROM api_keys LEFT OUTER JOIN users ON api_keys.user_id = users.id \nWHERE api_keys.key_type = 'service' ORDER BY api_keys.created_at DESC";
        fn tokens(sql: &str) -> Vec<String> {
            sql.split_whitespace()
                .map(|token| match token {
                    "'service'" => "?".to_string(),
                    other => other.to_string(),
                })
                .collect()
        }
        assert_eq!(tokens(SERVICE_KEYS_QUERY), tokens(recorded));
    }

    #[tokio::test]
    async fn empty_result_is_an_empty_page() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let rows = fetch_service_keys(&mysql).await.unwrap();
        assert!(rows.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 1);
        // The key type binds as a string, not an integer.
        assert_eq!(queries[0].first_integer, None);
        assert!(queries[0].sql.contains("WHERE api_keys.key_type = ?"));
        assert!(
            queries[0]
                .sql
                .ends_with("ORDER BY api_keys.created_at DESC"),
            "the recorded ordering is preserved: {}",
            queries[0].sql
        );
    }
}
