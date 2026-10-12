// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! User authentication for the plugins-installed API.
//!
//! Source: the FastAPI `OAuth2PasswordBearer` dependency in
//! `app/core/security.py` plus `get_current_user`, `app/core/jwt_compat.py`
//! and `app/core/session_token.py`. The scheme rejects a request that carries
//! no bearer credential with `401 {"detail":"Not authenticated"}` before any
//! verification runs. A present `Authorization: Bearer <jwt>` is verified with
//! the active signing key (then configured legacy decode-only keys), must be
//! an interactive user session payload, and must resolve to an active user
//! row; those checks report `401 "Could not validate credentials"` and
//! `401 "User not activated"`.
use std::sync::Arc;

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

/// Source `session_token.py`: sessions have no `scope` claim and a
/// `token_use` of either absent or `wework_access`.
const WEWORK_ACCESS_TOKEN_USE: &str = "wework_access";

/// Source `OAuth2PasswordBearer.make_not_authenticated_error`.
const NOT_AUTHENTICATED_DETAIL: &str = "Not authenticated";
/// Source `security.py` `verify_token` / `get_current_user` failure detail.
const UNAUTHORIZED_DETAIL: &str = "Could not validate credentials";
/// Source `security.py` `get_current_user` inactive-user detail.
const USER_NOT_ACTIVATED_DETAIL: &str = "User not activated";

#[derive(Debug, Deserialize)]
struct Claims {
    sub: Option<String>,
    scope: Option<String>,
    token_use: Option<String>,
}

/// One `users` row needed for authentication (`shared/models/db/user.py`).
///
/// `user_name` and `role` are decoded because the source row model selects
/// them; only `id` and `is_active` drive this endpoint's behavior, but the
/// columns stay in the projection so the row remains source-compatible for
/// sibling endpoints that will reuse this lookup.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    pub id: i64,
    #[allow(dead_code)]
    pub user_name: String,
    pub is_active: bool,
    #[allow(dead_code)]
    pub role: String,
}

pub struct InstalledPluginsUser(pub UserRow);

/// `AuthFailure` carries only a challenge string, so the two distinct
/// `InvalidCredentials` outcomes and the `MissingCredentials` outcome are
/// tagged here and recovered by the authenticator's `reject` implementation.
const NOT_AUTHENTICATED: &str = "Wegent-Plugins-Installed-Not-Authenticated";
const USER_NOT_ACTIVATED: &str = "Wegent-Plugins-Installed-User-Not-Activated";

impl std::ops::Deref for InstalledPluginsUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl brz_http_server::Authenticator<InstalledPluginsUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<InstalledPluginsUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
        authenticate(
            &self.state().mysql,
            &headers.view(),
            &self.state().jwt_secret_keys,
            &self.state().jwt_algorithm,
        )
        .await
        .map(InstalledPluginsUser)
        .map_err(|error| match error {
            AuthError::NotAuthenticated => {
                brz_http_server::AuthFailure::missing_credentials(NOT_AUTHENTICATED)
            }
            AuthError::InvalidCredentials => {
                brz_http_server::AuthFailure::invalid_credentials("Bearer")
            }
            AuthError::UserNotActivated => {
                brz_http_server::AuthFailure::invalid_credentials(USER_NOT_ACTIVATED)
            }
            AuthError::Dependency => brz_http_server::AuthFailure::Internal,
        })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a InstalledPluginsUser,
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
                challenge: NOT_AUTHENTICATED,
            } => crate::http_compat::FastApiError::unauthorized(NOT_AUTHENTICATED_DETAIL),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: USER_NOT_ACTIVATED,
            } => crate::http_compat::FastApiError::unauthorized(USER_NOT_ACTIVATED_DETAIL),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::internal()
            }
            _ => crate::http_compat::FastApiError::unauthorized(UNAUTHORIZED_DETAIL),
        }
        .into_http_error(arena)
    }
}

pub async fn find_user_by_name<M>(mysql: &M, user_name: &str) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT id, user_name, is_active, `role` FROM users WHERE user_name = ? LIMIT 1",
            (user_name,),
        )
        .await
}

/// Verify a bearer token against the active key, then legacy decode keys.
///
/// Mirrors `decode_jose_jwt`, which tries each configured key in order and
/// maps any failure to one 401 response.
pub fn verify_token(token: &str, keys: &[Arc<str>], algorithm: &str) -> Option<String> {
    let algorithm = match algorithm {
        "HS256" => Algorithm::HS256,
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => return None,
    };
    let mut validation = Validation::new(algorithm);
    // Source `verify_token` requires `sub`; no audience is issued or checked.
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    for key in keys {
        let decoding = DecodingKey::from_secret(key.as_bytes());
        if let Ok(claims) = decode::<Claims>(token, &decoding, &validation) {
            let payload = claims.claims;
            if !is_user_session_payload(&payload) {
                return None;
            }
            return payload.sub;
        }
    }
    None
}

fn is_user_session_payload(claims: &Claims) -> bool {
    claims.scope.is_none()
        && matches!(
            claims.token_use.as_deref(),
            None | Some(WEWORK_ACCESS_TOKEN_USE)
        )
}

/// Extract the bearer credential like the source `OAuth2PasswordBearer`
/// dependency, whose `get_authorization_scheme_param` splits the header on the
/// first space and defaults both halves to the empty string.
///
/// `None` means the request supplied no bearer credential at all: no
/// `Authorization` header, an empty header, or a scheme other than `Bearer`.
/// FastAPI rejects that before `get_current_user` runs, so it must stay
/// distinct from a credential that verification rejects. A `Bearer` header with
/// an empty credential still reaches verification and reports the
/// invalid-credential detail.
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<&str> {
    let value = headers.header("authorization")?;
    let (scheme, token) = value.split_once(' ').unwrap_or((value, ""));
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

/// The source authentication chain's distinct failure outcomes.
///
/// The response detail depends on which check failed, so the target keeps them
/// apart instead of collapsing them into one 401.
#[derive(Debug)]
pub enum AuthError {
    /// `401 "Not authenticated"`: no bearer credential was supplied.
    NotAuthenticated,
    /// `401 "Could not validate credentials"`: verification failed, the token
    /// carried no usable `sub`, or no user row matched.
    InvalidCredentials,
    /// `401 "User not activated"`: the resolved row is inactive.
    UserNotActivated,
    /// The user lookup failed; the source maps unexpected failures to its 500
    /// handler outside this endpoint's control.
    Dependency,
}

/// Authenticate the request with the exact failure classification of the
/// source scheme plus `get_current_user`.
pub async fn authenticate<M>(
    mysql: &M,
    headers: &impl crate::headers::Headers,
    keys: &[Arc<str>],
    algorithm: &str,
) -> Result<UserRow, AuthError>
where
    M: Mysql,
{
    let Some(token) = bearer_token(headers) else {
        return Err(AuthError::NotAuthenticated);
    };
    let Some(username) = verify_token(token, keys, algorithm) else {
        return Err(AuthError::InvalidCredentials);
    };
    match find_user_by_name(mysql, &username).await {
        Ok(Some(user)) if user.is_active => Ok(user),
        Ok(Some(_)) => Err(AuthError::UserNotActivated),
        Ok(None) => Err(AuthError::InvalidCredentials),
        Err(error) => {
            tracing::error!(%error, %username, "authentication user lookup failed");
            Err(AuthError::Dependency)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    fn make_token(key: &str, claims: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.as_bytes());
        let mut mac =
            <Hmac<Sha256> as sha2::digest::KeyInit>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(format!("{header}.{payload}").as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{header}.{payload}.{signature}")
    }

    fn headers_with(value: &'static str) -> crate::headers::HeaderSlice<'static> {
        let slice: &'static [(&'static str, &'static str); 1] =
            Box::leak(Box::new([("authorization", value)]));
        crate::headers::HeaderSlice::new(slice)
    }

    fn test_keys() -> Vec<Arc<str>> {
        vec![Arc::from("secret"), Arc::from("legacy")]
    }

    #[test]
    fn bearer_extraction_matches_source() {
        assert_eq!(
            bearer_token(&headers_with("Bearer abc")).map(str::to_string),
            Some("abc".to_string())
        );
        assert_eq!(
            bearer_token(&headers_with("bearer abc")).map(str::to_string),
            Some("abc".to_string())
        );
        // A non-bearer scheme, a bare scheme, and an empty credential all keep
        // the source split: only the scheme selects the authentication branch.
        assert_eq!(bearer_token(&headers_with("abc")), None);
        assert_eq!(bearer_token(&headers_with("Basic abc")), None);
        assert_eq!(
            bearer_token(&headers_with("Bearer ")).map(str::to_string),
            Some(String::new())
        );
        assert_eq!(
            bearer_token(&headers_with("Bearer")).map(str::to_string),
            Some(String::new())
        );
        assert_eq!(bearer_token(&headers_with("")), None);
        assert_eq!(bearer_token(&crate::headers::HeaderSlice::new(&[])), None);
    }

    /// The representative recorded case sends no `Authorization` header. The
    /// source FastAPI dependency rejects it with `401 "Not authenticated"`
    /// before `get_current_user` runs, so the target must not report the
    /// invalid-credential detail for it.
    #[tokio::test]
    async fn missing_bearer_credential_is_not_authenticated() {
        let keys = test_keys();
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let no_header = crate::headers::HeaderSlice::new(&[]);
        for (headers, header) in [
            (no_header, "no header"),
            (headers_with("Basic abc"), "non-bearer scheme"),
            (headers_with(""), "empty header"),
        ] {
            let error = authenticate(&mysql, &headers, &keys, "HS256")
                .await
                .err()
                .unwrap_or_else(|| panic!("{header} must be rejected"));
            assert!(
                matches!(error, AuthError::NotAuthenticated),
                "{header} reports the wrong failure"
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
        let keys = test_keys();
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for value in ["Bearer ", "Bearer"] {
            let error = authenticate(&mysql, &headers_with(value), &keys, "HS256")
                .await
                .err()
                .unwrap_or_else(|| panic!("{value:?} must be rejected"));
            assert!(
                matches!(error, AuthError::InvalidCredentials),
                "{value:?} reports the wrong failure"
            );
        }
    }

    #[test]
    fn verifies_session_token_and_rejects_other_uses() {
        let keys = test_keys();
        let ok = make_token("secret", r#"{"sub":"matao"}"#);
        assert_eq!(verify_token(&ok, &keys, "HS256").as_deref(), Some("matao"));

        let legacy = make_token("legacy", r#"{"sub":"matao"}"#);
        assert_eq!(
            verify_token(&legacy, &keys, "HS256").as_deref(),
            Some("matao")
        );

        let bad_signature = make_token("other", r#"{"sub":"matao"}"#);
        assert_eq!(verify_token(&bad_signature, &keys, "HS256"), None);

        let wework = make_token("secret", r#"{"sub":"matao","token_use":"wework_access"}"#);
        assert_eq!(
            verify_token(&wework, &keys, "HS256").as_deref(),
            Some("matao")
        );

        let refresh = make_token("secret", r#"{"sub":"matao","token_use":"wework_refresh"}"#);
        assert_eq!(verify_token(&refresh, &keys, "HS256"), None);

        let scoped = make_token("secret", r#"{"sub":"matao","scope":"read"}"#);
        assert_eq!(verify_token(&scoped, &keys, "HS256"), None);
    }

    #[test]
    fn rejects_unsupported_algorithm() {
        let keys = test_keys();
        let token = make_token("secret", r#"{"sub":"matao"}"#);
        assert_eq!(verify_token(&token, &keys, "RS256"), None);
    }
}
