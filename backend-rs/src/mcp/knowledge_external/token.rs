// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! External document download-token verification
//! (`app/services/knowledge/external_document_access.py`:
//! `verify_document_download_token`).
//!
//! `wegent_kb_get_document_download` mints a short-lived HS256 token
//! (`DOCUMENT_DOWNLOAD_TOKEN_EXPIRES_SECONDS = 300`) carrying the token type,
//! the issuing user, the document, the disposition, and the download-exempt
//! flag. The file endpoint accepts it through the `X-Wegent-Download-Token`
//! header and re-verifies it here: `decode_pyjwt` tries the active signing
//! key and then the configured legacy decode-only keys, matching PyJWT's
//! default validation (no leeway, `exp` and `nbf` enforced, no audience
//! requirement). Every decode or claim failure is one indistinguishable
//! `None` that the endpoint renders as `401 {"error": "Invalid or expired
//! download token", "code": "unauthorized"}`.

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

use crate::config::AuthConfig;

/// `DOCUMENT_DOWNLOAD_TOKEN_TYPE`.
const DOCUMENT_DOWNLOAD_TOKEN_TYPE: &str = "external_knowledge_document_download";
/// `ALLOWED_DOWNLOAD_DISPOSITIONS`.
const ALLOWED_DOWNLOAD_DISPOSITIONS: [&str; 2] = ["inline", "attachment"];

/// A verified `DocumentDownloadToken` payload.
pub(crate) struct DocumentDownloadToken {
    pub(crate) user_id: i64,
    pub(crate) document_id: i64,
    pub(crate) disposition: String,
    pub(crate) document_download_exempt: bool,
}

/// The download-token claim set. Every claim is optional so a token carrying
/// an unexpected shape fails the source's claim checks instead of the
/// decoder; `exp` is consumed by `jsonwebtoken`'s validation.
#[derive(Debug, Deserialize)]
struct DocumentDownloadTokenClaims {
    #[serde(default, rename = "type")]
    token_type: Option<String>,
    #[serde(default)]
    user_id: Option<i64>,
    #[serde(default)]
    document_id: Option<i64>,
    #[serde(default)]
    disposition: Option<String>,
    #[serde(default)]
    document_download_exempt: Option<bool>,
    #[serde(default)]
    #[allow(dead_code, reason = "validated by jsonwebtoken, not read directly")]
    exp: Option<i64>,
}

/// `settings.ALGORITHM` (`app/core/config.py`); `HS256` by default.
fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// `decode_pyjwt(token, algorithms=[settings.ALGORITHM])` with PyJWT's
/// default options: `exp`/`nbf` are validated with no leeway when present and
/// neither is required, and no audience is required.
fn decode_claims(config: &AuthConfig, token: &str) -> Option<DocumentDownloadTokenClaims> {
    let mut validation = Validation::new(algorithm(config));
    validation.validate_aud = false;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.leeway = 0;
    validation.required_spec_claims.clear();

    let mut keys: Vec<&str> = vec![config.jwt_key.as_str()];
    for key in &config.legacy_jwt_keys {
        if !keys.contains(&key.as_str()) {
            keys.push(key.as_str());
        }
    }
    keys.into_iter().find_map(|key| {
        decode::<DocumentDownloadTokenClaims>(
            token,
            &DecodingKey::from_secret(key.as_bytes()),
            &validation,
        )
        .ok()
        .map(|data| data.claims)
    })
}

/// `verify_document_download_token`: the verified payload, or `None` for a
/// decode failure, a wrong token type, a non-positive `user_id`/`document_id`,
/// an unknown disposition, or a non-boolean exemption flag.
pub(crate) fn verify_document_download_token(
    config: &AuthConfig,
    token: &str,
) -> Option<DocumentDownloadToken> {
    let claims = decode_claims(config, token)?;
    if claims.token_type.as_deref() != Some(DOCUMENT_DOWNLOAD_TOKEN_TYPE) {
        return None;
    }
    // `type(user_id) is not int or user_id <= 0`: serde already rejects a
    // non-integer JSON scalar, so only the sign check remains.
    let user_id = claims.user_id.filter(|id| *id > 0)?;
    let document_id = claims.document_id.filter(|id| *id > 0)?;
    let disposition = claims.disposition?;
    if !ALLOWED_DOWNLOAD_DISPOSITIONS.contains(&disposition.as_str()) {
        return None;
    }
    Some(DocumentDownloadToken {
        user_id,
        document_id,
        disposition,
        document_download_exempt: claims.document_download_exempt.unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token(claims: serde_json::Value) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"test-key"),
        )
        .expect("signs")
    }

    fn claim_set(exp_offset: i64) -> serde_json::Value {
        json!({
            "type": DOCUMENT_DOWNLOAD_TOKEN_TYPE,
            "user_id": 5831,
            "document_id": 30830,
            "disposition": "attachment",
            "document_download_exempt": false,
            "exp": chrono::Utc::now().timestamp() + exp_offset,
        })
    }

    #[test]
    fn accepts_the_recorded_download_token_shape() {
        let verified =
            verify_document_download_token(&config(), &token(claim_set(300))).expect("verifies");
        assert_eq!(verified.user_id, 5831);
        assert_eq!(verified.document_id, 30830);
        assert_eq!(verified.disposition, "attachment");
        assert!(!verified.document_download_exempt);
    }

    #[test]
    fn missing_exemption_defaults_to_false() {
        let mut claims = claim_set(300);
        claims
            .as_object_mut()
            .unwrap()
            .remove("document_download_exempt");
        let verified = verify_document_download_token(&config(), &token(claims)).expect("verifies");
        assert!(!verified.document_download_exempt);
    }

    #[test]
    fn rejects_elapsed_non_positive_and_mismatched_claims() {
        assert!(verify_document_download_token(&config(), &token(claim_set(-1))).is_none());

        let mut zero_user = claim_set(300);
        zero_user["user_id"] = json!(0);
        assert!(verify_document_download_token(&config(), &token(zero_user)).is_none());

        let mut wrong_type = claim_set(300);
        wrong_type["type"] = json!("session");
        assert!(verify_document_download_token(&config(), &token(wrong_type)).is_none());

        let mut wrong_disposition = claim_set(300);
        wrong_disposition["disposition"] = json!("preview");
        assert!(verify_document_download_token(&config(), &token(wrong_disposition)).is_none());

        let mut bad_exempt = claim_set(300);
        bad_exempt["document_download_exempt"] = json!(1);
        assert!(verify_document_download_token(&config(), &token(bad_exempt)).is_none());

        let mut missing_document = claim_set(300);
        missing_document
            .as_object_mut()
            .unwrap()
            .remove("document_id");
        assert!(verify_document_download_token(&config(), &token(missing_document)).is_none());
    }

    #[test]
    fn rejects_a_token_signed_with_another_key() {
        let forged = encode(
            &Header::new(Algorithm::HS256),
            &claim_set(300),
            &EncodingKey::from_secret(b"other-key"),
        )
        .expect("signs");
        assert!(verify_document_download_token(&config(), &forged).is_none());
    }
}
