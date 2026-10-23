// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SmartAppMarketplaceService.download_artifact` plus the ticketed artifact
//! download storage read.
//!
//! Resolves the published Smart app, rechecks the caller's access role, loads
//! the token's release (requiring `scan_status = 'passed'`), then opens the
//! immutable object from the plugin package store
//! (`app/services/plugin_package_storage.py` through the lazy
//! `object_storage_presign_service` client, which unlike the wework
//! transcript store performs no bucket probe before `get_object`).
use brz_http::Client as HttpClient;
use brz_http_server::StatusCode;
use brz_mysql::{Mysql, MysqlResult};
use brz_redis::Redis;

use super::db;
use super::models::SmartAppRow;
use super::service::access_role;
use crate::attachments::minio_client::{self, MinioConfig};
use crate::config::env_or_dotenv;
use crate::http_compat::FastApiError;
use crate::permissions::EntityResolvers;

/// `settings.PLUGIN_STORAGE_BUCKET` default (`app/core/config.py`).
const DEFAULT_BUCKET: &str = "wegent";
/// `settings.ATTACHMENT_S3_REGION` default.
const DEFAULT_REGION: &str = "us-east-1";

/// `_raise_storage_unavailable`: `503 {"detail": {"code":
/// "smart_app_storage_unavailable", "message": "Smart app file storage is
/// unavailable"}}`. Shared by the artifact download and marketplace listing.
pub(crate) fn storage_unavailable() -> FastApiError {
    FastApiError::json_body(
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({
            "detail": {
                "code": "smart_app_storage_unavailable",
                "message": "Smart app file storage is unavailable",
            }
        }),
    )
}

/// `SmartAppArtifactDownload`: the resolved release's storage coordinates.
pub struct SmartAppArtifactDownload {
    pub storage_key: String,
    pub filename: String,
    pub size_bytes: i64,
}

/// Failure modes of `download_artifact`, mapped to responses by the handler.
pub enum ArtifactError {
    /// `HTTPException(404, detail)` raised by the source service.
    NotFound(&'static str),
    /// A dependency failure the source's global handler renders as 500.
    Dependency,
}

/// `PluginPackageStorage.bucket`: the shared `ATTACHMENT_S3_*` endpoint and
/// credentials with the plugin storage bucket.
pub fn plugin_storage_config() -> MinioConfig {
    let mut config = MinioConfig::from_env().unwrap_or(MinioConfig {
        endpoint: String::new(),
        access_key: String::new(),
        secret_key: String::new(),
        bucket: String::new(),
        region: DEFAULT_REGION.to_string(),
    });
    config.bucket = env_or_dotenv("PLUGIN_STORAGE_BUCKET")
        .filter(|bucket| !bucket.is_empty())
        .unwrap_or_else(|| DEFAULT_BUCKET.to_string());
    config
}

/// `plugin_package_storage.presign_download`'s URL half: a MinIO SigV4 `GET`
/// query URL for one object in the plugin storage bucket, signed at the
/// current request time with `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS`.
///
/// Every configuration or signing failure is the source's
/// `MarketplaceArtifactStorageError`, which both Smart app endpoints map to
/// their 503 body.
pub(crate) fn presign_download_url(storage_key: &str) -> Result<String, PresignError> {
    let config = plugin_storage_config();
    if config.host().is_empty() || config.access_key.is_empty() || config.secret_key.is_empty() {
        return Err(PresignError);
    }
    let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let expires_seconds = u64::try_from(super::link::expires_seconds().max(0)).unwrap_or(0);
    Ok(crate::workspace_archive::s3_presign::presign(
        config.scheme(),
        config.host(),
        "GET",
        &format!("/{}/{}", config.bucket, storage_key.trim_start_matches('/')),
        &config.access_key,
        &config.secret_key,
        &config.region,
        &amz_date,
        expires_seconds,
    ))
}

/// A presign client failure (`MarketplaceArtifactStorageError`).
pub(crate) struct PresignError;

/// `marketplace_artifact_storage.open_download(storage_key)`: one
/// `get_object` on the plugin storage bucket with no bucket probe (the lazy
/// presign-service client builds `Minio` and calls `get_object` directly).
/// Every failure is a `MarketplaceArtifactStorageError`, which the endpoint
/// maps to its 503.
pub async fn open_download(
    client: &HttpClient,
    config: &MinioConfig,
    storage_key: &str,
) -> Result<Vec<u8>, minio_client::StorageError> {
    minio_client::get_object(client, config, storage_key).await
}

/// `download_artifact`: the release row behind a verified download token, or
/// the source's not-found/access failures.
pub async fn download_artifact<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    smart_app_id: i64,
    release_id: i64,
    user_id: i64,
) -> Result<SmartAppArtifactDownload, ArtifactError>
where
    M: Mysql,
    R: Redis,
{
    let app = match db::find_smart_app(mysql, smart_app_id).await {
        Ok(Some(app)) if app.status == "published" => app,
        Ok(_) => return Err(ArtifactError::NotFound("Smart app not found")),
        Err(_) => return Err(ArtifactError::Dependency),
    };
    if require_access(mysql, redis, resolvers, &app, user_id)
        .await
        .map_err(|_| ArtifactError::Dependency)?
        .is_none()
    {
        return Err(ArtifactError::NotFound("Smart app not found"));
    }
    match db::find_passed_release(mysql, release_id, app.id).await {
        Ok(Some(release)) => Ok(SmartAppArtifactDownload {
            storage_key: release.storage_key,
            filename: format!("{}-{}.zip", app.name, release.version),
            size_bytes: release.size_bytes,
        }),
        Ok(None) => Err(ArtifactError::NotFound("Smart app release not found")),
        Err(_) => Err(ArtifactError::Dependency),
    }
}

/// `_access_role(...) is None` -> the source's 404. A dependency failure
/// inside the ERP resolver branch is swallowed by the source
/// (`get_org_department_resource_ids` catches every exception), matching the
/// existing descriptor service.
async fn require_access<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    app: &SmartAppRow,
    user_id: i64,
) -> MysqlResult<Option<&'static str>>
where
    M: Mysql,
    R: Redis,
{
    access_role(mysql, redis, resolvers, app, user_id).await
}
