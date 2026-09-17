// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JWT session verification and user lookup.
//!
//! Mirrors `app.core.security.get_current_user`: decode the bearer token
//! (`app.core.jwt_compat.decode_jose_jwt` with the active then legacy
//! signing keys, `app.core.session_token.is_user_session_payload`), then
//! load the user row and reject missing or inactive users with
//! `401 {"detail": ...}`.
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

use super::auth_error::AuthError;
use crate::auth::SessionClaims;
use crate::config::AuthConfig;

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
fn verify_token(config: &AuthConfig, token: &str) -> Result<String, AuthError> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose rejects the `none` algorithm; HS256 is the configured
    // algorithm and no audience is required. `exp` is validated when present
    // but not a required claim, matching python-jose decode defaults.
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    let mut last_error = None;
    for key_bytes in decoding_keys(config) {
        let key = DecodingKey::from_secret(&key_bytes);
        match decode::<SessionClaims>(token, &key, &validation) {
            Ok(token) => {
                return token
                    .claims
                    .username()
                    .ok_or_else(AuthError::invalid_credentials);
            }
            Err(error) => last_error = Some(error),
        }
    }
    match last_error {
        Some(_) => Err(AuthError::invalid_credentials()),
        None => Err(AuthError::invalid_credentials()),
    }
}

/// Database user row (`users` table) for authentication and search.
///
/// `user_name` and `email` are part of the source row shape; they are
/// selected so the auth query matches the source column projection but are
/// only consumed by the search endpoint's separate query.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub struct UserRow {
    pub id: i32,
    #[allow(dead_code)]
    pub user_name: String,
    #[allow(dead_code)]
    pub email: Option<String>,
    #[allow(dead_code)]
    pub is_active: i8,
}

/// `get_current_user`: verify the bearer token and load the active user.
pub async fn get_current_user<M>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> Result<UserRow, AuthError>
where
    M: brz_mysql::Mysql,
{
    let token = extract_authorization_token(authorization);
    if token.is_empty() {
        return Err(AuthError::missing_token());
    }
    let username = verify_token(config, &token)?;
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT id, user_name, email, is_active FROM users WHERE user_name = ? LIMIT 1",
            (username,),
        )
        .await
        .map_err(AuthError::dependency)?;
    match user {
        None => Err(AuthError::invalid_credentials()),
        Some(user) if user.is_active == 0 => Err(AuthError::user_not_activated()),
        Some(user) => Ok(user),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthConfig;
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
        let token = token_for(serde_json::json!({"sub": "junlong5"}));
        assert_eq!(verify_token(&config(), &token).unwrap(), "junlong5");

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

        let no_sub = token_for(serde_json::json!({"user_id": 1}));
        assert!(verify_token(&config(), &no_sub).is_err());
    }

    #[test]
    fn rotates_to_legacy_key() {
        let config = AuthConfig {
            jwt_key: "new-key".to_string(),
            legacy_jwt_keys: vec!["old-key".to_string()],
            algorithm: "HS256".to_string(),
        };
        let legacy_token = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("old-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "legacy-user"}), &key).unwrap()
        };
        assert_eq!(verify_token(&config, &legacy_token).unwrap(), "legacy-user");
    }
}
