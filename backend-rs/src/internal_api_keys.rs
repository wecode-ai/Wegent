// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/api-keys/lookup` — resolve the identity of a raw API
//! key for other trusted internal services
//! (`app.api.endpoints.internal.api_keys.lookup_api_key`).
//!
//! Pipeline:
//! 1. the router-level `Depends(verify_internal_service_token)` bearer check
//!    (`crate::internal_auth::InternalService`, no database access);
//! 2. `APIKeyLookupRequest` body validation: `api_key` is a required
//!    `min_length=1` string (`app.schemas.api_key`);
//! 3. `find_valid_api_key(db, api_key, key_type="service")`: a valid service
//!    key answers with its own `name` and `key_type="service"` — service key
//!    identities do not depend on their creator, so no owner is read;
//! 4. otherwise `verify_api_key(db, api_key, update_last_used_at=False)`: the
//!    personal-key lookup, the owner `users` read, and the active-owner check
//!    answer `key_type="personal"` or `exists=false`;
//! 5. `APIKeyLookupResponse(exists, user_name, key_type)`.
//!
//! Both key lookups share `find_valid_api_key` (`app.core.auth_utils`): the
//! raw value must start with `wg-`, the sha256 hash must match an active row
//! of the requested type, and the row must not be expired
//! (`expires_at < datetime.utcnow()` drops it). Neither lookup writes:
//! `last_used_at` is intentionally not bumped. The source driver renders the
//! filter values as inline literals inside `COM_QUERY`, so the statements are
//! built the same way instead of prepared-statement parameters. The recorded
//! session's trailing `ROLLBACK`s are driver session cleanup that Replay
//! classifies as optional, so no rollback statements are issued here.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::{NaiveDateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::attachments::s3_signing::hex_sha256;
use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::sql_support::quote_sql_literal;
use crate::state::AppState;

/// `app.models.api_key.KEY_TYPE_SERVICE`: resolved first; the response reports
/// the key's own name.
const KEY_TYPE_SERVICE: &str = "service";

/// `app.models.api_key.KEY_TYPE_PERSONAL`: the personal fallback whose owner
/// must exist and be active.
const KEY_TYPE_PERSONAL: &str = "personal";

/// `app.core.auth_utils.API_KEY_PREFIX`: raw keys carry this prefix.
const API_KEY_PREFIX: &str = "wg-";

/// `APIKeyLookupResponse` (`app.schemas.api_key`): `exists` precedes the
/// optional `user_name` and `key_type`.
#[derive(Debug, Serialize)]
pub struct APIKeyLookupResponse {
    pub exists: bool,
    pub user_name: Option<String>,
    pub key_type: Option<&'static str>,
}

/// POST /api/internal/api-keys/lookup: the internal lookup free function,
/// injecting the process-lifetime application state and the internal-service
/// bearer check.
#[brz_http_server::post("/api/internal/api-keys/lookup")]
async fn lookup_api_key(
    #[inject(state)] state: &AppState,
    #[auth] _service: crate::internal_auth::InternalService,
    body: Value,
) -> Result<APIKeyLookupResponse, FastApiError> {
    let api_key = parse_request(&body)?;
    lookup_api_key_value(&state.mysql, api_key).await
}

/// `APIKeyLookupRequest` body validation (`app.schemas.api_key`): a required
/// `min_length=1` string. FastAPI validates the body before the endpoint runs,
/// so a failure renders a 422 without dependency traffic.
fn parse_request(body: &Value) -> Result<&str, FastApiError> {
    let Value::Object(object) = body else {
        return Err(body_error(
            "model_attributes_type",
            "Input should be a valid dictionary or object to extract fields from",
            None,
            body,
            None,
        ));
    };
    let Some(value) = object.get("api_key") else {
        return Err(body_error(
            "missing",
            "Field required",
            Some("api_key"),
            body,
            None,
        ));
    };
    let Value::String(api_key) = value else {
        return Err(body_error(
            "string_type",
            "Input should be a valid string",
            Some("api_key"),
            value,
            None,
        ));
    };
    if api_key.is_empty() {
        return Err(body_error(
            "string_too_short",
            "String should have at least 1 character",
            Some("api_key"),
            value,
            Some(serde_json::json!({"min_length": 1})),
        ));
    }
    Ok(api_key)
}

/// One FastAPI body-validation error entry; `field` selects between a whole
/// body `loc` (non-object input) and a named field `loc`.
fn body_error(
    kind: &str,
    message: &str,
    field: Option<&str>,
    input: &Value,
    ctx: Option<Value>,
) -> FastApiError {
    let mut entry = serde_json::json!({
        "type": kind,
        "loc": match field {
            Some(field) => serde_json::json!(["body", field]),
            None => serde_json::json!(["body"]),
        },
        "msg": message,
        "input": input,
    });
    if let Some(ctx) = ctx {
        entry["ctx"] = ctx;
    }
    FastApiError::validation(serde_json::Value::Array(vec![entry]))
}

/// Handler body for `POST /api/internal/api-keys/lookup`. `api_key` is the
/// raw request value.
async fn lookup_api_key_value<M>(
    mysql: &M,
    api_key: &str,
) -> Result<APIKeyLookupResponse, FastApiError>
where
    M: Mysql,
{
    // `if not is_api_key(api_key)`: a non-`wg-` value is never hashed or
    // looked up, in either the service or the personal pass.
    if !is_api_key(api_key) {
        return Ok(not_exists());
    }

    let key_hash = hex_sha256(api_key.as_bytes());
    let now = Utc::now().naive_utc();

    // Service keys resolve first: the identity is the key's own name and no
    // owner is read (`find_valid_api_key(..., key_type=KEY_TYPE_SERVICE)`).
    let service = fetch_api_key(mysql, &key_hash, KEY_TYPE_SERVICE)
        .await
        .map_err(internal)?;
    if let Some(record) = valid_key(service.as_ref(), now) {
        return Ok(APIKeyLookupResponse {
            exists: true,
            user_name: Some(record.name.clone()),
            key_type: Some(KEY_TYPE_SERVICE),
        });
    }

    // `verify_api_key(..., update_last_used_at=False)`: the personal-key
    // lookup, then the owner read.
    let personal = fetch_api_key(mysql, &key_hash, KEY_TYPE_PERSONAL)
        .await
        .map_err(internal)?;
    let Some(record) = valid_key(personal.as_ref(), now) else {
        return Ok(not_exists());
    };

    let user = fetch_user_by_id(mysql, record.user_id)
        .await
        .map_err(internal)?;
    // `user is None` and `not user.is_active` both answer `exists=false`.
    let Some(user) = user.filter(|user| user.is_active != 0) else {
        return Ok(not_exists());
    };

    Ok(APIKeyLookupResponse {
        exists: true,
        user_name: Some(user.user_name),
        key_type: Some(KEY_TYPE_PERSONAL),
    })
}

/// The `exists=false` response (`APIKeyLookupResponse(exists=False)`): both
/// optional fields render as JSON `null`.
fn not_exists() -> APIKeyLookupResponse {
    APIKeyLookupResponse {
        exists: false,
        user_name: None,
        key_type: None,
    }
}

/// `api_key.startswith("wg-") if api_key else False`.
fn is_api_key(api_key: &str) -> bool {
    api_key.starts_with(API_KEY_PREFIX)
}

/// `find_valid_api_key`'s post-query decision: the record when present and
/// unexpired (`expires_at < datetime.utcnow()` drops it).
fn valid_key(record: Option<&ApiKeyLookupRow>, now: NaiveDateTime) -> Option<&ApiKeyLookupRow> {
    record.filter(|record| record.expires_at >= now)
}

/// The source `db.query(APIKey).filter(APIKey.key_hash == key_hash,
/// APIKey.key_type == key_type, APIKey.is_active == True).first()` rendering:
/// every mapped column, aliased `api_keys_<column>` like SQLAlchemy's labeled
/// rendering, with the driver's inline literals. Only `name`, `user_id`, and
/// `expires_at` are decoded; the other columns are selected to keep the
/// statement identical to the recorded exchange.
const API_KEY_COLUMNS: &str = "SELECT api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at";

/// The source `db.query(User).filter(User.id == api_key_record.user_id)
/// .first()` rendering: every mapped column, aliased `users_<column>` like
/// SQLAlchemy's labeled rendering.
const USER_COLUMNS: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// Render the key-hash lookup for one key type with the driver's inline
/// literals (the source sends `COM_QUERY`, not a prepared statement).
fn api_key_by_hash_sql(key_hash: &str, key_type: &str) -> String {
    format!(
        "{API_KEY_COLUMNS} \nFROM api_keys \nWHERE api_keys.key_hash = {} \
         AND api_keys.key_type = {} AND api_keys.is_active = true \n LIMIT 1",
        quote_sql_literal(key_hash),
        quote_sql_literal(key_type),
    )
}

/// Render the owner lookup with the driver's inline integer literal.
fn user_by_id_sql(user_id: i32) -> String {
    format!("{USER_COLUMNS} \nFROM users \nWHERE users.id = {user_id} \n LIMIT 1")
}

/// One `api_keys` row, projected to the columns the lookup reads.
#[derive(Debug, FromMysqlRow)]
#[cfg_attr(test, derive(PartialEq))]
struct ApiKeyLookupRow {
    #[mysql(rename = "api_keys_user_id")]
    user_id: i32,
    #[mysql(rename = "api_keys_name")]
    name: String,
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: chrono::NaiveDateTime,
}

/// Run the key-hash lookup for one key type.
async fn fetch_api_key<M>(
    mysql: &M,
    key_hash: &str,
    key_type: &str,
) -> MysqlResult<Option<ApiKeyLookupRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(api_key_by_hash_sql(key_hash, key_type).as_str(), ())
        .await
}

/// Run the owner lookup.
async fn fetch_user_by_id<M>(mysql: &M, user_id: i32) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(user_by_id_sql(user_id).as_str(), ())
        .await
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
    use serde_json::json;

    fn naive(month: u32, day: u32, hour: u32, minute: u32, second: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, second)
            .unwrap()
    }

    fn row(name: &str, expires_at: chrono::NaiveDateTime) -> ApiKeyLookupRow {
        ApiKeyLookupRow {
            user_id: 2,
            name: name.to_string(),
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
    fn service_query_renders_the_recorded_statement() {
        let recorded = "SELECT api_keys.id AS api_keys_id, api_keys.user_id AS api_keys_user_id, \
             api_keys.key_hash AS api_keys_key_hash, api_keys.key_prefix AS api_keys_key_prefix, \
             api_keys.name AS api_keys_name, api_keys.key_type AS api_keys_key_type, \
             api_keys.description AS api_keys_description, \
             api_keys.expires_at AS api_keys_expires_at, \
             api_keys.last_used_at AS api_keys_last_used_at, \
             api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
             api_keys.updated_at AS api_keys_updated_at \n\
             FROM api_keys \n\
             WHERE api_keys.key_hash = \
             'dbe3206526dc7a1fa6ce46a95129f1e336822ddf95bb33a575bb3fa7607fd33c' \
             AND api_keys.key_type = 'service' AND api_keys.is_active = true \n LIMIT 1";
        assert_eq!(
            api_key_by_hash_sql(
                "dbe3206526dc7a1fa6ce46a95129f1e336822ddf95bb33a575bb3fa7607fd33c",
                KEY_TYPE_SERVICE
            ),
            recorded
        );
    }

    #[test]
    fn personal_query_renders_the_recorded_statement() {
        let recorded = "SELECT api_keys.id AS api_keys_id, api_keys.user_id AS api_keys_user_id, \
             api_keys.key_hash AS api_keys_key_hash, api_keys.key_prefix AS api_keys_key_prefix, \
             api_keys.name AS api_keys_name, api_keys.key_type AS api_keys_key_type, \
             api_keys.description AS api_keys_description, \
             api_keys.expires_at AS api_keys_expires_at, \
             api_keys.last_used_at AS api_keys_last_used_at, \
             api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
             api_keys.updated_at AS api_keys_updated_at \n\
             FROM api_keys \n\
             WHERE api_keys.key_hash = \
             'dbe3206526dc7a1fa6ce46a95129f1e336822ddf95bb33a575bb3fa7607fd33c' \
             AND api_keys.key_type = 'personal' AND api_keys.is_active = true \n LIMIT 1";
        assert_eq!(
            api_key_by_hash_sql(
                "dbe3206526dc7a1fa6ce46a95129f1e336822ddf95bb33a575bb3fa7607fd33c",
                KEY_TYPE_PERSONAL
            ),
            recorded
        );
    }

    #[test]
    fn user_query_renders_the_recorded_statement() {
        let recorded = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \n\
             FROM users \n\
             WHERE users.id = 2 \n LIMIT 1";
        assert_eq!(user_by_id_sql(2), recorded);
    }

    #[test]
    fn missing_record_reports_not_exists() {
        assert_eq!(valid_key(None, naive(10, 10, 6, 10, 43)), None);
    }

    #[test]
    fn expired_record_reports_not_exists() {
        let expired = row("example-user", naive(10, 9, 6, 10, 43));
        assert_eq!(valid_key(Some(&expired), naive(10, 10, 6, 10, 43)), None);
        // Exactly-now expiry is not `< now`, so the row survives.
        let boundary = row("example-user", naive(10, 10, 6, 10, 43));
        assert_eq!(
            valid_key(Some(&boundary), naive(10, 10, 6, 10, 43)),
            Some(&boundary)
        );
    }

    #[test]
    fn response_bodies_match_the_pydantic_model() {
        // The recorded success body renders every model field in order.
        let personal = APIKeyLookupResponse {
            exists: true,
            user_name: Some("example-user".to_string()),
            key_type: Some(KEY_TYPE_PERSONAL),
        };
        assert_eq!(
            serde_json::to_string(&personal).unwrap(),
            r#"{"exists":true,"user_name":"example-user","key_type":"personal"}"#
        );
        // A service key answers with the key's own name.
        let service = APIKeyLookupResponse {
            exists: true,
            user_name: Some("example-service".to_string()),
            key_type: Some(KEY_TYPE_SERVICE),
        };
        assert_eq!(
            serde_json::to_string(&service).unwrap(),
            r#"{"exists":true,"user_name":"example-service","key_type":"service"}"#
        );
        // The unknown/invalid key renders the optional fields as JSON null.
        assert_eq!(
            serde_json::to_string(&not_exists()).unwrap(),
            r#"{"exists":false,"user_name":null,"key_type":null}"#
        );
    }

    #[test]
    fn body_validation_matches_fastapi() {
        // A non-object body fails before any field is read.
        let error = parse_request(&json!([1, 2])).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            error.validation_detail(),
            r#"[{"type":"model_attributes_type","loc":["body"],"msg":"Input should be a valid dictionary or object to extract fields from","input":[1,2]}]"#
        );

        let missing = parse_request(&json!({})).unwrap_err().validation_detail();
        assert!(missing.contains(r#""type":"missing""#));
        assert!(missing.contains(r#""loc":["body","api_key"]"#));
        assert!(missing.contains(r#""msg":"Field required""#));

        let null = parse_request(&json!({"api_key": null}))
            .unwrap_err()
            .validation_detail();
        assert!(null.contains(r#""type":"string_type""#));

        let empty = parse_request(&json!({"api_key": ""}))
            .unwrap_err()
            .validation_detail();
        assert!(empty.contains(r#""type":"string_too_short""#));
        assert!(empty.contains(r#""ctx":{"min_length":1}"#));

        assert_eq!(
            parse_request(&json!({"api_key": "wg-abc"})).unwrap(),
            "wg-abc"
        );
    }

    #[tokio::test]
    async fn non_wg_key_skips_the_database() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let response = lookup_api_key_value(&mysql, "not-an-api-key")
            .await
            .unwrap();
        assert!(!response.exists);
        assert!(response.user_name.is_none());
        assert!(response.key_type.is_none());
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn valid_format_key_queries_service_before_personal() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let response =
            lookup_api_key_value(&mysql, "wg-yMbd40_N7GJnRpF4Uhw_RaJPLbUIfRwpEjgVV1FFCBA")
                .await
                .unwrap();
        // The capture returns no rows, so the lookup answers not-exists after
        // both passes.
        assert!(!response.exists);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert_eq!(queries[0].args, 0);
        assert!(queries[0].sql.contains("key_type = 'service'"));
        assert!(queries[1].sql.contains("key_type = 'personal'"));
        for query in &queries {
            assert!(
                query.sql.contains(
                    quote_sql_literal(&hex_sha256(
                        b"wg-yMbd40_N7GJnRpF4Uhw_RaJPLbUIfRwpEjgVV1FFCBA"
                    ))
                    .as_str()
                )
            );
        }
    }
}
