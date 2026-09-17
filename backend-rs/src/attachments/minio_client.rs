// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MinIO/S3-compatible object client for the `minio`/`s3` attachment
//! storage backend (the configured object store).
//!
//! Mirrors the observable wire behavior of the source `minio-py` client on
//! the read path: the backend constructor's bucket-existence probe
//! (`HEAD /{bucket}`) and `get_object` (`GET /{bucket}/{key}`), both signed
//! with AWS SigV4 for the unsigned-payload body and carrying the MinIO user
//! agent.
use std::time::Duration;

use anyhow::Context as _;
use brz_http::Client as HttpClient;

use super::s3_signing;

/// Source `REMOTE_MEDIA_TIMEOUT`/client default exchange budget for storage
/// reads; bounds one request's connect+read window.
const STORAGE_TIMEOUT: Duration = Duration::from_secs(120);

/// The source deployment's configured MinIO backend.
#[derive(Debug, Clone)]
pub struct MinioConfig {
    /// `ATTACHMENT_S3_ENDPOINT` (an `http(s)://host:port` URL from the
    /// deployment configuration).
    pub endpoint: String,
    /// `ATTACHMENT_S3_ACCESS_KEY`.
    pub access_key: String,
    /// `ATTACHMENT_S3_SECRET_KEY`.
    pub secret_key: String,
    /// `ATTACHMENT_S3_BUCKET`.
    pub bucket: String,
    /// `ATTACHMENT_S3_REGION`.
    pub region: String,
}

impl MinioConfig {
    /// `Minio(endpoint_clean, ...)`: the scheme is stripped from the endpoint
    /// and decides `use_ssl`; the remaining `host:port` becomes the Host.
    fn host(&self) -> &str {
        self.endpoint
            .strip_prefix("http://")
            .or_else(|| self.endpoint.strip_prefix("https://"))
            .unwrap_or(&self.endpoint)
    }

    fn scheme(&self) -> &str {
        if self.endpoint.starts_with("https://") {
            "https"
        } else {
            "http"
        }
    }
}

/// Read outcomes of one object fetch.
pub enum StorageError {
    /// Transport failure or non-200 upstream status (`minio-py` returns
    /// `None` and the endpoint renders 500 `Failed to retrieve attachment
    /// data`).
    Unavailable,
}

/// `MinIOStorageBackend` construction plus `bucket_exists`:
/// `HEAD {scheme}://{host}/{bucket}`. Failures are logged by the source and
/// re-raised as `StorageError` from the constructor.
pub async fn ensure_bucket_exists(
    client: &HttpClient,
    config: &MinioConfig,
) -> Result<(), StorageError> {
    let host = config.host();
    let url = format!("{}://{host}/{}", config.scheme(), config.bucket);
    let amz_date = s3_signing::amz_timestamp_now();
    let signed = s3_signing::sign(
        &config.access_key,
        &config.secret_key,
        &config.region,
        host,
        "HEAD",
        &format!("/{}", config.bucket),
        &amz_date,
    );
    let request = client
        .request(brz_http::Method::HEAD, &url)
        .map_err(|_| StorageError::Unavailable)?
        .header("authorization", signed.authorization)
        .header("x-amz-content-sha256", signed.content_sha256)
        .header("x-amz-date", signed.amz_date)
        .header("user-agent", "MinIO (Linux; x86_64) minio-py/7.2.20");
    let response = request
        .send()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    if !response.status().is_success() {
        return Err(StorageError::Unavailable);
    }
    Ok(())
}

/// `MinIOStorageBackend.get(key)`: `GET {scheme}://{host}/{bucket}/{key}`.
/// `NoSuchKey` and every other failure map to `None` in the source, which the
/// endpoint renders as 500 `Failed to retrieve attachment data`.
pub async fn get_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<Vec<u8>, StorageError> {
    let host = config.host();
    let uri = format!("/{}/{}", config.bucket, encode_object_path(key));
    let url = format!("{}://{host}{uri}", config.scheme());
    let amz_date = s3_signing::amz_timestamp_now();
    let signed = s3_signing::sign(
        &config.access_key,
        &config.secret_key,
        &config.region,
        host,
        "GET",
        &uri,
        &amz_date,
    );
    let request = client
        .get(&url)
        .map_err(|_| StorageError::Unavailable)?
        .header("authorization", signed.authorization)
        .header("x-amz-content-sha256", signed.content_sha256)
        .header("x-amz-date", signed.amz_date)
        .header("user-agent", "MinIO (Linux; x86_64) minio-py/7.2.20");
    let response = request
        .send()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    if !response.status().is_success() {
        return Err(StorageError::Unavailable);
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    Ok(body.to_vec())
}

/// URL-encode an object key the way `minio-py` does for path-style requests:
/// percent-encode every byte except unreserved characters and `/`.
fn encode_object_path(key: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(key.len());
    for &byte in key.as_bytes() {
        let unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/');
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

/// Build the process-lifetime storage HTTP client (the source builds one
/// `Minio` client per backend instance sharing urllib3 pools).
pub fn build_client() -> anyhow::Result<HttpClient> {
    HttpClient::builder()
        .connect_timeout(STORAGE_TIMEOUT)
        .read_timeout(STORAGE_TIMEOUT)
        .build()
        .context("failed to build the attachment storage HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_object_paths_like_minio_py() {
        assert_eq!(
            encode_object_path("attachments/abc_123"),
            "attachments/abc_123"
        );
        assert_eq!(encode_object_path("a b"), "a%20b");
        assert_eq!(encode_object_path("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn endpoint_scheme_and_host_are_parsed() {
        let config = MinioConfig {
            endpoint: "http://s3.example.invalid:9100".to_string(),
            access_key: String::new(),
            secret_key: String::new(),
            bucket: "wegent".to_string(),
            region: "us-east-1".to_string(),
        };
        assert_eq!(config.host(), "s3.example.invalid:9100");
        assert_eq!(config.scheme(), "http");
    }
}
