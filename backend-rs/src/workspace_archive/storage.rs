// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MinIO storage service for workspace archives.
//!
//! Mirrors `app/services/workspace_archive/storage.py`'s
//! `ArchiveStorageService`: the archive bucket lives on the same MinIO/S3
//! deployment as the attachments backend (it reuses `ATTACHMENT_S3_ENDPOINT`
//! and credentials), and the executor transfers the archive directly through
//! presigned URLs. Only the read path the restore flow needs is ported:
//! bucket existence, object existence, and presigned download URLs.
use brz_http::Client as HttpClient;

use crate::attachments::minio_client::encode_object_path;
use crate::attachments::s3_signing;

/// The source `WORKSPACE_ARCHIVE_BUCKET` default (`app/core/config.py`).
const DEFAULT_BUCKET: &str = "wegent-archives";
/// The source `ATTACHMENT_S3_REGION` default.
const DEFAULT_REGION: &str = "us-east-1";
/// `presigned_get_object`'s default expiry (`expires_seconds=3600`).
const DOWNLOAD_URL_EXPIRES_SECONDS: u64 = 3600;
/// The MinIO/S3 user agent the source client sends.
const USER_AGENT: &str = "MinIO (Linux; x86_64) minio-py/7.2.20";

/// The configured archive object store, read from the attachment S3 settings
/// plus the archive bucket name.
pub(crate) struct ArchiveStorage {
    endpoint: String,
    access_key: String,
    secret_key: String,
    bucket: String,
    region: String,
    use_ssl: bool,
}

impl ArchiveStorage {
    /// Build the archive storage client, mirroring the source property's
    /// `ValueError` when the attachment S3 configuration is absent.
    pub(crate) fn from_env() -> anyhow::Result<Self> {
        let endpoint = crate::config::env_or_dotenv("ATTACHMENT_S3_ENDPOINT").unwrap_or_default();
        let access_key =
            crate::config::env_or_dotenv("ATTACHMENT_S3_ACCESS_KEY").unwrap_or_default();
        let secret_key =
            crate::config::env_or_dotenv("ATTACHMENT_S3_SECRET_KEY").unwrap_or_default();
        if endpoint.is_empty() || access_key.is_empty() || secret_key.is_empty() {
            anyhow::bail!(
                "MinIO configuration not set: ATTACHMENT_S3_ENDPOINT, \
                 ATTACHMENT_S3_ACCESS_KEY and ATTACHMENT_S3_SECRET_KEY are required"
            );
        }
        let use_ssl = crate::config::env_or_dotenv("ATTACHMENT_S3_USE_SSL")
            .map(|value| value.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        Ok(Self {
            endpoint,
            access_key,
            secret_key,
            bucket: crate::config::env_or_dotenv("WORKSPACE_ARCHIVE_BUCKET")
                .unwrap_or_else(|| DEFAULT_BUCKET.to_string()),
            region: crate::config::env_or_dotenv("ATTACHMENT_S3_REGION")
                .unwrap_or_else(|| DEFAULT_REGION.to_string()),
            use_ssl,
        })
    }

    /// The scheme the source `Minio(..., secure=use_ssl)` derives from the
    /// endpoint (`http://` disables TLS).
    fn scheme(&self) -> &str {
        if self.use_ssl { "https" } else { "http" }
    }

    /// `Minio(endpoint_clean, ...)`: the scheme is stripped from the endpoint
    /// and the remainder becomes the Host.
    fn host(&self) -> &str {
        self.endpoint
            .strip_prefix("http://")
            .or_else(|| self.endpoint.strip_prefix("https://"))
            .unwrap_or(&self.endpoint)
    }

    /// `_ensure_bucket`: `HEAD {bucket}` followed by `PUT {bucket}` when it is
    /// missing (`bucket_exists` then `make_bucket`).
    async fn ensure_bucket(&self, http: &HttpClient) -> anyhow::Result<()> {
        let url = format!("{}://{}/{}", self.scheme(), self.host(), self.bucket);
        let amz_date = s3_signing::amz_timestamp_now();
        let signed = s3_signing::sign(
            &self.access_key,
            &self.secret_key,
            &self.region,
            self.host(),
            "HEAD",
            &format!("/{}", self.bucket),
            &amz_date,
        );
        let response = http
            .request(brz_http::Method::HEAD, &url)?
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        if response.status().is_success() {
            return Ok(());
        }
        self.make_bucket(http).await
    }

    /// `make_bucket`: `PUT {bucket}` with an empty body.
    async fn make_bucket(&self, http: &HttpClient) -> anyhow::Result<()> {
        let url = format!("{}://{}/{}", self.scheme(), self.host(), self.bucket);
        let amz_date = s3_signing::amz_timestamp_now();
        let signed = s3_signing::sign_headers(
            &self.access_key,
            &self.secret_key,
            &self.region,
            "PUT",
            &format!("/{}", self.bucket),
            &amz_date,
            s3_signing::EMPTY_BODY_SHA256,
            &[
                ("host", self.host()),
                ("x-amz-content-sha256", s3_signing::EMPTY_BODY_SHA256),
                ("x-amz-date", amz_date.as_str()),
            ],
        );
        let response = http
            .request(brz_http::Method::PUT, &url)?
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            anyhow::bail!(
                "failed to create archive bucket: HTTP {}",
                response.status()
            )
        }
    }

    /// `archive_exists`: `stat_object` maps `NoSuchKey` to `False` and every
    /// other failure to a raised error.
    pub(crate) async fn archive_exists(
        &self,
        http: &HttpClient,
        storage_key: &str,
    ) -> anyhow::Result<bool> {
        self.ensure_bucket(http).await?;
        let uri = format!("/{}/{}", self.bucket, encode_object_path(storage_key));
        let url = format!("{}://{}{uri}", self.scheme(), self.host());
        let amz_date = s3_signing::amz_timestamp_now();
        let signed = s3_signing::sign(
            &self.access_key,
            &self.secret_key,
            &self.region,
            self.host(),
            "HEAD",
            &uri,
            &amz_date,
        );
        let response = http
            .request(brz_http::Method::HEAD, &url)?
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            Ok(true)
        } else if status == 404 {
            Ok(false)
        } else {
            anyhow::bail!("unexpected archive stat status {status}")
        }
    }

    /// `generate_download_url`: a presigned `GET` URL for the object, valid
    /// for one hour.
    pub(crate) async fn generate_download_url(
        &self,
        http: &HttpClient,
        storage_key: &str,
    ) -> anyhow::Result<String> {
        self.ensure_bucket(http).await?;
        let uri = format!("/{}/{}", self.bucket, encode_object_path(storage_key));
        Ok(super::s3_presign::presign(
            self.scheme(),
            self.host(),
            "GET",
            &uri,
            &self.access_key,
            &self.secret_key,
            &self.region,
            &s3_signing::amz_timestamp_now(),
            DOWNLOAD_URL_EXPIRES_SECONDS,
        ))
    }
}
