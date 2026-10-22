// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework desktop token minting shared by the session-approve and refresh
//! endpoints.
//!
//! Mirrors `create_access_token` (`app.core.security`): sign the caller's
//! claim map with `settings.SECRET_KEY` and `settings.ALGORITHM` and
//! append `exp` for the requested lifetime. The device-bound access token
//! carries `token_use=wework_access`; the refresh token carries
//! `token_use=wework_refresh`, the `cnf.jkt` device thumbprint, and a fresh
//! `jti`.
use jsonwebtoken::{Algorithm, EncodingKey};

use crate::http_compat::FastApiError;

/// `WEWORK_REFRESH_TOKEN_USE` (`app.core.session_token`).
pub(crate) const WEWORK_REFRESH_TOKEN_USE: &str = "wework_refresh";
/// `WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES` default (`app.core.config`: 60).
pub(crate) const WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES_DEFAULT: i64 = 60;
/// `WEWORK_REFRESH_TOKEN_EXPIRE_MINUTES` default (`app.core.config`: 365 days).
const WEWORK_REFRESH_TOKEN_EXPIRE_MINUTES_DEFAULT: i64 = 365 * 24 * 60;

/// Claim map for the access token. Device-bound adds
/// `token_use=wework_access` and uses `WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES`;
/// legacy omits it and uses `ACCESS_TOKEN_EXPIRE_MINUTES`.
pub(crate) fn access_claims(
    sub: &str,
    user_id: i32,
    device_bound: bool,
) -> Result<serde_json::Value, FastApiError> {
    let expire_minutes = if device_bound {
        wework_access_expire_minutes()
    } else {
        crate::config::env_access_token_expire_minutes()
    };
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(expire_minutes)).timestamp();
    let mut claims = serde_json::Map::new();
    claims.insert("sub".to_string(), sub.into());
    claims.insert("user_id".to_string(), serde_json::Value::from(user_id));
    claims.insert("exp".to_string(), exp.into());
    if device_bound {
        claims.insert(
            "token_use".to_string(),
            crate::auth::WEWORK_ACCESS_TOKEN_USE.into(),
        );
    }
    Ok(serde_json::Value::Object(claims))
}

/// Claim map for the device-bound refresh token: `token_use=wework_refresh`,
/// the `cnf.jkt` thumbprint, and a freshly generated `jti`.
pub(crate) fn refresh_claims(
    sub: &str,
    user_id: i32,
    device_thumbprint: &str,
) -> Result<serde_json::Value, FastApiError> {
    let expire_minutes = crate::config::env_or_dotenv("WEWORK_REFRESH_TOKEN_EXPIRE_MINUTES")
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(WEWORK_REFRESH_TOKEN_EXPIRE_MINUTES_DEFAULT);
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(expire_minutes)).timestamp();
    let mut cnf = serde_json::Map::new();
    cnf.insert("jkt".to_string(), device_thumbprint.into());
    let mut claims = serde_json::Map::new();
    claims.insert("sub".to_string(), sub.into());
    claims.insert("user_id".to_string(), serde_json::Value::from(user_id));
    claims.insert("token_use".to_string(), WEWORK_REFRESH_TOKEN_USE.into());
    claims.insert("cnf".to_string(), serde_json::Value::Object(cnf));
    claims.insert("jti".to_string(), uuid4_hex()?.into());
    claims.insert("exp".to_string(), exp.into());
    Ok(serde_json::Value::Object(claims))
}

/// Sign and encode a JWT with the configured key and algorithm.
pub(crate) fn create_token(
    jwt_key: &str,
    algorithm: &str,
    claims: serde_json::Value,
) -> Result<String, FastApiError> {
    let alg = jwt_algorithm(algorithm);
    let header = jsonwebtoken::Header::new(alg);
    let key = EncodingKey::from_secret(jwt_key.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key).map_err(|error| {
        tracing::error!(%error, "wework auth token signing failed");
        FastApiError::internal()
    })
}

/// UUIDv4 (RFC 4122) string: 8-4-4-4-12 lowercase hex with version 4 and the
/// RFC 4122 variant bits, matching `str(uuid.uuid4())`.
pub(crate) fn uuid4_hex() -> Result<String, FastApiError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| {
        tracing::error!(%error, "jti random source failed");
        FastApiError::internal()
    })?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    ))
}

/// Map a settings algorithm name to `jsonwebtoken`'s algorithm enum.
pub(crate) fn jwt_algorithm(name: &str) -> Algorithm {
    match name {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// `WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES` (minutes; default 60).
pub(crate) fn wework_access_expire_minutes() -> i64 {
    crate::config::env_or_dotenv("WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES")
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(WEWORK_ACCESS_TOKEN_EXPIRE_MINUTES_DEFAULT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid4_hex_has_version_and_variant_bits() {
        let id = uuid4_hex().unwrap();
        assert_eq!(id.len(), 36);
        assert!(id.chars().filter(|c| *c == '-').count() == 4);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }
}
