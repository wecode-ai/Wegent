// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Flexible authentication for the knowledge-open endpoints
//! (`app.core.security.get_auth_context`).
//!
//! The full source flow for the recorded cases (service API key with
//! `wegent-username`):
//!
//! 1. API key extraction (X-API-Key > Authorization Bearer >
//!    wegent-source, `wg-` prefixed only; `api_key#username` split);
//! 2. `api_keys` lookup by SHA-256 hash — the full SQLAlchemy-labeled
//!    projection with the hash and `is_active` filters inlined as literals,
//!    matching the recorded COM_QUERY text exactly;
//! 3. `last_used_at` UPDATE (literal timestamp) + COMMIT, then the ORM
//!    reload by primary key (full labeled projection, literal id) that
//!    SQLAlchemy's post-commit attribute access performs;
//! 4. personal key: `userReader.get_by_id`;
//!    service key: `wegent-username` (or key-suffix) `userReader.get_by_name`;
//! 5. JWT Bearer fallback for non-`wg-` tokens.
//!
//! The `userReader` lookups go through `AppState::user_reader`
//! (`crate::user_reader::UserByIdReader`): the public default is the direct
//! SQL reader, and a deployment that replaces `userReader` installs its own
//! reader before route construction, so the knowledge endpoints read the
//! same deployment-specific path (including any `user:v2:data` cache) the
//! source's module-level `userReader` does. The JWT and task-token fallbacks
//! query `users` directly in the source (`db.query(User)`), so they keep the
//! direct SQL reader.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::ApiFailure;
use crate::auth::{SessionClaims, UserRow};
use crate::config::AuthConfig;
use crate::headers::Headers as _;
use crate::state::AppState;
use crate::user_reader::{USER_BY_ID_QUERY, USER_BY_NAME_QUERY, UserRecord};

/// API key prefix (`app.core.auth_utils.API_KEY_PREFIX`).
const API_KEY_PREFIX: &str = "wg-";

/// `KEY_TYPE_PERSONAL` (`app.models.api_key`).
const KEY_TYPE_PERSONAL: &str = "personal";

/// `KEY_TYPE_SERVICE` (`app.models.api_key`).
const KEY_TYPE_SERVICE: &str = "service";

/// The authenticated user of one request.
pub struct CurrentUser {
    pub id: i64,
    #[allow(dead_code)]
    pub user_name: String,
}

pub struct KnowledgeUser(pub CurrentUser);

impl std::ops::Deref for KnowledgeUser {
    type Target = CurrentUser;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const KNOWLEDGE_AUTH_REQUIRED: &str = "Wegent-Knowledge-Auth-Required";
const KNOWLEDGE_AUTH_INVALID_KEY: &str = "Wegent-Knowledge-Auth-Invalid-Key";
const KNOWLEDGE_AUTH_EXPIRED_KEY: &str = "Wegent-Knowledge-Auth-Expired-Key";
const KNOWLEDGE_AUTH_USER_NOT_FOUND: &str = "Wegent-Knowledge-Auth-User-Not-Found";
const KNOWLEDGE_AUTH_USERNAME_REQUIRED: &str = "Wegent-Knowledge-Auth-Username-Required";
const KNOWLEDGE_AUTH_INVALID_USERNAME: &str = "Wegent-Knowledge-Auth-Invalid-Username";
const KNOWLEDGE_AUTH_INACTIVE: &str = "Wegent-Knowledge-Auth-Inactive";
const KNOWLEDGE_AUTH_INVALID: &str = "Wegent-Knowledge-Auth-Invalid";

impl brz_http_server::Authenticator<KnowledgeUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<KnowledgeUser, brz_http_server::AuthFailure> {
        let value = |name| {
            request
                .header(name)
                .and_then(|v| std::str::from_utf8(v).ok())
        };
        let headers = crate::headers::OwnedHeaders::from_pairs([
            ("authorization", value("authorization")),
            ("x-api-key", value("x-api-key")),
            ("wegent-source", value("wegent-source")),
            ("wegent-username", value("wegent-username")),
        ]);
        get_auth_context(self.state(), &headers.view())
            .await
            .map(KnowledgeUser)
            .map_err(|error| {
                if error.status() == brz_http_server::StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else {
                    let challenge = match error.detail() {
                        "API key is required" => KNOWLEDGE_AUTH_REQUIRED,
                        "Invalid API key" => KNOWLEDGE_AUTH_INVALID_KEY,
                        "API key has expired" => KNOWLEDGE_AUTH_EXPIRED_KEY,
                        "User not found or inactive" => KNOWLEDGE_AUTH_USER_NOT_FOUND,
                        "Username is required for service key authentication (use wegent-username header)" => {
                            KNOWLEDGE_AUTH_USERNAME_REQUIRED
                        }
                        "Username can only contain letters, numbers, underscores, and hyphens" => {
                            KNOWLEDGE_AUTH_INVALID_USERNAME
                        }
                        detail if detail.starts_with("User '") && detail.ends_with("' is inactive") => {
                            KNOWLEDGE_AUTH_INACTIVE
                        }
                        _ => KNOWLEDGE_AUTH_INVALID,
                    };
                    brz_http_server::AuthFailure::invalid_credentials(challenge)
                }
            })
    }

    fn api_log_id<'a>(&'a self, principal: &'a KnowledgeUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        let error = match failure {
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_INVALID_KEY,
            } => crate::http_compat::FastApiError::unauthorized("Invalid API key"),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_EXPIRED_KEY,
            } => crate::http_compat::FastApiError::unauthorized("API key has expired"),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_USER_NOT_FOUND,
            } => crate::http_compat::FastApiError::unauthorized("User not found or inactive"),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_USERNAME_REQUIRED,
            } => crate::http_compat::FastApiError::detail(
                brz_http_server::StatusCode::BAD_REQUEST,
                "Username is required for service key authentication (use wegent-username header)",
            ),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_INVALID_USERNAME,
            } => crate::http_compat::FastApiError::detail(
                brz_http_server::StatusCode::BAD_REQUEST,
                "Username can only contain letters, numbers, underscores, and hyphens",
            ),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_INACTIVE,
            } => {
                let username = knowledge_username(request).unwrap_or_default();
                crate::http_compat::FastApiError::unauthorized(format!(
                    "User '{username}' is inactive"
                ))
            }
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                )
            }
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: KNOWLEDGE_AUTH_INVALID,
            } => {
                crate::http_compat::FastApiError::unauthorized("Invalid authentication credentials")
            }
            _ => crate::http_compat::FastApiError::unauthorized("API key is required"),
        };
        error.into_http_error(arena)
    }
}

fn knowledge_username(request: brz_http_server::AuthRequest<'_>) -> Option<String> {
    let value = |name| {
        request
            .header(name)
            .and_then(|value| std::str::from_utf8(value).ok())
    };
    let headers = crate::headers::OwnedHeaders::from_pairs([
        ("authorization", value("authorization")),
        ("x-api-key", value("x-api-key")),
        ("wegent-source", value("wegent-source")),
        ("wegent-username", value("wegent-username")),
    ]);
    let headers = headers.view();
    let username_from_key =
        api_key_from_headers(&headers).and_then(|key| split_key_with_username(&key).1);
    username_from_key.or_else(|| {
        headers
            .header("wegent-username")
            .map(str::trim)
            .filter(|username| !username.is_empty())
            .map(str::to_owned)
    })
}

/// `api_keys` columns as rendered by `db.query(APIKey)`.
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

/// `api_keys` row selected by hash (`db.query(APIKey).filter(key_hash,
/// is_active)`); only the fields the auth flow reads are exposed.
#[derive(Debug, FromMysqlRow)]
struct ApiKeyRow {
    #[mysql(rename = "api_keys_id")]
    id: i32,
    #[mysql(rename = "api_keys_user_id")]
    user_id: i32,
    #[mysql(rename = "api_keys_key_type")]
    key_type: String,
    /// `DATETIME` decoded as the driver's datetime type, then formatted for
    /// the naive-UTC lexicographic expiry comparison like the source.
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: chrono::NaiveDateTime,
}

/// The post-commit reload row (SQLAlchemy expires the ORM object on
/// commit; the next attribute read reloads it by primary key).
#[derive(Debug, FromMysqlRow)]
struct ApiKeyReloadRow {
    #[allow(dead_code)]
    #[mysql(rename = "api_keys_name")]
    name: String,
    #[allow(dead_code)]
    #[mysql(rename = "api_keys_key_type")]
    key_type: String,
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

/// The raw bearer credential from the Authorization header.
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
/// datetime.utcnow()`): the stored `DATETIME` compared against the current
/// naive UTC timestamp, second precision.
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
fn algorithm(config: &AuthConfig) -> jsonwebtoken::Algorithm {
    match config.algorithm.as_str() {
        "HS384" => jsonwebtoken::Algorithm::HS384,
        "HS512" => jsonwebtoken::Algorithm::HS512,
        _ => jsonwebtoken::Algorithm::HS256,
    }
}

fn decode_with_keys<T: for<'de> Deserialize<'de>>(config: &AuthConfig, token: &str) -> Option<T> {
    let mut validation = jsonwebtoken::Validation::new(algorithm(config));
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    decoding_keys(config)
        .into_iter()
        .find_map(|key_bytes| {
            jsonwebtoken::decode::<T>(
                token,
                &jsonwebtoken::DecodingKey::from_secret(&key_bytes),
                &validation,
            )
            .ok()
        })
        .map(|token| token.claims)
}

/// `UserReader.get_by_id` as a direct SQL lookup: the source's JWT and
/// task-token fallbacks query `users` directly (`db.query(User)`) rather than
/// through the deployment `userReader`, so they reuse the shared statement.
async fn direct_user_by_id<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<UserRecord>>
where
    M: Mysql,
{
    let row: Option<UserRow> = mysql.fetch_optional(USER_BY_ID_QUERY, (user_id,)).await?;
    Ok(row.map(UserRecord::from))
}

/// `UserReader.get_by_name` as a direct SQL lookup; see
/// [`direct_user_by_id`].
async fn direct_user_by_name<M>(mysql: &M, user_name: &str) -> MysqlResult<Option<UserRecord>>
where
    M: Mysql,
{
    let row: Option<UserRow> = mysql
        .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
        .await?;
    Ok(row.map(UserRecord::from))
}

/// `verify_jwt_token_with_db`: decode a user-session JWT and load the user.
async fn verify_jwt_token_with_db(
    config: &AuthConfig,
    mysql: &impl Mysql,
    token: &str,
) -> Result<Option<UserRecord>, ApiFailure> {
    let Some(claims) = decode_with_keys::<SessionClaims>(config, token) else {
        return Ok(None);
    };
    let Some(user_name) = claims.username() else {
        return Ok(None);
    };
    let user = direct_user_by_name(mysql, &user_name)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    Ok(user.filter(|user| user.is_active))
}

/// `verify_task_token` fallback: `type=task_token` JWT resolving a user id.
async fn verify_task_token_user(
    config: &AuthConfig,
    mysql: &impl Mysql,
    token: &str,
) -> Result<Option<UserRecord>, ApiFailure> {
    let Some(claims) = decode_with_keys::<TaskTokenClaims>(config, token) else {
        return Ok(None);
    };
    if claims.token_type.as_deref() != Some("task_token") {
        return Ok(None);
    }
    let Some(user_id) = claims.user_id else {
        return Ok(None);
    };
    let user = direct_user_by_id(mysql, user_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    Ok(user.filter(|user| user.is_active))
}

/// Authenticate one request and return the user
/// (`get_auth_context` with the source priority order).
pub async fn get_auth_context(
    state: &AppState,
    headers: &impl crate::headers::Headers,
) -> Result<CurrentUser, ApiFailure> {
    let mysql = &state.mysql;
    let config = &state.auth;

    let wegent_username = headers
        .header("wegent-username")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let api_key = api_key_from_headers(headers);

    // Fallback: JWT Bearer token when no API key is present.
    let Some(api_key) = api_key else {
        if let Some(token) = bearer_token(headers).filter(|token| !is_api_key(token)) {
            if let Some(user) = verify_jwt_token_with_db(config, mysql, &token).await? {
                return Ok(CurrentUser {
                    id: user.id,
                    user_name: user.user_name,
                });
            }
            if let Some(user) = verify_task_token_user(config, mysql, &token).await? {
                return Ok(CurrentUser {
                    id: user.id,
                    user_name: user.user_name,
                });
            }
        }
        return Err(ApiFailure::new(
            brz_http_server::StatusCode::UNAUTHORIZED,
            "API key is required",
        ));
    };

    // `api_key#username` format.
    let (actual_api_key, username_from_key) = split_key_with_username(&api_key);

    // Select the key by SHA-256 hash (full labeled projection, scalar
    // filters inlined as literals like the recorded COM_QUERY).
    let key_hash = hex_sha256(actual_api_key.as_bytes());
    let record: Option<ApiKeyRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.key_hash = '{key_hash}' \
                 AND api_keys.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let Some(record) = record else {
        return Err(ApiFailure::new(
            brz_http_server::StatusCode::UNAUTHORIZED,
            "Invalid API key",
        ));
    };

    // Expiration check (naive UTC comparison).
    if api_key_expired(record.expires_at) {
        return Err(ApiFailure::new(
            brz_http_server::StatusCode::UNAUTHORIZED,
            "API key has expired",
        ));
    }

    // Update `last_used_at` (UPDATE + COMMIT). The source renders
    // `datetime.utcnow()` (microsecond precision, naive UTC) inline.
    let now = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    mysql
        .execute(
            &format!(
                "UPDATE api_keys SET last_used_at='{now}', updated_at=now() \
                 WHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    // SQLAlchemy expires the ORM object on commit; the endpoint's later
    // `api_key_record.name` read reloads the row by primary key (full
    // labeled projection, literal id).
    let _reload: Option<ApiKeyReloadRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;

    // Personal key: return the key owner directly (`userReader.get_by_id`
    // through the deployment reader: the internal deployment serves the
    // `user:v2:data:{user_id}` cache document without a SQL lookup).
    if record.key_type == KEY_TYPE_PERSONAL {
        let user = state
            .user_reader
            .get_by_id(i64::from(record.user_id))
            .await
            .map_err(|error| ApiFailure::internal(error.to_string()))?;
        return match user {
            Some(user) if user.is_active => Ok(CurrentUser {
                id: user.id,
                user_name: user.user_name,
            }),
            _ => Err(ApiFailure::new(
                brz_http_server::StatusCode::UNAUTHORIZED,
                "User not found or inactive",
            )),
        };
    }

    // Service key: require a username via header or `api_key#username`.
    if record.key_type == KEY_TYPE_SERVICE {
        let target_username = username_from_key.clone().or(wegent_username);
        let Some(target_username) = target_username else {
            return Err(ApiFailure::new(
                brz_http_server::StatusCode::BAD_REQUEST,
                "Username is required for service key authentication \
                 (use wegent-username header)",
            ));
        };
        // Username format validation (`^[a-zA-Z0-9_-]+$`).
        if target_username.is_empty()
            || !target_username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(ApiFailure::new(
                brz_http_server::StatusCode::BAD_REQUEST,
                "Username can only contain letters, numbers, underscores, and hyphens",
            ));
        }
        // `userReader.get_by_name` through the deployment reader (the
        // internal deployment resolves `user:v2:idx:name:{user_name}` first).
        let user = state
            .user_reader
            .get_by_name(&target_username)
            .await
            .map_err(|error| ApiFailure::internal(error.to_string()))?;
        if let Some(user) = user {
            if !user.is_active {
                return Err(ApiFailure::new(
                    brz_http_server::StatusCode::UNAUTHORIZED,
                    format!("User '{target_username}' is inactive"),
                ));
            }
            return Ok(CurrentUser {
                id: user.id,
                user_name: user.user_name,
            });
        }
        // The source auto-creates the missing user and applies default
        // resources; only the authentication outcome is observable here.
        return Err(ApiFailure::new(
            brz_http_server::StatusCode::UNAUTHORIZED,
            "User not found or inactive",
        ));
    }

    Err(ApiFailure::new(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Invalid authentication credentials",
    ))
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
