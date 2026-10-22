// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Browser-native download-token credential resolution for the attachment
//! download exit (`app/api/endpoints/adapter/attachments.py:
//! _resolve_user_from_download_token`).
//!
//! `POST /api/attachments/{attachment_id}/download-token` mints a
//! short-lived HS256 token (`DOWNLOAD_TOKEN_EXPIRE_SECONDS = 300`) carrying
//! `scope=attachment_download`, the attachment id, the issuing user
//! (`user_id` and `sub`), and a `download`/`playback` purpose. The download
//! endpoint accepts that token through the `download_token` query parameter
//! and resolves it back to the issuing `users` row.
//!
//! Signing and decoding use the active key only (`settings.SECRET_KEY`
//! with `settings.ALGORITHM`), unlike the session path's active-then-legacy
//! rotation. Every decode, claim, and user failure is one indistinguishable
//! outcome that the caller renders as `401 {"detail": "Invalid download
//! token"}`; a database failure is not an authentication failure.
//!
//! Re-opened 2026-10-12 (round 5): after merging canonical 140f28ffd (which
//! applied the smart-apps download response_jwt rule), the download-token
//! port was re-verified with no behavior change; this note only changes the
//! target fingerprint for a fresh handoff.

use super::auth::UserRow;
use crate::config::AuthConfig;
use brz_mysql::MysqlResult;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::Deserialize;

/// `DOWNLOAD_TOKEN_SCOPE`.
const DOWNLOAD_TOKEN_SCOPE: &str = "attachment_download";

/// `DOWNLOAD_TOKEN_EXPIRE_SECONDS`: the minted token's lifetime.
pub const DOWNLOAD_TOKEN_EXPIRE_SECONDS: i64 = 300;

/// The `purpose` claim for a browser-native download token.
pub const DOWNLOAD_PURPOSE: &str = "download";

/// The `purpose` claim the attachment playback proxy URL embeds so the
/// download endpoint streams the resolved media inline.
pub const PLAYBACK_PURPOSE: &str = "playback";

/// The token claims in the source `jwt.encode` payload's key order.
#[derive(serde::Serialize)]
struct IssuedDownloadTokenClaims<'a> {
    scope: &'a str,
    attachment_id: i64,
    user_id: i32,
    sub: &'a str,
    purpose: &'a str,
    exp: i64,
}

/// `_create_download_token`: a short-lived HS256 JWT carrying the download
/// scope, the attachment id, the issuing user (`user_id`/`sub`), a purpose,
/// and an `exp` `DOWNLOAD_TOKEN_EXPIRE_SECONDS` in the future. `None` when
/// signing fails (the caller renders the source's unhandled 500).
pub fn create_download_token(
    config: &AuthConfig,
    attachment_id: i64,
    user_id: i32,
    user_name: &str,
    purpose: &str,
) -> Option<String> {
    let claims = IssuedDownloadTokenClaims {
        scope: DOWNLOAD_TOKEN_SCOPE,
        attachment_id,
        user_id,
        sub: user_name,
        purpose,
        exp: chrono::Utc::now().timestamp() + DOWNLOAD_TOKEN_EXPIRE_SECONDS,
    };
    encode(
        &Header::new(super::auth::algorithm(config)),
        &claims,
        &EncodingKey::from_secret(config.jwt_key.as_bytes()),
    )
    .ok()
}

/// The `AttachmentAccessPurpose` a resolved credential selects. `Share` is
/// produced only by the share-token method and `Preview` only by the session
/// method's `purpose=preview` override (never by a download-token claim);
/// both otherwise share `Download`'s policy probe but stream inline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadPurpose {
    Download,
    Playback,
    Share,
    Preview,
}

/// A resolved download token: the issuing user and the requested purpose.
pub struct AttachmentDownloadToken {
    pub user: UserRow,
    pub purpose: DownloadPurpose,
}

/// The download-token claim set. Every claim is optional because a token
/// carrying an unexpected shape must fail the claim checks rather than the
/// decoder; `exp` is consumed by `jsonwebtoken`'s validation and is not read
/// here.
#[derive(Debug, Deserialize)]
struct DownloadTokenClaims {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    attachment_id: Option<i64>,
    #[serde(default)]
    user_id: Option<i32>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    purpose: Option<String>,
    #[serde(default)]
    #[allow(dead_code, reason = "validated by jsonwebtoken, not read directly")]
    exp: Option<i64>,
}

/// `jwt.decode(download_token, settings.SECRET_KEY,
/// algorithms=[settings.ALGORITHM])`: a present `exp`/`nbf` is validated with
/// no leeway and neither is a required claim, matching PyJWT's default decode
/// options. `jsonwebtoken` otherwise defaults to a 60-second leeway and skips
/// `nbf`, which would accept a download token the source rejects.
fn decode_download_token(config: &AuthConfig, token: &str) -> Option<DownloadTokenClaims> {
    let mut validation = Validation::new(super::auth::algorithm(config));
    validation.validate_aud = false;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.leeway = 0;
    validation.required_spec_claims.clear();
    let key = DecodingKey::from_secret(config.jwt_key.as_bytes());
    decode::<DownloadTokenClaims>(token, &key, &validation)
        .ok()
        .map(|data| data.claims)
}

/// `payload.get("purpose", "download")` followed by the source's
/// `purpose not in {"download", "playback"}` rejection.
fn purpose_from_claim(purpose: Option<&str>) -> Option<DownloadPurpose> {
    match purpose.unwrap_or("download") {
        "download" => Some(DownloadPurpose::Download),
        "playback" => Some(DownloadPurpose::Playback),
        _ => None,
    }
}

/// `_resolve_user_from_download_token`: `Ok(Some(...))` for an accepted
/// token, `Ok(None)` for every source 401 (decode failure, scope or
/// attachment mismatch, unusable purpose, or no matching active user), and
/// `Err` only when the `users` lookup itself fails.
pub async fn resolve_user_from_download_token(
    config: &AuthConfig,
    mysql: &brz_mysql::MysqlService,
    attachment_id: i64,
    token: &str,
) -> MysqlResult<Option<AttachmentDownloadToken>> {
    let Some(claims) = decode_download_token(config, token) else {
        return Ok(None);
    };
    if claims.scope.as_deref() != Some(DOWNLOAD_TOKEN_SCOPE)
        || claims.attachment_id != Some(attachment_id)
    {
        return Ok(None);
    }
    let Some(purpose) = purpose_from_claim(claims.purpose.as_deref()) else {
        return Ok(None);
    };
    let (Some(user_id), Some(user_name)) = (claims.user_id, claims.sub.as_deref()) else {
        return Ok(None);
    };
    let user: Option<UserRow> = mysql
        .fetch_optional(USER_BY_DOWNLOAD_TOKEN_QUERY, (user_id, user_name))
        .await?;
    Ok(user.map(|user| AttachmentDownloadToken { user, purpose }))
}

/// `db.query(User).filter(User.id == payload["user_id"], User.user_name ==
/// payload["sub"], User.is_active == True).first()`: every mapped column,
/// aliased `users_<column>` like SQLAlchemy's labeled rendering.
const USER_BY_DOWNLOAD_TOKEN_QUERY: &str = "SELECT users.id AS users_id, \
     users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.user_name = ? AND users.is_active = true \
     LIMIT 1";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthConfig;
    use jsonwebtoken::{Algorithm, EncodingKey, Header};

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: vec!["legacy-key".to_string()],
            algorithm: "HS256".to_string(),
        }
    }

    fn token_for(claims: serde_json::Value, key: &str) -> String {
        jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .unwrap()
    }

    fn claims(exp: i64) -> serde_json::Value {
        serde_json::json!({
            "scope": "attachment_download",
            "attachment_id": 42,
            "user_id": 7,
            "sub": "user",
            "purpose": "download",
            "exp": exp,
        })
    }

    /// A future `exp` keeps the token alive for the claim checks; the decode
    /// helper must not reject it on time alone.
    fn future_exp() -> i64 {
        chrono::Utc::now().timestamp() + 300
    }

    #[test]
    fn accepts_the_issued_claim_set() {
        let decoded =
            decode_download_token(&config(), &token_for(claims(future_exp()), "test-key"))
                .expect("decodes");
        assert_eq!(decoded.scope.as_deref(), Some(DOWNLOAD_TOKEN_SCOPE));
        assert_eq!(decoded.attachment_id, Some(42));
        assert_eq!(decoded.user_id, Some(7));
        assert_eq!(decoded.sub.as_deref(), Some("user"));
    }

    /// `exp` is enforced with no leeway: the recorded tokens expire five
    /// minutes after they are minted, so an elapsed token is rejected.
    #[test]
    fn rejects_an_elapsed_token() {
        let elapsed = chrono::Utc::now().timestamp() - 1;
        assert!(
            decode_download_token(&config(), &token_for(claims(elapsed), "test-key")).is_none()
        );
    }

    /// Only the active key decodes a download token; the session path's
    /// legacy rotation does not apply here.
    #[test]
    fn rejects_the_legacy_key() {
        let token = token_for(claims(future_exp()), "legacy-key");
        assert!(decode_download_token(&config(), &token).is_none());
    }

    #[test]
    fn rejects_a_different_algorithm() {
        let token = jsonwebtoken::encode(
            &Header::new(Algorithm::HS384),
            &claims(future_exp()),
            &EncodingKey::from_secret(b"test-key"),
        )
        .unwrap();
        assert!(decode_download_token(&config(), &token).is_none());
    }

    #[test]
    fn purpose_claims_map_to_the_source_set() {
        assert_eq!(
            purpose_from_claim(None),
            Some(DownloadPurpose::Download),
            "an absent purpose defaults to download"
        );
        assert_eq!(
            purpose_from_claim(Some("download")),
            Some(DownloadPurpose::Download)
        );
        assert_eq!(
            purpose_from_claim(Some("playback")),
            Some(DownloadPurpose::Playback)
        );
        assert_eq!(purpose_from_claim(Some("share")), None);
        assert_eq!(purpose_from_claim(Some("")), None);
    }

    /// The minted token carries exactly the source claim set, signs with the
    /// active key, and expires `DOWNLOAD_TOKEN_EXPIRE_SECONDS` from now; the
    /// existing decoder accepts it.
    #[test]
    fn mints_a_token_the_decoder_accepts() {
        let before = chrono::Utc::now().timestamp();
        let token = create_download_token(&config(), 1373657, 626, "hanlin10", DOWNLOAD_PURPOSE)
            .expect("signs");
        let decoded = decode_download_token(&config(), &token).expect("decodes");
        assert_eq!(decoded.scope.as_deref(), Some(DOWNLOAD_TOKEN_SCOPE));
        assert_eq!(decoded.attachment_id, Some(1373657));
        assert_eq!(decoded.user_id, Some(626));
        assert_eq!(decoded.sub.as_deref(), Some("hanlin10"));
        assert_eq!(decoded.purpose.as_deref(), Some("download"));
        let exp = decoded.exp.expect("exp present");
        assert!(
            (before + DOWNLOAD_TOKEN_EXPIRE_SECONDS..=before + DOWNLOAD_TOKEN_EXPIRE_SECONDS + 2)
                .contains(&exp),
            "exp {exp} is not now + {DOWNLOAD_TOKEN_EXPIRE_SECONDS}"
        );
    }

    /// A recorded statement with the inline literals swapped for bound
    /// parameters: the target SQL must stay token-identical after whitespace
    /// normalization.
    #[test]
    fn user_query_matches_the_recorded_statement() {
        let recorded = "SELECT users.id AS users_id, users.user_name AS users_user_name, users.password_hash AS users_password_hash, users.email AS users_email, users.git_info AS users_git_info, users.is_active AS users_is_active, users.`role` AS users_role, users.auth_source AS users_auth_source, users.preferences AS users_preferences, users.created_at AS users_created_at, users.updated_at AS users_updated_at \nFROM users \nWHERE users.id = 7 AND users.user_name = 'user' AND users.is_active = true \n LIMIT 1";
        fn tokens(sql: &str) -> Vec<String> {
            sql.split_whitespace()
                .map(|token| match token {
                    "7" => "?".to_string(),
                    "'user'" => "?".to_string(),
                    other => other.to_string(),
                })
                .collect()
        }
        assert_eq!(tokens(USER_BY_DOWNLOAD_TOKEN_QUERY), tokens(recorded));
    }
}
