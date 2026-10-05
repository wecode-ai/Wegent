// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_stream_external_attachment`: the external media playback stage of the
//! attachment download endpoints.
//!
//! The source resolves an attachment whose bytes live outside local storage
//! through the registered external account playback resolvers
//! (`app/services/attachment/external_storage.py`), then stream-proxies the
//! resolved media URL (`_stream_remote_media`). The resolvers are
//! application-owned: the open-source deployment registers none
//! (`_playback_resolvers` is empty), so the stage resolves nothing and the
//! caller keeps its local-bytes path, while the internal deployment registers
//! the external media resolver. [`ExternalMediaRelay`] carries that split without
//! putting internal media knowledge in this crate, mirroring
//! [`crate::media_policy::MediaPolicy`].
//!
//! Ownership: the relay owns the resolver decision and the relay itself. A
//! transport failure of the relayed media, or any other exception the source
//! does not convert into an `HTTPException`, is the application's unhandled
//! error and is rendered by
//! [`FastApiError::unhandled`](crate::http_compat::FastApiError::unhandled).
use std::pin::Pin;

use async_trait::async_trait;
use brz_http_server::{Binary, Bytes, HttpResponse, IntoHttpResponse as _};
use futures_util::Stream;

use crate::http_compat::FastApiError;

/// The relayed remote media body: upstream chunks streamed to the client
/// (`_stream_remote_media`'s `aiter_bytes` `StreamingResponse`).
pub type MediaStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static>>;

/// The outcome of one download response: local bytes for the stored
/// attachment path, or the relayed external media stream.
pub enum AttachmentDownload {
    /// `_stream_stored_attachment`: bytes read from the configured backend.
    Binary(HttpResponse<Binary>),
    /// `_stream_remote_media`: the resolved playback relayed to the client.
    Stream(HttpResponse<MediaStream>),
}

impl From<HttpResponse<Binary>> for AttachmentDownload {
    fn from(response: HttpResponse<Binary>) -> Self {
        Self::Binary(response)
    }
}

// A bare `AttachmentDownload` converts through the `Direct` category: each
// variant already holds a built response. The enum does not implement
// `Serialize`, so these impls are the only applicable conversions.
impl brz_http_server::IntoHttpError for AttachmentDownload {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Binary(response) => response.into_http_response(arena),
            Self::Stream(response) => response.into_http_response(arena),
        }
    }
}

impl brz_http_server::IntoHttpResponse<brz_http_server::__private::kind::Direct>
    for AttachmentDownload
{
    fn into_http_response(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Binary(response) => response.into_http_response(arena),
            Self::Stream(response) => response.into_http_response(arena),
        }
    }
}

/// The `type_data` facts the registered playback resolvers read.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ExternalMediaReference {
    /// The stored media reference: `(media_type, media_id)` of a persisted
    /// external upload, `None` when the attachment carries none.
    pub media_reference: Option<(&'static str, String)>,
    /// The legacy playback resolver's file-platform `fid`.
    pub legacy_fid: Option<String>,
    /// `context.mime_type`, the legacy playback's default media type.
    pub mime_type: String,
}

impl ExternalMediaReference {
    /// `_resolve_attachment_playback`'s `type_data` projection: the facts the
    /// registered playback resolvers read from one `subtask_contexts` row.
    /// Every attachment download endpoint that runs the external media stage
    /// builds its request from this projection.
    #[must_use]
    pub(crate) fn from_context(context: &super::context_store::SubtaskContextRow) -> Self {
        let metadata = context.metadata();
        Self {
            media_reference: metadata
                .and_then(super::context_store::AttachmentMetadata::stored_media_reference),
            legacy_fid: metadata
                .and_then(super::context_store::AttachmentMetadata::legacy_weibo_fid),
            mime_type: context.mime_type(),
        }
    }
}

/// The attachment facts the resolver chain reads
/// (`resolve_external_attachment_playback(type_data=..., user_id=...)` plus
/// the filename the relay forwards).
pub struct ExternalMediaRequest<'a> {
    pub attachment_id: i64,
    pub user_id: i64,
    /// `context.original_filename`, the relayed `Content-Disposition` name.
    pub original_filename: &'a str,
    /// The `type_data` projection the resolvers read.
    pub reference: ExternalMediaReference,
}

/// `_stream_external_attachment(context)`.
#[async_trait]
pub trait ExternalMediaRelay: Send + Sync {
    /// Resolves the attachment's playback and relays the media.
    ///
    /// - `Ok(None)` — no resolver matched the attachment; the caller falls
    ///   through to the external-media policy and the stored bytes.
    /// - `Ok(Some(response))` — the relayed media response.
    /// - `Err(error)` — the source's error mapping: a resolver failure is
    ///   `502 External media playback URL is unavailable`, a blocked URL is
    ///   `502 Invalid remote media URL`, and a relay transport failure stays
    ///   the application's unhandled 500.
    async fn stream_external_attachment(
        &self,
        request: ExternalMediaRequest<'_>,
    ) -> Result<Option<AttachmentDownload>, FastApiError>;
}

/// The open-source deployment's relay: `_playback_resolvers` has no
/// registrations, so `_stream_external_attachment` always returns `None`.
pub struct NoExternalMediaRelay;

#[async_trait]
impl ExternalMediaRelay for NoExternalMediaRelay {
    async fn stream_external_attachment(
        &self,
        _request: ExternalMediaRequest<'_>,
    ) -> Result<Option<AttachmentDownload>, FastApiError> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::context_store::SubtaskContextRow;
    use brz_mysql::Json;
    use serde_json::{Value, json};

    fn context_row(context_type: &str, type_data: Value) -> SubtaskContextRow {
        SubtaskContextRow {
            id: 1351364,
            subtask_id: 272678883838578,
            user_id: 1984,
            context_type: context_type.to_string(),
            name: "video_272678883838529_272678883838578.mp4".to_string(),
            status: "ready".to_string(),
            error_message: None,
            binary_data: Vec::new(),
            image_base64: None,
            extracted_text: None,
            text_length: 0,
            type_data: Some(Json(type_data.into())),
            created_at: None,
            updated_at: None,
        }
    }

    #[tokio::test]
    async fn the_default_relay_resolves_nothing() {
        // `_playback_resolvers` is empty in the open-source deployment.
        let relayed = NoExternalMediaRelay
            .stream_external_attachment(ExternalMediaRequest {
                attachment_id: 1,
                user_id: 2,
                original_filename: "clip.mp4",
                reference: ExternalMediaReference::default(),
            })
            .await
            .expect("no resolver");
        assert!(relayed.is_none());
    }

    /// A recorded external video attachment: its persisted
    /// `weibo_video_upload.media_id` is the stored media reference that routes
    /// the download to the external media stage instead of the stored bytes.
    #[test]
    fn a_persisted_weibo_upload_yields_the_stored_media_reference() {
        let context = context_row(
            "attachment",
            json!({
                "mime_type": "video/mp4",
                "file_extension": ".mp4",
                "storage_backend": "weibo_video_hosting",
                "video_metadata": {
                    "fid": "1000000000000001",
                    "media_id": "1000000000000002",
                    "video_url": "http://video.example.invalid/o0/clip",
                },
                "weibo_video_upload": {
                    "fid": "1000000000000001",
                    "media_id": "1000000000000002",
                    "upload_id": "",
                },
            }),
        );
        let reference = ExternalMediaReference::from_context(&context);
        assert_eq!(
            reference.media_reference,
            Some(("video", "1000000000000002".to_string()))
        );
        // The legacy playback resolver requires the `weibo` storage backend,
        // which `weibo_video_hosting` is not.
        assert_eq!(reference.legacy_fid, None);
        assert_eq!(reference.mime_type, "video/mp4");
    }

    /// A `video_metadata.media_id` without an explicit upload reference still
    /// resolves as a video (the stored media reference's metadata fallback).
    #[test]
    fn video_metadata_media_id_is_a_stored_media_reference_fallback() {
        let context = context_row(
            "attachment",
            json!({"video_metadata": {"media_id": 7}, "storage_backend": "mysql"}),
        );
        assert_eq!(
            ExternalMediaReference::from_context(&context).media_reference,
            Some(("video", "7".to_string()))
        );
    }

    /// The legacy path only arms for the `weibo` storage backend; an ordinary
    /// attachment carries neither reference and keeps the stored-bytes path.
    #[test]
    fn the_legacy_fid_requires_the_weibo_storage_backend() {
        let legacy = context_row(
            "attachment",
            json!({"storage_backend": "weibo", "fid": "1000000000000002"}),
        );
        let reference = ExternalMediaReference::from_context(&legacy);
        assert_eq!(reference.media_reference, None);
        assert_eq!(reference.legacy_fid, Some("1000000000000002".to_string()));

        let ordinary = context_row("attachment", json!({"storage_backend": "mysql"}));
        let reference = ExternalMediaReference::from_context(&ordinary);
        assert_eq!(reference.media_reference, None);
        assert_eq!(reference.legacy_fid, None);
    }
}
