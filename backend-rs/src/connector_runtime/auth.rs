// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Connector-token authentication for `GET /api/connector-runtime/tools`.
//!
//! Ports `app/api/endpoints/connector_runtime.py::get_connector_runtime_user`:
//! the `Bearer` credential is verified against `settings.SECRET_KEY` with
//! `settings.ALGORITHM` for the `wegent-connector-runtime` audience, its
//! `token_type`/`scope` claims are checked, and the referenced active user must
//! exist under the token's `user_id` and `sub` username.

use brz_http_server::StatusCode;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Deserializer};

use crate::apps_installed::db::{self, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;

pub struct ConnectorUser(pub UserRow);

impl std::ops::Deref for ConnectorUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const CONNECTOR_REQUIRED: &str = "Wegent-Connector-Required";
const CONNECTOR_SCOPE_INVALID: &str = "Wegent-Connector-Scope-Invalid";
const CONNECTOR_USER_UNAVAILABLE: &str = "Wegent-Connector-User-Unavailable";

impl brz_http_server::Authenticator<ConnectorUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<ConnectorUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        authenticate(self.state(), authorization)
            .await
            .map(ConnectorUser)
            .map_err(|error| {
                if error.status() == brz_http_server::StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else {
                    match error.detail_message() {
                        Some("Connector token required") => {
                            brz_http_server::AuthFailure::missing_credentials(CONNECTOR_REQUIRED)
                        }
                        Some("Invalid connector token scope") => {
                            brz_http_server::AuthFailure::invalid_credentials(
                                CONNECTOR_SCOPE_INVALID,
                            )
                        }
                        Some("Connector user unavailable") => {
                            brz_http_server::AuthFailure::invalid_credentials(
                                CONNECTOR_USER_UNAVAILABLE,
                            )
                        }
                        _ => brz_http_server::AuthFailure::invalid_credentials("Bearer"),
                    }
                }
            })
    }

    fn api_log_id<'a>(&'a self, principal: &'a ConnectorUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.users_user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        let detail = match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: CONNECTOR_REQUIRED,
            } => "Connector token required",
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: CONNECTOR_SCOPE_INVALID,
            } => "Invalid connector token scope",
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: CONNECTOR_USER_UNAVAILABLE,
            } => "Connector user unavailable",
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                return crate::http_compat::FastApiError::internal().into_http_error(arena);
            }
            _ => "Invalid connector token",
        };
        crate::http_compat::FastApiError::detail(brz_http_server::StatusCode::UNAUTHORIZED, detail)
            .into_http_error(arena)
    }
}

/// `aud` required by the connector-runtime audience check.
const CONNECTOR_AUDIENCE: &str = "wegent-connector-runtime";
/// `scope` required by the connector-runtime token.
const CONNECTOR_SCOPE: &str = "connectors:invoke";
/// `token_type` required by the connector-runtime token.
const CONNECTOR_TOKEN_TYPE: &str = "connector";

/// `get_connector_runtime_user`: resolve the caller from a connector token.
pub(crate) async fn authenticate(
    state: &AppState,
    authorization: Option<&str>,
) -> Result<UserRow, FastApiError> {
    let Some(token) = connector_token(authorization) else {
        return Err(error("Connector token required"));
    };
    // `settings.SECRET_KEY`: the active key, never a legacy decode key.
    let Some(key) = state.jwt_secret_keys.first() else {
        return Err(error("Invalid connector token"));
    };
    let Some(claims) = verify_connector_token(token, key, &state.jwt_algorithm) else {
        return Err(error("Invalid connector token"));
    };
    if claims.token_type.0.as_deref() != Some(CONNECTOR_TOKEN_TYPE)
        || claims.audience() != Some(CONNECTOR_AUDIENCE)
        || claims.scope.0.as_deref() != Some(CONNECTOR_SCOPE)
    {
        return Err(error("Invalid connector token scope"));
    }
    let (Some(user_id), Some(user_name)) = (claims.user_id.0, claims.sub.0.as_deref()) else {
        // `isinstance(user_id, int)` failure and a lookup with an absent
        // username both leave the caller without an active user row.
        return Err(error("Connector user unavailable"));
    };
    match db::find_user_by_id_and_name(&state.mysql, user_id, user_name).await {
        Ok(Some(user)) if user.users_is_active => Ok(user),
        Ok(_) => Err(error("Connector user unavailable")),
        Err(failure) => {
            tracing::error!(%failure, %user_id, "connector token user lookup failed");
            Err(FastApiError::internal())
        }
    }
}

/// `HTTPException(status.HTTP_401_UNAUTHORIZED, detail)`.
fn error(detail: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::UNAUTHORIZED, detail)
}

/// `authorization.startswith("Bearer ")` followed by
/// `removeprefix("Bearer ").strip()`.
fn connector_token(authorization: Option<&str>) -> Option<&str> {
    authorization?.strip_prefix("Bearer ").map(str::trim)
}

/// Claims of a connector token. Every claim is decoded tolerantly: a claim
/// with an unexpected JSON type behaves like the source's `claims.get(...)`
/// default (`None`) instead of failing the whole token.
#[derive(Debug, Deserialize)]
struct ConnectorClaims {
    #[serde(default)]
    sub: Claim<String>,
    #[serde(default)]
    user_id: Claim<i64>,
    #[serde(default)]
    token_type: Claim<String>,
    #[serde(default)]
    scope: Claim<String>,
    #[serde(default)]
    aud: Option<Audience>,
}

/// A JWT `aud` claim: one audience or a list of audiences. A claim of any other
/// shape fails the decode, like the source client's claims-format error.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Audience {
    Single(String),
    Multiple(Vec<String>),
}

/// A claim read like `claims.get(key)` in the source: a value of the expected
/// JSON type is kept and every other shape (including `null`) reads as absent.
#[derive(Debug, Default)]
struct Claim<T>(Option<T>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Claim<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input<T> {
            Typed(T),
            Other(serde::de::IgnoredAny),
        }
        Ok(match Input::deserialize(deserializer)? {
            Input::Typed(value) => Self(Some(value)),
            Input::Other(_) => Self(None),
        })
    }
}

impl ConnectorClaims {
    /// The raw `aud` claim when it is exactly one string, mirroring the
    /// source's `claims.get("aud") != "wegent-connector-runtime"` comparison.
    fn audience(&self) -> Option<&str> {
        match self.aud.as_ref()? {
            Audience::Single(value) => Some(value),
            Audience::Multiple(_) => None,
        }
    }

    /// Whether the token's audience satisfies the source's `jwt.decode(...,
    /// audience="wegent-connector-runtime")` check. python-jose skips the
    /// audience check when the claim is absent and accepts a list containing
    /// the expected audience; an audience of another type is a claims error.
    fn audience_accepted(&self) -> bool {
        match self.aud.as_ref() {
            None => true,
            Some(Audience::Single(value)) => value == CONNECTOR_AUDIENCE,
            Some(Audience::Multiple(values)) => {
                values.iter().any(|value| value == CONNECTOR_AUDIENCE)
            }
        }
    }
}

/// Decode and verify a connector token with the active signing key.
///
/// python-jose validates a present `exp`/`nbf` with no leeway and does not
/// require them, and reports a present-but-mismatched `aud` as a token error
/// before the source's own claim checks run.
fn verify_connector_token(token: &str, key: &str, algorithm: &str) -> Option<ConnectorClaims> {
    let algorithm = match algorithm {
        "HS256" => Algorithm::HS256,
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => return None,
    };
    let mut validation = Validation::new(algorithm);
    validation.required_spec_claims.clear();
    validation.validate_aud = false;
    validation.validate_nbf = true;
    validation.leeway = 0;
    let claims = decode::<ConnectorClaims>(
        token,
        &DecodingKey::from_secret(key.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    claims.audience_accepted().then_some(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    const TEST_KEY: &str = "secret-key";

    fn make_token(key: &str, claims: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.as_bytes());
        let mut mac =
            <Hmac<Sha256> as sha2::digest::KeyInit>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(format!("{header}.{payload}").as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{header}.{payload}.{signature}")
    }

    /// A future expiration (`NumericDate`), so the token stays valid for the
    /// test process lifetime.
    fn future_exp() -> i64 {
        chrono::Utc::now().timestamp() + 3600
    }

    fn connector_claims(exp: i64) -> String {
        format!(
            r#"{{"sub":"junshu","user_id":83,"token_type":"connector","aud":"wegent-connector-runtime","scope":"connectors:invoke","exp":{exp}}}"#
        )
    }

    /// Minimal holder for the verifier's two inputs: the active signing key
    /// and the configured algorithm name.
    fn verify_with(key: &str, algorithm: &str, token: &str) -> Option<ConnectorClaims> {
        verify_connector_token(token, key, algorithm)
    }

    #[test]
    fn accepts_a_connector_token() {
        let token = make_token(TEST_KEY, &connector_claims(future_exp()));
        let claims = verify_with(TEST_KEY, "HS256", &token).expect("token verifies");
        assert_eq!(claims.sub.0.as_deref(), Some("junshu"));
        assert_eq!(claims.user_id.0, Some(83));
        assert_eq!(claims.token_type.0.as_deref(), Some("connector"));
        assert_eq!(claims.scope.0.as_deref(), Some("connectors:invoke"));
        assert_eq!(claims.audience(), Some(CONNECTOR_AUDIENCE));
    }

    #[test]
    fn rejects_a_foreign_signature_or_algorithm() {
        let token = make_token("another-key", &connector_claims(future_exp()));
        assert!(verify_with(TEST_KEY, "HS256", &token).is_none());
        let signed = make_token(TEST_KEY, &connector_claims(future_exp()));
        assert!(verify_with(TEST_KEY, "RS256", &signed).is_none());
    }

    #[test]
    fn rejects_an_expired_or_future_not_before_token() {
        let expired = make_token(
            TEST_KEY,
            &connector_claims(chrono::Utc::now().timestamp() - 1),
        );
        assert!(verify_with(TEST_KEY, "HS256", &expired).is_none());
        let claims = format!(
            r#"{{"sub":"junshu","user_id":83,"token_type":"connector","aud":"wegent-connector-runtime","scope":"connectors:invoke","nbf":{}}}"#,
            chrono::Utc::now().timestamp() + 3600
        );
        let not_yet_valid = make_token(TEST_KEY, &claims);
        assert!(verify_with(TEST_KEY, "HS256", &not_yet_valid).is_none());
    }

    #[test]
    fn audience_rules_match_the_source() {
        // Absent, single, and list audiences.
        let absent = make_token(
            TEST_KEY,
            r#"{"sub":"junshu","user_id":83,"token_type":"connector","scope":"connectors:invoke"}"#,
        );
        let claims = verify_with(TEST_KEY, "HS256", &absent).expect("absent aud decodes");
        assert_eq!(claims.audience(), None);
        assert!(claims.audience_accepted());

        let listed = make_token(
            TEST_KEY,
            r#"{"sub":"junshu","user_id":83,"token_type":"connector","aud":["other","wegent-connector-runtime"],"scope":"connectors:invoke"}"#,
        );
        let claims = verify_with(TEST_KEY, "HS256", &listed).expect("list aud decodes");
        assert_eq!(claims.audience(), None);
        assert!(claims.audience_accepted());

        // A present-but-mismatched audience fails the decode, like jose.
        let mismatched = make_token(
            TEST_KEY,
            &connector_claims(future_exp()).replace("wegent-connector-runtime", "another-service"),
        );
        assert!(verify_with(TEST_KEY, "HS256", &mismatched).is_none());

        // A non-string audience is a claims format error.
        let malformed = make_token(
            TEST_KEY,
            r#"{"sub":"junshu","user_id":83,"token_type":"connector","aud":7,"scope":"connectors:invoke"}"#,
        );
        assert!(verify_with(TEST_KEY, "HS256", &malformed).is_none());
    }

    #[test]
    fn claim_types_are_read_like_claims_get() {
        let claims: ConnectorClaims =
            serde_json::from_str(r#"{"sub":123,"user_id":"83","token_type":null,"scope":["a"]}"#)
                .expect("tolerant claim decoding never fails");
        assert_eq!(claims.sub.0, None);
        assert_eq!(claims.user_id.0, None);
        assert_eq!(claims.token_type.0, None);
        assert_eq!(claims.scope.0, None);
    }

    #[test]
    fn bearer_prefix_matches_source() {
        assert_eq!(connector_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(connector_token(Some("Bearer  abc ")), Some("abc"));
        assert_eq!(connector_token(Some("bearer abc")), None);
        assert_eq!(connector_token(Some("abc")), None);
        assert_eq!(connector_token(Some("")), None);
        assert_eq!(connector_token(None), None);
    }
}
