// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-owned seams for `POST /api/attachments/upload`.
//!
//! `context_service.upload_attachment` resolves two application-owned pieces
//! the open-source deployment does not know about:
//!
//! - the object-storage backend selected by `ATTACHMENT_STORAGE_BACKEND`
//!   (`mysql`, `minio` or `s3`); deployments may supply another implementation;
//! - a best-effort image upload for accepted image types
//!   through the configured application-owned media service.
//!
//! [`AttachmentUploadBackend`] carries that split without putting internal
//! media-service knowledge in this crate, mirroring
//! [`crate::attachments::external_media::ExternalMediaRelay`]. The public
//! default keeps bytes in `subtask_contexts.binary_data`. The configured S3
//! backend uses real signed object writes; neither uploads images elsewhere.
use async_trait::async_trait;

/// The metadata the source image upload produces.
#[derive(Debug, Clone)]
pub struct ImagePid {
    /// The reusable picture id (`image_pid`).
    pub pid: String,
}

/// `StorageBackend.save` inputs: the generated storage key, the (already
/// encrypted) object bytes, and the metadata the backend forwards.
pub struct StoreObjectRequest<'a> {
    /// `generate_storage_key(...)`: `attachments/{uuid}_{ts}_{user}_{id}`.
    pub key: &'a str,
    /// `b"".join(...)` / `encrypt_attachment(...)`: the bytes to store.
    pub data: &'a [u8],
    /// The original filename metadata (`x-amz-meta-filename`).
    pub filename: &'a str,
    /// `context.mime_type`, the object content type.
    pub mime_type: &'a str,
    /// `context.user_id` (`x-amz-meta-user_id`).
    pub user_id: i64,
}

/// Inputs of the source image-upload service's upload call.
pub struct ImageUploadRequest<'a> {
    pub filename: &'a str,
    pub content: &'a [u8],
    pub mime_type: &'a str,
    /// `users.preferences`, read by the source media-uid resolver.
    pub preferences: &'a str,
}

/// `StorageError` / an upload-transport failure.
#[derive(Debug)]
pub struct UploadBackendError;

impl std::fmt::Display for UploadBackendError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("attachment upload backend failure")
    }
}

/// The configured storage backend plus the image-upload capability.
#[async_trait]
pub trait AttachmentUploadBackend: Send + Sync {
    /// Provider label stored alongside a successfully uploaded image id.
    fn image_pid_source(&self) -> &'static str {
        "image_upload"
    }

    /// Provider label for video metadata whose bytes are stored externally.
    fn video_metadata_storage_backend(&self) -> &'static str {
        "external"
    }

    /// `StorageBackend.backend_type`: `"mysql"` keeps bytes in
    /// `subtask_contexts.binary_data`; any other value stores them externally.
    fn backend_type(&self) -> &str;

    /// `get_storage_backend`'s backend construction. The MinIO backend probes
    /// the bucket (`HEAD /{bucket}`) here; the MySQL backend is a no-op.
    async fn ensure_ready(&self) -> Result<(), UploadBackendError>;

    /// `StorageBackend.save`. `Ok(true)` means the object was stored
    /// externally, so the caller clears `binary_data`; `Ok(false)` keeps the
    /// bytes in the database row.
    async fn store_object(
        &self,
        request: StoreObjectRequest<'_>,
    ) -> Result<bool, UploadBackendError>;

    /// The source image upload; `None` when the content is not a
    /// supported image or the upload fails (the source's best-effort failure).
    async fn upload_image_pid(&self, request: ImageUploadRequest<'_>) -> Option<ImagePid>;

    /// `StorageBackend.delete`: remove one stored object. `Ok(false)` marks a
    /// failed removal that the source logs without blocking a row deletion;
    /// the MySQL backend keeps the bytes in the row, so it has nothing to
    /// remove and reports success.
    async fn delete_object(&self, key: &str) -> Result<bool, UploadBackendError>;
}

/// The open-source default: `ATTACHMENT_STORAGE_BACKEND=mysql` and no image
/// upload.
pub struct MySqlStorageBackend;

#[async_trait]
impl AttachmentUploadBackend for MySqlStorageBackend {
    fn backend_type(&self) -> &str {
        "mysql"
    }

    async fn ensure_ready(&self) -> Result<(), UploadBackendError> {
        Ok(())
    }

    async fn store_object(
        &self,
        _request: StoreObjectRequest<'_>,
    ) -> Result<bool, UploadBackendError> {
        Ok(false)
    }

    async fn upload_image_pid(&self, _request: ImageUploadRequest<'_>) -> Option<ImagePid> {
        None
    }

    async fn delete_object(&self, _key: &str) -> Result<bool, UploadBackendError> {
        Ok(true)
    }
}
