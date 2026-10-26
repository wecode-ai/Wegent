// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/{attachment_id}/playback`
//! (`app/api/endpoints/adapter/attachments.py:get_attachment_playback`).
//!
//! The route returns fresh browser playback metadata for a media attachment.
//! Authentication is the public shared-task `share_token` (403 when it does
//! not grant access) or the bearer session JWT (401 when neither credential is
//! present); the context resolution is `_get_attachment_context`, the shared
//! knowledge-document download policy runs with the `playback` purpose, and
//! the registered external playback resolver supplies the media URL.
//!
//! A resolver that reports `direct` delivery returns its URL verbatim; every
//! other attachment falls back to this service's `download` URL carrying a
//! short-lived `playback` credential.

use std::sync::Arc;

use brz_http_server::StatusCode;

use super::auth::UserRow;
use super::context_store;
use super::download_token;
use super::external_media::{ExternalMediaReference, PlaybackDeliveryMode};
use crate::state::AppState;

/// `AttachmentPlaybackResponse`: Pydantic serializes the fields in
/// declaration order with `None` as `null`.
#[derive(serde::Serialize)]
pub struct AttachmentPlaybackResponse {
    pub playback_url: String,
    pub cover_url: Option<String>,
}

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

fn attachment_not_found() -> crate::http_compat::FastApiError {
    error_response(StatusCode::NOT_FOUND, "Attachment not found")
}

fn internal_error() -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// `_resolve_attachment_playback`'s converted resolver failure.
fn playback_unavailable() -> crate::http_compat::FastApiError {
    error_response(
        StatusCode::BAD_GATEWAY,
        "External media playback URL is unavailable",
    )
}

/// Handler body for `GET /api/attachments/{attachment_id}/playback`.
pub(super) async fn attachment_playback(
    state: &Arc<AppState>,
    attachment_id: i64,
    share_token: Option<&str>,
    user: Option<&UserRow>,
) -> Result<AttachmentPlaybackResponse, crate::http_compat::FastApiError> {
    // A present `share_token` selects the public shared-task method; an empty
    // parameter is falsy in the source and falls through to the session JWT.
    let context = match share_token.filter(|token| !token.is_empty()) {
        Some(token) => {
            let has_access =
                super::share_token::validate_share_token_access(state, attachment_id, token)
                    .await?;
            if !has_access {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Share token access denied",
                ));
            }
            // The granted viewer re-reads the context directly; the source
            // does not re-check the `attachment` context type here.
            match context_store::get_context_optional(&state.mysql, attachment_id).await {
                Ok(Some(context)) => context,
                Ok(None) => return Err(attachment_not_found()),
                Err(error) => {
                    tracing::error!(%error, "attachment playback context lookup failed");
                    return Err(internal_error());
                }
            }
        }
        None => match user {
            Some(user) => {
                super::handler::get_attachment_context(state, attachment_id, user.users_id).await?
            }
            None => {
                return Err(error_response(
                    StatusCode::UNAUTHORIZED,
                    "Authentication required",
                ));
            }
        },
    };

    // `_require_attachment_download_allowed(db, context, "playback")`.
    let file_extension = context.file_extension();
    match super::download_policy::require_attachment_download_allowed(
        &state.mysql,
        attachment_id,
        &context.mime_type(),
        Some(&file_extension),
        super::download_policy::Purpose::Playback,
    )
    .await
    {
        Ok(None) => {}
        Ok(Some(error)) => return Err(error),
        Err(error) => {
            tracing::error!(%error, "attachment playback policy check failed");
            return Err(internal_error());
        }
    }

    // `_resolve_attachment_playback`: the application-owned resolver chain;
    // every resolver failure becomes the source's 502.
    let reference = ExternalMediaReference::from_context(&context);
    let playback = match state
        .external_playback
        .resolve_playback_url(&reference, i64::from(context.user_id))
        .await
    {
        Ok(playback) => playback,
        Err(error) => {
            tracing::error!(?error, "attachment playback resolution failed");
            return Err(playback_unavailable());
        }
    };

    // `external_playback.cover_url or _attachment_cover_url(context)`: an
    // empty resolver cover is falsy and falls back to the stored cover.
    let cover_url = playback
        .as_ref()
        .and_then(|playback| playback.cover_url.clone())
        .filter(|cover| !cover.is_empty())
        .or_else(|| context.attachment_cover_url());

    if let Some(playback) =
        playback.filter(|playback| playback.delivery_mode == PlaybackDeliveryMode::Direct)
    {
        return Ok(AttachmentPlaybackResponse {
            playback_url: playback.url,
            cover_url,
        });
    }

    // `context_service.build_attachment_url(attachment_id)` plus the
    // browser-native credential the download endpoint accepts.
    let mut proxy_url = crate::attachment_block::build_attachment_download_url(attachment_id);
    match share_token.filter(|token| !token.is_empty()) {
        Some(token) => {
            proxy_url.push_str("?share_token=");
            proxy_url.push_str(&percent_encode(token));
        }
        None => {
            let Some(user) = user else {
                // The session branch guarantees a user; a missing one is the
                // source's unhandled attribute error.
                return Err(internal_error());
            };
            let token = download_token::create_download_token(
                &state.auth,
                attachment_id,
                user.users_id,
                &user.users_user_name,
                download_token::PLAYBACK_PURPOSE,
            )
            .ok_or_else(|| {
                tracing::error!("attachment playback token mint failed");
                internal_error()
            })?;
            proxy_url.push_str("?download_token=");
            proxy_url.push_str(&percent_encode(&token));
        }
    }
    Ok(AttachmentPlaybackResponse {
        playback_url: proxy_url,
        cover_url,
    })
}

/// `urllib.parse.quote(value, safe="")`: percent-encode every byte except the
/// unreserved set (`quote`'s default `/` safe character is removed by the
/// explicit `safe=""`).
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A recording-shaped `GET /api/attachments/*/playback` body: Pydantic
    /// declaration order with `cover_url: null`.
    const RECORDED_PLAYBACK_URL: &str = "https://media.example.test/recorded/playback.mp4";

    #[test]
    fn renders_the_recorded_playback_body_in_field_order() {
        let response = AttachmentPlaybackResponse {
            playback_url: RECORDED_PLAYBACK_URL.to_string(),
            cover_url: None,
        };
        let body = serde_json::to_string(&response).expect("playback response serializes");
        assert_eq!(
            body,
            format!("{{\"playback_url\":\"{RECORDED_PLAYBACK_URL}\",\"cover_url\":null}}")
        );
        assert_eq!(body.len(), 84);
    }

    #[test]
    fn percent_encodes_like_python_quote_with_empty_safe() {
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a-b.c_d~e"), "a-b.c_d~e");
        // `safe=""` encodes `/`, unlike the filename helper.
        assert_eq!(percent_encode("a/b"), "a%2Fb");
        assert_eq!(percent_encode("示例"), "%E7%A4%BA%E4%BE%8B");
    }

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/attachments/:attachment_id/playback";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/attachments/42/playback"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
