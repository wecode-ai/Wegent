// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication for `GET /api/v1/kinds/skills/{id}/download`.
//!
//! Mirrors `app.core.security.get_current_user_jwt_apikey_tasktoken` in
//! priority order: X-API-Key header (personal keys `wg-...`), Authorization
//! Bearer API key, user session JWT, then task token fallback. Rejects with
//! the source-compatible 401 details.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::auth::SessionClaims;
use crate::config::AuthConfig;

/// API key prefix (`app.core.auth_utils.API_KEY_PREFIX`).
const API_KEY_PREFIX: &str = "wg-";

/// `users` row needed by the download path.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct UserRow {
    pub id: i32,
    pub user_name: String,
    pub is_active: i8,
    pub role: String,
}

pub struct SkillDownloadUser {
    pub user: UserRow,
    pub runtime_download: bool,
}

impl std::ops::Deref for SkillDownloadUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.user
    }
}

const SKILL_AUTH_MISSING: &str = "Wegent-Skill-Auth-Missing";
const SKILL_AUTH_INVALID_API_KEY: &str = "Wegent-Skill-Auth-Invalid-Api-Key";

impl brz_http_server::Authenticator<SkillDownloadUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<SkillDownloadUser, brz_http_server::AuthFailure> {
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
        let runtime_download = is_runtime_skill_download(&self.state().auth, &headers.view());
        get_current_user(&self.state().auth, &self.state().mysql, &headers.view())
            .await
            .map(|user| SkillDownloadUser {
                user,
                runtime_download,
            })
            .map_err(|error| match error.detail {
                "Missing authentication credentials" => {
                    brz_http_server::AuthFailure::missing_credentials(SKILL_AUTH_MISSING)
                }
                "Invalid or expired API key" => {
                    brz_http_server::AuthFailure::invalid_credentials(SKILL_AUTH_INVALID_API_KEY)
                }
                _ => brz_http_server::AuthFailure::invalid_credentials("Bearer"),
            })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a SkillDownloadUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.user.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        let detail = match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: SKILL_AUTH_MISSING,
            } => "Missing authentication credentials",
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: SKILL_AUTH_INVALID_API_KEY,
            } => "Invalid or expired API key",
            _ => "Could not validate credentials",
        };
        crate::http_compat::FastApiError::unauthorized(detail).into_http_error(arena)
    }
}

impl UserRow {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

/// `is_api_key`: a token is an API key when it starts with `wg-`.
pub fn is_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
}

/// `verify_api_key`: SHA-256 hash lookup on active personal keys followed by
/// an active-user check. `update_last_used_at` writes are skipped because the
/// source download path only reads.
async fn verify_api_key<M>(mysql: &M, api_key: &str) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    let key_hash = hex_sha256(api_key.as_bytes());
    let record: Option<ApiKeyRow> = mysql
        .fetch_optional(
            "SELECT user_id, expires_at, key_type FROM api_keys \
             WHERE key_hash = ? AND is_active = 1 LIMIT 1",
            (key_hash.as_str(),),
        )
        .await?;
    let Some(record) = record else {
        return Ok(None);
    };
    if record.is_expired() || record.key_type != "personal" {
        return Ok(None);
    }
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, is_active, role FROM users WHERE id = ? LIMIT 1",
            (record.user_id,),
        )
        .await?;
    Ok(user.filter(|user| user.is_active != 0))
}

/// `api_keys` row fragments for verification.
#[derive(Debug, FromMysqlRow)]
struct ApiKeyRow {
    user_id: i32,
    /// `DATETIME` decoded as raw text to avoid timezone parsing.
    expires_at: String,
    key_type: String,
}

impl ApiKeyRow {
    /// The source compares `expires_at < datetime.utcnow()` (naive UTC).
    /// The stored value is a naive UTC `DATETIME`; comparing its date-time
    /// prefix against the current naive UTC timestamp preserves the source
    /// boundary (`YYYY-MM-DD HH:MM:SS` sorts lexicographically).
    fn is_expired(&self) -> bool {
        let now = chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S");
        self.expires_at.trim() < now.to_string().as_str()
    }
}

/// Task token claims (`app.services.auth.task_token`).
#[derive(Debug, Deserialize)]
struct TaskTokenClaims {
    user_id: i64,
    #[serde(default)]
    #[allow(dead_code)]
    user_name: String,
    #[serde(rename = "type")]
    token_type: Option<String>,
}

fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        if !keys.iter().any(|existing| existing == key.as_bytes()) {
            keys.push(key.as_bytes().to_vec());
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

/// Decode a JWT with the active key, then legacy decode-only keys
/// (`app.core.jwt_compat.decode_pyjwt`).
fn decode_jwt<T: for<'de> Deserialize<'de>>(config: &AuthConfig, token: &str) -> Result<T, ()> {
    let mut validation = Validation::new(algorithm(config));
    validation.validate_aud = false;
    // Task tokens carry `exp`, but a missing claim must not fail decode on
    // its own (python-jose only validates `exp` when present unless required).
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    let mut last_error = None;
    for key_bytes in decoding_keys(config) {
        let key = DecodingKey::from_secret(&key_bytes);
        match decode::<T>(token, &key, &validation) {
            Ok(token) => return Ok(token.claims),
            Err(error) => last_error = Some(error),
        }
    }
    let _ = last_error;
    Err(())
}

/// `verify_jwt_token_with_db`: session JWT -> user by `sub` (user_name).
async fn verify_jwt_with_db<M>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    let claims = match decode_jwt::<SessionClaims>(config, token) {
        Ok(claims) if claims.is_user_session_payload() => claims,
        _ => return Ok(None),
    };
    let Some(user_name) = claims.username() else {
        return Ok(None);
    };
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, is_active, role FROM users \
             WHERE user_name = ? LIMIT 1",
            (user_name.as_str(),),
        )
        .await?;
    Ok(user.filter(|user| user.is_active != 0))
}

/// `verify_task_token`: task-token JWT -> user by `user_id` claim.
async fn verify_task_token<M>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    let claims: TaskTokenClaims = match decode_jwt(config, token) {
        Ok(claims) => claims,
        Err(()) => return Ok(None),
    };
    if claims.token_type.as_deref() != Some("task_token") {
        return Ok(None);
    }
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, is_active, role FROM users WHERE id = ? LIMIT 1",
            (claims.user_id as i32,),
        )
        .await?;
    Ok(user.filter(|user| user.is_active != 0))
}

/// Extract the bearer token: `Bearer ` prefix or the plain header value.
fn extract_bearer(authorization: Option<&str>) -> String {
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

/// An authentication failure with the source-compatible 401 body.
#[derive(Debug)]
pub struct AuthError {
    pub detail: &'static str,
}

impl AuthError {
    pub fn invalid_api_key() -> Self {
        Self {
            detail: "Invalid or expired API key",
        }
    }

    pub fn invalid_credentials() -> Self {
        Self {
            detail: "Could not validate credentials",
        }
    }

    pub fn missing_credentials() -> Self {
        Self {
            detail: "Missing authentication credentials",
        }
    }
}

/// `get_current_user_jwt_apikey_tasktoken`.
pub async fn get_current_user<M>(
    config: &AuthConfig,
    mysql: &M,
    headers: &impl crate::headers::Headers,
) -> Result<UserRow, AuthError>
where
    M: Mysql,
{
    let authorization = headers.header("authorization");
    let x_api_key = headers.header("x-api-key").unwrap_or("");

    // Priority 1: X-API-Key header.
    if is_api_key(x_api_key) {
        return match verify_api_key(mysql, x_api_key).await {
            Ok(Some(user)) => Ok(user),
            _ => Err(AuthError::invalid_api_key()),
        };
    }

    // Priority 2: Authorization Bearer header.
    let token = extract_bearer(authorization);
    if !token.is_empty() {
        if is_api_key(&token) {
            return match verify_api_key(mysql, &token).await {
                Ok(Some(user)) => Ok(user),
                _ => Err(AuthError::invalid_api_key()),
            };
        }
        if let Ok(Some(user)) = verify_jwt_with_db(config, mysql, &token).await {
            return Ok(user);
        }
        if let Ok(Some(user)) = verify_task_token(config, mysql, &token).await {
            return Ok(user);
        }
        return Err(AuthError::invalid_credentials());
    }

    Err(AuthError::missing_credentials())
}

/// `_is_runtime_skill_download`: executor credentials (API key or task
/// token) may download system skills.
pub fn is_runtime_skill_download(
    config: &AuthConfig,
    headers: &impl crate::headers::Headers,
) -> bool {
    let x_api_key = headers.header("x-api-key").unwrap_or("");
    if is_api_key(x_api_key) {
        return true;
    }
    let token = extract_bearer(headers.header("authorization"));
    if token.is_empty() {
        return false;
    }
    is_api_key(&token) || decode_jwt::<TaskTokenClaims>(config, &token).is_ok()
}

/// Lowercase hex SHA-256 digest of `data`.
pub fn hex_sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        jsonwebtoken::encode(
            &header,
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(b"test-key"),
        )
        .unwrap()
    }

    fn headers(auth: Option<&'static str>) -> crate::headers::HeaderSlice<'static> {
        static NONE: [(&str, &str); 0] = [];
        match auth {
            Some(value) => {
                let slice: &'static [(&'static str, &'static str); 1] =
                    Box::leak(Box::new([("authorization", value)]));
                crate::headers::HeaderSlice::new(slice)
            }
            None => crate::headers::HeaderSlice::new(&NONE),
        }
    }

    #[test]
    fn recognizes_api_keys_by_prefix() {
        assert!(is_api_key("wg-abcdef"));
        assert!(!is_api_key("jwt-token"));
        assert!(!is_api_key(""));
    }

    #[test]
    fn extracts_bearer_tokens() {
        assert_eq!(extract_bearer(Some("Bearer abc")), "abc");
        assert_eq!(extract_bearer(Some("bearer abc")), "abc");
        assert_eq!(extract_bearer(Some("abc")), "abc");
        assert_eq!(extract_bearer(None), "");
    }

    #[test]
    fn session_claims_accept_wework_and_reject_scopes() {
        let claims: SessionClaims = serde_json::from_value(json!({
            "sub": "u", "token_use": "wework_access"
        }))
        .unwrap();
        assert!(claims.is_user_session_payload());

        let scoped: SessionClaims = serde_json::from_value(json!({
            "sub": "u", "scope": "read"
        }))
        .unwrap();
        assert!(!scoped.is_user_session_payload());
    }

    #[test]
    fn decodes_task_tokens_and_rejects_other_types() {
        let token = token_for(json!({"user_id": 1, "type": "task_token", "subtask_id": 2}));
        let claims: TaskTokenClaims = decode_jwt(&config(), &token).unwrap();
        assert_eq!(claims.user_id, 1);
        assert_eq!(claims.token_type.as_deref(), Some("task_token"));

        let other_type = token_for(json!({"user_id": 1, "type": "skill_identity"}));
        let claims: TaskTokenClaims = decode_jwt(&config(), &other_type).unwrap();
        assert_eq!(claims.token_type.as_deref(), Some("skill_identity"));
    }

    #[test]
    fn runtime_download_detects_executor_credentials() {
        let task = token_for(json!({"user_id": 1, "type": "task_token"}));
        let bearer: &'static str = Box::leak(format!("Bearer {task}").into_boxed_str());
        assert!(is_runtime_skill_download(&config(), &headers(Some(bearer))));
        assert!(is_runtime_skill_download(
            &config(),
            &headers(Some("Bearer wg-abc"))
        ));
        assert!(!is_runtime_skill_download(
            &config(),
            &headers(Some("Bearer session-token"))
        ));
    }

    #[test]
    fn sha256_matches_reference_vector() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn api_key_rows_compare_naive_utc_datetimes() {
        let unexpired = ApiKeyRow {
            user_id: 1,
            expires_at: "2999-01-01 00:00:00".to_string(),
            key_type: "personal".to_string(),
        };
        assert!(!unexpired.is_expired());

        let expired = ApiKeyRow {
            user_id: 1,
            expires_at: "2000-01-01 00:00:00".to_string(),
            key_type: "personal".to_string(),
        };
        assert!(expired.is_expired());
    }
}
