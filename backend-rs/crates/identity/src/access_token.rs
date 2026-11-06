//! Account login access-token signing shared by authentication flows.
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use jsonwebtoken::Algorithm;
use serde::Serialize;

/// JWT claims of `create_access_token`: `sub`, `user_id`, and the derived
/// `exp` (seconds since the epoch).
#[derive(Debug, Serialize)]
struct AccessClaims<'a> {
    sub: &'a str,
    user_id: i32,
    exp: i64,
}

/// `create_access_token`: `data` + `exp` (now + `ACCESS_TOKEN_EXPIRE_MINUTES`
/// minutes, default 7 days), signed with the configured key/algorithm.
pub fn create_access_token(
    config: &AuthConfig,
    sub: &str,
    user_id: i32,
) -> Result<String, FastApiError> {
    let expire_minutes = crate::config::env_access_token_expire_minutes();
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(expire_minutes)).timestamp();
    let claims = AccessClaims { sub, user_id, exp };
    let header = jsonwebtoken::Header::new(signing_algorithm(config));
    jsonwebtoken::encode(&header, &claims, &encoding_key(config))
        .map_err(|_| FastApiError::internal())
}

/// Signing algorithm from settings (`HS256`).
fn signing_algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// The active signing key (`SECRET_KEY`).
fn encoding_key(config: &AuthConfig) -> jsonwebtoken::EncodingKey {
    jsonwebtoken::EncodingKey::from_secret(config.jwt_key.as_bytes())
}
