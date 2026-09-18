// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication for `get_current_user`
//! (`app.core.security.get_current_user`, OAuth2 Bearer JWT only).
//!
//! The source endpoint depends on `security.get_current_user`, which decodes
//! a user-session JWT from the `Authorization: Bearer` header, resolves the
//! `users` row by `user_name`, and rejects missing, invalid, or inactive
//! users with `401 {"detail": ...}` and `WWW-Authenticate: Bearer`.
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

use super::auth_error::AuthError;
use crate::auth::SessionClaims;
use crate::config::AuthConfig;

/// `users` row used by authentication and team serialization. The full
/// column list matches the source `db.query(User)` rendering; the fields
/// authentication does not read carry `#[allow(dead_code)]`.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub struct UserRow {
    pub users_id: i32,
    /// Selected to match the source column list; the value is not read here.
    #[allow(dead_code)]
    pub users_user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code)]
    pub users_email: Option<String>,
    /// `users.git_info` is a JSON column; decoding it as a plain string is a
    /// driver type error, so it decodes as JSON like the source `User` model.
    #[allow(dead_code)]
    pub users_git_info: brz_mysql::Json<crate::json_compat::OpaqueJson>,
    pub users_is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "users_role")]
    pub users_role: String,
    #[allow(dead_code)]
    pub users_auth_source: String,
    #[allow(dead_code)]
    pub users_preferences: String,
    #[allow(dead_code)]
    pub users_created_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    pub users_updated_at: Option<chrono::NaiveDateTime>,
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

/// `verify_token` + user lookup (`get_current_user`).
pub async fn get_current_user<M, H>(
    config: &AuthConfig,
    mysql: &M,
    headers: &H,
) -> Result<UserRow, AuthError>
where
    M: brz_mysql::Mysql,
    H: crate::headers::Headers,
{
    let token = extract_authorization_token(headers.header("authorization"));
    if token.is_empty() {
        return Err(AuthError::not_authenticated());
    }

    let claims = match decode_with_keys::<SessionClaims>(config, &token) {
        Some(claims) if claims.is_user_session_payload() => claims,
        _ => return Err(AuthError::could_not_validate_credentials()),
    };
    let Some(user_name) = claims.sub else {
        return Err(AuthError::could_not_validate_credentials());
    };

    // `db.query(User).filter(User.user_name == ...)` renders the full column
    // list with `users_<name>` aliases; the replay engine matches MySQL
    // exchanges by normalized SQL tokens, so the projection must match the
    // source statement exactly.
    let user: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \
             FROM users \
             WHERE users.user_name = ? \
             LIMIT 1",
            (user_name.as_str(),),
        )
        .await
        .map_err(AuthError::dependency)?;
    match user {
        Some(user) if user.users_is_active != 0 => Ok(user),
        Some(_) => Err(AuthError::user_not_activated()),
        None => Err(AuthError::could_not_validate_credentials()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bearer_and_plain_tokens() {
        assert_eq!(extract_authorization_token(Some("Bearer tok")), "tok");
        assert_eq!(extract_authorization_token(Some("tok")), "tok");
        assert_eq!(extract_authorization_token(None), "");
    }

    #[test]
    fn session_payload_filter() {
        let claims = |scope: Option<serde_json::Value>, token_use: Option<&str>| SessionClaims {
            sub: Some("ziping6".to_string()),
            scope: scope.map(|_| serde::de::IgnoredAny),
            token_use: token_use.map(str::to_string),
            exp: None,
        };
        assert!(claims(None, None).is_user_session_payload());
        assert!(claims(None, Some("wework_access")).is_user_session_payload());
        assert!(!claims(Some(serde_json::json!("read")), None).is_user_session_payload());
        assert!(!claims(None, Some("other")).is_user_session_payload());
    }
}
