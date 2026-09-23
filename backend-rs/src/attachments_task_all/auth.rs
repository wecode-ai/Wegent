// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication for `GET /api/attachments/task/{task_id}/all`:
//! `app.core.security.get_current_user_jwt_apikey_tasktoken`.
//!
//! Both recorded cases authenticate with a task token, so the only MySQL
//! statement this dependency emits is the full-column `users` row selected
//! by id. The API-key and user-session paths render the same full
//! SQLAlchemy projection (by `id` after the `api_keys` lookup, and by
//! `user_name` respectively); all paths use the public direct user reader.
use brz_mysql::{FromMysqlRow, Mysql};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::auth_error::HttpError;
use crate::auth::SessionClaims;
use crate::config::AuthConfig;

/// API key prefix (`app.core.auth_utils.API_KEY_PREFIX`).
const API_KEY_PREFIX: &str = "wg-";

/// `KEY_TYPE_PERSONAL` (`app.models.api_key`): only personal keys are
/// accepted by this dependency.
const KEY_TYPE_PERSONAL: &str = "personal";

/// The authenticated user of one request.
#[derive(Debug)]
pub struct CurrentUser {
    pub id: i64,
    #[allow(dead_code)]
    pub user_name: String,
}

pub struct AuthenticatedUser(pub CurrentUser);

impl std::ops::Deref for AuthenticatedUser {
    type Target = CurrentUser;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const ATTACHMENTS_MISSING: &str = "Wegent-Attachments-Missing";
const ATTACHMENTS_INVALID_API_KEY: &str = "Wegent-Attachments-Invalid-Api-Key";

impl brz_http_server::Authenticator<AuthenticatedUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<AuthenticatedUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        let x_api_key = request
            .header("x-api-key")
            .and_then(|v| std::str::from_utf8(v).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([
            ("authorization", authorization),
            ("x-api-key", x_api_key),
        ]);
        get_current_user(&self.state().auth, &self.state().mysql, &headers.view())
            .await
            .map(AuthenticatedUser)
            .map_err(|error| {
                if error.status() == brz_http_server::StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else if error.detail() == "Missing authentication credentials" {
                    brz_http_server::AuthFailure::missing_credentials(ATTACHMENTS_MISSING)
                } else if error.detail() == "Invalid or expired API key" {
                    brz_http_server::AuthFailure::invalid_credentials(ATTACHMENTS_INVALID_API_KEY)
                } else {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
            })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a AuthenticatedUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: ATTACHMENTS_MISSING,
            } => crate::http_compat::FastApiError::detail(
                brz_http_server::StatusCode::UNAUTHORIZED,
                "Missing authentication credentials",
            ),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: ATTACHMENTS_INVALID_API_KEY,
            } => crate::http_compat::FastApiError::unauthorized("Invalid or expired API key"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                )
            }
            _ => crate::http_compat::FastApiError::unauthorized("Could not validate credentials"),
        }
        .into_http_error(arena)
    }
}

/// A `users` row loaded with the full SQLAlchemy labeled projection; the
/// columns the endpoint does not read carry `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
struct UserRow {
    #[mysql(rename = "users_id")]
    id: i64,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    password_hash: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_email")]
    email: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "users_git_info")]
    git_info: brz_mysql::Json<crate::json_compat::OpaqueJson>,
    #[mysql(rename = "users_is_active")]
    is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "users_role")]
    role: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_auth_source")]
    auth_source: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_preferences")]
    preferences: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    #[mysql(rename = "users_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// `db.query(User)` full labeled column list.
const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// `api_keys` row selected by hash (`db.query(APIKey).filter(key_hash,
/// is_active)`).
#[derive(Debug, FromMysqlRow)]
struct ApiKeyRow {
    #[allow(dead_code)]
    id: i64,
    user_id: i64,
    key_type: String,
    /// `DATETIME` kept as text; compared lexicographically against the
    /// current naive-UTC `YYYY-MM-DD HH:MM:SS` timestamp like the source
    /// (`expires_at < datetime.utcnow()`).
    expires_at: String,
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

/// Decode keys derived from the active key and legacy decode-only keys.
fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        let candidate = key.as_bytes();
        if !keys.iter().any(|existing| *existing == candidate) {
            keys.push(candidate.to_vec());
        }
    }
    keys
}

fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

fn decode_with_keys<T: for<'de> Deserialize<'de>>(config: &AuthConfig, token: &str) -> Option<T> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose decode defaults: signature and `exp` when present; no
    // audience required and `exp` need not exist.
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    decoding_keys(config)
        .into_iter()
        .find_map(|key_bytes| {
            decode::<T>(token, &DecodingKey::from_secret(&key_bytes), &validation).ok()
        })
        .map(|token| token.claims)
}

/// The bearer credential from the `Authorization` header
/// (`extract_authorization_token`: `Bearer xxx` or the plain value).
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<String> {
    let value = headers.header("authorization")?;
    let token = match value.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") => token.trim(),
        _ => value.trim(),
    };
    (!token.is_empty()).then(|| token.to_string())
}

fn header_value<'a>(headers: &'a impl crate::headers::Headers, name: &str) -> Option<&'a str> {
    headers
        .header(name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `get_current_user_jwt_apikey_tasktoken` with the source priority order:
/// X-API-Key header, Authorization Bearer API key, user-session JWT, then
/// the task-token fallback.
pub async fn get_current_user<M: Mysql>(
    config: &AuthConfig,
    mysql: &M,
    headers: &impl crate::headers::Headers,
) -> Result<CurrentUser, HttpError> {
    // Priority 1: `X-API-Key` header.
    if let Some(api_key) = header_value(headers, "x-api-key").filter(|k| is_api_key(k)) {
        return verify_api_key(mysql, api_key).await;
    }

    // Priority 2: `Authorization: Bearer` header.
    if let Some(token) = bearer_token(headers) {
        if is_api_key(&token) {
            return verify_api_key(mysql, &token).await;
        }
        // Priority 3: standard user-session JWT (by `user_name`).
        if let Some(user) = verify_jwt_token_with_db(config, mysql, &token).await? {
            return Ok(user);
        }
        // Priority 4: task-token fallback (by `user_id`).
        if let Some(user) = verify_task_token_user(config, mysql, &token).await? {
            return Ok(user);
        }
        return Err(HttpError::invalid_credentials());
    }

    Err(HttpError::missing_credentials())
}

/// `verify_api_key` (`app.core.auth_utils`, read-only): select the active
/// key by SHA-256 hash, reject expired/non-personal keys, and load the
/// owner user by id.
async fn verify_api_key<M: Mysql>(mysql: &M, api_key: &str) -> Result<CurrentUser, HttpError> {
    let key_hash = hex_sha256(api_key.as_bytes());
    let record: Option<ApiKeyRow> = mysql
        .fetch_optional(
            "SELECT id, user_id, key_type, expires_at FROM api_keys \
             WHERE key_hash = ? AND is_active = 1 LIMIT 1",
            (key_hash.as_str(),),
        )
        .await
        .map_err(HttpError::dependency)?;
    let Some(record) = record else {
        return Err(HttpError::invalid_api_key());
    };
    if api_key_expired(&record.expires_at) || record.key_type != KEY_TYPE_PERSONAL {
        return Err(HttpError::invalid_api_key());
    }
    let user = user_by_id(mysql, record.user_id).await?;
    match user {
        Some(user) if user.is_active != 0 => Ok(CurrentUser {
            id: user.id,
            user_name: user.user_name,
        }),
        _ => Err(HttpError::invalid_api_key()),
    }
}

/// `verify_jwt_token_with_db`: decode a user-session JWT and load the user
/// by `user_name`.
async fn verify_jwt_token_with_db<M: Mysql>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> Result<Option<CurrentUser>, HttpError> {
    let Some(claims) = decode_with_keys::<SessionClaims>(config, token) else {
        return Ok(None);
    };
    let Some(user_name) = claims.username() else {
        return Ok(None);
    };
    let user: Option<UserRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {USER_COLUMNS} \
                 FROM users \
                 WHERE users.user_name = ? \
                 LIMIT 1"
            ),
            (user_name,),
        )
        .await
        .map_err(HttpError::dependency)?;
    Ok(user
        .filter(|user| user.is_active != 0)
        .map(|user| CurrentUser {
            id: user.id,
            user_name: user.user_name,
        }))
}

/// `verify_task_token` fallback: `type=task_token` JWT resolving a user id.
async fn verify_task_token_user<M: Mysql>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> Result<Option<CurrentUser>, HttpError> {
    let Some(claims) = decode_with_keys::<TaskTokenClaims>(config, token) else {
        return Ok(None);
    };
    if claims.token_type.as_deref() != Some("task_token") {
        return Ok(None);
    }
    let Some(user_id) = claims.user_id else {
        return Ok(None);
    };
    let user = user_by_id(mysql, user_id).await?;
    Ok(user
        .filter(|user| user.is_active != 0)
        .map(|user| CurrentUser {
            id: user.id,
            user_name: user.user_name,
        }))
}

/// `db.query(User).filter(User.id == id).first()`.
async fn user_by_id<M: Mysql>(mysql: &M, user_id: i64) -> Result<Option<UserRow>, HttpError> {
    mysql
        .fetch_optional(
            &format!(
                "SELECT {USER_COLUMNS} \
                 FROM users \
                 WHERE users.id = ? \
                 LIMIT 1"
            ),
            (user_id,),
        )
        .await
        .map_err(HttpError::dependency)
}

/// SHA-256 hex digest (`hashlib.sha256(...).hexdigest()`).
fn hex_sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Expiration check: naive-UTC `YYYY-MM-DD HH:MM:SS` lexicographic
/// comparison, matching the source `datetime.utcnow()` comparison.
fn api_key_expired(expires_at: &str) -> bool {
    let now = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    expires_at.trim() < now.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::EncodingKey;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret("test-key".as_bytes());
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    fn headers_with(value: Option<&'static str>) -> crate::headers::HeaderSlice<'static> {
        static NONE: [(&str, &str); 0] = [];
        match value {
            Some(value) => {
                let slice: &'static [(&'static str, &'static str); 1] =
                    Box::leak(Box::new([("authorization", value)]));
                crate::headers::HeaderSlice::new(slice)
            }
            None => crate::headers::HeaderSlice::new(&NONE),
        }
    }

    #[test]
    fn api_key_prefix_is_wg() {
        assert!(is_api_key("wg-abc"));
        assert!(!is_api_key("jwt-token"));
    }

    #[test]
    fn task_token_requires_type_claim() {
        let claims = decode_with_keys::<TaskTokenClaims>(
            &config(),
            &token_for(serde_json::json!({
                "type": "task_token", "user_id": 4771
            })),
        )
        .unwrap();
        assert_eq!(claims.user_id, Some(4771));

        let session = decode_with_keys::<TaskTokenClaims>(
            &config(),
            &token_for(serde_json::json!({
                "sub": "u"
            })),
        )
        .unwrap();
        assert_ne!(session.token_type.as_deref(), Some("task_token"));
    }

    #[test]
    fn session_claims_filter_scoped_and_service_tokens() {
        let claims = |value: serde_json::Value| {
            decode_with_keys::<SessionClaims>(&config(), &token_for(value)).unwrap()
        };
        assert!(claims(serde_json::json!({"sub": "u"})).is_user_session_payload());
        assert!(
            claims(serde_json::json!({"sub": "u", "token_use": "wework_access"}))
                .is_user_session_payload()
        );
        assert!(
            !claims(serde_json::json!({"sub": "u", "scope": "read"})).is_user_session_payload()
        );
        assert!(
            !claims(serde_json::json!({"sub": "u", "token_use": "api_key"}))
                .is_user_session_payload()
        );
    }

    #[test]
    fn extracts_bearer_case_insensitively() {
        assert_eq!(
            bearer_token(&headers_with(Some("Bearer abc.def"))).as_deref(),
            Some("abc.def")
        );
        assert_eq!(
            bearer_token(&headers_with(Some("bearer abc"))).as_deref(),
            Some("abc")
        );
        assert_eq!(
            bearer_token(&headers_with(Some("plain"))).as_deref(),
            Some("plain")
        );
        assert_eq!(bearer_token(&headers_with(None)), None);
    }

    #[test]
    fn hex_digest_is_sha256_hex() {
        // Known SHA-256 vector: sha256("abc").
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn user_columns_projection_matches_source_labels() {
        assert!(USER_COLUMNS.contains("users.id AS users_id"));
        assert!(USER_COLUMNS.contains("users.`role` AS users_role"));
        assert!(USER_COLUMNS.contains("users.updated_at AS users_updated_at"));
        assert!(USER_COLUMNS.contains("users.password_hash AS users_password_hash"));
    }
}
