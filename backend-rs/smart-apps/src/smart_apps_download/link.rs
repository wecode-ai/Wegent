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
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use sha2::{Sha256, Sha384, Sha512};

use super::models::DownloadClaims;
use crate::config::AuthConfig;

/// `settings.API_PREFIX` (`/api`): the mount prefix of every Backend route.
const API_PREFIX: &str = "/api";
/// `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS` default.
const DEFAULT_EXPIRES_SECONDS: i64 = 600;
/// `build_smart_app_download_url` payload purpose.
const PURPOSE: &str = "smart_app_artifact_download";

/// `verify_smart_app_download_token`'s verified identities
/// (`SmartAppDownloadClaims`).
#[derive(Debug)]
pub struct SmartAppDownloadClaims {
    pub smart_app_id: i64,
    pub release_id: i64,
    pub user_id: i64,
}

/// The `int(claims["iat"])` failure mode of `_validate_iat`.
enum IatFailure {
    /// `ValueError`: caught and rendered as `JWTClaimsError` (the 403).
    ValueError,
    /// `TypeError`: escapes `JWTError` handling (the unhandled 500).
    TypeError,
}

/// A claim that distinguishes an absent key from an explicit JSON `null`
/// (Python's `claims.get("iat") is None` sees both as `None`, but the claims
/// dict keeps an explicit `iat: None` which `int(...)` rejects with
/// `TypeError`).
#[derive(Debug, Default)]
enum MaybeNull {
    #[default]
    Absent,
    Null,
    Value(serde_json::Value),
}

impl<'de> Deserialize<'de> for MaybeNull {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct Visitor;
        impl<'v> serde::de::Visitor<'v> for Visitor {
            type Value = MaybeNull;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(MaybeNull::Null)
            }
            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(MaybeNull::Null)
            }
            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: serde::Deserializer<'v>,
            {
                serde_json::Value::deserialize(deserializer).map(MaybeNull::Value)
            }
        }
        deserializer.deserialize_option(Visitor)
    }
}

/// The decode-only claim set. Every business claim is optional so a token
/// carrying an unexpected shape fails the `type(...) is int` checks rather
/// than the decoder; `exp`/`nbf` are consumed by `jsonwebtoken`'s
/// validation, and `aud`/`sub`/`jti` by the jose-parity checks below.
#[derive(Debug, Deserialize)]
struct VerifiedClaims {
    #[serde(default)]
    smart_app_id: Option<serde_json::Value>,
    #[serde(default)]
    release_id: Option<serde_json::Value>,
    #[serde(default)]
    user_id: Option<serde_json::Value>,
    #[serde(default)]
    purpose: Option<String>,
    #[serde(default)]
    nonce: Option<serde_json::Value>,
    #[serde(default)]
    #[allow(dead_code, reason = "consumed by jsonwebtoken's validation")]
    aud: Option<serde_json::Value>,
    #[serde(default)]
    sub: Option<serde_json::Value>,
    #[serde(default)]
    jti: Option<serde_json::Value>,
    #[serde(default)]
    iat: MaybeNull,
}

impl VerifiedClaims {
    /// `type(smart_app_id) is not int`: Python `bool` is a subclass of `int`
    /// and passes the source check (`True` is `int`-typed), while a float or
    /// a numeric string does not. JSON numbers that are not exactly
    /// representable integers are floats in Python.
    fn int_typed(value: &Option<serde_json::Value>) -> Option<i64> {
        match value.as_ref()? {
            serde_json::Value::Number(number) => {
                if let Some(id) = number.as_i64() {
                    Some(id)
                } else if let Some(id) = number.as_u64() {
                    id.try_into().ok()
                } else {
                    None
                }
            }
            serde_json::Value::Bool(flag) => Some(i64::from(*flag)),
            _ => None,
        }
    }

    /// `_validate_iat`: `int(claims["iat"])` — a present `iat` must coerce
    /// through Python `int()`. An integer, float, boolean, or numeric string
    /// passes; a non-numeric string raises the caught `ValueError`
    /// (`JWTClaimsError`); `None`, an object, or an array raises `TypeError`,
    /// which escapes the source's `JWTError` handling.
    fn iat_failure(&self) -> Option<IatFailure> {
        match &self.iat {
            MaybeNull::Absent => None,
            MaybeNull::Null => Some(IatFailure::TypeError),
            MaybeNull::Value(serde_json::Value::Number(_))
            | MaybeNull::Value(serde_json::Value::Bool(_)) => None,
            MaybeNull::Value(serde_json::Value::String(text)) => {
                if text.trim().parse::<i64>().is_ok() || text.trim().parse::<f64>().is_ok() {
                    None
                } else {
                    Some(IatFailure::ValueError)
                }
            }
            MaybeNull::Value(_) => Some(IatFailure::TypeError),
        }
    }

    /// `_validate_sub`: a present `sub` must be a string (the source passes
    /// no expected subject, so only the type check applies).
    fn sub_is_string(&self) -> bool {
        matches!(self.sub, None | Some(serde_json::Value::String(_)))
    }

    /// `_validate_jti`: a present `jti` must be a string.
    fn jti_is_string(&self) -> bool {
        matches!(self.jti, None | Some(serde_json::Value::String(_)))
    }

    /// The verified business claims: `purpose == 'smart_app_artifact_download'`,
    /// integer-typed identities, and a present (non-null) `nonce`.
    fn verified(&self) -> Option<SmartAppDownloadClaims> {
        if self.purpose.as_deref() != Some(PURPOSE) {
            return None;
        }
        if self.nonce.as_ref().is_none_or(serde_json::Value::is_null) {
            return None;
        }
        Some(SmartAppDownloadClaims {
            smart_app_id: Self::int_typed(&self.smart_app_id)?,
            release_id: Self::int_typed(&self.release_id)?,
            user_id: Self::int_typed(&self.user_id)?,
        })
    }
}

/// `verify_smart_app_download_token`'s outcomes. `_validate_iat` catches
/// only `ValueError`; a `None`/object/array `iat` raises `TypeError`, which
/// escapes `JWTError` handling and renders as the source's unhandled 500.
pub enum VerifiedDownloadToken {
    /// The verified identities.
    Claims(SmartAppDownloadClaims),
    /// `InvalidSmartAppDownloadToken` -> the endpoint's 403.
    Invalid,
    /// The uncaught `TypeError` -> the application's unhandled 500.
    Unhandled,
}

/// `verify_smart_app_download_token`: decode with the active
/// `SECRET_KEY` only (`jwt.decode(token, settings.SECRET_KEY,
/// algorithms=[settings.ALGORITHM])`; no legacy key rotation), then apply the
/// payload contract. Every decode or claim failure is one indistinguishable
/// `Invalid` outcome the endpoint renders as `403 {"detail": "Invalid or
/// expired Smart app download link"}`.
///
/// python-jose's default decode options: a present `exp`/`nbf` is validated
/// with no leeway and neither is required; a present `aud` with no expected
/// audience fails (`_validate_aud`); a present `iat` must coerce through
/// `int()` (a `ValueError` is the 403; a `TypeError` is the 500); a present
/// `sub`/`jti` must be a string; the header `alg` must be in `algorithms`.
/// `jsonwebtoken`'s defaults otherwise differ (60-second leeway, skipped
/// `nbf`), so the validation is pinned here.
pub fn verify_smart_app_download_token(config: &AuthConfig, token: &str) -> VerifiedDownloadToken {
    let mut validation = Validation::new(signing_algorithm_value(config));
    validation.validate_aud = true;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.leeway = 0;
    validation.required_spec_claims.clear();
    let key = DecodingKey::from_secret(config.jwt_key.as_bytes());
    let Some(claims) = decode::<VerifiedClaims>(token, &key, &validation)
        .ok()
        .map(|token| token.claims)
    else {
        return VerifiedDownloadToken::Invalid;
    };
    match claims.iat_failure() {
        Some(IatFailure::TypeError) => return VerifiedDownloadToken::Unhandled,
        Some(IatFailure::ValueError) => return VerifiedDownloadToken::Invalid,
        None => {}
    }
    if !claims.sub_is_string() || !claims.jti_is_string() {
        return VerifiedDownloadToken::Invalid;
    }
    match claims.verified() {
        Some(claims) => VerifiedDownloadToken::Claims(claims),
        None => VerifiedDownloadToken::Invalid,
    }
}

/// The `Algorithm` for `jsonwebtoken`'s `Validation::new`, matching the
/// `settings.ALGORITHM` constraint of `signing_algorithm`.
fn signing_algorithm_value(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

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

    /// A token minted by `build_download_url` round-trips through
    /// `verify_smart_app_download_token` with the same identities.
    #[test]
    fn verifies_a_minted_download_token() {
        let now = Utc::now();
        let (url, _) = build_download_url(&config("HS256"), 13, 29, 8, now);
        let token = url.split("token=").nth(1).expect("token in url");
        let VerifiedDownloadToken::Claims(claims) =
            verify_smart_app_download_token(&config("HS256"), token)
        else {
            panic!("a freshly minted token verifies");
        };
        assert_eq!(claims.smart_app_id, 13);
        assert_eq!(claims.release_id, 29);
        assert_eq!(claims.user_id, 8);
    }

    /// python-jose's decode defaults: an absent `exp` is accepted
    /// (`require_exp` defaults to False) while an expired `exp` is rejected
    /// with zero leeway.
    #[test]
    fn an_expired_token_is_rejected_and_a_missing_exp_is_accepted() {
        let now = Utc::now();
        let token = |claims: serde_json::Value| {
            jsonwebtoken::encode(
                &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
                &claims,
                &jsonwebtoken::EncodingKey::from_secret(b"secret"),
            )
            .unwrap()
        };
        let base = serde_json::json!({
            "smart_app_id": 13, "release_id": 29, "user_id": 8,
            "purpose": PURPOSE, "nonce": "YLHQPmISLYpuELkziOM2Rw",
        });
        // No `exp`: jose's `require_exp` default is False, so it verifies.
        let VerifiedDownloadToken::Claims(claims) =
            verify_smart_app_download_token(&config("HS256"), &token(base.clone()))
        else {
            panic!("a token without exp verifies");
        };
        assert_eq!(claims.smart_app_id, 13);
        // Expired `exp`: rejected with zero leeway.
        let expired = base.clone();
        let expired = {
            let mut value = expired;
            value["exp"] = serde_json::json!(now.timestamp() - 30);
            value
        };
        assert!(matches!(
            verify_smart_app_download_token(&config("HS256"), &token(expired)),
            VerifiedDownloadToken::Invalid
        ));
    }

    /// The payload contract: wrong purpose, float identities, a null nonce, a
    /// present `aud`, and a non-string `sub` are all rejected; a
    /// `TypeError`-raising `iat` is the source's unhandled 500; a
    /// `ValueError` `iat` (non-numeric string) is the 403; a wrong signature
    /// fails the decoder.
    #[test]
    fn rejects_tokens_failing_the_source_payload_contract() {
        let token = |claims: serde_json::Value| {
            jsonwebtoken::encode(
                &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
                &claims,
                &jsonwebtoken::EncodingKey::from_secret(b"secret"),
            )
            .unwrap()
        };
        let base = || {
            serde_json::json!({
                "smart_app_id": 13, "release_id": 29, "user_id": 8,
                "purpose": PURPOSE, "nonce": "YLHQPmISLYpuELkziOM2Rw",
                "exp": 9_999_999_999_i64,
            })
        };
        let verify = |claims: serde_json::Value| {
            verify_smart_app_download_token(&config("HS256"), &token(claims))
        };
        // Wrong purpose.
        let mut wrong_purpose = base();
        wrong_purpose["purpose"] = serde_json::json!("other");
        assert!(matches!(
            verify(wrong_purpose),
            VerifiedDownloadToken::Invalid
        ));
        // Float identity: `type(13.0) is not int`.
        let mut float_id = base();
        float_id["smart_app_id"] = serde_json::json!(13.0);
        assert!(matches!(verify(float_id), VerifiedDownloadToken::Invalid));
        // Null nonce: `not payload.get("nonce")`.
        let mut null_nonce = base();
        null_nonce["nonce"] = serde_json::Value::Null;
        assert!(matches!(verify(null_nonce), VerifiedDownloadToken::Invalid));
        // Present `aud` with no expected audience: jose's `_validate_aud`
        // raises `Invalid audience`.
        let mut with_aud = base();
        with_aud["aud"] = serde_json::json!("someone");
        assert!(matches!(verify(with_aud), VerifiedDownloadToken::Invalid));
        // Non-string `sub`: jose's `_validate_sub` raises.
        let mut int_sub = base();
        int_sub["sub"] = serde_json::json!(5);
        assert!(matches!(verify(int_sub), VerifiedDownloadToken::Invalid));
        // `iat` as an object: `int({})` raises `TypeError`, which escapes the
        // source's `JWTError` handling (the unhandled 500).
        let mut iat_object = base();
        iat_object["iat"] = serde_json::json!({"a": 1});
        assert!(matches!(
            verify(iat_object),
            VerifiedDownloadToken::Unhandled
        ));
        // `iat` as `null`: also a `TypeError`.
        let mut iat_null = base();
        iat_null["iat"] = serde_json::Value::Null;
        assert!(matches!(verify(iat_null), VerifiedDownloadToken::Unhandled));
        // `iat` as a non-numeric string: `int('abc')` raises `ValueError`,
        // caught as `JWTClaimsError` (the 403).
        let mut iat_string = base();
        iat_string["iat"] = serde_json::json!("abc");
        assert!(matches!(verify(iat_string), VerifiedDownloadToken::Invalid));
        // A wrong signature fails the decoder.
        let minted = token(base());
        assert!(matches!(
            verify_smart_app_download_token(
                &AuthConfig {
                    jwt_key: "other".to_owned(),
                    legacy_jwt_keys: Vec::new(),
                    algorithm: "HS256".to_owned(),
                },
                &minted
            ),
            VerifiedDownloadToken::Invalid
        ));
    }
}
