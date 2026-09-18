// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication: `get_current_user` from source `app/core/security.py`.
//!
//! Verifies the bearer JWT (active key then legacy decode-only keys),
//! enforces the interactive user-session claim shape, and loads the user
//! with the direct MySQL `users` query. Source `get_current_user` uses
//! `db.query(User).filter(User.user_name == username)`; the public reader
//! follows that direct lookup.
use brz_mysql::FromMysqlRow;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

use super::error::ApiError;
use crate::auth::SessionClaims;

/// The authenticated user context of one request.
pub(crate) struct AuthContext {
    pub(crate) user_id: i64,
    #[allow(dead_code)]
    pub(crate) user_name: String,
    #[allow(dead_code)]
    pub(crate) is_active: bool,
}

#[derive(Debug, FromMysqlRow)]
struct UserRow {
    #[mysql(rename = "users_id")]
    id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    password_hash: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_email")]
    email: String,
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

/// JWT claims: only `sub` is consumed; `exp` is validated by the decoder.
/// Extract the bearer token from the Authorization header, matching
/// FastAPI's `OAuth2PasswordBearer` (RFC 6750): the scheme must be
/// `bearer` (case-insensitive) and the credential non-empty, otherwise the
/// request is not authenticated.
fn extract_token(headers: &impl crate::headers::Headers) -> Option<String> {
    let value = headers.header("authorization")?;
    let (scheme, token) = match value.split_once(' ') {
        Some((scheme, token)) => (scheme, token.trim()),
        None => (value, ""),
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    if token.is_empty() {
        return None;
    }
    Some(token.to_owned())
}

fn unauthorized() -> ApiError {
    ApiError::unauthorized("Could not validate credentials")
}

/// Authenticate the request: verify the JWT and load the user.
pub(crate) async fn authenticate<M>(
    mysql: &M,
    jwt_decode_keys: &[String],
    jwt_algorithm: &str,
    headers: &impl crate::headers::Headers,
) -> Result<AuthContext, ApiError>
where
    M: brz_mysql::Mysql,
{
    authenticate_with_query_fallback(mysql, jwt_decode_keys, jwt_algorithm, headers, None).await
}

/// `get_current_user_from_query_or_header`: the Authorization bearer token
/// first, then the `?token=` query parameter as the fallback credential.
pub(crate) async fn authenticate_with_query_fallback<M>(
    mysql: &M,
    jwt_decode_keys: &[String],
    jwt_algorithm: &str,
    headers: &impl crate::headers::Headers,
    token_query: Option<&str>,
) -> Result<AuthContext, ApiError>
where
    M: brz_mysql::Mysql,
{
    let token = match extract_token(headers) {
        Some(token) => token,
        None => match token_query {
            Some(token) if !token.is_empty() => token.to_owned(),
            _ => return Err(unauthorized()),
        },
    };
    let claims =
        decode_session_token(&token, jwt_decode_keys, jwt_algorithm).ok_or_else(unauthorized)?;
    let Some(user_name) = claims.username() else {
        return Err(unauthorized());
    };

    let user = load_user(mysql, &user_name).await?;
    let Some(user) = user else {
        return Err(unauthorized());
    };
    if user.is_active == 0 {
        return Err(ApiError::unauthorized("User not activated"));
    }
    Ok(AuthContext {
        user_id: user.id,
        user_name: user.user_name,
        is_active: user.is_active != 0,
    })
}

/// Load the user by name with the direct MySQL query, mirroring source
/// `get_current_user` (`db.query(User).filter(User.user_name == username)`).
/// The projection is the full labeled column list SQLAlchemy renders, so the
/// prepared statement matches the recorded exchange for replay.
async fn load_user<M>(mysql: &M, user_name: &str) -> Result<Option<UserRow>, ApiError>
where
    M: brz_mysql::Mysql,
{
    mysql
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
            (user_name,),
        )
        .await
        .map_err(|error| {
            tracing::warn!(%error, user = %user_name, "[auth] user query failed");
            ApiError::internal("user query failed")
        })
}

/// Verify the JWT and return its claims, trying each configured key
/// (`decode_jose_jwt`: active key first, then legacy decode-only keys).
fn decode_session_token(token: &str, keys: &[String], algorithm: &str) -> Option<SessionClaims> {
    if !algorithm.eq_ignore_ascii_case("HS256") {
        return None;
    }
    let mut last_error = None;
    for key in keys {
        let mut validation = Validation::new(Algorithm::HS256);
        // python-jose's default decode validates only the signature and `exp`
        // when present; it does not require `exp` to exist.
        validation.required_spec_claims.clear();
        validation.validate_aud = false;
        match decode::<SessionClaims>(
            token,
            &DecodingKey::from_secret(key.as_bytes()),
            &validation,
        ) {
            Ok(data) => return Some(data.claims),
            Err(error) => last_error = Some(error),
        }
    }
    let _ = last_error;
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use jsonwebtoken::{EncodingKey, Header, encode};

    fn make_token(key: &str, claims: &str) -> String {
        encode(
            &Header::default(),
            &serde_json::from_str::<serde_json::Value>(claims).unwrap(),
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .unwrap()
    }

    #[test]
    fn verifies_with_active_key() {
        let token = make_token("secret", r#"{"sub":"alice","exp":9999999999}"#);
        let claims =
            decode_session_token(&token, &["secret".to_owned()], "HS256").expect("valid token");
        assert_eq!(claims.sub.as_deref(), Some("alice"));
    }

    #[test]
    fn rejects_wrong_key() {
        let token = make_token("secret", r#"{"sub":"alice","exp":9999999999}"#);
        assert!(decode_session_token(&token, &["other".to_owned()], "HS256").is_none());
    }

    #[test]
    fn tries_legacy_keys_after_active() {
        let token = make_token("legacy", r#"{"sub":"a","exp":9999999999}"#);
        let keys = vec!["active".to_owned(), "legacy".to_owned()];
        assert!(decode_session_token(&token, &keys, "HS256").is_some());
    }

    #[test]
    fn missing_exp_still_decodes_like_jose() {
        let token = make_token("k", r#"{"sub":"a"}"#);
        assert!(decode_session_token(&token, &["k".to_owned()], "HS256").is_some());
    }

    #[test]
    fn expired_token_rejected() {
        let token = make_token("k", r#"{"sub":"a","exp":100}"#);
        assert!(decode_session_token(&token, &["k".to_owned()], "HS256").is_none());
    }

    #[test]
    fn extracts_bearer_token() {
        let bearer = crate::headers::HeaderSlice::new(&[("authorization", "Bearer abc")]);
        assert_eq!(extract_token(&bearer).as_deref(), Some("abc"));
        let plain = crate::headers::HeaderSlice::new(&[("authorization", "abc")]);
        assert_eq!(extract_token(&plain), None);
        let empty = crate::headers::HeaderSlice::new(&[("authorization", "Bearer ")]);
        assert_eq!(extract_token(&empty), None);
    }

    #[test]
    fn base64_url_helper_unaffected() {
        assert_eq!(URL_SAFE_NO_PAD.decode("aGk").unwrap(), b"hi");
    }
}
