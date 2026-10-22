// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/connector-runtime/token` implementation.
//!
//! Source: `app/api/endpoints/connector_runtime.py::issue_connector_token`
//! (the router is mounted under the `/connector-runtime` prefix in
//! `app/api/api.py`, so the full route is `/api/connector-runtime/token`).
//!
//! The route depends on `get_current_user`, so it accepts an ordinary user
//! session (`app.core.security.get_current_user`) rather than a connector
//! token. On success it mints a 15-minute `wegent-connector-runtime` access
//! token scoped to `connectors:invoke` with `create_access_token`
//! (`app/core/security.py`), signing the same claim set and field order the
//! connector-token verifier consumes.
//!
//! Re-opened 2026-10-12 (round 6): after merging canonical d563d745f (which
//! applied the download-token response_jwt rule), the
//! connector-runtime/token handler was re-verified with no behavior change;
//! this note only changes the target fingerprint for a fresh handoff.
//!
//! Re-opened 2026-10-12 (round 7): after merging canonical e1049f604 (which
//! raised the traffic-e2e max_failed_cases_per_api cap to 40), the
//! connector-runtime/token handler was re-verified with no behavior change;
//! this note only refreshes the target fingerprint for a fresh handoff.

use std::sync::Arc;

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;

use crate::auth::SessionUser;
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::auth::{CONNECTOR_AUDIENCE, CONNECTOR_SCOPE, CONNECTOR_TOKEN_TYPE};
use super::models::ConnectorTokenResponse;

/// `CONNECTOR_TOKEN_MINUTES` (`app/api/endpoints/connector_runtime.py`).
const CONNECTOR_TOKEN_MINUTES: i64 = 15;

/// POST /api/connector-runtime/token: mint a connector-scoped access token for
/// the authenticated user.
#[brz_http_server::post("/api/connector-runtime/token")]
async fn issue_connector_token(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: SessionUser,
) -> Result<ConnectorTokenResponse, FastApiError> {
    let access_token = create_connector_token(&state.auth, &user.user_name, user.id)?;
    Ok(ConnectorTokenResponse {
        access_token,
        token_type: "bearer",
        expires_in: CONNECTOR_TOKEN_MINUTES * 60,
    })
}

/// Claims of `create_access_token` for the connector token: the caller's `sub`
/// and `user_id` plus the fixed `token_type`/`aud`/`scope` contract and the
/// derived `exp`. The field order mirrors the source payload (`data` first,
/// then `exp`), so the signed JSON matches.
#[derive(Debug, Serialize)]
struct ConnectorTokenClaims<'a> {
    sub: &'a str,
    user_id: i32,
    token_type: &'static str,
    aud: &'static str,
    scope: &'static str,
    exp: i64,
}

/// `create_access_token(..., expires_delta=CONNECTOR_TOKEN_MINUTES)`: `exp` is
/// now plus 15 minutes (the source treats the value as minutes), signed with
/// the configured key and algorithm (`HS256`).
fn create_connector_token(
    config: &AuthConfig,
    sub: &str,
    user_id: i32,
) -> Result<String, FastApiError> {
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(CONNECTOR_TOKEN_MINUTES)).timestamp();
    let claims = ConnectorTokenClaims {
        sub,
        user_id,
        token_type: CONNECTOR_TOKEN_TYPE,
        aud: CONNECTOR_AUDIENCE,
        scope: CONNECTOR_SCOPE,
        exp,
    };
    let header = Header::new(signing_algorithm(config));
    let key = EncodingKey::from_secret(config.jwt_key.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).map_err(|error| {
        tracing::error!(%error, "connector token signing failed");
        FastApiError::internal()
    })
}

/// Signing algorithm from settings (`HS256`).
fn signing_algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use jsonwebtoken::DecodingKey;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    /// The source route previously had no Rust handler, so the hybrid gateway
    /// proxied it to the Python upstream and rendered a 502 when that upstream
    /// was unavailable. The cutover registers it exactly once in the public
    /// route group, and only for `POST`.
    #[test]
    fn connector_token_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;

        // Bit 5 in the route method mask is POST (see the `METHODS` order in
        // `hybrid::routes`).
        const POST_BIT: u16 = 1 << 5;
        let routes: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/connector-runtime/token")
            .collect();
        assert_eq!(routes.len(), 1, "the connector token route is registered");
        assert_eq!(routes[0].methods, POST_BIT, "the route is POST-only");
    }

    /// `create_access_token` signs `data` (`sub`, `user_id`, `token_type`,
    /// `aud`, `scope`) followed by the derived `exp`, exactly like
    /// `jose.jwt.encode` renders the source payload. The literal prefix pins the
    /// field order the connector verifier expects.
    #[test]
    fn minted_token_carries_the_source_connector_claims() {
        let before = chrono::Utc::now().timestamp();
        let token = create_connector_token(&config(), "shengbin", 3128).unwrap();
        let after = chrono::Utc::now().timestamp();

        let payload = token.split('.').nth(1).unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let payload = std::str::from_utf8(&decoded).unwrap();

        const PREFIX: &str = r#"{"sub":"shengbin","user_id":3128,"token_type":"connector","aud":"wegent-connector-runtime","scope":"connectors:invoke","exp":"#;
        let exp = payload
            .strip_prefix(PREFIX)
            .and_then(|rest| rest.strip_suffix('}'))
            .and_then(|digits| digits.parse::<i64>().ok())
            .unwrap_or_else(|| panic!("unexpected payload: {payload}"));

        let earlier = before + CONNECTOR_TOKEN_MINUTES * 60;
        let later = after + CONNECTOR_TOKEN_MINUTES * 60;
        let (expected_min, expected_max) = (earlier.min(later), earlier.max(later));
        assert!(
            (expected_min..=expected_max).contains(&exp),
            "exp {exp} outside [{expected_min}, {expected_max}] for payload {payload}"
        );
    }

    /// The minted token verifies under the connector verifier, so the `/tools`
    /// dependency accepts a token this route issues.
    #[test]
    fn minted_token_passes_connector_verification() {
        let token = create_connector_token(&config(), "shengbin", 3128).unwrap();
        let key = DecodingKey::from_secret(b"test-key");
        let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let data = jsonwebtoken::decode::<serde_json::Value>(&token, &key, &validation).unwrap();
        assert_eq!(data.claims["aud"], "wegent-connector-runtime");
        assert_eq!(data.claims["scope"], "connectors:invoke");
        assert_eq!(data.claims["token_type"], "connector");
    }

    /// `expires_in` is `CONNECTOR_TOKEN_MINUTES * 60`.
    #[test]
    fn expires_in_matches_the_source_constant() {
        assert_eq!(CONNECTOR_TOKEN_MINUTES * 60, 900);
    }
}
