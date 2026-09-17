// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/download/shared` — public share-link
//! download (`app/api/endpoints/adapter/attachments.py:public_download_attachment`).
//!
//! Source pipeline (`public_download_attachment`):
//! 1. `_verify_public_share_token` (`verify_public_attachment_token`): a
//!    python-jose HS256 decode with the active `SECRET_KEY` (no legacy
//!    key rotation here), `exp` validated when present and no audience
//!    required. Failure, a missing/non-integer `attachment_id`, a `purpose`
//!    other than `public_attachment_download`, or a missing `nonce` all map
//!    to 403 `{"detail": "Invalid or expired share link"}`.
//! 2. `context_service.get_context_optional` (the labeled
//!    `subtask_contexts` SELECT by id): 404 `Attachment not found` when the
//!    row is absent or `context_type != 'attachment'`. No ownership check —
//!    the token alone grants access.
//! 3. `application media download policy` (video extension with
//!    the `external account` storage backend -> 400). The registered external playback
//!    resolvers are empty in this deployment (`_playback_resolvers` has no
//!    registrations), so `_stream_external_attachment` is always `None`.
//! 4. `_stream_stored_attachment`: re-fetch the context
//!    (`asyncio.to_thread`, a second `subtask_contexts` SELECT), load the
//!    bytes from the configured `ATTACHMENT_STORAGE_BACKEND` (`mysql`
//!    binary_data or the MinIO/S3 object store), decrypt when
//!    `is_encrypted`, and stream with
//!    `Content-Disposition`/`Content-Length`/`X-Accel-Buffering: no` headers.
use std::borrow::Cow;
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_http_server::{Binary, HttpResponse};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

use super::context_store;
use super::minio_client::MinioConfig;
use super::storage;
use crate::config::AuthConfig;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

/// `PUBLIC_ATTACHMENT_PURPOSE` (`app/services/attachment/public_link.py`):
/// the single purpose value a public share token may carry.
const PUBLIC_ATTACHMENT_PURPOSE: &str = "public_attachment_download";

/// 403 `{"detail": "Invalid or expired share link"}`: the endpoint's error
/// for every token failure (invalid signature, expired, wrong purpose,
/// missing attachment_id, missing nonce).
fn invalid_share_link() -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(StatusCode::FORBIDDEN, "Invalid or expired share link")
}

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

/// 404 `{"detail": "Attachment not found"}`.
fn attachment_not_found() -> crate::http_compat::FastApiError {
    error_response(StatusCode::NOT_FOUND, "Attachment not found")
}

fn storage_failure() -> crate::http_compat::FastApiError {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to retrieve attachment data",
    )
}

fn internal_error() -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
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

fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// `verify_public_attachment_token`: decode with the active
/// `SECRET_KEY` only (`jwt.decode(token, settings.SECRET_KEY,
/// algorithms=[settings.ALGORITHM])`; unlike `decode_jose_jwt`, no legacy
/// key rotation). `exp` is validated when present (python-jose default) and
/// no audience is required. Returns the verified `attachment_id`.
fn verify_public_share_token(config: &AuthConfig, token: &str) -> Option<i64> {
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

/// `_build_content_disposition` (shared with the download handler): ASCII
/// filenames get a quoted `filename="..."` (backslash and quote escaped);
/// non-ASCII filenames use RFC 5987 `filename*=UTF-8''<percent-encoded>`.
fn build_content_disposition(filename: &str) -> String {
    if filename.is_ascii() {
        let escaped = filename.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("attachment; filename=\"{escaped}\"");
    }
    format!("attachment; filename*=UTF-8''{}", percent_encode(filename))
}

/// RFC 3986 percent-encoding with no safe characters (`quote(filename,
/// safe="")`).
fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// Handler body for `GET /api/attachments/download/shared`.
pub(super) async fn public_download_attachment(
    state: &Arc<AppState>,
    token: &str,
) -> Result<HttpResponse<Binary>, crate::http_compat::FastApiError> {
    // `_verify_public_share_token`.
    let Some(attachment_id) = verify_public_share_token(&state.auth, token) else {
        return Err(invalid_share_link());
    };

    // `get_context_optional` (no permission check — the token is
    // sufficient).
    let context = match context_store::get_context_optional(&state.mysql, attachment_id).await {
        Ok(context) => context,
        Err(error) => {
            tracing::error!(%error, "shared attachment context lookup failed");
            return Err(internal_error());
        }
    };
    let Some(context) = context else {
        return Err(attachment_not_found());
    };
    if context.context_type != CONTEXT_TYPE_ATTACHMENT {
        return Err(attachment_not_found());
    }

    // `application media download policy`. `_stream_external_
    // attachment` resolves through the registered playback resolvers, which
    // this deployment never registers, so it is always `None` and produces
    // no dependency calls.
    if state.media_policy.download_unsupported(
        &context.context_type,
        &context.file_extension(),
        &context.storage_backend(),
    ) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Video attachments are stored externally and cannot be downloaded \
             through this endpoint",
        ));
    }

    // `_stream_stored_attachment`: re-fetch the context in the storage
    // worker, then load the bytes from the configured backend.
    let stored = match context_store::get_context_optional(&state.mysql, attachment_id).await {
        Ok(stored) => stored,
        Err(error) => {
            tracing::error!(%error, "shared attachment storage refetch failed");
            return Err(storage_failure());
        }
    };
    let Some(stored) = stored else {
        return Err(storage_failure());
    };
    let minio = minio_config_from_env();
    let bytes = match storage::get_attachment_binary_data(
        &state.mysql,
        &state.attachment_http,
        minio.as_ref(),
        &stored,
    )
    .await
    {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(storage_failure()),
        Err(error) => {
            tracing::error!(%error, "shared attachment storage read failed");
            return Err(storage_failure());
        }
    };

    let media_type = stored.mime_type();
    let media_type = if media_type.is_empty() {
        Cow::Borrowed("application/octet-stream")
    } else {
        Cow::Owned(media_type)
    };
    let filename = stored.original_filename();
    let content_disposition = build_content_disposition(&filename);

    let response = HttpResponse::new(Binary::new(bytes))
        .header("content-type", media_type.as_ref())
        .map_err(attachment_header_error)?
        .header("content-disposition", &content_disposition)
        .map_err(attachment_header_error)?
        .header("x-accel-buffering", "no")
        .map_err(attachment_header_error)?;
    Ok(response)
}

/// Maps a response-header construction failure to a 500.
fn attachment_header_error(
    error: brz_http_server::HeaderBlockError,
) -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

/// `get_storage_backend` configuration for the `minio`/`s3` backends
/// (`ATTACHMENT_S3_*`); `None` when not configured, leaving the `mysql`
/// backend in effect. Reads the same environment/dotenv names as the other
/// attachment download handlers.
fn minio_config_from_env() -> Option<MinioConfig> {
    let endpoint = crate::config::env_or_dotenv("ATTACHMENT_S3_ENDPOINT").unwrap_or_default();
    let access_key = crate::config::env_or_dotenv("ATTACHMENT_S3_ACCESS_KEY").unwrap_or_default();
    let secret_key = crate::config::env_or_dotenv("ATTACHMENT_S3_SECRET_KEY").unwrap_or_default();
    if endpoint.is_empty() || access_key.is_empty() || secret_key.is_empty() {
        return None;
    }
    Some(MinioConfig {
        endpoint,
        access_key,
        secret_key,
        bucket: crate::config::env_or_dotenv("ATTACHMENT_S3_BUCKET")
            .unwrap_or_else(|| "attachments".to_string()),
        region: crate::config::env_or_dotenv("ATTACHMENT_S3_REGION")
            .unwrap_or_else(|| "us-east-1".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::EncodingKey;
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

    #[test]
    fn ascii_filenames_use_quoted_disposition() {
        // The recorded Content-Disposition for attachment 1287754.
        assert_eq!(
            build_content_disposition("5a45906495f67b996f55cacccb753ba0.jpeg"),
            "attachment; filename=\"5a45906495f67b996f55cacccb753ba0.jpeg\""
        );
    }
}
