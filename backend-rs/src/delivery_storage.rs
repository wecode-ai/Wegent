// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Delivery object storage (`app/services/delivery/storage.py`).
//!
//! The source `delivery_storage` singleton lazily builds one MinIO/S3 client
//! — sharing the `ATTACHMENT_S3_*` endpoint, credentials, and region but the
//! dedicated `DELIVERY_S3_BUCKET` — and, on the first object access, probes
//! the bucket (`HEAD /{bucket}`) and creates it (`PUT /{bucket}`) when it is
//! absent. Later reads issue only the object fetch (`GET /{bucket}/{key}`).
//! The built client is retained for the process lifetime, so the bucket probe
//! runs once per process rather than once per request.
//!
//! Only the read the loop-item attachment content path needs is ported:
//! `get_bytes`. A missing object (`NoSuchKey`) is retried once and then
//! reported as `DeliveryObjectNotFoundError`; an unconfigured or otherwise
//! failing store is `DeliveryStorageUnavailableError`. The caller renders both
//! as its unhandled 500.
//!
//! The storage transport is the shared process-lifetime outbound client
//! (`AppState::attachment_http`); the source `Minio` client likewise reuses
//! its urllib3 pool.
use std::sync::atomic::{AtomicBool, Ordering};

use brz_http::Client as HttpClient;

use crate::attachments::minio_client::{self, MinioConfig};
use crate::attachments::s3_signing;

/// `settings.DELIVERY_S3_BUCKET` default.
const DEFAULT_BUCKET: &str = "wegent-deliveries";

/// The MinIO/S3 user agent the source client sends.
const USER_AGENT: &str = "MinIO (Linux; x86_64) minio-py/7.2.20";

/// Whether the process has probed the delivery bucket. The source caches the
/// built `Minio` client on the module singleton, so `bucket_exists` runs once
/// per process rather than once per request; a failed probe is not cached and
/// is retried on the next read.
static BUCKET_PROBED: AtomicBool = AtomicBool::new(false);

/// One delivery object read's outcome.
pub enum DeliveryReadError {
    /// `DeliveryObjectNotFoundError` (the `NoSuchKey` branch).
    NotFound,
    /// `DeliveryStorageUnavailableError` or an unconfigured store.
    Unavailable,
}

/// `DeliveryStorage.client`: the shared `ATTACHMENT_S3_*` endpoint and
/// credentials with the dedicated delivery bucket. `None` when the endpoint or
/// credentials are absent (the source raises `MinIO credentials are not
/// configured`).
fn config_from_env() -> Option<MinioConfig> {
    let mut config = MinioConfig::from_env()?;
    config.bucket = crate::config::env_or_dotenv("DELIVERY_S3_BUCKET")
        .filter(|bucket| !bucket.is_empty())
        .unwrap_or_else(|| DEFAULT_BUCKET.to_string());
    Some(config)
}

/// Write a new object without overwriting an active delivery revision.
pub async fn write_object(
    client: &HttpClient,
    key: &str,
    bytes: &[u8],
) -> Result<(), DeliveryReadError> {
    let config = config_from_env().ok_or(DeliveryReadError::Unavailable)?;
    ensure_bucket(client, &config).await?;
    minio_client::put_object(client, &config, key, bytes)
        .await
        .map_err(|_| DeliveryReadError::Unavailable)
}

/// Remove abandoned staging objects or objects superseded by a committed save.
pub async fn delete_object(client: &HttpClient, key: &str) -> Result<(), DeliveryReadError> {
    let config = config_from_env().ok_or(DeliveryReadError::Unavailable)?;
    minio_client::delete_object(client, &config, key)
        .await
        .map_err(|_| DeliveryReadError::Unavailable)
}

/// `DeliveryStorage.get_bytes(object_key)`: ensure the bucket once per process,
/// then read the object, retrying once on a missing key.
pub async fn read_object(client: &HttpClient, key: &str) -> Result<Vec<u8>, DeliveryReadError> {
    let Some(config) = config_from_env() else {
        return Err(DeliveryReadError::Unavailable);
    };
    if !BUCKET_PROBED.load(Ordering::Acquire) {
        ensure_bucket(client, &config).await?;
        BUCKET_PROBED.store(true, Ordering::Release);
    }
    match minio_client::get_object(client, &config, key).await {
        Ok(bytes) => Ok(bytes),
        // `except S3Error as exc: if exc.code != "NoSuchKey": raise` — the
        // source retries the read once before `DeliveryObjectNotFoundError`.
        Err(minio_client::StorageError::NotFound) => {
            match minio_client::get_object(client, &config, key).await {
                Ok(bytes) => Ok(bytes),
                Err(_) => Err(DeliveryReadError::NotFound),
            }
        }
        Err(minio_client::StorageError::Unavailable) => Err(DeliveryReadError::Unavailable),
    }
}

/// `DeliveryStorage.client`: `bucket_exists(bucket)` then `make_bucket(bucket)`
/// when the probe reports the bucket missing.
async fn ensure_bucket(client: &HttpClient, config: &MinioConfig) -> Result<(), DeliveryReadError> {
    if minio_client::ensure_bucket_exists(client, config)
        .await
        .is_ok()
    {
        return Ok(());
    }
    make_bucket(client, config).await
}

/// `make_bucket`: `PUT /{bucket}` with an empty body.
async fn make_bucket(client: &HttpClient, config: &MinioConfig) -> Result<(), DeliveryReadError> {
    let host = config.host();
    let uri = format!("/{}", config.bucket);
    let url = format!("{}://{host}{uri}", config.scheme());
    let amz_date = s3_signing::amz_timestamp_now();
    let signed = s3_signing::sign_headers(
        &config.access_key,
        &config.secret_key,
        &config.region,
        "PUT",
        &uri,
        &amz_date,
        s3_signing::EMPTY_BODY_SHA256,
        &[
            ("host", host),
            ("x-amz-content-sha256", s3_signing::EMPTY_BODY_SHA256),
            ("x-amz-date", amz_date.as_str()),
        ],
    );
    let response = client
        .request(brz_http::Method::PUT, &url)
        .map_err(|_| DeliveryReadError::Unavailable)?
        .header("authorization", signed.authorization)
        .header("x-amz-content-sha256", signed.content_sha256)
        .header("x-amz-date", signed.amz_date)
        .header("user-agent", USER_AGENT)
        .send()
        .await
        .map_err(|_| DeliveryReadError::Unavailable)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(DeliveryReadError::Unavailable)
    }
}
