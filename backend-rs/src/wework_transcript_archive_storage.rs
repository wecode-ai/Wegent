// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework transcript archive object storage.
//!
//! Mirrors `app.services.wework_transcript_storage`: the process-lifetime
//! `wework_transcript_storage` singleton lazily builds one MinIO/S3 client and
//! probes the configured bucket (`HEAD /{bucket}`) before its first object
//! operation, then reads (`GET /{bucket}/{key}`), inspects
//! (`HEAD /{bucket}/{key}`), writes (`PUT /{bucket}/{key}`), or removes
//! (`DELETE /{bucket}/{key}`) one archive object. A missing object
//! (`NoSuchKey`) is the download endpoint's 404 `archive_not_found`; an
//! unconfigured or otherwise failing store is its 503
//! `transcript_storage_unavailable`.
//!
//! The storage client itself is the shared process-lifetime outbound transport
//! (`AppState::attachment_http`); the source's `Minio` client is likewise built
//! once and retained on the singleton.
use std::sync::atomic::{AtomicBool, Ordering};

use brz_http::Client as HttpClient;

use crate::attachments::minio_client::{self, MinioConfig};

/// `settings.WEWORK_TRANSCRIPT_S3_BUCKET` default.
const DEFAULT_BUCKET: &str = "wework-transcripts";

/// Whether the process has already probed the archive bucket. The source
/// caches the built `Minio` client on the module singleton, so `bucket_exists`
/// runs once per process rather than once per request; a failed probe is not
/// cached and is retried on the next operation.
static BUCKET_PROBED: AtomicBool = AtomicBool::new(false);

/// One archive operation's outcome, mapped by the endpoints to `_translate`:
/// `NotFound` -> 404 `archive_not_found`, `Unavailable` -> 503
/// `transcript_storage_unavailable`.
pub enum ArchiveReadError {
    NotFound,
    Unavailable,
}

/// `WeworkTranscriptStorage.client`: the shared `ATTACHMENT_S3_*` endpoint and
/// credentials with the transcript bucket. `None` when the endpoint or
/// credentials are absent, which the source reports as `Wework transcript
/// object storage is unavailable`.
pub fn config_from_env() -> Option<MinioConfig> {
    let mut config = MinioConfig::from_env()?;
    config.bucket = crate::config::env_or_dotenv("WEWORK_TRANSCRIPT_S3_BUCKET")
        .filter(|bucket| !bucket.is_empty())
        .unwrap_or_else(|| DEFAULT_BUCKET.to_string());
    Some(config)
}

/// The source singleton's lazy `bucket_exists` probe, run once per process
/// before the first object operation.
async fn ensure_bucket(client: &HttpClient, config: &MinioConfig) -> Result<(), ArchiveReadError> {
    if !BUCKET_PROBED.load(Ordering::Acquire) {
        minio_client::ensure_bucket_exists(client, config)
            .await
            .map_err(|_| ArchiveReadError::Unavailable)?;
        BUCKET_PROBED.store(true, Ordering::Release);
    }
    Ok(())
}

/// `WeworkTranscriptStorage.stream(object_key)`: ensure the bucket once per
/// process, then read the object. A `404` from the object store is the
/// `NoSuchKey` branch the source maps to `WeworkTranscriptStorageNotFoundError`.
pub async fn read_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<Vec<u8>, ArchiveReadError> {
    ensure_bucket(client, config).await?;
    match minio_client::get_object(client, config, key).await {
        Ok(bytes) => Ok(bytes),
        Err(minio_client::StorageError::NotFound) => Err(ArchiveReadError::NotFound),
        Err(minio_client::StorageError::Unavailable) => Err(ArchiveReadError::Unavailable),
    }
}

/// `WeworkTranscriptStorage.exists(object_key)`: `stat_object` reports whether
/// the archive object is still stored. A missing object is `false`; a failed
/// inspection is the endpoint's 503.
pub async fn object_exists(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<bool, ArchiveReadError> {
    ensure_bucket(client, config).await?;
    match minio_client::stat_object(client, config, key).await {
        Ok(()) => Ok(true),
        Err(minio_client::StorageError::NotFound) => Ok(false),
        Err(minio_client::StorageError::Unavailable) => Err(ArchiveReadError::Unavailable),
    }
}

/// `WeworkTranscriptStorage.put_stream(object_key, stream, size)`: store one
/// uploaded segment object. Every failure is the endpoint's 503.
pub async fn put_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
    body: &[u8],
) -> Result<(), ArchiveReadError> {
    ensure_bucket(client, config).await?;
    minio_client::put_object(client, config, key, body)
        .await
        .map_err(|_| ArchiveReadError::Unavailable)
}

/// `WeworkTranscriptStorage.delete(object_key)`: remove one obsolete segment
/// object. Every failure is a storage error; the pruner logs and continues.
pub async fn delete_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<(), ArchiveReadError> {
    ensure_bucket(client, config).await?;
    minio_client::delete_object(client, config, key)
        .await
        .map_err(|_| ArchiveReadError::Unavailable)
}
