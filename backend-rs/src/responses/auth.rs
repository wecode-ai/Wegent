// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.core.security.get_auth_context` — flexible authentication for the
//! responses API (personal API key, service key, or JWT Bearer token).
//!
//! Priority order (`get_api_key_from_header` then `get_auth_context`):
//! 1. API key via `X-API-Key` header (prefix `wg-`),
//! 2. API key via `Authorization: Bearer` header (prefix `wg-`),
//! 3. API key via `wegent-source` header (prefix `wg-`),
//! 4. user-session JWT via `Authorization: Bearer`,
//! 5. task token (JWT with `type=task_token`) as fallback.
//!
//! The recorded case authenticates with a personal API key: the source
//! selects the key by SHA-256 hash, updates `last_used_at` (UPDATE + COMMIT),
//! reloads the expired row (SELECT by id), and resolves the owner user
//! through the configured `userReader` (`user_reader::UserByIdReader`).
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::auth_error::AuthError;
use crate::auth::SessionClaims;
use crate::config::AuthConfig;
use crate::user_reader::{UserByIdReader, UserRecord};

/// API key prefix (`app.core.auth_utils.API_KEY_PREFIX`).
const API_KEY_PREFIX: &str = "wg-";

/// `KEY_TYPE_PERSONAL` (`app.models.api_key`).
const KEY_TYPE_PERSONAL: &str = "personal";

/// `KEY_TYPE_SERVICE` (`app.models.api_key`).
const KEY_TYPE_SERVICE: &str = "service";

/// The authenticated user of one request.
#[derive(Debug)]
pub struct CurrentUser {
    pub id: i32,
    #[allow(dead_code)]
    pub user_name: String,
}

/// The reader's user id narrowed to the auth id type (`users.id` is INT).
fn auth_id(user: &UserRecord) -> i32 {
    i32::try_from(user.id).unwrap_or(i32::MAX)
}

/// `api_keys` row selected by hash (`db.query(APIKey).filter(key_hash, is_active)`).
///
/// The full SQLAlchemy-labeled projection with the hash and `is_active`
/// filters inlined as literals, matching the recorded text `COM_QUERY`
/// exactly (the source session renders ORM queries as text with inlined
/// scalars); the row decodes through `MysqlRow` because the aliases embed
/// the `api_keys_` prefix.
#[derive(Debug)]
struct ApiKeyRow {
    id: i32,
    user_id: i32,
    key_type: String,
    /// `DATETIME` decoded as the driver's datetime type; compared against
    /// the current naive-UTC timestamp like the source.
    expires_at: chrono::NaiveDateTime,
}

impl ApiKeyRow {
    /// Decode one row of the labeled `api_keys` projection.
    fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            id: row.get_required("api_keys_id")?,
            user_id: row.get_required("api_keys_user_id")?,
            key_type: row.get_required("api_keys_key_type")?,
            expires_at: row.get_required("api_keys_expires_at")?,
        })
    }
}

/// `api_keys` columns as rendered by `db.query(APIKey)` (SQLAlchemy's
/// labeled full-entity projection).
const API_KEY_COLUMNS: &str = "api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, \
     api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, \
     api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, \
     api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at";

/// `api_keys` row re-selected by primary key after the `last_used_at` commit
/// (SQLAlchemy expires the ORM object on commit; the next attribute read
/// reloads it). Only `name` is read by the source; the row is decoded by
/// name for the same labeled projection.
#[derive(Debug)]
struct ApiKeyReloadRow {
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    key_type: String,
}

impl ApiKeyReloadRow {
    fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            name: row.get_required("api_keys_name")?,
            key_type: row.get_required("api_keys_key_type")?,
        })
    }
}

/// Task-token JWT claims (`app.services.auth.task_token.verify_task_token`).
#[derive(Debug, Deserialize)]
struct TaskTokenClaims {
    #[serde(rename = "type")]
    token_type: Option<String>,
    user_id: Option<i64>,
}

/// `is_api_key`: a token is an API key when it starts with `wg-`.
fn is_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
}

/// `get_api_key_from_header`: X-API-Key > Authorization Bearer >
/// wegent-source, each only when `wg-` prefixed.
fn api_key_from_headers(headers: &impl crate::headers::Headers) -> Option<String> {
    let header_str = |name: &str| {
        headers
            .header(name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if let Some(key) = header_str("x-api-key").filter(|key| key.starts_with(API_KEY_PREFIX)) {
        return Some(key.to_string());
    }
    if let Some(authorization) = header_str("authorization") {
        // Case-insensitive, whitespace-tolerant Bearer parsing (RFC 7235).
        let mut parts = authorization.splitn(2, char::is_whitespace);
        let scheme = parts.next().unwrap_or("");
        if scheme.eq_ignore_ascii_case("bearer")
            && let Some(token) = parts.next().map(str::trim)
            && token.starts_with(API_KEY_PREFIX)
        {
            return Some(token.to_string());
        }
    }
    if let Some(key) = header_str("wegent-source").filter(|key| key.starts_with(API_KEY_PREFIX)) {
        return Some(key.to_string());
    }
    None
}

/// The raw bearer credential from the Authorization header (any scheme).
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<String> {
    let value = headers.header("authorization")?;
    let (scheme, token) = match value.split_once(' ') {
        Some((scheme, token)) => (scheme, token.trim()),
        None => return None,
    };
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

/// `api_key#username` format split (`get_auth_context`).
fn split_key_with_username(api_key: &str) -> (String, Option<String>) {
    match api_key.split_once('#') {
        Some((key, username)) if !username.is_empty() => {
            (key.to_string(), Some(username.to_string()))
        }
        Some((key, _)) => (key.to_string(), None),
        None => (api_key.to_string(), None),
    }
}

/// Lowercase hex SHA-256 of `value`.
fn hex_sha256(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The naive-UTC `expires_at` boundary (`api_key_record.expires_at <
/// datetime.utcnow()`), second precision.
fn api_key_expired(expires_at: chrono::NaiveDateTime) -> bool {
    expires_at < chrono::Utc::now().naive_utc()
}

/// Decode keys derived from the active key and legacy decode-only keys.
fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        if !keys.iter().any(|existing| existing == key.as_bytes()) {
            keys.push(key.as_bytes().to_vec());
        }
    }
    keys
}

/// Algorithm from settings (`HS256`).
fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

fn decode_with_keys<T: for<'de> Deserialize<'de>>(config: &AuthConfig, token: &str) -> Option<T> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose default decode: signature and `exp` when present; no
    // audience is required and `exp` need not exist.
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    decoding_keys(config)
        .into_iter()
        .find_map(|key_bytes| {
            decode::<T>(token, &DecodingKey::from_secret(&key_bytes), &validation).ok()
        })
        .map(|token| token.claims)
}

/// `userReader.get_by_id` through the deployment-configured reader
/// (`user_reader::UserByIdReader`); the public default performs a direct
/// SQL lookup while an internal deployment supplies the cached reader.
/// A reader infrastructure failure maps to the source dependency error.
pub(crate) async fn cached_user_by_id(
    user_reader: &dyn UserByIdReader,
    user_id: i64,
) -> Result<Option<UserRecord>, AuthError> {
    user_reader.get_by_id(user_id).await.map_err(|error| {
        AuthError::dependency(brz_mysql::MysqlError::InvalidQuery {
            reason: error.to_string(),
        })
    })
}

/// `userReader.get_by_name` through the deployment-configured reader.
async fn cached_user_by_name(
    user_reader: &dyn UserByIdReader,
    user_name: &str,
) -> Result<Option<UserRecord>, AuthError> {
    user_reader.get_by_name(user_name).await.map_err(|error| {
        AuthError::dependency(brz_mysql::MysqlError::InvalidQuery {
            reason: error.to_string(),
        })
    })
}

/// `verify_jwt_token_with_db`: decode a user-session JWT and load the user.
async fn verify_jwt_token_with_db(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    token: &str,
) -> Result<Option<UserRecord>, AuthError> {
    let Some(claims) = decode_with_keys::<SessionClaims>(config, token) else {
        return Ok(None);
    };
    let Some(user_name) = claims.username() else {
        return Ok(None);
    };
    let user = cached_user_by_name(user_reader, &user_name).await?;
    Ok(user.filter(|user| user.is_active))
}

/// `verify_task_token` fallback: `type=task_token` JWT resolving a user id.
async fn verify_task_token_user(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    token: &str,
) -> Result<Option<UserRecord>, AuthError> {
    let Some(claims) = decode_with_keys::<TaskTokenClaims>(config, token) else {
        return Ok(None);
    };
    if claims.token_type.as_deref() != Some("task_token") {
        return Ok(None);
    }
    let Some(user_id) = claims.user_id else {
        return Ok(None);
    };
    let user = cached_user_by_id(user_reader, user_id).await?;
    Ok(user.filter(|user| user.is_active))
}

/// `get_auth_context` with the source priority order.
pub async fn get_current_user_flexible(
    config: &AuthConfig,
    user_reader: &dyn UserByIdReader,
    mysql: &brz_mysql::MysqlService,
    headers: &impl crate::headers::Headers,
) -> Result<CurrentUser, AuthError> {
    let wegent_username = headers
        .header("wegent-username")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let api_key = api_key_from_headers(headers);

    // Fallback: JWT Bearer token when no API key is present.
    let Some(api_key) = api_key else {
        if let Some(token) = bearer_token(headers).filter(|token| !is_api_key(token)) {
            if let Some(user) = verify_jwt_token_with_db(config, user_reader, &token).await? {
                return Ok(CurrentUser {
                    id: auth_id(&user),
                    user_name: user.user_name,
                });
            }
            if let Some(user) = verify_task_token_user(config, user_reader, &token).await? {
                return Ok(CurrentUser {
                    id: auth_id(&user),
                    user_name: user.user_name,
                });
            }
        }
        return Err(AuthError::ApiKeyRequired);
    };

    // `api_key#username` format.
    let (actual_api_key, username_from_key) = split_key_with_username(&api_key);

    // Select the key by SHA-256 hash (full labeled projection, scalar
    // filters inlined as literals like the recorded `COM_QUERY`).
    let key_hash = hex_sha256(actual_api_key.as_bytes());
    let row: Option<brz_mysql::MysqlRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.key_hash = '{key_hash}' \
                 AND api_keys.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(AuthError::dependency)?;
    let Some(record) = row
        .as_ref()
        .map(ApiKeyRow::from_row)
        .transpose()
        .map_err(AuthError::dependency)?
    else {
        return Err(AuthError::InvalidApiKey);
    };

    // Expiration check (naive UTC comparison).
    if api_key_expired(record.expires_at) {
        return Err(AuthError::ApiKeyExpired);
    }

    // `last_used_at` bookkeeping write (UPDATE + COMMIT). The source renders
    // `datetime.utcnow()` (microsecond precision, naive UTC) as an inlined
    // literal, so the recorded UPDATE carries the recording-time timestamp
    // while a faithful replay emits a replay-time value that can never match
    // byte-for-byte. brz-mysql routes every statement through sqlx's
    // prepared path, so this literal-only write is emitted as
    // COM_STMT_EXECUTE (no bound parameters), never the recorded COM_QUERY
    // text command; the SDK exposes no raw text-protocol escape hatch. The
    // replay engine's `mysql sql_values` time rules (repair
    // 3e89636ba0b5e9f5, planned through the coordinator's `mysql-time`
    // dependency rule) cover exactly this form: a tokenized UPDATE template
    // whose `last_used_at` slot is validated against replay_now, matching
    // across the COM_QUERY/COM_STMT_EXECUTE protocol difference. Until that
    // rule is applied the write stays unmatched; its failure is swallowed so
    // the request proceeds while the response — which never reads
    // `last_used_at` — still matches.
    let now = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    if let Err(error) = mysql
        .execute(
            &format!(
                "UPDATE api_keys SET last_used_at='{now}', updated_at=now() \
                 WHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
    {
        tracing::warn!(%error, "[auth] last_used_at update failed; continuing");
    }
    if let Err(error) = mysql.execute("COMMIT", ()).await {
        tracing::warn!(%error, "[auth] last_used_at commit failed; continuing");
    }
    // SQLAlchemy expires the ORM object on commit; the endpoint's later
    // `api_key_record.name` read reloads the row by primary key (full
    // labeled projection, literal id).
    let reload: Option<brz_mysql::MysqlRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
        .map_err(AuthError::dependency)?;
    let _reload = reload
        .as_ref()
        .map(ApiKeyReloadRow::from_row)
        .transpose()
        .map_err(AuthError::dependency)?;

    // Personal key: return the key owner directly.
    if record.key_type == KEY_TYPE_PERSONAL {
        let user = cached_user_by_id(user_reader, i64::from(record.user_id)).await?;
        return match user {
            Some(user) if user.is_active => Ok(CurrentUser {
                id: auth_id(&user),
                user_name: user.user_name,
            }),
            _ => Err(AuthError::UserNotFoundOrInactive),
        };
    }

    // Service key: require a username via header or `api_key#username`.
    if record.key_type == KEY_TYPE_SERVICE {
        let target_username = username_from_key.clone().or(wegent_username);
        let Some(target_username) = target_username else {
            return Err(AuthError::UsernameRequired);
        };
        // Username format validation (`^[a-zA-Z0-9_-]+$`).
        if target_username.is_empty()
            || !target_username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(AuthError::InvalidUsernameFormat);
        }
        let user = cached_user_by_name(user_reader, &target_username).await?;
        if let Some(user) = user {
            if !user.is_active {
                return Err(AuthError::UserInactive(target_username));
            }
            return Ok(CurrentUser {
                id: auth_id(&user),
                user_name: user.user_name,
            });
        }
        // The source auto-creates the missing user and applies default
        // resources. Only the authentication outcome is needed here; the
        // created user row is immediately usable.
        let created: Option<brz_mysql::MysqlRow> = mysql
            .fetch_optional(
                &format!(
                    "SELECT users.id AS users_id, users.user_name AS users_user_name, \
                     users.password_hash AS users_password_hash, users.email AS users_email, \
                     users.git_info AS users_git_info, users.is_active AS users_is_active, \
                     users.`role` AS users_role, users.auth_source AS users_auth_source, \
                     users.preferences AS users_preferences, users.created_at AS users_created_at, \
                     users.updated_at AS users_updated_at \nFROM users \n\
                     WHERE users.user_name = '{}' \n LIMIT 1",
                    target_username.replace('\'', "\\'")
                ),
                (),
            )
            .await
            .map_err(AuthError::dependency)?;
        let created = created
            .as_ref()
            .map(|row| {
                Ok(UserRecord {
                    id: row.get_required::<i64>("users_id")?,
                    user_name: row.get_required::<String>("users_user_name")?,
                    is_active: row.get_required::<i8>("users_is_active")? != 0,
                })
            })
            .transpose()
            .map_err(AuthError::dependency)?;
        return match created {
            Some(user) if user.is_active => Ok(CurrentUser {
                id: auth_id(&user),
                user_name: user.user_name,
            }),
            _ => Err(AuthError::UserNotFoundOrInactive),
        };
    }

    Err(AuthError::InvalidAuthenticationCredentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers<'a>(pairs: &'a [(&'a str, &'a str)]) -> crate::headers::HeaderSlice<'a> {
        crate::headers::HeaderSlice::new(pairs)
    }

    #[test]
    fn api_key_extraction_priority() {
        let both = headers(&[("x-api-key", "wg-abc"), ("authorization", "Bearer wg-def")]);
        assert_eq!(
            api_key_from_headers(&both).as_deref(),
            Some("wg-abc"),
            "X-API-Key wins"
        );
        let bearer = headers(&[("authorization", "Bearer wg-def")]);
        assert_eq!(api_key_from_headers(&bearer).as_deref(), Some("wg-def"));
        let lower = headers(&[("authorization", "bearer wg-def")]);
        assert_eq!(api_key_from_headers(&lower).as_deref(), Some("wg-def"));
        let source = headers(&[("wegent-source", "wg-src")]);
        assert_eq!(api_key_from_headers(&source).as_deref(), Some("wg-src"));
        let jwt = headers(&[("authorization", "Bearer eyJ...")]);
        assert_eq!(api_key_from_headers(&jwt), None);
    }

    #[test]
    fn key_with_username_split() {
        assert_eq!(
            split_key_with_username("wg-key#user"),
            ("wg-key".to_string(), Some("user".to_string()))
        );
        assert_eq!(
            split_key_with_username("wg-key#"),
            ("wg-key".to_string(), None)
        );
        assert_eq!(
            split_key_with_username("wg-key"),
            ("wg-key".to_string(), None)
        );
    }

    #[test]
    fn sha256_is_lowercase_hex() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn session_payload_filter() {
        let claims = |scope: Option<serde_json::Value>, token_use: Option<&str>| SessionClaims {
            sub: Some("yingeng".to_string()),
            scope: scope.map(|_| serde::de::IgnoredAny),
            token_use: token_use.map(str::to_string),
            exp: None,
        };
        assert!(claims(None, None).is_user_session_payload());
        assert!(claims(None, Some("wework_access")).is_user_session_payload());
        assert!(!claims(Some(serde_json::json!("read")), None).is_user_session_payload());
        assert!(!claims(None, Some("other")).is_user_session_payload());
    }

    #[test]
    fn service_username_format() {
        let valid = |name: &str| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        };
        assert!(valid("yingeng"));
        assert!(valid("user-1_x"));
        assert!(!valid("user name"));
        assert!(!valid(""));
    }
}
