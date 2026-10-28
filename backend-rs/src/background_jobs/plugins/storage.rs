// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Immutable packages use the existing private plugin bucket and object keys.

use crate::attachments::{
    minio_client::{self, MinioConfig, StorageError},
    s3_signing,
};
use anyhow::{Result, bail};

pub struct Storage {
    config: MinioConfig,
    http: brz_http::Client,
}
impl Storage {
    pub fn new() -> Result<Self> {
        let mut config = MinioConfig::from_env()
            .ok_or_else(|| anyhow::anyhow!("Plugin object storage is not configured"))?;
        let secure = crate::config::env_or_dotenv("ATTACHMENT_S3_USE_SSL")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        config.endpoint = format!(
            "{}://{}",
            if secure { "https" } else { "http" },
            config.host()
        );
        config.bucket = crate::config::env_or_dotenv("PLUGIN_STORAGE_BUCKET")
            .unwrap_or_else(|| "wegent".into());
        Ok(Self {
            config,
            http: minio_client::build_client()?,
        })
    }
    pub async fn get(&self, key: &str) -> Result<Vec<u8>> {
        minio_client::get_object(&self.http, &self.config, key)
            .await
            .map_err(|_| anyhow::anyhow!("Plugin package could not be read"))
    }
    pub async fn delete(&self, key: &str) -> Result<()> {
        minio_client::delete_object(&self.http, &self.config, key)
            .await
            .map_err(|_| anyhow::anyhow!("Plugin package rollback could not be completed"))
    }
    pub async fn put(&self, key: &str, bytes: &[u8]) -> Result<bool> {
        match minio_client::stat_object(&self.http, &self.config, key).await {
            Ok(()) => {
                if self.get(key).await? != bytes {
                    bail!("Immutable plugin object already exists with different content")
                }
                return Ok(false);
            }
            Err(StorageError::NotFound) => {}
            Err(_) => bail!("Plugin package store is unavailable"),
        }
        self.ensure_bucket().await?;
        minio_client::put_object_with_content_type(
            &self.http,
            &self.config,
            key,
            bytes,
            "application/zip",
        )
        .await
        .map_err(|_| anyhow::anyhow!("Plugin package could not be stored"))?;
        Ok(true)
    }
    async fn ensure_bucket(&self) -> Result<()> {
        let config = &self.config;
        let host = config.host();
        let uri = format!("/{}", config.bucket);
        let url = format!("{}://{host}{uri}", config.scheme());
        let signed = s3_signing::sign(
            &config.access_key,
            &config.secret_key,
            &config.region,
            host,
            "HEAD",
            &uri,
            &s3_signing::amz_timestamp_now(),
        );
        let response = self
            .http
            .as_reqwest()
            .head(&url)
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .send()
            .await?;
        if response.status().is_success() {
            return Ok(());
        }
        if response.status().as_u16() != 404 {
            bail!("Plugin bucket could not be inspected")
        }
        let signed = s3_signing::sign(
            &config.access_key,
            &config.secret_key,
            &config.region,
            host,
            "PUT",
            &uri,
            &s3_signing::amz_timestamp_now(),
        );
        let response = self
            .http
            .as_reqwest()
            .put(url)
            .header("authorization", signed.authorization)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("x-amz-date", signed.amz_date)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("Plugin bucket could not be created")
        }
        Ok(())
    }
}
