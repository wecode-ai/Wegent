// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional JWT session authentication mirroring
//! `app.core.security.get_current_user_optional` for the attachment download
//! endpoint.
//!
//! `None` (anonymous) when the header is absent, the token fails
//! `decode_jose_jwt`/`verify_token`, or the user is missing or inactive; the
//! download endpoint then applies its share-token/browser fallbacks.
use crate::auth::SessionClaims;
use crate::config::AuthConfig;
use crate::json_compat::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

/// A `users` row selected with the source SQLAlchemy projection: every
/// mapped column, labeled `users_<column>`. Only `id` and `is_active` are
/// consumed; the remaining columns are decoded so the statement matches the
/// recorded source query (the replay matcher requires an exact
/// normalized-SQL token match, and the recorded exchange is SQLAlchemy's
/// full twelve-column labeled statement).
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct UserRow {
    pub users_id: i32,
    #[allow(dead_code)]
    pub users_user_name: String,
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    pub users_email: Option<String>,
    pub users_git_info: Json<OpaqueJson>,
    pub users_is_active: i8,
    pub users_role: String,
    pub users_auth_source: String,
    pub users_preferences: String,
    pub users_created_at: NaiveDateTime,
    pub users_updated_at: NaiveDateTime,
}

pub struct AttachmentUser(pub UserRow);

impl std::ops::Deref for AttachmentUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl brz_http_server::Authenticator<AttachmentUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<AttachmentUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        get_current_user_optional(&self.state().auth, &self.state().mysql, authorization)
            .await
            .map_err(|_| brz_http_server::AuthFailure::Internal)?
            .map(AttachmentUser)
            .ok_or_else(|| brz_http_server::AuthFailure::missing_credentials("Bearer"))
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a AttachmentUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.users_user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        _failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        crate::http_compat::FastApiError::detail(
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
        )
        .into_http_error(arena)
    }
}

/// `get_current_user`'s `db.query(User).filter(User.user_name ==
/// username).first()` statement, rendered exactly as SQLAlchemy labels it.
const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

/// Extract the bearer credential like `extract_authorization_token`:
/// case-insensitive `Bearer ` prefix or the plain header value.
fn extract_authorization_token(authorization: Option<&str>) -> String {
    let Some(header) = authorization else {
        return String::new();
    };
    let header = header.trim();
    if let Some(token) = header.strip_prefix("Bearer ") {
        return token.trim().to_string();
    }
    if let Some(token) = header.strip_prefix("bearer ") {
        return token.trim().to_string();
    }
    header.to_string()
}

fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

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

/// `verify_token` with key rotation: the active key, then legacy keys.
/// Returns the verified `sub` username.
fn verify_token(config: &AuthConfig, token: &str) -> Option<String> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose validates `exp` only when present; no audience is required.
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    for key_bytes in decoding_keys(config) {
        let key = DecodingKey::from_secret(&key_bytes);
        if let Ok(token) = decode::<SessionClaims>(token, &key, &validation) {
            // `is_user_session_payload` plus non-empty `sub` extraction.
            return token.claims.username();
        }
    }
    None
}

/// `get_current_user_optional`: `None` for every failure mode (invalid,
/// missing, or inactive user) instead of a 401.
pub async fn get_current_user_optional<M>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> brz_mysql::MysqlResult<Option<UserRow>>
where
    M: brz_mysql::Mysql,
{
    let token = extract_authorization_token(authorization);
    if token.is_empty() {
        return Ok(None);
    }
    let Some(username) = verify_token(config, &token) else {
        return Ok(None);
    };
    let user: Option<UserRow> = mysql
        .fetch_optional(USER_BY_NAME_QUERY, (username,))
        .await?;
    Ok(user.filter(|user| user.users_is_active != 0))
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
        let key = EncodingKey::from_secret(b"test-key");
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    #[test]
    fn extracts_bearer_tokens() {
        assert_eq!(
            extract_authorization_token(Some("Bearer abc.def")),
            "abc.def"
        );
        assert_eq!(extract_authorization_token(Some("bearer abc")), "abc");
        assert_eq!(extract_authorization_token(Some("abc")), "abc");
        assert_eq!(extract_authorization_token(None), "");
    }

    #[test]
    fn verifies_sessions_and_rejects_service_tokens() {
        let token = token_for(serde_json::json!({"sub": "yuxuan25"}));
        assert_eq!(verify_token(&config(), &token).as_deref(), Some("yuxuan25"));

        let wework = token_for(serde_json::json!({"sub": "u", "token_use": "wework_access"}));
        assert_eq!(verify_token(&config(), &wework).as_deref(), Some("u"));

        let scoped = token_for(serde_json::json!({"sub": "u", "scope": "read"}));
        assert!(verify_token(&config(), &scoped).is_none());

        let api_key = token_for(serde_json::json!({"sub": "u", "token_use": "api_key"}));
        assert!(verify_token(&config(), &api_key).is_none());
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
            let key = EncodingKey::from_secret(b"old-key");
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "legacy-user"}), &key).unwrap()
        };
        assert_eq!(
            verify_token(&config, &legacy).as_deref(),
            Some("legacy-user")
        );
    }
}
