// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional JWT session authentication shared by public marketplace APIs.
//!
//! Mirrors `app.core.security.get_current_user_optional` plus
//! `app.core.jwt_compat.decode_jose_jwt` in the source service: a missing or
//! invalid bearer token resolves to no user, while a valid token resolves to
//! the active `users` row referenced by the `sub` claim.
use std::sync::Arc;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

use crate::auth::SessionClaims;
use crate::plugins_marketplace::db::{MysqlCapability, UserRepository, UserRow};

/// Result of optional authentication: the active user row or `None`.
pub type OptionalUser = Option<UserRow>;

pub struct MarketplaceUser(pub UserRow);

impl std::ops::Deref for MarketplaceUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl brz_http_server::Authenticator<MarketplaceUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<MarketplaceUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        current_user_optional(
            &self.state().mysql,
            &self.state().jwt_secret_keys,
            &self.state().jwt_algorithm,
            authorization,
        )
        .await
        .map(MarketplaceUser)
        .ok_or_else(|| brz_http_server::AuthFailure::missing_credentials("Bearer"))
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a MarketplaceUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }
}

fn bearer_token(header: Option<&str>) -> Option<&str> {
    let header = header?;
    let (scheme, token) = header.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") {
        Some(token.trim())
    } else {
        None
    }
}

/// Resolve the optional current user from the request environment.
///
/// Verifies the bearer token with the active signing key, then the configured
/// legacy decode-only keys (`decode_jose_jwt` key rotation), matching the
/// source's optional-auth contract. Any decode or lookup failure resolves to
/// `None`.
pub async fn current_user_optional<M>(
    mysql: &M,
    keys: &[Arc<str>],
    algorithm: &str,
    authorization: Option<&str>,
) -> OptionalUser
where
    M: MysqlCapability,
{
    let token = bearer_token(authorization)?;
    let algorithm = match algorithm {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    };
    let mut validation = Validation::new(algorithm);
    // python-jose validates `exp` only when present and checks no audience
    // for this token shape; no claim is required.
    validation.validate_exp = true;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    for key in keys {
        let decoded = decode::<SessionClaims>(
            token,
            &DecodingKey::from_secret(key.as_bytes()),
            &validation,
        );
        let Ok(data) = decoded else {
            continue;
        };
        let claims = data.claims;
        let sub = claims.username()?;
        let user = UserRepository::find_by_username(mysql, &sub).await;
        return match user {
            Ok(Some(user)) if user.is_active => Some(user),
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_token_extracts_case_insensitive_scheme() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("abc")), None);
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn session_payload_rejects_service_scopes() {
        let user = SessionClaims {
            sub: Some("u".to_owned()),
            scope: None,
            token_use: None,
            exp: None,
        };
        assert!(user.is_user_session_payload());
        let service = SessionClaims {
            sub: Some("u".to_owned()),
            scope: Some(serde::de::IgnoredAny),
            token_use: None,
            exp: None,
        };
        assert!(!service.is_user_session_payload());
        let api = SessionClaims {
            sub: Some("u".to_owned()),
            scope: None,
            token_use: Some("api".to_owned()),
            exp: None,
        };
        assert!(!api.is_user_session_payload());
    }
}
