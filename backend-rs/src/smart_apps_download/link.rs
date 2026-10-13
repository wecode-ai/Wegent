// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Short-lived Backend download links for Smart app artifacts.
//!
//! Port of `app/services/smart_app_download_link.py` and the `expiresAt`
//! serialization of `SmartAppDownloadDescriptor`.
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use sha2::{Sha256, Sha384, Sha512};

use super::models::DownloadClaims;
use crate::config::AuthConfig;

/// `settings.API_PREFIX` (`/api`): the mount prefix of every Backend route.
const API_PREFIX: &str = "/api";
/// `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS` default.
const DEFAULT_EXPIRES_SECONDS: i64 = 600;
/// `build_smart_app_download_url` payload purpose.
const PURPOSE: &str = "smart_app_artifact_download";

/// `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS`: the configured link
/// lifetime, defaulting to the source's 600 seconds.
pub fn expires_seconds() -> i64 {
    crate::config::env_or_dotenv("PLUGIN_PACKAGE_URL_EXPIRES_SECONDS")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_EXPIRES_SECONDS)
}

/// `build_smart_app_download_url`: a scoped relative Backend URL for one
/// release plus the absolute expiry the descriptor reports.
pub fn build_download_url(
    config: &AuthConfig,
    smart_app_id: i64,
    release_id: i64,
    user_id: i64,
    now: DateTime<Utc>,
) -> (String, DateTime<Utc>) {
    let expires_at = now + Duration::seconds(expires_seconds());
    let claims = DownloadClaims {
        smart_app_id,
        release_id,
        user_id,
        purpose: PURPOSE,
        nonce: random_nonce(),
        iat: now.timestamp(),
        exp: expires_at.timestamp(),
    };
    let token = encode_token(config, &claims);
    let url = format!("{API_PREFIX}/smart-apps/marketplace/{smart_app_id}/artifact?token={token}");
    (url, expires_at)
}

/// Pydantic v2 datetime JSON form: RFC 3339 with a `Z` suffix, microseconds
/// present only when nonzero (`2026-10-10T06:37:30.688045Z`).
pub fn format_expires_at(expires_at: DateTime<Utc>) -> String {
    if expires_at.timestamp_subsec_micros() == 0 {
        expires_at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
    } else {
        expires_at.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
    }
}

/// `python-jose` `jwt.encode(..., algorithm=settings.ALGORITHM)`: compact JWS
/// with an `{"alg": ...,"typ":"JWT"}` header.
fn encode_token(config: &AuthConfig, claims: &DownloadClaims) -> String {
    let algorithm = signing_algorithm(config);
    let header = format!("{{\"alg\":\"{algorithm}\",\"typ\":\"JWT\"}}");
    let payload = serde_json::to_vec(claims).expect("download claims serialize");
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.as_bytes()),
        URL_SAFE_NO_PAD.encode(&payload)
    );
    let key = config.jwt_key.as_bytes();
    let signature = match algorithm {
        "HS384" => hmac_sha384(key, signing_input.as_bytes()),
        "HS512" => hmac_sha512(key, signing_input.as_bytes()),
        _ => hmac_sha256(key, signing_input.as_bytes()),
    };
    format!("{signing_input}.{signature}")
}

/// The source `settings.ALGORITHM`, constrained to the HS family the token
/// verifier accepts.
fn signing_algorithm(config: &AuthConfig) -> &str {
    match config.algorithm.as_str() {
        "HS384" => "HS384",
        "HS512" => "HS512",
        _ => "HS256",
    }
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn hmac_sha384(key: &[u8], message: &[u8]) -> String {
    let mut mac = <Hmac<Sha384> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn hmac_sha512(key: &[u8], message: &[u8]) -> String {
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// `secrets.token_urlsafe(16)`: 16 random bytes as URL-safe Base64 without
/// padding. A failure to gather entropy yields an empty nonce, matching the
/// existing token generator in this crate.
fn random_nonce() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        return String::new();
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(algorithm: &str) -> AuthConfig {
        AuthConfig {
            jwt_key: "secret".to_owned(),
            legacy_jwt_keys: Vec::new(),
            algorithm: algorithm.to_owned(),
        }
    }

    /// The pydantic v2 datetime rendering: `Z` suffix, microseconds when
    /// nonzero and omitted when zero.
    #[test]
    fn expires_at_matches_pydantic_datetime_json() {
        let with_micros = DateTime::parse_from_rfc3339("2026-10-10T06:37:30.688045Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            format_expires_at(with_micros),
            "2026-10-10T06:37:30.688045Z"
        );
        let whole_second = DateTime::parse_from_rfc3339("2026-10-10T06:37:30Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(format_expires_at(whole_second), "2026-10-10T06:37:30Z");
    }

    /// A minted link is a verifiable HS256 JWS carrying the source claims and
    /// a `+600s` expiry.
    #[test]
    fn builds_a_scoped_hs256_link() {
        let now = DateTime::parse_from_rfc3339("2026-10-10T06:27:30.688045Z")
            .unwrap()
            .with_timezone(&Utc);
        let (url, expires_at) = build_download_url(&config("HS256"), 9, 32, 2231, now);
        assert!(url.starts_with("/api/smart-apps/marketplace/9/artifact?token="));
        assert_eq!(format_expires_at(expires_at), "2026-10-10T06:37:30.688045Z");

        let token = url.split("token=").nth(1).expect("token in url");
        let segments: Vec<&str> = token.split('.').collect();
        assert_eq!(segments.len(), 3, "compact JWS has three segments");
        assert_eq!(
            URL_SAFE_NO_PAD.decode(segments[0]).unwrap(),
            br#"{"alg":"HS256","typ":"JWT"}"#
        );
        let payload = URL_SAFE_NO_PAD.decode(segments[1]).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["smart_app_id"], 9);
        assert_eq!(value["release_id"], 32);
        assert_eq!(value["user_id"], 2231);
        assert_eq!(value["purpose"], "smart_app_artifact_download");
        assert_eq!(value["iat"], 1_791_613_650);
        assert_eq!(value["exp"], 1_791_614_250);
        assert_eq!(value["nonce"].as_str().unwrap().len(), 22);

        let signing_input = format!("{}.{}", segments[0], segments[1]);
        assert_eq!(
            segments[2],
            hmac_sha256(b"secret", signing_input.as_bytes())
        );
    }
}
