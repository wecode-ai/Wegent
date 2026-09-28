// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! User authentication for the plugins-installed API.
//!
//! Source: `app/core/security.py` `get_current_user` plus
//! `app/core/jwt_compat.py` and `app/core/session_token.py`. A request must
//! carry `Authorization: Bearer <jwt>`; the token is verified with the active
//! signing key (then configured legacy decode-only keys), must be an
//! interactive user session payload, and must resolve to an active user row.
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

/// Source `session_token.py`: sessions have no `scope` claim and a
/// `token_use` of either absent or `wework_access`.
const WEWORK_ACCESS_TOKEN_USE: &str = "wework_access";

/// Source `security.py` `get_current_user` failure response.
pub const UNAUTHORIZED_BODY: &str = "{\"detail\":\"Could not validate credentials\"}";

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
        .map_err(|(status, _)| {
            if status == brz_http_server::StatusCode::INTERNAL_SERVER_ERROR {
                brz_http_server::AuthFailure::Internal
            } else {
                brz_http_server::AuthFailure::invalid_credentials("Bearer")
            }
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
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::internal()
            }
            _ => crate::http_compat::FastApiError::unauthorized("Could not validate credentials"),
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

/// Extract the bearer credential like `extract_authorization_token`.
fn bearer_token(headers: &impl crate::headers::Headers) -> Option<&str> {
    let value = headers.header("authorization")?;
    let (scheme, token) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() {
        Some(token)
    } else {
        None
    }
}

/// Authenticate the request. Returns `Err((status, body))` on failure.
pub async fn authenticate<M>(
    mysql: &M,
    headers: &impl crate::headers::Headers,
    keys: &[Arc<str>],
    algorithm: &str,
) -> Result<UserRow, (StatusCode, &'static str)>
where
    M: Mysql,
{
    let Some(token) = bearer_token(headers) else {
        return Err((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY));
    };
    let Some(username) = verify_token(token, keys, algorithm) else {
        return Err((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY));
    };
    match find_user_by_name(mysql, &username).await {
        Ok(Some(user)) if user.is_active => Ok(user),
        Ok(_) => Err((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY)),
        // Preserve the dependency error category; the source maps unexpected
        // failures to a 500 handler outside this endpoint's control.
        Err(error) => {
            tracing::error!(%error, %username, "authentication user lookup failed");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
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
        assert_eq!(bearer_token(&headers_with("abc")), None);
        assert_eq!(bearer_token(&headers_with("Bearer ")), None);
        assert_eq!(bearer_token(&crate::headers::HeaderSlice::new(&[])), None);
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
