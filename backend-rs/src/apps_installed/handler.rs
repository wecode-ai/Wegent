// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/apps/installed` handler (source
//! `app/api/endpoints/connector_app_projection.py::installed_apps`).
use std::sync::Arc;

use crate::auth::SessionClaims;
use brz_http_server::StatusCode;
use jsonwebtoken::Algorithm;

use super::db::{self, UserRow};
use super::service::{self, ConnectorApp};
use crate::auth::AppAuthenticator;
use crate::state::AppState;

/// Source `get_current_user` failure response.
const INVALID_CREDENTIALS: &str = "Could not validate credentials";
const APPS_MISSING: &str = "Wegent-Apps-Not-Authenticated";
const APPS_INACTIVE: &str = "Wegent-Apps-User-Inactive";

pub(crate) struct InstalledAppsUser(UserRow);

impl InstalledAppsUser {
    pub(crate) fn into_row(self) -> UserRow {
        self.0
    }
}

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
            .map_err(|(status, detail)| {
                if status == StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else if detail == "Not authenticated" {
                    brz_http_server::AuthFailure::missing_credentials(APPS_MISSING)
                } else if detail == "User not activated" {
                    brz_http_server::AuthFailure::invalid_credentials(APPS_INACTIVE)
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
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: APPS_MISSING,
            } => crate::http_compat::FastApiError::unauthorized("Not authenticated"),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: APPS_INACTIVE,
            } => crate::http_compat::FastApiError::unauthorized("User not activated"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                unauthorized_error((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
            }
            _ => unauthorized_error((StatusCode::UNAUTHORIZED, INVALID_CREDENTIALS)),
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
    if status == StatusCode::UNAUTHORIZED {
        crate::http_compat::FastApiError::unauthorized(body)
    } else {
        crate::http_compat::FastApiError::unhandled()
    }
}

/// JWT session authentication mirroring `get_current_user`.
async fn resolve_installed_apps_user(
    state: &AppState,
    authorization: Option<&str>,
) -> Result<UserRow, (StatusCode, &'static str)> {
    let Some(token) = bearer_token(authorization) else {
        return Err((StatusCode::UNAUTHORIZED, "Not authenticated"));
    };
    let Some(username) = verify_token(token, &state.jwt_secret_keys, &state.jwt_algorithm) else {
        return Err((StatusCode::UNAUTHORIZED, INVALID_CREDENTIALS));
    };
    match db::find_user_by_name(&state.mysql, &username).await {
        Ok(Some(user)) if user.users_is_active => Ok(user),
        Ok(Some(_)) => Err((StatusCode::UNAUTHORIZED, "User not activated")),
        Ok(None) => Err((StatusCode::UNAUTHORIZED, INVALID_CREDENTIALS)),
        Err(error) => {
            tracing::error!(%error, %username, "authentication user lookup failed");
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
        }
    }
}

/// Extract the bearer credential like `extract_authorization_token`.
fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    crate::auth::bearer_credential(authorization)
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
    crate::jwt_compat::decode_jose::<SessionClaims>(
        token,
        keys.iter().map(|key| key.as_bytes()),
        algorithm,
    )?
    .username()
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
        assert_eq!(bearer_token(Some("Bearer ")), Some(""));
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

#[cfg(test)]
mod python_compatibility {
    #[test]
    fn session_entry_point_matches_python() {
        for (name, claims, expected) in crate::jwt_compat::tests::session_cases() {
            let token = crate::jwt_compat::tests::sign(&claims, b"test-key");
            assert_eq!(
                super::verify_token(&token, &[std::sync::Arc::from("test-key")], "HS256").is_some(),
                expected,
                "{name}"
            );
        }
    }
}

#[cfg(test)]
mod error_compatibility {
    #[test]
    fn authentication_errors_have_python_json_bodies() {
        use brz_http_server::IntoHttpError as _;
        let arena = brz_http_server::EphemeralBytesArena::new(256);
        for detail in [
            "Not authenticated",
            "Could not validate credentials",
            "User not activated",
        ] {
            let response =
                super::unauthorized_error((brz_http_server::StatusCode::UNAUTHORIZED, detail))
                    .into_http_error(&arena);
            assert_eq!(response.status(), brz_http_server::StatusCode::UNAUTHORIZED);
            let brz_http_server::ResponseBody::Arena(body) = response.body() else {
                panic!("expected JSON error");
            };
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(body.as_ref()).unwrap(),
                serde_json::json!({"detail":detail})
            );
        }
    }
}
