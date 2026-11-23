//! A plugin collector receives one expiring source lease, never service credentials.
use crate::{config::AuthConfig, http_compat::FastApiError};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

const AUDIENCE: &str = "wework-observation-collector";

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Collector {
    pub user_id: i64,
    pub observation_id: String,
    pub lease_id: String,
    pub exp: i64,
    aud: String,
}

pub(super) fn issue(
    config: &AuthConfig,
    owner: i64,
    observation: &str,
    lease: &str,
) -> Result<String, FastApiError> {
    let claims = Collector {
        user_id: owner,
        observation_id: observation.to_owned(),
        lease_id: lease.to_owned(),
        exp: chrono::Utc::now().timestamp() + 900,
        aud: AUDIENCE.into(),
    };
    let algorithm = Algorithm::from_str(&config.algorithm).map_err(|_| FastApiError::internal())?;
    jsonwebtoken::encode(
        &Header::new(algorithm),
        &claims,
        &EncodingKey::from_secret(config.jwt_key.as_bytes()),
    )
    .map_err(|_| FastApiError::internal())
}

fn verify(token: &str, key: &[u8], algorithm: &str) -> Option<Collector> {
    let mut validation = Validation::new(Algorithm::from_str(algorithm).ok()?);
    validation.set_audience(&[AUDIENCE]);
    validation.validate_nbf = true;
    validation.leeway = 0;
    let claims =
        jsonwebtoken::decode::<Collector>(token, &DecodingKey::from_secret(key), &validation)
            .ok()?
            .claims;
    (claims.user_id > 0
        && claims.observation_id.len() == 64
        && !claims.lease_id.is_empty()
        && claims.aud == AUDIENCE)
        .then_some(claims)
}

impl brz_http_server::Authenticator<Collector> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<Collector, brz_http_server::AuthFailure> {
        let token = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| brz_http_server::AuthFailure::missing_credentials("Bearer"))?;
        let key = self
            .state()
            .jwt_secret_keys
            .first()
            .ok_or(brz_http_server::AuthFailure::Internal)?;
        verify(token, key.as_bytes(), &self.state().jwt_algorithm)
            .ok_or_else(|| brz_http_server::AuthFailure::invalid_credentials("Bearer"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collector_token_is_source_lease_scoped_and_cannot_accept_session_or_connector_tokens() {
        let config = AuthConfig {
            jwt_key: "test-secret".into(),
            legacy_jwt_keys: vec![],
            algorithm: "HS256".into(),
        };
        let token = issue(&config, 7, &"a".repeat(64), "lease-one").unwrap();
        let claims = verify(&token, b"test-secret", "HS256").unwrap();
        assert_eq!(claims.user_id, 7);
        assert_eq!(claims.lease_id, "lease-one");
        assert!(verify(&token, b"another-secret", "HS256").is_none());
        let session = jsonwebtoken::encode(
            &Header::default(),
            &serde_json::json!({"sub":"user","user_id":7,"exp":chrono::Utc::now().timestamp()+300}),
            &EncodingKey::from_secret(b"test-secret"),
        )
        .unwrap();
        assert!(verify(&session, b"test-secret", "HS256").is_none());
    }
}
