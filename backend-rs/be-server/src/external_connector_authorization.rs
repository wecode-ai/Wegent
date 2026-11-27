// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use brz_http_server::{HttpResponse, StatusCode};
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::Serialize;
use sha2::Sha256;

use crate::http_compat::FastApiError;
use crate::state::AppState;
use wegent_connector_apps::external_authorization::{AuthorizationStatus, lookup};
use wegent_responses_api::auth::ResponsesUser;

const LINK_TTL_SECONDS: i64 = 600;
const LINK_KEY_CONTEXT: &[u8] = b"wegent:external-connector-authorization:v1";
const LINK_AUDIENCE: &str = "wegent-external-connector-authorization";

#[derive(Debug, Serialize)]
struct AuthorizationResponse {
    slug: String,
    status: AuthorizationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorize_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
}

#[derive(Serialize)]
struct LinkClaims<'a> {
    aud: &'static str,
    exp: i64,
    user_id: i64,
    app_id: i64,
    slug: &'a str,
}

#[brz_http_server::get("/api/external/connector-apps/:slug/authorization")]
async fn precheck(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] principal: ResponsesUser,
    slug: String,
) -> Result<HttpResponse<AuthorizationResponse>, FastApiError> {
    authorization_response(state, principal, slug, false).await
}

#[brz_http_server::post("/api/external/connector-apps/:slug/oauth/start")]
async fn start(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] principal: ResponsesUser,
    slug: String,
) -> Result<HttpResponse<AuthorizationResponse>, FastApiError> {
    authorization_response(state, principal, slug, true).await
}

async fn authorization_response(
    state: &AppState,
    principal: ResponsesUser,
    slug: String,
    start: bool,
) -> Result<HttpResponse<AuthorizationResponse>, FastApiError> {
    if principal.api_key_id.is_none() {
        return Err(FastApiError::unauthorized("API key is required"));
    }
    let user_id = i64::from(principal.user.id);
    let (app_id, status) = lookup(&state.mysql, user_id, &slug).await?;
    let mut response = AuthorizationResponse {
        slug,
        status,
        authorize_url: None,
        expires_at: None,
    };
    if start && matches!(status, AuthorizationStatus::AuthorizationRequired) {
        let expires_at = chrono::Utc::now().timestamp() + LINK_TTL_SECONDS;
        response.authorize_url = Some(authorization_link(
            &state.oidc_config.frontend_url,
            state.auth.jwt_key.as_bytes(),
            LinkClaims {
                aud: LINK_AUDIENCE,
                exp: expires_at,
                user_id,
                app_id,
                slug: &response.slug,
            },
        )?);
        response.expires_at = Some(expires_at);
    }
    HttpResponse::new(response)
        .header("cache-control", "no-store")
        .map_err(|_| FastApiError::unhandled())
}

fn authorization_link(
    frontend_url: &str,
    secret: &[u8],
    claims: LinkClaims<'_>,
) -> Result<String, FastApiError> {
    let mut url = url::Url::parse(frontend_url.trim()).map_err(|_| invalid_frontend_url())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_frontend_url());
    }
    let path = format!(
        "{}/auth/connector/authorize",
        url.path().trim_end_matches('/')
    );
    // Separate this key from the keys accepted for user and task authentication.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| FastApiError::unhandled())?;
    mac.update(LINK_KEY_CONTEXT);
    let key = EncodingKey::from_secret(&mac.finalize().into_bytes());
    let ticket = encode(&Header::new(Algorithm::HS256), &claims, &key)
        .map_err(|_| FastApiError::unhandled())?;
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("slug", claims.slug)
        .append_pair("ticket", &ticket)
        .finish();
    url.set_path(&path);
    url.set_fragment(Some(&fragment));
    Ok(url.into())
}

fn invalid_frontend_url() -> FastApiError {
    tracing::error!("FRONTEND_URL is invalid for external connector authorization");
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Wegent authorization page unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_uses_the_frontend_base_path_and_keeps_the_ticket_out_of_the_query() {
        let link = authorization_link(
            "https://wegent.example/portal/",
            b"test-session-key",
            LinkClaims {
                aud: LINK_AUDIENCE,
                exp: 1_900_000_000,
                user_id: 7,
                app_id: 8,
                slug: "custom-connector",
            },
        )
        .unwrap();
        let link = url::Url::parse(&link).unwrap();
        assert_eq!(link.path(), "/portal/auth/connector/authorize");
        assert!(link.query().is_none());
        let pairs: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(link.fragment().unwrap().as_bytes()).collect();
        assert_eq!(pairs["slug"], "custom-connector");
        let token = &pairs["ticket"];
        let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
        validation.set_audience(&[LINK_AUDIENCE]);
        validation.validate_exp = false;
        assert!(
            jsonwebtoken::decode::<serde_json::Value>(
                token,
                &jsonwebtoken::DecodingKey::from_secret(b"test-session-key"),
                &validation,
            )
            .is_err()
        );
        // Expected key derived by the existing Python OAuth-session endpoint.
        let key = [
            99, 12, 16, 33, 67, 187, 249, 100, 150, 38, 207, 120, 119, 237, 177, 27, 107, 186, 83,
            117, 206, 80, 97, 105, 65, 184, 165, 106, 60, 184, 165, 149,
        ];
        let claims = jsonwebtoken::decode::<serde_json::Value>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(&key),
            &validation,
        )
        .unwrap()
        .claims;
        assert_eq!(claims["user_id"], 7);
        assert_eq!(claims["app_id"], 8);
        assert_eq!(claims["slug"], "custom-connector");
        assert_eq!(claims["exp"], 1_900_000_000);
    }
}
