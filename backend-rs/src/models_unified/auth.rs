// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bearer JWT authentication, ported from `app/core/security.py` and
//! `app/core/jwt_compat.py`.
//!
//! The endpoint is served under the source's FastAPI security dependency:
//! a request without a bearer credential yields 401 "Not authenticated", a
//! rejected token or missing user yields 401 "Could not validate credentials",
//! and an inactive user yields 401 "User not activated"; all three carry
//! `WWW-Authenticate: Bearer`.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

use super::mysql::UserRow;
use crate::auth::SessionClaims;

pub struct AuthenticatedUser(pub UserRow);

/// Challenge tags that recover a specific authentication failure in `reject`.
const MODELS_USER_INACTIVE: &str = "Wegent-Models-User-Inactive";

/// Source 401 details, one per distinct authentication failure.
const NOT_AUTHENTICATED_DETAIL: &str = "Not authenticated";
const INVALID_CREDENTIALS_DETAIL: &str = "Could not validate credentials";
const USER_NOT_ACTIVATED_DETAIL: &str = "User not activated";

impl brz_http_server::Authenticator<AuthenticatedUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<AuthenticatedUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
        let mut keys = vec![self.state().auth.jwt_key.clone()];
        keys.extend(self.state().auth.legacy_jwt_keys.iter().cloned());
        let algorithm = match self.state().auth.algorithm.as_str() {
            "HS384" => jsonwebtoken::Algorithm::HS384,
            "HS512" => jsonwebtoken::Algorithm::HS512,
            _ => jsonwebtoken::Algorithm::HS256,
        };
        authenticate(&headers.view(), &self.state().mysql, &keys, algorithm)
            .await
            .map_err(|error| match error {
                AuthError::MissingCredentials => {
                    brz_http_server::AuthFailure::missing_credentials("Bearer")
                }
                AuthError::InvalidCredentials => {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
                AuthError::UserNotActive => {
                    brz_http_server::AuthFailure::invalid_credentials(MODELS_USER_INACTIVE)
                }
                AuthError::Internal(_) => brz_http_server::AuthFailure::Internal,
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
            brz_http_server::AuthFailure::MissingCredentials { .. } => {
                crate::http_compat::FastApiError::unauthorized(NOT_AUTHENTICATED_DETAIL)
            }
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: MODELS_USER_INACTIVE,
            } => crate::http_compat::FastApiError::unauthorized(USER_NOT_ACTIVATED_DETAIL),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::internal()
            }
            _ => crate::http_compat::FastApiError::unauthorized(INVALID_CREDENTIALS_DETAIL),
        }
        .into_http_error(arena)
    }
}

/// The source authentication chain's distinct failure outcomes.
///
/// The response detail depends on which check failed, so the target keeps them
/// apart instead of collapsing them into one 401.
#[derive(Debug)]
pub enum AuthError {
    MissingCredentials,
    InvalidCredentials,
    UserNotActive,
    Internal(String),
}

impl IntoHttpError for AuthError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let (status, detail, challenge) = match self {
            Self::MissingCredentials => (
                StatusCode::UNAUTHORIZED,
                NOT_AUTHENTICATED_DETAIL.to_string(),
                true,
            ),
            Self::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                INVALID_CREDENTIALS_DETAIL.to_string(),
                true,
            ),
            Self::UserNotActive => (
                StatusCode::UNAUTHORIZED,
                USER_NOT_ACTIVATED_DETAIL.to_string(),
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
    let token = bearer_token(headers)?;
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

/// Extract the bearer credential like the source `OAuth2PasswordBearer`
/// dependency, whose `get_authorization_scheme_param` splits the header on the
/// first space and defaults both halves to the empty string.
///
/// `MissingCredentials` means the request supplied no bearer credential at all:
/// no `Authorization` header, an empty header, or a scheme other than `Bearer`.
/// FastAPI rejects that before `get_current_user` runs, so it stays distinct
/// from a credential that verification rejects. A `Bearer` header with an empty
/// credential still reaches verification and reports the invalid-credential
/// detail.
fn bearer_token(headers: &impl crate::headers::Headers) -> Result<String, AuthError> {
    let Some(value) = headers.header("authorization") else {
        return Err(AuthError::MissingCredentials);
    };
    let (scheme, token) = value.split_once(' ').unwrap_or((value, ""));
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(AuthError::MissingCredentials);
    }
    Ok(token.to_string())
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
    use super::{AuthError, authenticate, bearer_token};
    use crate::auth::SessionClaims;
    use crate::headers::{HeaderSlice, OwnedHeaders};
    use brz_http_server::{EphemeralBytesArena, IntoHttpError, ResponseBody, StatusCode};

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
    fn bearer_token_matches_the_source_scheme_split() {
        fn headers(value: &'static str) -> OwnedHeaders {
            OwnedHeaders::from_pairs([("authorization", Some(value))])
        }
        assert_eq!(bearer_token(&headers("Bearer abc").view()).unwrap(), "abc");
        assert_eq!(bearer_token(&headers("bearer abc").view()).unwrap(), "abc");
        // A `Bearer` header with an empty credential still reaches verification.
        assert_eq!(bearer_token(&headers("Bearer ").view()).unwrap(), "");
        assert_eq!(bearer_token(&headers("Bearer").view()).unwrap(), "");
        // The source scheme rejects anything that is not a bearer credential
        // before the token is ever decoded.
        for value in ["abc", "Basic abc", ""] {
            assert!(
                matches!(
                    bearer_token(&headers(value).view()),
                    Err(AuthError::MissingCredentials)
                ),
                "{value:?} must report missing credentials"
            );
        }
        assert!(matches!(
            bearer_token(&HeaderSlice::new(&[])),
            Err(AuthError::MissingCredentials)
        ));
    }

    fn keys() -> Vec<String> {
        vec!["test-key".to_string()]
    }

    /// The representative recorded case sends no `Authorization` header. The
    /// source FastAPI dependency rejects it with `401 "Not authenticated"`
    /// before `get_current_user` runs, so the target must not report the
    /// invalid-credential detail for it.
    #[tokio::test]
    async fn missing_bearer_credential_is_not_authenticated() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for (label, value) in [
            ("no header", None),
            ("non-bearer scheme", Some("Basic abc")),
            ("empty header", Some("")),
        ] {
            let headers = OwnedHeaders::from_pairs([("authorization", value)]);
            let error = authenticate(
                &headers.view(),
                &mysql,
                &keys(),
                jsonwebtoken::Algorithm::HS256,
            )
            .await
            .err()
            .unwrap_or_else(|| panic!("{label} must be rejected"));
            assert!(
                matches!(error, AuthError::MissingCredentials),
                "{label} reports the wrong failure"
            );
        }
        assert!(
            mysql.queries().is_empty(),
            "the scheme rejects before the user lookup"
        );
    }

    /// A `Bearer` header with an empty credential reaches verification, which
    /// the source reports as `401 "Could not validate credentials"`.
    #[tokio::test]
    async fn empty_bearer_credential_is_invalid_credentials() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for value in ["Bearer ", "Bearer"] {
            let headers = OwnedHeaders::from_pairs([("authorization", Some(value))]);
            let error = authenticate(
                &headers.view(),
                &mysql,
                &keys(),
                jsonwebtoken::Algorithm::HS256,
            )
            .await
            .err()
            .unwrap_or_else(|| panic!("{value:?} must be rejected"));
            assert!(
                matches!(error, AuthError::InvalidCredentials),
                "{value:?} reports the wrong failure"
            );
        }
        assert!(
            mysql.queries().is_empty(),
            "an empty credential fails verification before the user lookup"
        );
    }

    /// `AuthError` renders the source 401 details; only the missing-credential
    /// branch reports "Not authenticated".
    #[test]
    fn auth_errors_render_the_source_details() {
        for (error, detail) in [
            (AuthError::MissingCredentials, "Not authenticated"),
            (
                AuthError::InvalidCredentials,
                "Could not validate credentials",
            ),
            (AuthError::UserNotActive, "User not activated"),
        ] {
            let response = error.into_http_error(&EphemeralBytesArena::new(256));
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let ResponseBody::Arena(body) = response.body() else {
                panic!("the source renders a JSON body");
            };
            assert_eq!(
                std::str::from_utf8(body.as_ref()).unwrap(),
                format!("{{\"detail\":\"{detail}\"}}")
            );
        }
    }
}
