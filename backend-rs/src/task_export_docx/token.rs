// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! DOCX export download-token verification
//! (`app.services.auth.docx_export_download_token`).
//!
//! The token is a short-lived HS256 JWT bound to one task, user, and
//! `message_ids` filter. `verify_docx_export_download_token` decodes it with
//! the session signing key, checks the token type, task id, message-ids
//! digest, and user claims, and returns the bound user id.

use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::AuthConfig;

pub(crate) const DOCX_EXPORT_TOKEN_TYPE: &str = "docx_export_download_token";

/// Claims carried by a DOCX export download token.
#[derive(Debug, Deserialize)]
pub(crate) struct DownloadTokenClaims {
    #[serde(rename = "type")]
    pub token_type: String,
    pub task_id: i64,
    pub user_id: i64,
    #[allow(
        dead_code,
        reason = "present in the signed payload; only user_id is consumed"
    )]
    pub user_name: String,
    pub message_ids_hash: Option<String>,
    /// Validated by the decoder; not read by application code.
    #[serde(default)]
    #[allow(dead_code, reason = "validated by jsonwebtoken, not read directly")]
    pub exp: Option<i64>,
}

/// `message_ids_hash`: SHA-256 of the normalized comma-separated filter, or
/// `None` when the filter is absent or empty.
pub(crate) fn message_ids_hash(message_ids: Option<&str>) -> Option<String> {
    let normalized = message_ids?;
    let ids = normalized
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    if ids.is_empty() {
        return None;
    }
    let digest = Sha256::digest(ids.as_bytes());
    Some(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// Signing algorithm from settings (`HS256`).
fn signing_algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// `verify_docx_export_download_token`. Returns the bound user id when the
/// token is valid for this task and filter.
pub(crate) fn verify_download_token(
    config: &AuthConfig,
    token: &str,
    task_id: i64,
    message_ids: Option<&str>,
) -> Option<i64> {
    let mut validation = Validation::new(signing_algorithm(config));
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    let decoded = decode::<DownloadTokenClaims>(
        token,
        &DecodingKey::from_secret(config.jwt_key.as_bytes()),
        &validation,
    )
    .ok()?;
    let claims = decoded.claims;
    if claims.token_type != DOCX_EXPORT_TOKEN_TYPE {
        return None;
    }
    if claims.task_id != task_id {
        return None;
    }
    if claims.message_ids_hash.as_deref() != message_ids_hash(message_ids).as_deref() {
        return None;
    }
    Some(claims.user_id)
}

/// Claims of a newly minted token (`create_docx_export_download_token`). The
/// field order mirrors the source payload so the signed JSON matches.
#[derive(Debug, Serialize)]
struct NewDownloadTokenClaims<'a> {
    #[serde(rename = "type")]
    token_type: &'a str,
    task_id: i64,
    user_id: i64,
    user_name: &'a str,
    message_ids_hash: Option<String>,
    exp: i64,
}

/// `create_docx_export_download_token`: a fresh token bound to one task, user,
/// and `message_ids` filter, valid for `expires_in_minutes` from now.
pub(crate) fn create_download_token(
    config: &AuthConfig,
    task_id: i64,
    user_id: i64,
    user_name: &str,
    message_ids: Option<&str>,
    expires_in_minutes: i64,
) -> Option<String> {
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(expires_in_minutes)).timestamp();
    let claims = NewDownloadTokenClaims {
        token_type: DOCX_EXPORT_TOKEN_TYPE,
        task_id,
        user_id,
        user_name,
        message_ids_hash: message_ids_hash(message_ids),
        exp,
    };
    jsonwebtoken::encode(
        &Header::new(signing_algorithm(config)),
        &claims,
        &EncodingKey::from_secret(config.jwt_key.as_bytes()),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use jsonwebtoken::EncodingKey;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token(claims: serde_json::Value) -> String {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"test-key"),
        )
        .unwrap()
    }

    #[test]
    fn message_ids_hash_matches_source_digest() {
        assert_eq!(
            message_ids_hash(Some("1,2,3,4")),
            Some("37db36876b9ccaaa88394679f019c3435af9320dea117e867003840317870e25".to_string())
        );
        assert_eq!(message_ids_hash(None), None);
        assert_eq!(message_ids_hash(Some("")), None);
    }

    #[test]
    fn verifies_token_bound_to_task_and_filter() {
        let claims = serde_json::json!({
            "type": "docx_export_download_token",
            "task_id": 193651485592388_i64,
            "user_id": 1001,
            "user_name": "bob",
            "message_ids_hash": message_ids_hash(Some("1,2,3,4")),
        });
        let token = token(claims);
        assert_eq!(
            verify_download_token(&config(), &token, 193651485592388, Some("1,2,3,4")),
            Some(1001)
        );
        assert_eq!(
            verify_download_token(&config(), &token, 193651485592388, Some("2,3")),
            None
        );
        assert_eq!(
            verify_download_token(&config(), &token, 42, Some("1,2,3,4")),
            None
        );
    }

    #[test]
    fn rejects_foreign_signing_key_and_wrong_type() {
        let foreign = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            &serde_json::json!({
                "type": "docx_export_download_token",
                "task_id": 1_i64,
                "user_id": 1,
                "user_name": "u",
            }),
            &EncodingKey::from_secret(b"other-key"),
        )
        .unwrap();
        assert_eq!(verify_download_token(&config(), &foreign, 1, None), None);

        let wrong_type = token(serde_json::json!({
            "type": "other",
            "task_id": 1_i64,
            "user_id": 1,
            "user_name": "u",
        }));
        assert_eq!(verify_download_token(&config(), &wrong_type, 1, None), None);
    }

    #[test]
    fn created_token_round_trips_through_the_verifier() {
        let token = create_download_token(&config(), 21577915845327, 157, "sifang", Some("1,2"), 5)
            .unwrap();
        assert_eq!(
            verify_download_token(&config(), &token, 21577915845327, Some("1,2")),
            Some(157)
        );
        // A different filter or task is rejected by the bound claims.
        assert_eq!(
            verify_download_token(&config(), &token, 21577915845327, None),
            None
        );
        assert_eq!(
            verify_download_token(&config(), &token, 1, Some("1,2")),
            None
        );
    }

    #[test]
    fn created_payload_matches_the_source_claim_order_and_types() {
        let token = create_download_token(&config(), 21577915845327, 157, "sifang", Some("1,2"), 5)
            .unwrap();
        let payload = token.split('.').nth(1).unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "docx_export_download_token",
                "task_id": 21577915845327_i64,
                "user_id": 157,
                "user_name": "sifang",
                "message_ids_hash": message_ids_hash(Some("1,2")),
                "exp": value["exp"],
            })
        );
        assert!(value["exp"].is_i64());
    }
}
