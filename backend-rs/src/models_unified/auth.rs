// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bearer JWT authentication, ported from `app/core/security.py` and
//! `app/core/jwt_compat.py`.
//!
//! The endpoint is served under the source's FastAPI security dependency:
//! a missing/invalid token yields 401 with `WWW-Authenticate: Bearer`, a
//! missing user yields 401 "Could not validate credentials", and an inactive
//! user yields 401 "User not activated".
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

use super::mysql::UserRow;
use crate::auth::SessionClaims;

pub struct AuthenticatedUser(pub UserRow);

pub enum AuthError {
    MissingCredentials,
    InvalidCredentials,
    UserNotActive,
    Internal(String),
}

impl IntoHttpError for AuthError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let (status, detail, challenge) = match self {
            Self::MissingCredentials | Self::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "Could not validate credentials".to_string(),
                true,
            ),
            Self::UserNotActive => (
                StatusCode::UNAUTHORIZED,
                "User not activated".to_string(),
                true,
            ),
            Self::Internal(detail) => (StatusCode::INTERNAL_SERVER_ERROR, detail, false),
        };
        let mut response =
            crate::http_compat::FastApiError::detail(status, detail).into_http_error(arena);
        if challenge {
            let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
            block.extend_from_slice(b"www-authenticate: Bearer\r\n");
            if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}

/// Verify the bearer token and load the user, mirroring `get_current_user`.
pub async fn authenticate<M: brz_mysql::Mysql>(
    headers: &impl crate::headers::Headers,
    mysql: &M,
    decode_keys: &[String],
    algorithm: jsonwebtoken::Algorithm,
) -> Result<AuthenticatedUser, AuthError> {
    let token = bearer_token(headers).ok_or(AuthError::MissingCredentials)?;
    let claims = decode_session_token(&token, decode_keys, algorithm)
        .ok_or(AuthError::InvalidCredentials)?;
    let username = claims.sub.clone().ok_or(AuthError::InvalidCredentials)?;
    let user = mysql
        .fetch_optional::<_, _, UserRow>(
            "SELECT id, user_name, email, git_info, is_active, role, auth_source, \
             preferences FROM users WHERE user_name = ? LIMIT 1",
            (username.as_str(),),
        )
        .await
        .map_err(|error| AuthError::Internal(format!("database error: {error}")))?;
    let user = user.ok_or(AuthError::InvalidCredentials)?;
    if !user.is_active {
        return Err(AuthError::UserNotActive);
    }
    Ok(AuthenticatedUser(user))
}

/// Extract the bearer credential from the Authorization header, matching
/// `extract_authorization_token` (case-insensitive scheme).
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<String> {
    let value = headers.header("authorization")?;
    let mut parts = value.splitn(2, ' ');
    let scheme = parts.next()?.trim();
    if scheme.eq_ignore_ascii_case("bearer") {
        match parts.next() {
            Some(token) if !token.trim().is_empty() => Some(token.trim().to_string()),
            _ => None,
        }
    } else {
        Some(value.trim().to_string())
    }
}

/// Decode the JWT with the active key then legacy keys, matching
/// `decode_jose_jwt` plus `is_user_session_payload`.
fn decode_session_token(
    token: &str,
    decode_keys: &[String],
    algorithm: jsonwebtoken::Algorithm,
) -> Option<SessionClaims> {
    let mut last_error = None;
    for key in decode_keys {
        match jsonwebtoken::decode::<SessionClaims>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(key.as_bytes()),
            &jsonwebtoken::Validation::new(algorithm),
        ) {
            Ok(token_data) => {
                if token_data.claims.is_user_session_payload() {
                    return Some(token_data.claims);
                }
                return None;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let _ = last_error;
    None
}

#[cfg(test)]
mod tests {
    use super::bearer_token;
    use crate::auth::SessionClaims;
    use crate::headers::{HeaderSlice, OwnedHeaders};

    fn claims(scope: Option<&str>, token_use: Option<&str>) -> SessionClaims {
        SessionClaims {
            sub: Some("haibo16".to_string()),
            scope: scope.map(|_| serde::de::IgnoredAny),
            token_use: token_use.map(ToOwned::to_owned),
            exp: None,
        }
    }

    #[test]
    fn session_payload_matches_source_rules() {
        assert!(claims(None, None).is_user_session_payload());
        assert!(claims(None, Some("wework_access")).is_user_session_payload());
        assert!(!claims(Some("api"), None).is_user_session_payload());
        assert!(!claims(None, Some("wework_refresh")).is_user_session_payload());
    }

    #[test]
    fn bearer_token_extracts_case_insensitive_scheme() {
        fn headers(value: &'static str) -> OwnedHeaders {
            OwnedHeaders::from_pairs([("authorization", Some(value))])
        }
        assert_eq!(
            bearer_token(&headers("Bearer abc").view()).as_deref(),
            Some("abc")
        );
        assert_eq!(
            bearer_token(&headers("bearer abc").view()).as_deref(),
            Some("abc")
        );
        assert_eq!(bearer_token(&headers("abc").view()).as_deref(), Some("abc"));
        assert_eq!(bearer_token(&HeaderSlice::new(&[])).as_deref(), None);
    }
}
