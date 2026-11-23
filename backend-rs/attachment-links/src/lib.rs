// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Signed public attachment download links
//! (`app/services/attachment/public_link.py`).
//!
//! A public download link contains an HMAC-signed JWT with an attachment ID,
//! a scoped purpose, a fresh nonce, an issue time, and an expiration time.
//! The token is embedded in
//! `{WEGENT_BACKEND_PUBLIC_URL}/api/attachments/download/shared?token=...`.

#![forbid(unsafe_code)]

pub mod attachment_block;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};

use wegent_backend_config::{AuthConfig, env_or_dotenv};

/// `PUBLIC_ATTACHMENT_PURPOSE`: the only purpose the download verifier
/// accepts.
const PUBLIC_ATTACHMENT_PURPOSE: &str = "public_attachment_download";

/// Source default `WEGENT_BACKEND_PUBLIC_URL`.
const DEFAULT_PUBLIC_BASE_URL: &str = "http://localhost:8000";

/// Path of the public download route (`build_public_attachment_download_url`).
const PUBLIC_DOWNLOAD_PATH: &str = "/api/attachments/download/shared";

/// `settings.WEGENT_BACKEND_PUBLIC_URL`. The source reads the pydantic
/// settings singleton, so the value is resolved once per process.
pub fn public_base_url() -> &'static str {
    static BASE_URL: OnceLock<String> = OnceLock::new();
    BASE_URL
        .get_or_init(|| {
            env_or_dotenv("WEGENT_BACKEND_PUBLIC_URL")
                .unwrap_or_else(|| DEFAULT_PUBLIC_BASE_URL.to_owned())
        })
        .as_str()
}

/// Claims of a public attachment share token
/// (`generate_public_attachment_token`).
#[derive(Debug, Serialize)]
struct PublicAttachmentClaims<'a> {
    attachment_id: i64,
    purpose: &'a str,
    nonce: String,
    iat: i64,
    exp: i64,
}

/// Signing algorithm from settings (`HS256`).
fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// `generate_public_attachment_token`: a fresh token scoped to one
/// attachment, valid for `expires` from `now`.
pub fn generate_public_attachment_token(
    config: &AuthConfig,
    attachment_id: i64,
    expires: Duration,
    now: DateTime<Utc>,
) -> anyhow::Result<String> {
    let claims = PublicAttachmentClaims {
        attachment_id,
        purpose: PUBLIC_ATTACHMENT_PURPOSE,
        nonce: random_nonce(),
        iat: now.timestamp(),
        exp: (now + expires).timestamp(),
    };
    let header = Header::new(algorithm(config));
    let key = EncodingKey::from_secret(config.jwt_key.as_bytes());
    jsonwebtoken::encode(&header, &claims, &key)
        .map_err(|error| anyhow::anyhow!("public attachment token failed to sign: {error}"))
}

/// `build_public_attachment_download_url`: the scoped token as a query
/// parameter of the public download route. An empty base URL keeps the
/// route-relative form (`base_url.strip().rstrip("/")`).
pub fn build_public_attachment_download_url(
    config: &AuthConfig,
    base_url: &str,
    attachment_id: i64,
    expires: Duration,
    now: DateTime<Utc>,
) -> anyhow::Result<String> {
    let token = generate_public_attachment_token(config, attachment_id, expires, now)?;
    let prefix = base_url.trim().trim_end_matches('/');
    Ok(format!("{prefix}{PUBLIC_DOWNLOAD_PATH}?token={token}"))
}

/// Claims of a public attachment share token
/// (`verify_public_attachment_token`'s payload contract).
#[derive(Debug, Deserialize)]
struct ShareClaims {
    attachment_id: Option<i64>,
    purpose: Option<String>,
    nonce: Option<String>,
}

impl ShareClaims {
    /// The verified `attachment_id`: `payload.get("attachment_id")` must be
    /// an `int` in the source and `payload.get("nonce")` must be present
    /// (`not None`, not empty in practice for a `token_urlsafe` nonce).
    fn verified_attachment_id(&self) -> Option<i64> {
        if self.purpose.as_deref() != Some(PUBLIC_ATTACHMENT_PURPOSE) {
            return None;
        }
        let id = self.attachment_id?;
        if self.nonce.as_deref().unwrap_or_default().is_empty() {
            return None;
        }
        Some(id)
    }
}

/// `verify_public_attachment_token`: decode with the active
/// `SECRET_KEY` only (`jwt.decode(token, settings.SECRET_KEY,
/// algorithms=[settings.ALGORITHM])`; unlike `decode_jose_jwt`, no legacy
/// key rotation). `exp` is validated when present (python-jose default) and
/// no audience is required. Returns the verified `attachment_id`.
pub fn verify_public_share_token(config: &AuthConfig, token: &str) -> Option<i64> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose: `verify_aud` passes when the claim is absent; the token
    // carries no audience, so no audience is required.
    validation.validate_aud = false;
    // `exp`/`iat`/`nbf` are validated only when present in the source.
    validation.required_spec_claims.clear();
    let key = DecodingKey::from_secret(config.jwt_key.as_bytes());
    decode::<ShareClaims>(token, &key, &validation)
        .ok()
        .and_then(|token| token.claims.verified_attachment_id())
}

/// `secrets.token_urlsafe(16)`: 16 random bytes as URL-safe base64
/// without padding.
///
/// The deployment has no dedicated RNG dependency; the standard library's
/// OS-seeded hasher is the same entropy source the request-id filter uses
/// (`filters/request_id.rs`). The download verifier only requires the claim
/// to be present and non-empty.
fn random_nonce() -> String {
    static NEXT_NONCE: OnceLock<AtomicU32> = OnceLock::new();
    let counter = NEXT_NONCE
        .get_or_init(|| AtomicU32::new(0))
        .fetch_add(1, Ordering::Relaxed);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(counter);
    let first = hasher.finish();
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(counter);
    hasher.write_u64(first);
    let second = hasher.finish();

    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&first.to_le_bytes());
    bytes[8..].copy_from_slice(&second.to_le_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{DecodingKey, Validation, decode};

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn claims(token: &str) -> serde_json::Value {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_aud = false;
        // The fixture's fixed `iat`/`exp` predate the test run.
        validation.validate_exp = false;
        validation.required_spec_claims.clear();
        let decoded =
            decode::<serde_json::Value>(token, &DecodingKey::from_secret(b"test-key"), &validation)
                .expect("token verifies");
        decoded.claims
    }

    fn token_of(url: &str) -> &str {
        url.split_once("?token=").expect("token query").1
    }

    #[test]
    fn url_carries_the_scoped_one_hour_token() {
        let now = DateTime::from_timestamp(1_789_887_883, 0).expect("fixed time");
        let url = build_public_attachment_download_url(
            &config(),
            "https://wegent.example.invalid/",
            1_330_367,
            Duration::seconds(3600),
            now,
        )
        .expect("signs");

        assert_eq!(
            url,
            format!(
                "https://wegent.example.invalid{PUBLIC_DOWNLOAD_PATH}?token={}",
                token_of(&url)
            )
        );
        let claims = claims(token_of(&url));
        assert_eq!(claims["attachment_id"], 1_330_367);
        assert_eq!(claims["purpose"], PUBLIC_ATTACHMENT_PURPOSE);
        assert_eq!(claims["iat"], 1_789_887_883);
        assert_eq!(claims["exp"], 1_789_891_483);
        // `token_urlsafe(16)`: 16 bytes as unpadded URL-safe base64.
        assert_eq!(claims["nonce"].as_str().expect("nonce").len(), 22);
    }

    #[test]
    fn blank_base_url_keeps_the_route_relative_form() {
        let url = build_public_attachment_download_url(
            &config(),
            "  ",
            7,
            Duration::seconds(3600),
            Utc::now(),
        )
        .expect("signs");
        assert!(
            url.starts_with("/api/attachments/download/shared?token="),
            "{url}"
        );
    }

    #[test]
    fn every_call_signs_a_new_token() {
        let now = Utc::now();
        let first = generate_public_attachment_token(&config(), 7, Duration::seconds(3600), now)
            .expect("signs");
        let second = generate_public_attachment_token(&config(), 7, Duration::seconds(3600), now)
            .expect("signs");
        assert_ne!(first, second);
        assert_ne!(claims(&first)["nonce"], claims(&second)["nonce"]);
    }

    #[test]
    fn nonces_are_unpadded_url_safe_base64() {
        for _ in 0..8 {
            let nonce = random_nonce();
            assert_eq!(nonce.len(), 22);
            assert!(!nonce.contains(['=', '+', '/']), "{nonce}");
        }
    }

    #[test]
    fn configured_algorithm_signs_the_header() {
        let mut config = config();
        config.algorithm = "HS512".to_string();
        let token = generate_public_attachment_token(&config, 7, Duration::seconds(60), Utc::now())
            .expect("signs");
        let header = jsonwebtoken::decode_header(&token).expect("header");
        assert_eq!(header.alg, Algorithm::HS512);
    }
}

#[cfg(test)]
mod verification_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "share-test-key".to_string(),
            legacy_jwt_keys: vec!["legacy-key".to_string()],
            algorithm: "HS256".to_string(),
        }
    }

    fn share_token(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"share-test-key");
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    #[test]
    fn verifies_a_well_formed_share_token() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after Unix epoch")
            .as_secs();
        let token = share_token(serde_json::json!({
            "attachment_id": 1287754,
            "purpose": "public_attachment_download",
            "nonce": "aNAPDSW01gmFxIJgWdEnqg",
            "iat": now,
            "exp": now + 7 * 24 * 60 * 60,
        }));
        assert_eq!(verify_public_share_token(&config(), &token), Some(1287754));
    }

    #[test]
    fn rejects_tokens_signed_with_legacy_keys() {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"legacy-key");
        let token = jsonwebtoken::encode(
            &header,
            &serde_json::json!({
                "attachment_id": 1,
                "purpose": "public_attachment_download",
                "nonce": "n",
            }),
            &key,
        )
        .unwrap();
        assert_eq!(verify_public_share_token(&config(), &token), None);
    }

    #[test]
    fn rejects_wrong_purpose_missing_nonce_and_garbage() {
        let claims = serde_json::json!({
            "attachment_id": 1,
            "purpose": "public_attachment_download",
            "nonce": "n",
        });
        let mut wrong_purpose = claims.clone();
        wrong_purpose["purpose"] = serde_json::json!("attachment_download");
        assert_eq!(
            verify_public_share_token(&config(), &share_token(wrong_purpose)),
            None
        );

        let mut missing_nonce = claims;
        missing_nonce.as_object_mut().unwrap().remove("nonce");
        assert_eq!(
            verify_public_share_token(&config(), &share_token(missing_nonce)),
            None
        );

        assert_eq!(verify_public_share_token(&config(), "not-a-jwt"), None);
    }
}
