// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Row and response models for the Smart app download descriptor.
//!
//! The row projections mirror the source SQLAlchemy models `SmartApp` and
//! `SmartAppRelease` (`app/models/smart_app_marketplace.py`), and the response
//! mirrors the `SmartAppDownloadDescriptor` schema
//! (`app/schemas/smart_app.py`), which FastAPI renders as `application/json`.
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;

use brz_json::OpaqueJson;

/// One `smart_apps` row.
///
/// `db.get(SmartApp, id)` selects every mapped column, so the projection keeps
/// the source column list and order.
#[derive(Debug, FromMysqlRow)]
pub struct SmartAppRow {
    pub id: i64,
    pub owner_user_id: i64,
    pub name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub display_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub summary: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub description_md: String,
    pub source_type: String,
    pub visibility: String,
    pub status: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub tags_json: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub icon_storage_key: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub screenshots_json: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub extensions_json: Json<OpaqueJson>,
    pub latest_release_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub featured_rank: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub is_listed: bool,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub updated_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub published_at: NaiveDateTime,
}

/// One `smart_app_releases` row.
///
/// `db.query(SmartAppRelease).filter(...).first()` labels each column
/// `<table>_<column>`, so the projection keeps the source aliases.
#[derive(Debug, FromMysqlRow)]
pub struct SmartAppReleaseRow {
    #[mysql(rename = "smart_app_releases_id")]
    pub id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_smart_app_id")]
    pub smart_app_id: i64,
    #[mysql(rename = "smart_app_releases_version")]
    pub version: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_manifest_json")]
    pub manifest_json: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_release_notes")]
    pub release_notes: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_storage_key")]
    pub storage_key: String,
    #[mysql(rename = "smart_app_releases_sha256")]
    pub sha256: String,
    #[mysql(rename = "smart_app_releases_size_bytes")]
    pub size_bytes: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_scan_status")]
    pub scan_status: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_scan_report_json")]
    pub scan_report_json: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_extensions_json")]
    pub extensions_json: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_created_by_user_id")]
    pub created_by_user_id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_created_at")]
    pub created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_app_releases_published_at")]
    pub published_at: NaiveDateTime,
}

/// `SmartAppDownloadDescriptor` (`app/schemas/smart_app.py`).
///
/// Field order and camelCase names match the pydantic model so the serialized
/// body is byte-compatible. `expiresAt` is preformatted to the pydantic v2
/// datetime JSON form (`...Z`), so the value is carried as text.
#[derive(Debug, serde::Serialize)]
pub struct SmartAppDownloadDescriptor {
    #[serde(rename = "smartAppId")]
    pub smart_app_id: i64,
    #[serde(rename = "releaseId")]
    pub release_id: i64,
    pub version: String,
    pub filename: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

/// The `build_smart_app_download_url` JWT payload
/// (`app/services/smart_app_download_link.py`).
///
/// Field order matches the source dict insertion order so the compact JSON
/// payload is byte-identical to python-jose's output.
#[derive(Debug, serde::Serialize)]
pub struct DownloadClaims {
    pub smart_app_id: i64,
    pub release_id: i64,
    pub user_id: i64,
    pub purpose: &'static str,
    pub nonce: String,
    pub iat: i64,
    pub exp: i64,
}
