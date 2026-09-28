// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication for `get_current_user_jwt_apikey_tasktoken`
//! (`app.core.security`).
//!
//! Priority order:
//! 1. API key via `X-API-Key` header (prefix `wg-`),
//! 2. API key via `Authorization: Bearer` header (prefix `wg-`),
//! 3. user-session JWT via `Authorization: Bearer` header,
//! 4. task token (JWT with `type=task_token`) as fallback.
//!
//! All failures return `401 {"detail": ...}` with
//! `WWW-Authenticate: Bearer`, matching the source FastAPI exceptions.
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::auth_error::AuthError;
use crate::auth::SessionClaims;
use crate::config::AuthConfig;

/// API key prefix (`app.core.auth_utils.API_KEY_PREFIX`).
const API_KEY_PREFIX: &str = "wg-";

/// Task-token JWT claims (`app.services.auth.task_token.verify_task_token`).
/// All source claim fields are kept to mirror the token contract.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct TaskTokenClaims {
    /// `type` must equal `task_token`.
    #[serde(rename = "type")]
    token_type: Option<String>,
    task_id: Option<i64>,
    subtask_id: Option<i64>,
    user_id: Option<i32>,
    user_name: Option<String>,
}

/// `users` row used by authentication.
#[allow(dead_code)]
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub struct UserRow {
    pub id: i32,
    pub user_name: String,
    pub email: Option<String>,
    pub is_active: i8,
}

/// Authenticated principal for the shared JWT / API-key / task-token
/// dependency used by task and cloud-project endpoints.
pub struct FlexibleUser(pub UserRow);

impl std::ops::Deref for FlexibleUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const FLEX_MISSING: &str = "Wegent-Flexible-Missing";
const FLEX_INVALID_API_KEY: &str = "Wegent-Flexible-Invalid-Api-Key";

impl brz_http_server::Authenticator<FlexibleUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<FlexibleUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        let x_api_key = request
            .header("x-api-key")
            .and_then(|value| std::str::from_utf8(value).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([
            ("authorization", authorization),
            ("x-api-key", x_api_key),
        ]);
        get_current_user(&self.state().auth, &self.state().mysql, &headers.view())
            .await
            .map(FlexibleUser)
            .map_err(|error| {
                if error.status() == brz_http_server::StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else if error.detail() == "Missing authentication credentials" {
                    brz_http_server::AuthFailure::missing_credentials(FLEX_MISSING)
                } else if error.detail() == "Invalid or expired API key" {
                    brz_http_server::AuthFailure::invalid_credentials(FLEX_INVALID_API_KEY)
                } else {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
            })
    }

    fn api_log_id<'a>(&'a self, principal: &'a FlexibleUser) -> Option<&'a dyn std::fmt::Display> {
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
                challenge: FLEX_MISSING,
            } => {
                crate::http_compat::FastApiError::unauthorized("Missing authentication credentials")
            }
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: FLEX_INVALID_API_KEY,
            } => crate::http_compat::FastApiError::unauthorized("Invalid or expired API key"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                )
            }
            _ => crate::http_compat::FastApiError::unauthorized("Could not validate credentials"),
        }
        .into_http_error(arena)
    }
}

/// `api_keys` row (`app.models.api_key.APIKey`).
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct ApiKeyRow {
    user_id: i32,
    #[mysql(rename = "key_type")]
    key_type: String,
    expires_at: Option<chrono::NaiveDateTime>,
}

/// API key shape (`is_api_key`): non-empty and `wg-` prefixed.
fn is_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
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
    // No audience is required by the source decoders.
    validation.validate_aud = false;
    decoding_keys(config)
        .into_iter()
        .find_map(|key_bytes| {
            let key = DecodingKey::from_secret(&key_bytes);
            decode::<T>(token, &key, &validation).ok()
        })
        .map(|token| token.claims)
}

/// `extract_authorization_token`: `Bearer ` credential or the plain value.
pub fn extract_authorization_token(authorization: Option<&str>) -> String {
    let Some(header) = authorization else {
        return String::new();
    };
    if let Some(token) = header.strip_prefix("Bearer ") {
        return token.trim().to_string();
    }
    if let Some(token) = header.strip_prefix("bearer ") {
        return token.trim().to_string();
    }
    header.trim().to_string()
}

/// `verify_api_key`: active, unexpired, personal key owned by an active user.
async fn verify_api_key<M>(
    mysql: &M,
    api_key: &str,
) -> Result<Option<UserRow>, brz_mysql::MysqlError>
where
    M: brz_mysql::Mysql,
{
    let key_hash = hex_sha256(api_key.as_bytes());
    let record: Option<ApiKeyRow> = mysql
        .fetch_optional(
            "SELECT user_id, key_type, expires_at FROM api_keys \
             WHERE key_hash = ? AND is_active = 1 LIMIT 1",
            (key_hash.as_str(),),
        )
        .await?;
    let Some(record) = record else {
        return Ok(None);
    };
    // An expired key never authenticates (NULL `expires_at` means no expiry).
    if let Some(expires_at) = record.expires_at {
        let now = chrono::Utc::now().naive_utc();
        if expires_at < now {
            return Ok(None);
        }
    }
    if record.key_type != "personal" {
        return Ok(None);
    }
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, email, is_active FROM users WHERE id = ? LIMIT 1",
            (record.user_id,),
        )
        .await?;
    Ok(match user {
        Some(user) if user.is_active != 0 => Some(user),
        _ => None,
    })
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

/// `verify_jwt_token_with_db`: decode a user-session JWT and load the user.
async fn verify_jwt_token_with_db<M>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> Result<Option<UserRow>, brz_mysql::MysqlError>
where
    M: brz_mysql::Mysql,
{
    let Some(claims) = decode_with_keys::<SessionClaims>(config, token) else {
        return Ok(None);
    };
    let Some(user_name) = claims.username() else {
        return Ok(None);
    };
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, email, is_active FROM users \
             WHERE user_name = ? LIMIT 1",
            (user_name,),
        )
        .await?;
    Ok(match user {
        Some(user) if user.is_active != 0 => Some(user),
        _ => None,
    })
}

/// `verify_task_token` fallback: `type=task_token` JWT resolving a user id.
async fn verify_task_token_user<M>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> Result<Option<UserRow>, brz_mysql::MysqlError>
where
    M: brz_mysql::Mysql,
{
    let Some(claims) = decode_with_keys::<TaskTokenClaims>(config, token) else {
        return Ok(None);
    };
    if claims.token_type.as_deref() != Some("task_token") {
        return Ok(None);
    }
    let Some(user_id) = claims.user_id else {
        return Ok(None);
    };
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, email, is_active FROM users WHERE id = ? LIMIT 1",
            (user_id,),
        )
        .await?;
    Ok(match user {
        Some(user) if user.is_active != 0 => Some(user),
        _ => None,
    })
}

/// `get_current_user_jwt_apikey_tasktoken` with the source priority order.
pub async fn get_current_user<M, H>(
    config: &AuthConfig,
    mysql: &M,
    headers: &H,
) -> Result<UserRow, AuthError>
where
    M: brz_mysql::Mysql,
    H: crate::headers::Headers,
{
    let x_api_key = headers
        .header("x-api-key")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let token = extract_authorization_token(headers.header("authorization"));

    // Priority 1: X-API-Key header.
    if let Some(api_key) = x_api_key.filter(|key| is_api_key(key)) {
        return match verify_api_key(mysql, &api_key).await {
            Ok(Some(user)) => Ok(user),
            Ok(None) => Err(AuthError::invalid_api_key()),
            Err(error) => Err(AuthError::dependency(error)),
        };
    }

    // Priority 2: Authorization Bearer header.
    if !token.is_empty() {
        if is_api_key(&token) {
            return match verify_api_key(mysql, &token).await {
                Ok(Some(user)) => Ok(user),
                Ok(None) => Err(AuthError::invalid_api_key()),
                Err(error) => Err(AuthError::dependency(error)),
            };
        }
        match verify_jwt_token_with_db(config, mysql, &token).await {
            Ok(Some(user)) => return Ok(user),
            Ok(None) => {}
            Err(error) => return Err(AuthError::dependency(error)),
        }
        return match verify_task_token_user(config, mysql, &token).await {
            Ok(Some(user)) => Ok(user),
            Ok(None) => Err(AuthError::invalid_credentials()),
            Err(error) => Err(AuthError::dependency(error)),
        };
    }

    Err(AuthError::missing_credentials())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_shape_requires_wg_prefix() {
        assert!(is_api_key("wg-abcdef"));
        assert!(!is_api_key("jwt-value"));
        assert!(!is_api_key(""));
    }

    #[test]
    fn extracts_bearer_and_plain_tokens() {
        assert_eq!(extract_authorization_token(Some("Bearer tok")), "tok");
        assert_eq!(extract_authorization_token(Some("tok")), "tok");
        assert_eq!(extract_authorization_token(None), "");
    }

    #[test]
    fn session_payload_filter() {
        let claims = |scope: Option<serde_json::Value>, token_use: Option<&str>| SessionClaims {
            sub: Some("qindi".to_string()),
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
    fn sha256_is_lowercase_hex() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
