// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication for model catalogs and inference gateways.

use crate::auth::{AppAuthenticator, AuthFailure, UserRow};
use crate::config::AuthConfig;
use std::{future::Future, pin::Pin};

pub const MODEL_INFERENCE_SCOPE: &str = "model:inference";

/// Resolve a currently valid personal API key to its active owner.
pub trait PersonalModelKeyReader: Send + Sync {
    fn owner_id<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<i32, AuthFailure>> + Send + 'a>>;
}

#[derive(Debug, PartialEq)]
pub enum RuntimeModelIdentity {
    Session(String),
    PersonalKey(i32),
}

/// Model requests accept user sessions and personal device API keys.
pub struct RuntimeModelUser(pub UserRow);

impl brz_http_server::Authenticator<RuntimeModelUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<RuntimeModelUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        let token = crate::auth::bearer_credential(authorization)
            .ok_or(AuthFailure::NotAuthenticated)
            .map_err(crate::auth::session_auth_failure)?;
        let identity = verify_runtime_model_token(
            &self.state().auth,
            self.state().runtime_model_keys.as_ref(),
            token,
        )
        .await
        .map_err(crate::auth::session_auth_failure)?;
        let user = match identity {
            RuntimeModelIdentity::Session(name) => {
                crate::auth::active_user_by_name(&self.state().mysql, &name).await
            }
            RuntimeModelIdentity::PersonalKey(id) => {
                let user = self
                    .state()
                    .mysql
                    .fetch_optional(crate::user_reader::USER_BY_ID_QUERY, (id,))
                    .await
                    .map_err(|_| AuthFailure::Dependency);
                user.and_then(crate::auth::select_active_user)
            }
        };
        user.map(RuntimeModelUser)
            .map_err(crate::auth::session_auth_failure)
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a RuntimeModelUser,
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
        crate::auth::session_rejection(failure).into_http_error(arena)
    }
}

/// Resolve model identity from a verified session or personal API key.
pub async fn verify_runtime_model_token(
    config: &AuthConfig,
    keys: &dyn PersonalModelKeyReader,
    token: &str,
) -> Result<RuntimeModelIdentity, AuthFailure> {
    if token.starts_with("wg-") {
        keys.owner_id(token)
            .await
            .map(RuntimeModelIdentity::PersonalKey)
    } else {
        let claims = crate::auth::decode_session_claims(config, token)
            .ok_or(AuthFailure::InvalidCredentials)?;
        let subject = if claims.scope.as_ref().and_then(serde_json::Value::as_str)
            == Some(MODEL_INFERENCE_SCOPE)
            && claims.token_use.is_none()
        {
            claims.sub.filter(|name| !name.is_empty())
        } else {
            claims.username()
        };
        subject
            .map(RuntimeModelIdentity::Session)
            .ok_or(AuthFailure::InvalidCredentials)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Keys;

    impl PersonalModelKeyReader for Keys {
        fn owner_id<'a>(
            &'a self,
            token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<i32, AuthFailure>> + Send + 'a>> {
            Box::pin(async move {
                if token == "wg-valid-device-key" {
                    Ok(7)
                } else {
                    Err(AuthFailure::InvalidCredentials)
                }
            })
        }
    }

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "model-auth-test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    #[tokio::test]
    async fn model_requests_resolve_personal_keys_and_reject_invalid_credentials() {
        assert_eq!(
            verify_runtime_model_token(&config(), &Keys, "wg-valid-device-key")
                .await
                .unwrap(),
            RuntimeModelIdentity::PersonalKey(7)
        );
        for token in [
            "wg-revoked-device-key",
            "wg-valid-device-key#another-user",
            "not-a-jwt",
        ] {
            assert!(matches!(
                verify_runtime_model_token(&config(), &Keys, token).await,
                Err(AuthFailure::InvalidCredentials)
            ));
        }
        assert!(crate::auth::verify_token(&config(), "wg-valid-device-key").is_err());
    }

    #[tokio::test]
    async fn model_requests_preserve_session_claim_boundaries() {
        let config = config();
        for (claims, accepted) in [
            (serde_json::json!({"sub":"session-owner"}), true),
            (
                serde_json::json!({"sub":"session-owner","scope":MODEL_INFERENCE_SCOPE}),
                true,
            ),
            (
                serde_json::json!({"sub":"session-owner","token_use":"wework_access"}),
                true,
            ),
            (
                serde_json::json!({"sub":"session-owner","scope":"read"}),
                false,
            ),
            (
                serde_json::json!({"sub":"session-owner","token_use":"wework_refresh"}),
                false,
            ),
        ] {
            let token = crate::wework_auth_tokens::create_token(
                &config.jwt_key,
                &config.algorithm,
                claims.clone(),
            )
            .unwrap();
            let result = verify_runtime_model_token(&config, &Keys, &token).await;
            if claims["scope"] == MODEL_INFERENCE_SCOPE {
                assert!(crate::auth::verify_token(&config, &token).is_err());
            }
            assert_eq!(result.is_ok(), accepted);
        }
    }
}
