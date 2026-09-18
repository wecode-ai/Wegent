// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/attachments/{attachment_id}/download` — file download
//! (`app/api/endpoints/adapter/attachments.py:download_attachment`).
//!
//! Source pipeline (JWT method, the recorded path):
//! 1. `security.get_current_user_optional`: verify the Bearer session JWT
//!    (`decode_jose_jwt` active key then legacy keys, `is_user_session_payload`)
//!    and load the `users` row by name; missing/invalid/inactive -> `None`.
//! 2. `_get_attachment_context`: `context_service.get_context_optional`
//!    (`SELECT ... FROM subtask_contexts WHERE id = ? LIMIT 1`), 404 when
//!    absent or `context_type != 'attachment'`.
//! 3. `_ensure_attachment_access`: uploader, task owner/member (via the
//!    subtask linkage), knowledge-base ACL, or the owner-fallback subtask
//!    probe; no access -> 404 `Attachment not found`.
//! 4. `_require_attachment_download_allowed`: the knowledge-document
//!    download policy probe (`download_policy.rs`).
//! 5. `_stream_external_attachment` -> `resolve_external_attachment_playback`
//!    (the registered external account media resolvers; playback metadata absent for
//!    ordinary attachments -> `None`).
//! 6. `application media download policy` (video extension with the
//!    `external account` storage backend -> 400).
//! 7. Generated-video `video_metadata.video_url` proxy streaming.
//! 8. `_stream_stored_attachment`: re-fetch the context
//!    (`asyncio.to_thread`, a second `subtask_contexts` SELECT), load the
//!    bytes from the configured `ATTACHMENT_STORAGE_BACKEND`
//!    (`mysql` binary_data or the MinIO/S3 object store), decrypt when
//!    `is_encrypted`, and stream with
//!    `Content-Disposition`/`Content-Length`/`X-Accel-Buffering: no` headers.
//!
//! The download-token, share-token, and anonymous-browser-redirect methods
//! share steps 2-8; the recorded case uses the JWT method.
//!
//! `GET /api/attachments/download/shared` (`public_download_attachment`)
//! is the public share-link variant: a signed token in the `token` query
//! parameter replaces user authentication and ownership checks entirely.

pub mod auth;
pub mod context_store;
pub mod detail;
pub mod detail_response;
pub mod download_policy;
pub mod executor_download;
pub mod handler;
pub mod minio_client;
pub mod s3_signing;
pub mod shared_download;
pub mod storage;
