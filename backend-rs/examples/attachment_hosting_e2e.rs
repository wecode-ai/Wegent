// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! A real application-owned media adapter for the public hosting contract.
//! ffprobe validates media and S3StorageBackend writes to an actual MinIO bucket.
//! The ordinary store deliberately points at a missing bucket: hosted uploads
//! can succeed only when the production handler bypasses its default path.
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wegent_backend_rs::{
    Application, AttachmentUploadBackend, BoxError, ExternalAttachmentStorageResult,
    ExternalAttachmentUploadError, ExternalAttachmentUploadRequest, HybridConfig, ImagePid,
    ImageUploadRequest, MinioConfig, S3StorageBackend, StoreObjectRequest, UploadBackendError,
    build_app_state, run_hybrid,
};

struct MediaHosting {
    media: S3StorageBackend,
    ordinary: S3StorageBackend,
}

fn inspect_media(content: Vec<u8>, mime: String) -> Result<Value, ExternalAttachmentUploadError> {
    let mut child = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type:format=duration",
            "-of",
            "json",
            "-i",
            "pipe:0",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ExternalAttachmentUploadError::Unavailable)?;
    let _ = child.stdin.take().expect("piped stdin").write_all(&content);
    let output = child
        .wait_with_output()
        .map_err(|_| ExternalAttachmentUploadError::Unavailable)?;
    let metadata: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    let media_type = mime.split('/').next().unwrap_or("");
    let matching_stream = metadata["streams"].as_array().is_some_and(|streams| {
        streams
            .iter()
            .any(|stream| stream["codec_type"] == media_type)
    });
    if !output.status.success() || !matching_stream {
        return Err(ExternalAttachmentUploadError::InvalidInput(
            "The file is not valid video or audio".to_owned(),
        ));
    }
    Ok(metadata)
}

#[async_trait]
impl AttachmentUploadBackend for MediaHosting {
    fn external_storage_backend(&self, mime: &str, purpose: &str) -> Option<&str> {
        // Videos support both purposes; audio hosting is intentionally default-only.
        (mime == "video/mp4" || (mime == "audio/wav" && purpose == "default"))
            .then_some("media_minio")
    }

    async fn store_external_attachment(
        &self,
        request: ExternalAttachmentUploadRequest<'_>,
    ) -> Result<ExternalAttachmentStorageResult, ExternalAttachmentUploadError> {
        let content = request.content.to_vec();
        let mime = request.mime_type.to_owned();
        let metadata = tokio::task::spawn_blocking(move || inspect_media(content, mime))
            .await
            .map_err(|_| ExternalAttachmentUploadError::Unavailable)??;
        let sha256 = format!("{:x}", Sha256::digest(request.content));
        let key = format!("media/{}/{sha256}", request.user_id);
        self.media
            .store_object(StoreObjectRequest {
                key: &key,
                data: request.content,
                filename: request.filename,
                mime_type: request.mime_type,
                user_id: request.user_id,
            })
            .await
            .map_err(|_| ExternalAttachmentUploadError::Unavailable)?;
        Ok(ExternalAttachmentStorageResult {
            backend_type: "media_minio".to_owned(),
            storage_key: key.clone(),
            type_data: json!({"hosted_media": {
                "media_id": key,
                "owner_id": request.user_id,
                "sha256": sha256,
                "probe": metadata,
            }})
            .as_object()
            .expect("object")
            .clone(),
        })
    }

    fn backend_type(&self) -> &str {
        self.ordinary.backend_type()
    }
    async fn ensure_ready(&self) -> Result<(), UploadBackendError> {
        self.ordinary.ensure_ready().await
    }
    async fn store_object(
        &self,
        request: StoreObjectRequest<'_>,
    ) -> Result<bool, UploadBackendError> {
        self.ordinary.store_object(request).await
    }
    async fn upload_image_pid(&self, _request: ImageUploadRequest<'_>) -> Option<ImagePid> {
        None
    }
    async fn delete_object(&self, key: &str) -> Result<bool, UploadBackendError> {
        self.media.delete_object(key).await
    }
}

fn main() -> Result<(), BoxError> {
    wegent_backend_rs::config::init_env();
    let logs = brz_logs::init_default()?;
    let runtime = tokio::runtime::Runtime::new()?;
    let result: Result<(), BoxError> = runtime.block_on(async {
        let mut state = build_app_state().await?;
        let config = MinioConfig::from_env()
            .ok_or_else(|| std::io::Error::other("MinIO configuration is required"))?;
        let mut ordinary_config = config.clone();
        ordinary_config.bucket = format!("{}-missing", config.bucket);
        state.attachment_upload = Arc::new(MediaHosting {
            media: S3StorageBackend::new(state.attachment_http.clone(), config),
            ordinary: S3StorageBackend::new(state.attachment_http.clone(), ordinary_config),
        });
        let application = Application::build(Arc::new(state)).await?;
        run_hybrid(HybridConfig::from_env()?, application).await
    });
    logs.flush()?;
    result
}
