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

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
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

/// `verify_docx_export_download_token`. Returns the bound user id when the
/// token is valid for this task and filter.
pub(crate) fn verify_download_token(
    config: &AuthConfig,
    token: &str,
    task_id: i64,
    message_ids: Option<&str>,
) -> Option<i64> {
    let mut validation = Validation::new(match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    });
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
