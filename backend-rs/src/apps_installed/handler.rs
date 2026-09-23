// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/apps/installed` handler (source
//! `app/api/endpoints/connector_app_projection.py::installed_apps`).
use std::sync::Arc;

use brz_http_server::StatusCode;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

use super::db::{self, UserRow};
use super::service::{self, ConnectorApp};
use crate::auth::AppAuthenticator;
use crate::state::AppState;

/// Source `get_current_user` failure response.
const UNAUTHORIZED_BODY: &str = "{\"detail\":\"Could not validate credentials\"}";

/// Claims accepted from a Wegent user-session token
/// (`app/core/session_token.py::is_user_session_payload`).
#[derive(Debug, Deserialize)]
struct Claims {
    sub: Option<String>,
    scope: Option<String>,
    token_use: Option<String>,
}

struct InstalledAppsUser(UserRow);

impl brz_http_server::Authenticator<InstalledAppsUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<InstalledAppsUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        resolve_installed_apps_user(self.state(), authorization)
            .await
            .map(InstalledAppsUser)
            .map_err(|(status, _)| {
                if status == StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
            })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a InstalledAppsUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.users_user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        let error = match failure {
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                unauthorized_error((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
            }
            _ => unauthorized_error((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY)),
        };
        error.into_http_error(arena)
    }
}

/// GET /api/apps/installed: the apps-installed free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/apps/installed")]
async fn installed_apps(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: InstalledAppsUser,
) -> Result<super::models::InstalledResponse, crate::http_compat::FastApiError> {
    apps(state, user.0).await
}

/// Handler body for `GET /api/apps/installed`.
async fn apps(
    state: &Arc<AppState>,
    user: UserRow,
) -> Result<super::models::InstalledResponse, crate::http_compat::FastApiError> {
    // `installed_apps` reads the app catalog twice: once inside tool
    // discovery and once for the projection loop, mirroring the two
    // identical `list_visible_apps` queries the source issues.
    let rows = db::list_connector_app_kinds(&state.mysql)
        .await
        .map_err(|error| {
            tracing::error!(%error, "connector app catalog read failed");
            internal_error()
        })?;
    let discovery_rows = db::list_connector_app_kinds(&state.mysql)
        .await
        .map_err(|error| {
            tracing::error!(%error, "connector app catalog read failed");
            internal_error()
        })?;
    let apps: Vec<ConnectorApp> = rows.iter().map(service::row_to_app).collect();
    let _ = discovery_rows;
    service::installed_apps(&state.mysql, &apps, &user)
        .await
        .map_err(|error| {
            tracing::error!(%error, "installed apps projection failed");
            internal_error()
        })
}

/// Maps the authenticate tuple error to the FastAPI-shaped 401/500 body.
fn unauthorized_error(
    (status, body): (StatusCode, &'static str),
) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, body)
}

/// JWT session authentication mirroring `get_current_user`.
async fn resolve_installed_apps_user(
    state: &AppState,
    authorization: Option<&str>,
) -> Result<UserRow, (StatusCode, &'static str)> {
    let Some(token) = bearer_token(authorization) else {
        return Err((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY));
    };
    let Some(username) = verify_token(token, &state.jwt_secret_keys, &state.jwt_algorithm) else {
        return Err((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY));
    };
    match db::find_user_by_name(&state.mysql, &username).await {
        Ok(Some(user)) if user.users_is_active => Ok(user),
        Ok(_) => Err((StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY)),
        Err(error) => {
            tracing::error!(%error, %username, "authentication user lookup failed");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
        }
    }
}

/// Extract the bearer credential like `extract_authorization_token`.
fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    let value = authorization?;
    let (scheme, token) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() {
        Some(token)
    } else {
        None
    }
}

/// Verify a bearer token against the active key, then legacy decode keys,
/// mirroring `decode_jose_jwt` and `verify_token`.
fn verify_token(token: &str, keys: &[Arc<str>], algorithm: &str) -> Option<String> {
    let algorithm = match algorithm {
        "HS256" => Algorithm::HS256,
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => return None,
    };
    let mut validation = Validation::new(algorithm);
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
    claims.scope.is_none() && matches!(claims.token_use.as_deref(), None | Some("wework_access"))
}

fn internal_error() -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "{\"detail\":\"Internal server error\"}",
    )
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

    #[test]
    fn bearer_extraction_matches_source() {
        assert_eq!(
            bearer_token(Some("Bearer abc")).map(str::to_string),
            Some("abc".to_string())
        );
        assert_eq!(
            bearer_token(Some("bearer abc")).map(str::to_string),
            Some("abc".to_string())
        );
        assert_eq!(bearer_token(Some("abc")), None);
        assert_eq!(bearer_token(Some("Bearer ")), None);
        assert_eq!(bearer_token(None), None);
    }

    fn test_keys() -> Vec<Arc<str>> {
        vec![Arc::from("secret"), Arc::from("legacy")]
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
