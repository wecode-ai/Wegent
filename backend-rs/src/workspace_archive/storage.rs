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

use crate::attachments::minio_client::{encode_object_path, object_request};
use crate::attachments::s3_signing;

/// The source `WORKSPACE_ARCHIVE_BUCKET` default (`app/core/config.py`).
const DEFAULT_BUCKET: &str = "wegent-archives";
/// The source `ATTACHMENT_S3_REGION` default.
const DEFAULT_REGION: &str = "us-east-1";
/// `presigned_get_object`'s default expiry (`expires_seconds=3600`).
const DOWNLOAD_URL_EXPIRES_SECONDS: u64 = 3600;
/// The MinIO/S3 user agent the source client sends.
const USER_AGENT: &str = "MinIO (Linux; x86_64) minio-py/7.2.20";

/// Whether the process-wide archive client has completed its one-time
/// initialization (`archive_storage_service` is a module-level singleton in
/// the source, so every request after the first reuses the ready client).
static INITIALIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Serializes the one-time initialization across concurrent first uses.
static INIT_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

    /// The absolute URL for a request path on the configured endpoint. Every
    /// S3 operation targets the configured host; only the request URI varies.
    fn url(&self, uri: &str) -> String {
        format!("{}://{}{uri}", self.scheme(), self.host())
    }

    /// The `Minio` client's lazy one-time initialization
    /// (`ArchiveStorageService.client`): every first use resolves the
    /// bucket's region (`GET /{bucket}?location=`), then `_ensure_bucket`
    /// probes `HEAD {bucket}` and creates it with `PUT {bucket}` when the
    /// response is `NoSuchBucket`. Later uses reuse the initialized client,
    /// so a request performs this exchange at most once.
    async fn ensure_ready(&self, http: &HttpClient) -> anyhow::Result<()> {
        if INITIALIZED.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        let _guard = INIT_MUTEX.lock().await;
        if INITIALIZED.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        // `_get_region`: `GET /{bucket}?location=` with the default region's
        // signature; the response's region text is cached (and this port
        // keeps the configured region, which the recording signs with).
        let location_uri = format!("/{}?location=", self.bucket);
        let url = self.url(&location_uri);
        let amz_date = s3_signing::amz_timestamp_now();
        let signed = s3_signing::sign(
            &self.access_key,
            &self.secret_key,
            &self.region,
            self.host(),
            "GET",
            &location_uri,
            &amz_date,
        );
        let response = http
            .request(brz_http::Method::GET, &url)?
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("bucket location query failed: HTTP {}", response.status());
        }
        // `bucket_exists`: `HEAD {bucket}`; only `NoSuchBucket` (404) falls
        // through to `make_bucket`.
        let bucket_uri = format!("/{}", self.bucket);
        let url = self.url(&bucket_uri);
        let amz_date = s3_signing::amz_timestamp_now();
        let signed = s3_signing::sign(
            &self.access_key,
            &self.secret_key,
            &self.region,
            self.host(),
            "HEAD",
            &bucket_uri,
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
        if (200..300).contains(&status) || status == 404 {
            if status == 404 {
                self.make_bucket(http).await?;
            }
            INITIALIZED.store(true, std::sync::atomic::Ordering::Release);
            return Ok(());
        }
        anyhow::bail!("bucket existence check failed: HTTP {status}")
    }

    /// `make_bucket`: `PUT {bucket}` with an empty body.
    async fn make_bucket(&self, http: &HttpClient) -> anyhow::Result<()> {
        let url = self.url(&format!("/{}", self.bucket));
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
        Ok(self.archive_size(http, storage_key).await?.is_some())
    }

    pub(crate) async fn archive_size(
        &self,
        http: &HttpClient,
        storage_key: &str,
    ) -> anyhow::Result<Option<u64>> {
        self.ensure_ready(http).await?;
        let uri = format!("/{}/{}", self.bucket, encode_object_path(storage_key));
        let url = self.url(&uri);
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
        let response = object_request(http, brz_http::Method::HEAD, &url, &self.bucket)?
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            Ok(Some(
                response
                    .headers()
                    .get("content-length")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
            ))
        } else if status == 404 {
            Ok(None)
        } else {
            anyhow::bail!("unexpected archive stat status {status}")
        }
    }

    pub(crate) async fn generate_upload_url(
        &self,
        http: &HttpClient,
        task_id: i64,
    ) -> anyhow::Result<(String, String)> {
        self.ensure_ready(http).await?;
        let key = format!("workspace-archives/{task_id}/archive.tar.gz");
        let uri = format!("/{}/{}", self.bucket, encode_object_path(&key));
        let url = super::s3_presign::presign(
            self.scheme(),
            self.host(),
            "PUT",
            &uri,
            &self.access_key,
            &self.secret_key,
            &self.region,
            &s3_signing::amz_timestamp_now(),
            3600,
        );
        Ok((url, key))
    }

    /// `generate_download_url`: a presigned `GET` URL for the object, valid
    /// for one hour.
    pub(crate) async fn generate_download_url(
        &self,
        http: &HttpClient,
        storage_key: &str,
    ) -> anyhow::Result<String> {
        self.ensure_ready(http).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::minio_client::metrics_tests::{scrape, serve_objects};

    fn storage(endpoint: &str, use_ssl: bool) -> ArchiveStorage {
        ArchiveStorage {
            endpoint: endpoint.to_string(),
            access_key: "access".to_string(),
            secret_key: "secret".to_string(),
            bucket: DEFAULT_BUCKET.to_string(),
            region: DEFAULT_REGION.to_string(),
            use_ssl,
        }
    }

    /// Every S3 request targets the configured endpoint host; the bucket only
    /// contributes a path segment.
    #[test]
    fn request_urls_include_the_configured_host() {
        let storage = storage("http://s3.example:9100", false);
        assert_eq!(
            storage.url("/wegent-archives"),
            "http://s3.example:9100/wegent-archives"
        );
        assert_eq!(
            storage.url("/wegent-archives/workspace-archives/1/archive.tar.gz"),
            "http://s3.example:9100/wegent-archives/workspace-archives/1/archive.tar.gz"
        );
    }

    #[test]
    fn request_urls_derive_the_scheme_from_use_ssl() {
        let storage = storage("s3.example:9100", true);
        assert_eq!(
            storage.url("/wegent-archives"),
            "https://s3.example:9100/wegent-archives"
        );
    }

    #[tokio::test]
    async fn archive_size_aggregates_metrics_without_changing_object_paths() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let prefix = "/wegent-archives/workspace-archives/";
        let server = tokio::spawn(serve_objects(listener, 2, prefix));
        let http = HttpClient::builder()
            .read_timeout(std::time::Duration::from_secs(5))
            .configure(|builder| builder.no_proxy())
            .build()
            .unwrap();
        let storage = storage(&origin, false);
        let keys = [
            "workspace-archives/42/archive.tar.gz",
            "workspace-archives/84/archive.tar.gz",
        ];
        for key in keys {
            assert_eq!(storage.archive_size(&http, key).await.unwrap(), Some(0));
        }
        let requests = server.await.unwrap();
        let object_paths: Vec<_> = requests
            .iter()
            .filter(|(line, _)| line.starts_with(&format!("HEAD {prefix}")))
            .map(|(line, _)| line.as_str())
            .collect();
        for (line, key) in object_paths.iter().zip(keys) {
            assert_eq!(*line, format!("HEAD /wegent-archives/{key} HTTP/1.1\r\n"));
        }
        assert_eq!(object_paths.len(), 2);
        let output = scrape();
        let metric = format!(
            "brz_req_total{{type=\"HTTP\",name=\"HEAD {origin}/wegent-archives/{{key}}\"}} 2"
        );
        assert!(output.lines().any(|line| line == metric));
        assert!(!output.contains(&format!("{origin}{prefix}")));
    }
}
