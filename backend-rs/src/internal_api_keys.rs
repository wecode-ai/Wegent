// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/api-keys/lookup` — resolve the owner of a raw personal
//! API key for other trusted internal services
//! (`app.api.endpoints.internal.api_keys.lookup_api_key`).
//!
//! Pipeline (mirrors `app.core.auth_utils.verify_api_key` with
//! `update_last_used_at=False`):
//! 1. the router-level `Depends(verify_internal_service_token)` bearer check
//!    (`crate::internal_auth::InternalService`, no database access);
//! 2. `is_api_key(api_key)` — the raw value must start with `wg-`, otherwise
//!    the lookup answers `exists=false` without any statement;
//! 3. `db.query(APIKey).filter(key_hash == sha256(api_key), is_active == True)
//!    .first()` — the sha256 hex digest of the raw key;
//! 4. the expiry (`expires_at < datetime.utcnow()`) and `key_type ==
//!    'personal'` checks;
//! 5. `db.query(User).filter(User.id == record.user_id).first()` and the
//!    active-user check (`user.is_active`);
//! 6. `APIKeyLookupResponse(exists, user_name)` — `user_name` is `null` when
//!    the key is unknown, expired, non-personal, or its owner is inactive.
//!
//! The lookup never writes: `last_used_at` is intentionally not bumped.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::attachments::s3_signing::hex_sha256;
use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `app.models.api_key.KEY_TYPE_PERSONAL`: the only `key_type` accepted, the
/// same rule executor authentication applies.
const KEY_TYPE_PERSONAL: &str = "personal";

/// `app.core.auth_utils.API_KEY_PREFIX`: raw keys carry this prefix.
const API_KEY_PREFIX: &str = "wg-";

/// `APIKeyLookupRequest` (`app.schemas.api_key`): a required raw key.
#[derive(Debug, Deserialize)]
pub struct APIKeyLookupRequest {
    pub api_key: String,
}

/// `APIKeyLookupResponse` (`app.schemas.api_key`): `exists` precedes the
/// optional `user_name`.
#[derive(Debug, Serialize)]
pub struct APIKeyLookupResponse {
    pub exists: bool,
    pub user_name: Option<String>,
}

/// POST /api/internal/api-keys/lookup: the internal lookup free function,
/// injecting the process-lifetime application state and the internal-service
/// bearer check.
#[brz_http_server::post("/api/internal/api-keys/lookup")]
async fn lookup_api_key(
    #[inject(state)] state: &AppState,
    #[auth] _service: crate::internal_auth::InternalService,
    request: APIKeyLookupRequest,
) -> Result<APIKeyLookupResponse, FastApiError> {
    lookup_api_key_value(&state.mysql, &request.api_key).await
}

/// Handler body for `POST /api/internal/api-keys/lookup`. `api_key` is the raw
/// request value.
async fn lookup_api_key_value<M>(
    mysql: &M,
    api_key: &str,
) -> Result<APIKeyLookupResponse, FastApiError>
where
    M: Mysql,
{
    // `if not api_key or not is_api_key(api_key)`: a non-`wg-` value is never
    // hashed or looked up.
    if !is_api_key(api_key) {
        tracing::warn!("[auth_utils] Invalid API key format");
        return Ok(not_exists());
    }

    let key_hash = hex_sha256(api_key.as_bytes());
    let record = fetch_api_key(mysql, &key_hash).await.map_err(internal)?;
    let user_id = match key_check(record.as_ref(), Utc::now().naive_utc()) {
        Some(user_id) => user_id,
        None => return Ok(not_exists()),
    };

    let user = fetch_user_by_id(mysql, user_id).await.map_err(internal)?;
    // `user is None` and `not user.is_active` both answer `exists=false`.
    let Some(user) = user.filter(|user| user.is_active != 0) else {
        return Ok(not_exists());
    };

    Ok(APIKeyLookupResponse {
        exists: true,
        user_name: Some(user.user_name),
    })
}

/// The `exists=false` response (`APIKeyLookupResponse(exists=False)`): the
/// optional field renders as JSON `null`.
fn not_exists() -> APIKeyLookupResponse {
    APIKeyLookupResponse {
        exists: false,
        user_name: None,
    }
}

/// `api_key.startswith("wg-") if api_key else False`.
fn is_api_key(api_key: &str) -> bool {
    api_key.starts_with(API_KEY_PREFIX)
}

/// The `verify_api_key` record decision after the key hash lookup: the owner
/// `user_id` when the row is present, unexpired, and a personal key, else
/// `None`.
fn key_check(record: Option<&ApiKeyLookupRow>, now: chrono::NaiveDateTime) -> Option<i32> {
    let record = record?;
    if record.expires_at < now {
        return None;
    }
    if record.key_type != KEY_TYPE_PERSONAL {
        return None;
    }
    Some(record.user_id)
}

/// `db.query(APIKey).filter(APIKey.key_hash == key_hash, APIKey.is_active ==
/// True).first()`: every mapped column, aliased `api_keys_<column>` like
/// SQLAlchemy's labeled rendering. Only `user_id`, `key_type`, and `expires_at`
/// are decoded; the other columns are selected to keep the statement identical
/// to the recorded exchange.
const API_KEY_BY_HASH_QUERY: &str = "SELECT api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at \
     FROM api_keys \
     WHERE api_keys.key_hash = ? AND api_keys.is_active = true \
     LIMIT 1";

/// The source `db.query(User).filter(User.id == api_key_record.user_id)
/// .first()` statement: every mapped column, aliased `users_<column>` like
/// SQLAlchemy's labeled rendering.
const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? \
     LIMIT 1";

/// One `api_keys` row, projected to the columns the lookup reads.
#[derive(Debug, FromMysqlRow)]
struct ApiKeyLookupRow {
    #[mysql(rename = "api_keys_user_id")]
    user_id: i32,
    #[mysql(rename = "api_keys_key_type")]
    key_type: String,
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: chrono::NaiveDateTime,
}

/// Run the key-hash lookup.
async fn fetch_api_key<M>(mysql: &M, key_hash: &str) -> MysqlResult<Option<ApiKeyLookupRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(API_KEY_BY_HASH_QUERY, (key_hash,))
        .await
}

/// Run the owner lookup.
async fn fetch_user_by_id<M>(mysql: &M, user_id: i32) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql.fetch_optional(USER_BY_ID_QUERY, (user_id,)).await
}

/// A dependency failure renders the framework's 500 handler body, matching the
/// source's unhandled exception path.
fn internal(error: impl std::fmt::Debug) -> FastApiError {
    tracing::error!(
        ?error,
        "internal api-keys lookup database dependency failure"
    );
    FastApiError::unhandled()
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

    fn row(key_type: &str, expires_at: chrono::NaiveDateTime) -> ApiKeyLookupRow {
        ApiKeyLookupRow {
            user_id: 3145,
            key_type: key_type.to_string(),
            expires_at,
        }
    }

    #[test]
    fn non_wg_key_matches_the_source_prefix_rule() {
        assert!(is_api_key("wg-abc"));
        assert!(!is_api_key("not-an-api-key"));
        assert!(!is_api_key(""));
        // The source compares `startswith("wg-")`, so a bare prefix passes the
        // format check and continues to the hash lookup.
        assert!(is_api_key("wg-"));
    }

    #[test]
    fn missing_record_reports_not_exists() {
        assert_eq!(key_check(None, naive(10, 10, 6, 10, 43)), None);
    }

    #[test]
    fn expired_key_reports_not_exists() {
        let expired = row(KEY_TYPE_PERSONAL, naive(10, 9, 6, 10, 43));
        assert_eq!(key_check(Some(&expired), naive(10, 10, 6, 10, 43)), None);
        // Exactly-now expiry is not `< now`, so the row survives.
        let boundary = row(KEY_TYPE_PERSONAL, naive(10, 10, 6, 10, 43));
        assert_eq!(
            key_check(Some(&boundary), naive(10, 10, 6, 10, 43)),
            Some(3145)
        );
    }

    #[test]
    fn service_key_reports_not_exists() {
        let service = row("service", naive(11, 1, 0, 0, 0));
        assert_eq!(key_check(Some(&service), naive(10, 10, 6, 10, 43)), None);
    }

    #[test]
    fn valid_personal_key_returns_owner_id() {
        let valid = row(KEY_TYPE_PERSONAL, naive(11, 1, 0, 0, 0));
        assert_eq!(
            key_check(Some(&valid), naive(10, 10, 6, 10, 43)),
            Some(3145)
        );
    }

    #[test]
    fn response_body_matches_the_pydantic_model() {
        // The recorded success body is `{"exists":true,"user_name":"qixiang"}`.
        let found = APIKeyLookupResponse {
            exists: true,
            user_name: Some("qixiang".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&found).unwrap(),
            r#"{"exists":true,"user_name":"qixiang"}"#
        );
        // The unknown/invalid key renders the optional field as JSON null.
        assert_eq!(
            serde_json::to_string(&not_exists()).unwrap(),
            r#"{"exists":false,"user_name":null}"#
        );
    }

    #[test]
    fn api_key_query_matches_recorded_statement() {
        let recorded = "SELECT api_keys.id AS api_keys_id, api_keys.user_id AS api_keys_user_id, \
             api_keys.key_hash AS api_keys_key_hash, api_keys.key_prefix AS api_keys_key_prefix, \
             api_keys.name AS api_keys_name, api_keys.key_type AS api_keys_key_type, \
             api_keys.description AS api_keys_description, \
             api_keys.expires_at AS api_keys_expires_at, \
             api_keys.last_used_at AS api_keys_last_used_at, \
             api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
             api_keys.updated_at AS api_keys_updated_at \nFROM api_keys \nWHERE \
             api_keys.key_hash = '080a12a1c95a4d091dd8eb8f79e1e82db09615967770c863364032396ac1c65f' \
             AND api_keys.is_active = true \n LIMIT 1";
        fn tokens(sql: &str) -> Vec<String> {
            sql.split_whitespace()
                .map(|token| match token {
                    "'080a12a1c95a4d091dd8eb8f79e1e82db09615967770c863364032396ac1c65f'" => {
                        "?".to_string()
                    }
                    other => other.to_string(),
                })
                .collect()
        }
        assert_eq!(tokens(API_KEY_BY_HASH_QUERY), tokens(recorded));
    }

    #[test]
    fn user_query_matches_recorded_statement() {
        let recorded = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \nFROM users \nWHERE users.id = 3145 \n LIMIT 1";
        fn tokens(sql: &str) -> Vec<String> {
            sql.split_whitespace()
                .map(|token| match token {
                    "3145" => "?".to_string(),
                    other => other.to_string(),
                })
                .collect()
        }
        assert_eq!(tokens(USER_BY_ID_QUERY), tokens(recorded));
    }

    #[tokio::test]
    async fn non_wg_key_skips_the_database() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let response = lookup_api_key_value(&mysql, "not-an-api-key")
            .await
            .unwrap();
        assert!(!response.exists);
        assert!(response.user_name.is_none());
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn valid_format_key_binds_the_sha256_hash() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let response =
            lookup_api_key_value(&mysql, "wg-yMbd40_N7GJnRpF4Uhw_RaJPLbUIfRwpEjgVV1FFCBA")
                .await
                .unwrap();
        // The capture returns no rows, so the lookup answers not-exists.
        assert!(!response.exists);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 1);
        fn tokens(sql: &str) -> String {
            sql.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        assert_eq!(tokens(&queries[0].sql), tokens(API_KEY_BY_HASH_QUERY));
    }
}
