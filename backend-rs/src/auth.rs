// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JWT session verification and user lookup.
//!
//! Mirrors `app.core.security.get_current_user`: decode the bearer token
//! (`app.core.jwt_compat.decode_jose_jwt` with the active then legacy signing
//! keys, `app.core.session_token.is_user_session_payload`), then load the user
//! row and reject missing or inactive users with `401 {"detail": ...}`.
use brz_mysql::{FromMysqlRow, Json};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

use crate::config::AuthConfig;

/// JWT claims carried by a user-session token.
///
/// Shared across all authentication paths. `sub` is optional because a token
/// may lack it (rejected later); `scope` is accepted as arbitrary JSON and a
/// session is only valid when it is absent or null; `exp` is consumed by
/// `jsonwebtoken`'s validation and is otherwise unused here.
#[derive(Debug, Deserialize)]
pub struct SessionClaims {
    pub sub: Option<String>,
    #[serde(default)]
    pub scope: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    pub token_use: Option<String>,
    /// Validated by the decoder; not read by application code.
    #[serde(default)]
    #[allow(dead_code, reason = "validated by jsonwebtoken, not read directly")]
    pub exp: Option<i64>,
}

impl SessionClaims {
    /// `is_user_session_payload`: no `scope` claim and `token_use` either
    /// absent or `wework_access`.
    pub fn is_user_session_payload(&self) -> bool {
        self.scope.is_none()
            && matches!(
                self.token_use.as_deref(),
                None | Some(WEWORK_ACCESS_TOKEN_USE)
            )
    }

    /// The non-empty `sub` when this is a user-session payload.
    pub fn username(&self) -> Option<String> {
        if !self.is_user_session_payload() {
            return None;
        }
        self.sub.clone().filter(|sub| !sub.is_empty())
    }
}

/// `WEWORK_ACCESS_TOKEN_USE` (`app.core.session_token`).
pub const WEWORK_ACCESS_TOKEN_USE: &str = "wework_access";

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

/// `extract_authorization_token`: case-insensitive Bearer credential or the
/// plain header value.
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

/// `verify_token` with key rotation: try the active key, then legacy keys.
fn verify_token(config: &AuthConfig, token: &str) -> Result<String, ()> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose rejects the `none` algorithm; HS256 is the configured
    // algorithm and no audience is required. `exp` is validated when present
    // but not a required claim, matching python-jose decode defaults.
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    for key_bytes in decoding_keys(config) {
        let key = DecodingKey::from_secret(&key_bytes);
        if let Ok(token) = decode::<SessionClaims>(token, &key, &validation) {
            let claims = token.claims;
            return claims.username().ok_or(());
        }
    }
    Err(())
}

/// Database user row (`users` table) for authentication.
///
/// The projection mirrors the source SQLAlchemy `db.query(User)` column list
/// exactly (all twelve mapped columns, aliased `<table>_<column>`), so the
/// prepared statement matches the recorded exchange for replay. Only `id`
/// and `is_active` are consumed by the devices endpoint. The result columns
/// carry the `users_<column>` aliases, so every field is renamed.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    #[mysql(rename = "users_id")]
    pub id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_email")]
    pub email: Option<String>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_git_info")]
    pub git_info: Json<crate::json_compat::OpaqueJson>,
    #[mysql(rename = "users_is_active")]
    pub is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_role")]
    pub role: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_auth_source")]
    pub auth_source: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_preferences")]
    pub preferences: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_created_at")]
    pub created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_updated_at")]
    pub updated_at: chrono::NaiveDateTime,
}

/// The source `db.query(User).filter(User.user_name == username).first()`
/// statement: every mapped column, aliased `users_<column>` like SQLAlchemy's
/// labeled query rendering.
pub(crate) const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

/// `get_current_user`: verify the bearer token and load the active user.
///
/// Returns `Err(reason)` where the reason selects the source-compatible
/// 401 response detail (`Could not validate credentials` or
/// `User not activated`).
pub async fn get_current_user<M>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> Result<UserRow, AuthFailure>
where
    M: brz_mysql::Mysql,
{
    let token = extract_authorization_token(authorization);
    if token.is_empty() {
        return Err(AuthFailure::InvalidCredentials);
    }
    let username = verify_token(config, &token).map_err(|_| AuthFailure::InvalidCredentials)?;
    let user: Option<UserRow> = mysql
        .fetch_optional(USER_BY_NAME_QUERY, (username,))
        .await
        .map_err(|_| AuthFailure::InvalidCredentials)?;
    match user {
        None => Err(AuthFailure::InvalidCredentials),
        Some(user) if user.is_active == 0 => Err(AuthFailure::UserNotActivated),
        Some(user) => Ok(user),
    }
}

/// Authentication failure classification for source-compatible 401 mapping.
pub enum AuthFailure {
    /// `401 {"detail": "Could not validate credentials"}`.
    InvalidCredentials,
    /// `401 {"detail": "User not activated"}`.
    UserNotActivated,
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

    fn header(value: &'static str) -> Option<&'static str> {
        Some(value)
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret("test-key".as_bytes());
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    #[test]
    fn extracts_bearer_token() {
        assert_eq!(
            extract_authorization_token(header("Bearer abc.def")),
            "abc.def"
        );
        assert_eq!(extract_authorization_token(header("bearer abc")), "abc");
        assert_eq!(extract_authorization_token(header("abc")), "abc");
        assert_eq!(extract_authorization_token(None), "");
    }

    #[test]
    fn verifies_session_token_and_rejects_scoped_tokens() {
        let token = token_for(serde_json::json!({"sub": "guofeng10"}));
        assert_eq!(verify_token(&config(), &token).unwrap(), "guofeng10");

        let scoped = token_for(serde_json::json!({"sub": "u", "scope": "read"}));
        assert!(verify_token(&config(), &scoped).is_err());

        let service = token_for(serde_json::json!({"sub": "u", "token_use": "api_key"}));
        assert!(verify_token(&config(), &service).is_err());

        let wework = token_for(serde_json::json!({"sub": "u", "token_use": "wework_access"}));
        assert_eq!(verify_token(&config(), &wework).unwrap(), "u");
    }

    #[test]
    fn rejects_wrong_signature_and_missing_sub() {
        let foreign = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("other-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "u"}), &key).unwrap()
        };
        assert!(verify_token(&config(), &foreign).is_err());

        let missing_sub = token_for(serde_json::json!({"n": 1}));
        assert!(verify_token(&config(), &missing_sub).is_err());
    }

    #[test]
    fn rotates_to_legacy_keys() {
        let config = AuthConfig {
            jwt_key: "new-key".to_string(),
            legacy_jwt_keys: vec!["old-key".to_string()],
            algorithm: "HS256".to_string(),
        };
        let legacy = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("old-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "legacy-user"}), &key).unwrap()
        };
        assert_eq!(verify_token(&config, &legacy).unwrap(), "legacy-user");
    }
}

#[cfg(test)]
mod scope_contract_tests {
    use super::*;
    #[test]
    fn only_missing_or_null_scope_is_a_session() {
        for raw in ["null", "false", "0", "0.0", "\"\"", "[]", "{}", "\"read\""] {
            let claims: SessionClaims =
                serde_json::from_str(&format!(r#"{{"sub":"user","scope":{raw}}}"#)).unwrap();
            assert_eq!(
                claims.is_user_session_payload(),
                raw == "null",
                "scope={raw}"
            );
        }
        let claims: SessionClaims = serde_json::from_str(r#"{"sub":"user"}"#).unwrap();
        assert!(claims.is_user_session_payload());
    }
}
