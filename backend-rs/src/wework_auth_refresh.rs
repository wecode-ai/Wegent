// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/auth/wework/refresh` — issue a desktop access token after the
//! caller proves possession of the device key bound to its refresh token.
//!
//! Mirrors `app.api.endpoints.wework_auth.refresh_wework_access_token`
//! (router prefix `/auth/wework`, mounted under the app prefix `/api`):
//! decode the HS refresh token with the active signing key and require
//! `token_use=wework_refresh`, take the `cnf.jkt` device thumbprint, verify the
//! ES256 device proof against that thumbprint and this exact request, load the
//! still-active `users` row, then mint a fresh `wework_access` token. Every
//! failure is a plain `HTTPException` body (`{"detail": ...}`) with no
//! `WWW-Authenticate` challenge; the endpoint is public because the device
//! proof, not a bearer credential, authenticates the caller.
use crate::jwt_compat::{jose_claims_valid, jose_validation};
use base64::Engine as _;
use jsonwebtoken::{Algorithm, DecodingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::auth::{USER_BY_NAME_QUERY, UserRow};
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::wework_auth_tokens::{
    WEWORK_REFRESH_TOKEN_USE, access_claims, create_token, jwt_algorithm,
    wework_access_expire_minutes,
};

/// `DEVICE_PROOF_MAX_AGE_SECONDS` (`app.api.endpoints.wework_auth`).
const DEVICE_PROOF_MAX_AGE_SECONDS: i64 = 5 * 60;
/// `_verify_device_proof`'s forward clock-skew allowance for `iat`.
const DEVICE_PROOF_FUTURE_SKEW_SECONDS: i64 = 30;
/// The source `request.url.path` for this route: the `htu` a proof must bind.
const REFRESH_PATH: &str = "/api/auth/wework/refresh";

/// `WeworkTokenRefreshRequest` (`app.schemas.user`): the desktop refresh token
/// and the device-signed proof that binds it to this exact request.
#[derive(Debug, Deserialize)]
pub struct WeworkTokenRefreshRequest {
    pub refresh_token: String,
    pub proof: String,
}

/// `WeworkTokenRefreshResponse` (`app.schemas.user`): field order as declared,
/// with `token_type` defaulting to `bearer`.
#[derive(Debug, Serialize)]
struct WeworkTokenRefreshResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
}

/// POST /api/auth/wework/refresh: issue a desktop access token after proving
/// possession of the device key bound to the refresh token. Public: the proof,
/// not a bearer credential, authenticates the caller.
#[brz_http_server::post("/api/auth/wework/refresh", access = public)]
async fn refresh_wework_access_token(
    #[inject(state)] state: &AppState,
    body: WeworkTokenRefreshRequest,
) -> Result<WeworkTokenRefreshResponse, FastApiError> {
    refresh_access_token(state, &body).await
}

/// `refresh_wework_access_token` (`app.api.endpoints.wework_auth`): decode the
/// refresh token, verify the device proof against its `cnf.jkt` thumbprint,
/// load the still-valid user, then mint a fresh `wework_access` token.
async fn refresh_access_token(
    state: &AppState,
    body: &WeworkTokenRefreshRequest,
) -> Result<WeworkTokenRefreshResponse, FastApiError> {
    let claims = verify_refresh_request(&state.auth, body, chrono::Utc::now().timestamp())?;
    let username = claims["sub"].as_str().expect("validated refresh subject");

    // Keep the full source projection and prepared statement unchanged.
    let user: Option<UserRow> = state
        .mysql
        .fetch_optional(USER_BY_NAME_QUERY, (username,))
        .await
        .map_err(|error| {
            tracing::warn!(%error, "wework refresh user lookup failed");
            FastApiError::unhandled()
        })?;
    issue_refreshed_token(&state.auth, &claims, user.as_ref())
}

fn verify_refresh_request(
    auth: &AuthConfig,
    body: &WeworkTokenRefreshRequest,
    now: i64,
) -> Result<serde_json::Value, FastApiError> {
    let claims = decode_refresh_token_at(auth, &body.refresh_token, now)?;
    let Some(expected_thumbprint) = claims
        .get("cnf")
        .and_then(serde_json::Value::as_object)
        .and_then(|cnf| cnf.get("jkt"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Err(invalid_refresh_token());
    };

    // `_verify_device_proof`: proof signature plus the request binding claims.
    verify_device_proof_at(
        &body.proof,
        &body.refresh_token,
        expected_thumbprint,
        REFRESH_PATH,
        now,
    )?;

    if !claims.get("sub").is_some_and(serde_json::Value::is_string) {
        return Err(invalid_refresh_token());
    }
    Ok(claims)
}

fn issue_refreshed_token(
    auth: &AuthConfig,
    claims: &serde_json::Value,
    user: Option<&UserRow>,
) -> Result<WeworkTokenRefreshResponse, FastApiError> {
    let Some(user) = user else {
        return Err(desktop_login_no_longer_valid());
    };
    // Python bool is also int; other non-integer IDs do not constrain the user.
    let mismatched = claims.get("user_id").is_some_and(|id| {
        if let Some(value) = id.as_bool() {
            i64::from(user.id) != i64::from(value)
        } else if id.is_i64() || id.is_u64() {
            id.as_i64() != Some(i64::from(user.id))
        } else {
            false
        }
    });
    if user.is_active == 0 || mismatched {
        return Err(desktop_login_no_longer_valid());
    }

    // `_create_wework_access_token` + `expires_in = minutes * 60`.
    let access_token = create_token(
        &auth.jwt_key,
        &auth.algorithm,
        access_claims(&user.user_name, user.id, true)?,
    )?;
    Ok(WeworkTokenRefreshResponse {
        access_token,
        token_type: "bearer",
        expires_in: wework_access_expire_minutes() * 60,
    })
}

/// `_decode_refresh_token`: verify the refresh token with the active signing
/// key and the configured algorithm, then require `token_use=wework_refresh`.
#[cfg(test)]
fn decode_refresh_token(
    config: &AuthConfig,
    token: &str,
) -> Result<serde_json::Value, FastApiError> {
    decode_refresh_token_at(config, token, chrono::Utc::now().timestamp())
}

fn decode_refresh_token_at(
    config: &AuthConfig,
    token: &str,
    now: i64,
) -> Result<serde_json::Value, FastApiError> {
    let key = DecodingKey::from_secret(config.jwt_key.as_bytes());
    let decoded = jsonwebtoken::decode::<serde_json::Value>(
        token,
        &key,
        &jose_validation(jwt_algorithm(&config.algorithm)),
    )
    .map_err(|_| desktop_login_expired())?;
    let claims = decoded.claims;
    if !jose_claims_valid(&claims, now) {
        return Err(desktop_login_expired());
    }
    if claims.get("token_use").and_then(serde_json::Value::as_str) != Some(WEWORK_REFRESH_TOKEN_USE)
    {
        return Err(invalid_refresh_token());
    }
    Ok(claims)
}

/// `_verify_device_proof`: validate the embedded EC P-256 key, bind it to the
/// expected thumbprint, verify the ES256 signature, then enforce the
/// `iat`/`htm`/`htu`/`ath`/`jti` proof-of-possession claims.
#[cfg(test)]
fn verify_device_proof(
    proof: &str,
    refresh_token: &str,
    expected_thumbprint: &str,
    expected_path: &str,
) -> Result<(), FastApiError> {
    verify_device_proof_at(
        proof,
        refresh_token,
        expected_thumbprint,
        expected_path,
        chrono::Utc::now().timestamp(),
    )
}

fn verify_device_proof_at(
    proof: &str,
    refresh_token: &str,
    expected_thumbprint: &str,
    expected_path: &str,
    now: i64,
) -> Result<(), FastApiError> {
    // `jwt.get_unverified_header(proof)`: a malformed token is an invalid proof.
    let header = unverified_header(proof)?;

    // `header.get("jwk") or {}` -> `_validated_device_public_key` (its 400s
    // propagate; a non-string component is the outer 401).
    let jwk = header
        .get("jwk")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let public_key = validated_device_public_key(&jwk)?;

    if header.get("alg").and_then(serde_json::Value::as_str) != Some("ES256") {
        return Err(invalid_device_proof());
    }
    if device_key_thumbprint(&public_key) != expected_thumbprint {
        return Err(proof_does_not_match());
    }

    let payload = decode_device_proof_at(proof, &public_key, now)?;

    if !proof_binding_valid(&payload, refresh_token, expected_path, now) {
        return Err(invalid_device_proof());
    }
    Ok(())
}

/// The `iat`/`htm`/`htu`/`ath`/`jti` proof-of-possession binding of a verified
/// device proof to this exact request.
fn proof_binding_valid(
    payload: &serde_json::Value,
    refresh_token: &str,
    expected_path: &str,
    now: i64,
) -> bool {
    let expected_ath = token_hash(refresh_token);
    payload
        .get("iat")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|issued_at| {
            i128::from(issued_at) <= i128::from(now) + i128::from(DEVICE_PROOF_FUTURE_SKEW_SECONDS)
                && i128::from(now) - i128::from(issued_at)
                    <= i128::from(DEVICE_PROOF_MAX_AGE_SECONDS)
        })
        && payload.get("htm").and_then(serde_json::Value::as_str) == Some("POST")
        && payload.get("htu").and_then(serde_json::Value::as_str) == Some(expected_path)
        && payload.get("ath").and_then(serde_json::Value::as_str) == Some(expected_ath.as_str())
        && payload
            .get("jti")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|jti| !jti.is_empty())
}

/// The validated EC P-256 device public key: the `kty`/`crv` literals and the
/// original base64url `x`/`y` strings used for the RFC 7638 thumbprint, plus
/// their decoded 32-byte coordinates for signature verification.
#[derive(Debug)]
struct DevicePublicKey {
    kty: &'static str,
    crv: &'static str,
    x: String,
    y: String,
    x_bytes: Vec<u8>,
    y_bytes: Vec<u8>,
}

/// `_validated_device_public_key`: require `EC`/`P-256` and 32-byte `x`/`y`.
///
/// A missing or non-`EC`/`P-256` `kty`/`crv` is the source's 400; a component
/// that is not a string is the outer 401; a component that fails to decode or
/// is not 32 bytes is the 400 invalid-key body.
fn validated_device_public_key(jwk: &serde_json::Value) -> Result<DevicePublicKey, FastApiError> {
    let kty = jwk.get("kty").and_then(serde_json::Value::as_str);
    let crv = jwk.get("crv").and_then(serde_json::Value::as_str);
    if kty != Some("EC") || crv != Some("P-256") {
        return Err(ec_p256_required());
    }
    let x_value = jwk
        .get("x")
        .cloned()
        .unwrap_or(serde_json::Value::String(String::new()));
    let y_value = jwk
        .get("y")
        .cloned()
        .unwrap_or(serde_json::Value::String(String::new()));
    let x_bytes = device_component(&x_value)?;
    if x_bytes.len() != 32 {
        return Err(invalid_device_public_key());
    }
    let y_bytes = device_component(&y_value)?;
    if y_bytes.len() != 32 {
        return Err(invalid_device_public_key());
    }
    Ok(DevicePublicKey {
        kty: "EC",
        crv: "P-256",
        x: x_value.as_str().unwrap_or_default().to_string(),
        y: y_value.as_str().unwrap_or_default().to_string(),
        x_bytes,
        y_bytes,
    })
}

/// `_base64url_decode` for one JWK coordinate: a non-string value is the outer
/// 401 (`TypeError`), a bad base64 value is the 400 invalid-key body.
fn device_component(value: &serde_json::Value) -> Result<Vec<u8>, FastApiError> {
    let Some(encoded) = value.as_str() else {
        return Err(invalid_device_proof());
    };
    decode_b64url(encoded).ok_or_else(invalid_device_public_key)
}

/// `_device_key_thumbprint`: RFC 7638 JWK thumbprint — the SHA-256 of the
/// canonical `{"crv","kty","x","y"}` object, base64url without padding.
fn device_key_thumbprint(key: &DevicePublicKey) -> String {
    let canonical = serde_json::json!({
        "crv": key.crv,
        "kty": key.kty,
        "x": key.x,
        "y": key.y,
    })
    .to_string();
    base64url_nopad(&sha256(canonical.as_bytes()))
}

/// `jwt.decode(proof, public_key, algorithms=["ES256"])`.
#[cfg(test)]
fn decode_device_proof(
    proof: &str,
    key: &DevicePublicKey,
) -> Result<serde_json::Value, FastApiError> {
    decode_device_proof_at(proof, key, chrono::Utc::now().timestamp())
}

fn decode_device_proof_at(
    proof: &str,
    key: &DevicePublicKey,
    now: i64,
) -> Result<serde_json::Value, FastApiError> {
    let x = base64url_nopad(&key.x_bytes);
    let y = base64url_nopad(&key.y_bytes);
    let decoding = DecodingKey::from_ec_components(&x, &y).map_err(|_| invalid_device_proof())?;
    jsonwebtoken::decode::<serde_json::Value>(proof, &decoding, &jose_validation(Algorithm::ES256))
        .map_err(|_| invalid_device_proof())
        .and_then(|data| {
            if jose_claims_valid(&data.claims, now) {
                Ok(data.claims)
            } else {
                Err(invalid_device_proof())
            }
        })
}

/// `jwt.get_unverified_header(proof)`: base64url-decode the header segment and
/// parse it as a JSON object; any failure is the invalid-proof 401.
fn unverified_header(proof: &str) -> Result<serde_json::Value, FastApiError> {
    let encoded = proof.split('.').next().unwrap_or_default();
    let decoded = decode_b64url(encoded).ok_or_else(invalid_device_proof)?;
    let header: serde_json::Value =
        serde_json::from_slice(&decoded).map_err(|_| invalid_device_proof())?;
    if !header.is_object() {
        return Err(invalid_device_proof());
    }
    Ok(header)
}

/// `_token_hash`: base64url(SHA-256(token)) without padding.
fn token_hash(token: &str) -> String {
    base64url_nopad(&sha256(token.as_bytes()))
}

/// SHA-256 digest bytes.
fn sha256(bytes: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().to_vec()
}

/// Base64url encoding without padding.
fn base64url_nopad(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `base64.urlsafe_b64decode(value + padding)`: base64url with optional
/// padding; `None` on any decode failure.
fn decode_b64url(value: &str) -> Option<Vec<u8>> {
    let padded_len = value.len().div_ceil(4) * 4;
    let mut padded = String::with_capacity(padded_len);
    padded.push_str(value);
    while padded.len() < padded_len {
        padded.push('=');
    }
    base64::engine::general_purpose::URL_SAFE
        .decode(padded.as_bytes())
        .ok()
}

/// `401 {"detail":"Desktop login has expired"}` — a refresh token that fails
/// signature, algorithm, or `exp` validation.
fn desktop_login_expired() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Desktop login has expired",
    )
}

/// `401 {"detail":"Invalid desktop refresh token"}` — a well-formed token with
/// the wrong `token_use`, a missing `cnf.jkt`, or a non-string `sub`.
fn invalid_refresh_token() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Invalid desktop refresh token",
    )
}

/// `401 {"detail":"Invalid desktop device proof"}` — malformed header, wrong
/// algorithm, bad signature, or failed request-binding claims.
fn invalid_device_proof() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Invalid desktop device proof",
    )
}

/// `401 {"detail":"Desktop device proof does not match this login"}` — the
/// proof key's thumbprint differs from the token's `cnf.jkt`.
fn proof_does_not_match() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Desktop device proof does not match this login",
    )
}

/// `401 {"detail":"Desktop login is no longer valid"}` — missing, inactive, or
/// mismatched user.
fn desktop_login_no_longer_valid() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNAUTHORIZED,
        "Desktop login is no longer valid",
    )
}

/// `400 {"detail":"Invalid device public key"}` — a `x`/`y` that fails to
/// decode or is not 32 bytes.
fn invalid_device_public_key() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::BAD_REQUEST,
        "Invalid device public key",
    )
}

/// `400 {"detail":"Device public key must use EC P-256"}` — `kty`/`crv` are
/// not `EC`/`P-256` (including a missing key).
fn ec_p256_required() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::BAD_REQUEST,
        "Device public key must use EC P-256",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::EncodingKey;

    /// A P-256 public key used to exercise the device-proof path. The point is
    /// a fixture this test owns, not a recorded device key.
    const TEST_X: &str = "3U-k2GEMmfSW3dt5XILfIMNxegJD_5sE80AXI0-ieis";
    const TEST_Y: &str = "Tr09EqkhWeDE1A8uNEreIDNJrCdx4LYbCW85bHctaFE";
    /// RFC 7638 thumbprint of `TEST_X`/`TEST_Y` (computed independently).
    const TEST_THUMBPRINT: &str = "BsUQbhzgf_g0rn4ifY0HR7JUwvkuGORlEJ3oi6vweEU";
    /// An ES256 JWS over `{"htm":"POST","htu":"/api/auth/wework/refresh",...}`
    /// signed by the private key for the fixture above.
    const TEST_PROOF: &str = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImp3ayI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6IjNVLWsyR0VNbWZTVzNkdDVYSUxmSU1OeGVnSkRfNXNFODBBWEkwLWllaXMiLCJ5IjoiVHIwOUVxa2hXZURFMUE4dU5FcmVJRE5KckNkeDRMWWJDVzg1YkhjdGFGRSJ9fQ.eyJodG0iOiJQT1NUIiwiaHR1IjoiL2FwaS9hdXRoL3dld29yay9yZWZyZXNoIiwiaWF0IjoxLCJqdGkiOiJqdGktMSIsImF0aCI6InVIcjNQd3RpdmdTM3ViazNvd2w0czZ1NFpEbnVzTTRCREprVmdQNGJqdjgifQ.uSLoKub1pZbsubyS0QiKoWDgArgoJzQCBa9JnlbgK5IGbw-NByUcyWH-8cNpLb6D4RVTF7lUAZDPPcd3h-h51g";

    fn test_device_key() -> DevicePublicKey {
        DevicePublicKey {
            kty: "EC",
            crv: "P-256",
            x: TEST_X.to_string(),
            y: TEST_Y.to_string(),
            x_bytes: decode_b64url(TEST_X).unwrap(),
            y_bytes: decode_b64url(TEST_Y).unwrap(),
        }
    }

    fn refresh_config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn signed_refresh_token(claims: serde_json::Value) -> String {
        create_token("test-key", "HS256", claims).unwrap()
    }

    #[test]
    fn device_key_thumbprint_matches_rfc7638() {
        assert_eq!(device_key_thumbprint(&test_device_key()), TEST_THUMBPRINT);
    }

    #[test]
    fn token_hash_is_base64url_sha256_without_padding() {
        assert_eq!(
            token_hash("sample-refresh-token"),
            "uHr3PwtivgS3ubk3owl4s6u4ZDnusM4BDJkVgP4bjv8"
        );
    }

    #[test]
    fn decode_b64url_accepts_optional_padding() {
        assert_eq!(decode_b64url("AAAA").unwrap(), vec![0, 0, 0]);
        assert_eq!(decode_b64url("AA").unwrap(), vec![0]);
        assert!(decode_b64url("!!!").is_none());
    }

    #[test]
    fn refresh_response_matches_the_source_shape() {
        assert_eq!(
            serde_json::to_string(&WeworkTokenRefreshResponse {
                access_token: "t".to_string(),
                token_type: "bearer",
                expires_in: 604_800,
            })
            .unwrap(),
            r#"{"access_token":"t","token_type":"bearer","expires_in":604800}"#
        );
    }

    #[test]
    fn refresh_request_requires_both_string_fields() {
        let ok: WeworkTokenRefreshRequest =
            serde_json::from_str(r#"{"refresh_token":"a","proof":"b"}"#).unwrap();
        assert_eq!((ok.refresh_token.as_str(), ok.proof.as_str()), ("a", "b"));
        assert!(
            serde_json::from_str::<WeworkTokenRefreshRequest>(r#"{"refresh_token":"a"}"#).is_err()
        );
        assert!(serde_json::from_str::<WeworkTokenRefreshRequest>(r#"{"proof":"b"}"#).is_err());
    }

    #[test]
    fn decode_refresh_token_gates_on_token_use() {
        let config = refresh_config();
        let future = chrono::Utc::now().timestamp() + 3600;
        let valid = signed_refresh_token(serde_json::json!({
            "sub": "u", "user_id": 7, "token_use": "wework_refresh", "exp": future
        }));
        let claims = decode_refresh_token(&config, &valid).unwrap();
        assert_eq!(claims["sub"], "u");
        assert_eq!(claims["user_id"], 7);

        let wrong_use = signed_refresh_token(serde_json::json!({
            "sub": "u", "token_use": "wework_access", "exp": future
        }));
        assert_eq!(
            decode_refresh_token(&config, &wrong_use)
                .unwrap_err()
                .detail_message(),
            Some("Invalid desktop refresh token")
        );
    }

    #[test]
    fn decode_refresh_token_rejects_expired_and_foreign_tokens() {
        let config = refresh_config();
        // python-jose validates `exp` with no leeway.
        let expired = signed_refresh_token(serde_json::json!({
            "sub": "u", "token_use": "wework_refresh",
            "exp": chrono::Utc::now().timestamp() - 10
        }));
        assert_eq!(
            decode_refresh_token(&config, &expired)
                .unwrap_err()
                .detail_message(),
            Some("Desktop login has expired")
        );
        // A token signed with a different key fails verification.
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"other-key".as_ref());
        let foreign = jsonwebtoken::encode(
            &header,
            &serde_json::json!({
                "sub": "u", "token_use": "wework_refresh",
                "exp": chrono::Utc::now().timestamp() + 3600
            }),
            &key,
        )
        .unwrap();
        assert_eq!(
            decode_refresh_token(&config, &foreign)
                .unwrap_err()
                .detail_message(),
            Some("Desktop login has expired")
        );
    }

    /// `python-jose` does not require `exp`; an absent claim is not rejected.
    #[test]
    fn decode_refresh_token_accepts_tokens_without_exp() {
        let token = signed_refresh_token(serde_json::json!({
            "sub": "u", "token_use": "wework_refresh"
        }));
        assert!(decode_refresh_token(&refresh_config(), &token).is_ok());
    }

    #[test]
    fn decode_device_proof_verifies_es256_signature() {
        let key = test_device_key();
        let claims = decode_device_proof(TEST_PROOF, &key).unwrap();
        assert_eq!(claims["htu"], REFRESH_PATH);
        // A tampered signature segment is rejected.
        let mut tampered = TEST_PROOF.to_string();
        tampered.push('A');
        assert!(decode_device_proof(&tampered, &key).is_err());
    }

    #[test]
    fn validated_device_public_key_classifies_errors() {
        assert_eq!(
            validated_device_public_key(&serde_json::json!({}))
                .unwrap_err()
                .detail_message(),
            Some("Device public key must use EC P-256")
        );
        // A non-string coordinate is the outer invalid-proof 401.
        assert_eq!(
            validated_device_public_key(&serde_json::json!({
                "kty": "EC", "crv": "P-256", "x": 1, "y": "AA"
            }))
            .unwrap_err()
            .detail_message(),
            Some("Invalid desktop device proof")
        );
        // A short coordinate is the 400 invalid-key body.
        assert_eq!(
            validated_device_public_key(&serde_json::json!({
                "kty": "EC", "crv": "P-256", "x": "AAAA", "y": "AAAA"
            }))
            .unwrap_err()
            .detail_message(),
            Some("Invalid device public key")
        );
    }

    #[test]
    fn verify_device_proof_requires_an_ec_p256_jwk() {
        let header = base64url_nopad(br#"{"alg":"ES256"}"#.as_ref());
        let token = format!("{header}.e30.AAAA");
        assert_eq!(
            verify_device_proof(&token, "t", "thumb", REFRESH_PATH)
                .unwrap_err()
                .detail_message(),
            Some("Device public key must use EC P-256")
        );
    }

    #[test]
    fn verify_device_proof_rejects_non_es256_algorithm() {
        let jwk = serde_json::json!({
            "kty": "EC", "crv": "P-256", "x": TEST_X, "y": TEST_Y
        });
        let header = base64url_nopad(
            serde_json::json!({ "alg": "HS256", "jwk": jwk })
                .to_string()
                .as_bytes(),
        );
        let token = format!("{header}.e30.AAAA");
        assert_eq!(
            verify_device_proof(&token, "t", TEST_THUMBPRINT, REFRESH_PATH)
                .unwrap_err()
                .detail_message(),
            Some("Invalid desktop device proof")
        );
    }

    #[test]
    fn verify_device_proof_enforces_thumbprint_and_binding() {
        // The fixture proof is bound to `sample-refresh-token` but its `iat` is
        // far in the past, so the binding check rejects it.
        assert_eq!(
            verify_device_proof(
                TEST_PROOF,
                "sample-refresh-token",
                TEST_THUMBPRINT,
                REFRESH_PATH
            )
            .unwrap_err()
            .detail_message(),
            Some("Invalid desktop device proof")
        );
        // A mismatched thumbprint is rejected before the signature is checked.
        assert_eq!(
            verify_device_proof(TEST_PROOF, "sample-refresh-token", "other", REFRESH_PATH)
                .unwrap_err()
                .detail_message(),
            Some("Desktop device proof does not match this login")
        );
    }

    #[test]
    fn proof_binding_requires_current_iat_and_exact_request() {
        let now = 1_000_000_i64;
        let good = serde_json::json!({
            "iat": now, "htm": "POST", "htu": REFRESH_PATH,
            "ath": token_hash("tok"), "jti": "j"
        });
        assert!(proof_binding_valid(&good, "tok", REFRESH_PATH, now));

        let mut p = good.clone();
        p["iat"] = (now + 31).into();
        assert!(!proof_binding_valid(&p, "tok", REFRESH_PATH, now));
        let mut p = good.clone();
        p["iat"] = (now - 301).into();
        assert!(!proof_binding_valid(&p, "tok", REFRESH_PATH, now));
        let mut p = good.clone();
        p["iat"] = serde_json::json!(1.5);
        assert!(!proof_binding_valid(&p, "tok", REFRESH_PATH, now));
        let mut p = good.clone();
        p["htu"] = "/api/other".into();
        assert!(!proof_binding_valid(&p, "tok", REFRESH_PATH, now));
        let mut p = good.clone();
        p["jti"] = "".into();
        assert!(!proof_binding_valid(&p, "tok", REFRESH_PATH, now));
        assert!(!proof_binding_valid(&good, "other", REFRESH_PATH, now));
    }
}

#[cfg(test)]
#[path = "wework_auth_refresh/compat_tests.rs"]
mod compat_tests;
