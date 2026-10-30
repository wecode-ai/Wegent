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
    /// `get_storage_backend`'s `minio`/`s3` configuration (`ATTACHMENT_S3_*`).
    /// `None` when the endpoint or credentials are absent, leaving the `mysql`
    /// backend in effect. Like every source `settings.*` read, the values come
    /// from the process environment or the source-compatible `/app/.env`
    /// dotenv file.
    pub fn from_env() -> Option<Self> {
        let endpoint = crate::config::env_or_dotenv("ATTACHMENT_S3_ENDPOINT").unwrap_or_default();
        let access_key =
            crate::config::env_or_dotenv("ATTACHMENT_S3_ACCESS_KEY").unwrap_or_default();
        let secret_key =
            crate::config::env_or_dotenv("ATTACHMENT_S3_SECRET_KEY").unwrap_or_default();
        if endpoint.is_empty() || access_key.is_empty() || secret_key.is_empty() {
            return None;
        }
        Some(Self {
            endpoint,
            access_key,
            secret_key,
            bucket: crate::config::env_or_dotenv("ATTACHMENT_S3_BUCKET")
                .unwrap_or_else(|| "attachments".to_string()),
            region: crate::config::env_or_dotenv("ATTACHMENT_S3_REGION")
                .unwrap_or_else(|| "us-east-1".to_string()),
        })
    }

    /// `Minio(endpoint_clean, ...)`: the scheme is stripped from the endpoint
    /// and decides `use_ssl`; the remaining `host:port` becomes the Host.
    pub fn host(&self) -> &str {
        self.endpoint
            .strip_prefix("http://")
            .or_else(|| self.endpoint.strip_prefix("https://"))
            .unwrap_or(&self.endpoint)
    }

    /// `Minio(..., secure=use_ssl)`: `http://` disables TLS.
    pub fn scheme(&self) -> &str {
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
    /// The object is absent: the object store answered `404`, which `minio-py`
    /// surfaces as an `S3Error` with a `NoSuchKey`/`NoSuchObject`/`NotFound`
    /// code. The attachment read path collapses this into the same `None` as
    /// `Unavailable`; the transcript archive read path distinguishes it as its
    /// 404 `archive_not_found`.
    NotFound,
}

/// Group object requests by method, origin, and bucket before registering
/// metrics. The entire key can contain IDs, including in directory names.
pub(crate) fn object_request(
    client: &HttpClient,
    method: brz_http::Method,
    url: impl brz_http::reqwest::IntoUrl,
    bucket: &str,
) -> brz_http::Result<brz_http::RequestBuilder> {
    let url = url.into_url()?;
    let name = format!(
        "{method} {}/{bucket}/{{key}}",
        url.origin().ascii_serialization()
    );
    Ok(client.endpoint_named(url, name)?.request(method))
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
/// endpoint renders as 500 `Failed to retrieve attachment data`. A `404`
/// upstream status is reported as `StorageError::NotFound` so the transcript
/// archive read path can render its own 404.
pub async fn get_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<Vec<u8>, StorageError> {
    let host = config.host();
    let uri = format!("/{}/{}", config.bucket, encode_object_path(key));
    let url = format!("{}://{host}{uri}", config.scheme());
    // The `x-amz-date` below comes from the live signing clock, matching the
    // source's minio-py signing; Replay tolerance for its drift is provided by
    // the `attachment-s3-signing-time-get` dependency rule.
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
    let request = object_request(client, brz_http::Method::GET, &url, &config.bucket)
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
        return if response.status().as_u16() == 404 {
            Err(StorageError::NotFound)
        } else {
            Err(StorageError::Unavailable)
        };
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    Ok(body.to_vec())
}

/// `MinIOStorageBackend.exists(key)` / minio-py `stat_object`:
/// `HEAD {scheme}://{host}/{bucket}/{key}`. A `404` upstream status is
/// reported as [`StorageError::NotFound`] so callers can render a missing
/// object; every other non-success status and transport failure is
/// [`StorageError::Unavailable`].
pub async fn stat_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<(), StorageError> {
    let host = config.host();
    let uri = format!("/{}/{}", config.bucket, encode_object_path(key));
    let url = format!("{}://{host}{uri}", config.scheme());
    let amz_date = s3_signing::amz_timestamp_now();
    let signed = s3_signing::sign(
        &config.access_key,
        &config.secret_key,
        &config.region,
        host,
        "HEAD",
        &uri,
        &amz_date,
    );
    let response = object_request(client, brz_http::Method::HEAD, &url, &config.bucket)
        .map_err(|_| StorageError::Unavailable)?
        .header("authorization", signed.authorization)
        .header("x-amz-content-sha256", signed.content_sha256)
        .header("x-amz-date", signed.amz_date)
        .header("user-agent", "MinIO (Linux; x86_64) minio-py/7.2.20")
        .send()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    if response.status().is_success() {
        Ok(())
    } else if response.status().as_u16() == 404 {
        Err(StorageError::NotFound)
    } else {
        Err(StorageError::Unavailable)
    }
}

/// minio-py `put_object` for a single-part upload:
/// `PUT {scheme}://{host}/{bucket}/{key}` with the object bytes as the body.
/// The payload hash signs the request (`x-amz-content-sha256`) over the
/// cleartext-HTTP transport the deployment uses, and the object is stored as
/// `application/octet-stream`.
pub async fn put_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
    body: &[u8],
) -> Result<(), StorageError> {
    put_object_with_content_type(client, config, key, body, "application/octet-stream").await
}

pub async fn put_object_with_content_type(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
    body: &[u8],
    content_type: &str,
) -> Result<(), StorageError> {
    let host = config.host();
    let uri = format!("/{}/{}", config.bucket, encode_object_path(key));
    let url = format!("{}://{host}{uri}", config.scheme());
    let amz_date = s3_signing::amz_timestamp_now();
    let payload_sha256 = s3_signing::hex_sha256(body);
    let signed = s3_signing::sign_headers(
        &config.access_key,
        &config.secret_key,
        &config.region,
        "PUT",
        &uri,
        &amz_date,
        &payload_sha256,
        &[
            ("host", host),
            ("content-type", content_type),
            ("x-amz-content-sha256", &payload_sha256),
            ("x-amz-date", &amz_date),
        ],
    );
    let response = object_request(client, brz_http::Method::PUT, &url, &config.bucket)
        .map_err(|_| StorageError::Unavailable)?
        .header("authorization", signed.authorization)
        .header("x-amz-content-sha256", signed.content_sha256)
        .header("x-amz-date", signed.amz_date)
        .header("content-type", content_type)
        .header("user-agent", "MinIO (Linux; x86_64) minio-py/7.2.20")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(StorageError::Unavailable)
    }
}

/// minio-py `remove_object`: `DELETE {scheme}://{host}/{bucket}/{key}` with
/// an empty-payload signature. The source treats every failure as a storage
/// error, so both a missing object and an unavailable store are
/// [`StorageError::Unavailable`].
pub async fn delete_object(
    client: &HttpClient,
    config: &MinioConfig,
    key: &str,
) -> Result<(), StorageError> {
    let host = config.host();
    let uri = format!("/{}/{}", config.bucket, encode_object_path(key));
    let url = format!("{}://{host}{uri}", config.scheme());
    let amz_date = s3_signing::amz_timestamp_now();
    let signed = s3_signing::sign(
        &config.access_key,
        &config.secret_key,
        &config.region,
        host,
        "DELETE",
        &uri,
        &amz_date,
    );
    let response = object_request(client, brz_http::Method::DELETE, &url, &config.bucket)
        .map_err(|_| StorageError::Unavailable)?
        .header("authorization", signed.authorization)
        .header("x-amz-content-sha256", signed.content_sha256)
        .header("x-amz-date", signed.amz_date)
        .header("user-agent", "MinIO (Linux; x86_64) minio-py/7.2.20")
        .send()
        .await
        .map_err(|_| StorageError::Unavailable)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(StorageError::Unavailable)
    }
}

/// URL-encode an object key the way `minio-py` does for path-style requests:
/// percent-encode every byte except unreserved characters and `/`.
pub fn encode_object_path(key: &str) -> String {
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
/// `Minio` client per backend instance sharing urllib3 pools). This is also the
/// state's shared outbound transport, so it trusts the deployment's extra
/// anchor when one is mounted; the source `httpx` clients resolve through the
/// system trust store and therefore accept intercepted HTTPS dependencies.
pub fn build_client() -> anyhow::Result<HttpClient> {
    HttpClient::builder()
        .connect_timeout(STORAGE_TIMEOUT)
        .read_timeout(STORAGE_TIMEOUT)
        .configure(|builder| match crate::http_trust::trust_anchor() {
            Some(anchor) => builder.add_root_certificate(anchor),
            None => builder,
        })
        .build()
        .context("failed to build the attachment storage HTTP client")
}

#[cfg(test)]
#[path = "minio_client_metrics_tests.rs"]
mod metrics_tests;

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
