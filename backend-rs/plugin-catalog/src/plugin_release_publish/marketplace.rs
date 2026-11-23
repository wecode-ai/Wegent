// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PluginMarketplaceService.publish_catalog_release` and the package safety
//! scan used by the release endpoint
//! (`app.services.plugin_marketplace_service`, `app.services.plugin_package_scanner`).
//!
//! Only the deferred-commit catalog path used by the protected release is
//! migrated: the caller owns the transaction, so the release row and the
//! plugin projection are flushed but not committed here.

use std::io::Cursor;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use brz_redis::Redis;
use chrono::NaiveDateTime;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::CatalogState;
use crate::http_compat::FastApiError;

use super::artifact;
use super::package::{self, UploadInfo};
use super::service::{now_local, sql_datetime};

/// `MAX_EXPANDED_PACKAGE_SIZE_BYTES`
const MAX_EXPANDED_PACKAGE_SIZE_BYTES: u64 = 200 * 1024 * 1024;
/// `MAX_PACKAGE_ENTRY_COUNT`
const MAX_PACKAGE_ENTRY_COUNT: usize = 10_000;
/// `SENSITIVE_FILENAMES`
const SENSITIVE_FILENAMES: [&str; 8] = [
    ".env",
    ".netrc",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ed25519",
    "id_rsa",
    "session.json",
];
/// `SENSITIVE_SUFFIXES`
const SENSITIVE_SUFFIXES: [&str; 4] = [".key", ".p12", ".pfx", ".pem"];

/// One published (or already existing) catalog release.
pub(crate) struct PublishedRelease {
    pub plugin_id: i64,
    pub release_id: i64,
    pub created: bool,
}

fn unprocessable(detail: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, detail.into())
}

fn conflict(detail: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::CONFLICT, detail.into())
}

fn database_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "plugin catalog database dependency failure");
    FastApiError::unhandled()
}

/// `publish_catalog_release(..., defer_commit=True)`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn publish_catalog_release<T: MysqlTransaction>(
    transaction: &mut T,
    catalog_namespace: &str,
    slug: &str,
    package: &[u8],
    listing_type: &str,
    visibility: &str,
    origin_plugin_id: i64,
    publication_revision_id: i64,
    source_commit_sha: &str,
    provenance: Value,
) -> Result<PublishedRelease, FastApiError> {
    if !valid_slug(slug) {
        return Err(unprocessable("Invalid plugin slug"));
    }
    if !matches!(listing_type, "plugin" | "skill") {
        return Err(unprocessable("Invalid plugin listing type"));
    }
    if !matches!(visibility, "workspace" | "public") {
        return Err(unprocessable("Invalid plugin visibility"));
    }
    if catalog_namespace != catalog_namespace_for_visibility(visibility) {
        return Err(unprocessable(
            "Catalog namespace does not match plugin visibility",
        ));
    }
    let (parsed, security_report) = analyze_package(package)?;
    if parsed.name != slug {
        return Err(unprocessable(
            "Official plugin slug must match the manifest name",
        ));
    }
    let plugin = ensure_catalog_plugin(
        transaction,
        catalog_namespace,
        slug,
        &parsed,
        listing_type,
        visibility,
        origin_plugin_id,
    )
    .await?;
    if plugin.source_type != "native"
        || plugin.source_provider != "wework"
        || plugin.owner_user_id != 0
    {
        return Err(conflict("Plugin slug is owned by a different publisher"));
    }
    if plugin.listing_type != listing_type {
        return Err(conflict("Plugin listing type cannot be changed"));
    }
    if catalog_namespace == "enterprise" {
        validate_enterprise_origin(&plugin, origin_plugin_id)?;
    }
    let current_release = current_release(transaction, &plugin).await?;
    if let Some(current) = &current_release
        && version_less_than(parsed.version.as_deref().unwrap_or(""), &current.version)
    {
        return Err(conflict(
            "Official plugin version must not be older than latest",
        ));
    }
    publish_release(
        transaction,
        &plugin,
        package,
        &parsed,
        security_report,
        publication_revision_id,
        source_commit_sha,
        provenance,
        current_release.as_ref(),
        visibility,
    )
    .await
}

fn catalog_namespace_for_visibility(visibility: &str) -> &'static str {
    match visibility {
        "public" => "wework-official",
        _ => "enterprise",
    }
}

/// `_validate_slug`: `^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$`.
fn valid_slug(value: &str) -> bool {
    let count = value.chars().count();
    if count == 0 || count > 100 {
        return false;
    }
    let mut chars = value.chars();
    let first = chars.next().expect("non-empty");
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    if count == 1 {
        return true;
    }
    let mut last = first;
    for character in chars {
        if !(character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-'))
        {
            return false;
        }
        last = character;
    }
    last.is_ascii_lowercase() || last.is_ascii_digit()
}

/// `_validate_version`: the source SemVer pattern.
fn valid_version(value: &str) -> bool {
    let Ok(regex) = regex::Regex::new(
        r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$",
    ) else {
        return false;
    };
    regex.is_match(value)
}

/// `_analyze_package`: the safety scan, then the package parse.
fn analyze_package(package: &[u8]) -> Result<(UploadInfo, Value), FastApiError> {
    let security_report = scan_package(package)?;
    let parsed = package::parse(package)?;
    if parsed.version.as_deref().unwrap_or("").is_empty() {
        return Err(unprocessable("Plugin version is required"));
    }
    if !valid_version(parsed.version.as_deref().unwrap_or("")) {
        return Err(unprocessable("Plugin version must be SemVer"));
    }
    Ok((parsed, security_report))
}

/// `scan_plugin_package`: reject unsafe archives and report executable paths.
fn scan_package(package: &[u8]) -> Result<Value, FastApiError> {
    let mut archive =
        ZipArchive::new(Cursor::new(package)).map_err(|_| unprocessable("Invalid plugin ZIP"))?;
    if archive.len() > MAX_PACKAGE_ENTRY_COUNT {
        return Err(unprocessable("Plugin package contains too many files"));
    }
    let mut executable_paths: Vec<String> = Vec::new();
    let mut expanded_size: u64 = 0;
    let mut normalized_paths: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    for index in 0..archive.len() {
        let member = archive
            .by_index_raw(index)
            .map_err(|_| unprocessable("Invalid plugin ZIP"))?;
        let filename = member.name().to_owned();
        if filename.starts_with('/') || filename.split('/').any(|part| part == "..") {
            return Err(unprocessable(format!(
                "Unsafe path in plugin ZIP: {filename}"
            )));
        }
        let normalized = filename
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect::<Vec<_>>()
            .join("/");
        if !normalized_paths.insert(normalized) {
            return Err(unprocessable(format!(
                "Duplicate path in plugin ZIP: {filename}"
            )));
        }
        let mode = member.unix_mode().unwrap_or(0);
        if mode & 0o170000 == 0o120000 {
            return Err(unprocessable(format!(
                "Symbolic links are not allowed: {filename}"
            )));
        }
        if member.encrypted() {
            return Err(unprocessable(format!(
                "Encrypted files are not allowed: {filename}"
            )));
        }
        expanded_size = expanded_size.saturating_add(member.size());
        if expanded_size > MAX_EXPANDED_PACKAGE_SIZE_BYTES {
            return Err(unprocessable("Expanded plugin package is too large"));
        }
        let basename = filename.rsplit('/').next().unwrap_or("").to_lowercase();
        if SENSITIVE_FILENAMES.contains(&basename.as_str())
            || SENSITIVE_SUFFIXES
                .iter()
                .any(|suffix| basename.ends_with(suffix))
        {
            return Err(unprocessable(format!(
                "Sensitive file is not allowed: {filename}"
            )));
        }
        if mode != 0 && mode & 0o170000 == 0o100000 && mode & 0o111 != 0 {
            executable_paths.push(filename);
        }
    }
    executable_paths.truncate(200);
    Ok(json!({
        "entryCount": archive.len(),
        "expandedSizeBytes": expanded_size,
        "executablePaths": executable_paths,
    }))
}

/// `ensure_catalog_plugin`.
async fn ensure_catalog_plugin<T: MysqlTransaction>(
    transaction: &mut T,
    catalog_namespace: &str,
    slug: &str,
    parsed: &UploadInfo,
    listing_type: &str,
    visibility: &str,
    origin_plugin_id: i64,
) -> Result<PluginRow, FastApiError> {
    let existing: Option<(i64,)> = transaction
        .fetch_optional(
            "SELECT plugins.id AS plugins_id FROM plugins \
             WHERE plugins.catalog_namespace = ? AND plugins.slug = ? LIMIT 1",
            (catalog_namespace, slug),
        )
        .await
        .map_err(database_error)?;
    if existing.is_none() {
        let now = sql_datetime(now_local());
        transaction
            .execute(
                "INSERT INTO plugins \
                 (catalog_namespace, slug, name, display_name, summary, description_md, listing_type, \
                 source_type, source_provider, owner_user_id, origin_plugin_id, category, \
                 keywords_json, interface_json, visibility, allow_copy, status, latest_release_id, \
                 featured_rank, created_at, updated_at, published_at) \
                 VALUES (?, ?, ?, ?, '', '', ?, 'native', 'wework', 0, ?, '', '[]', '{}', ?, 0, \
                 'draft', 0, 0, ?, ?, '1970-01-01 00:00:00.000000') \
                 ON DUPLICATE KEY UPDATE plugins.id = plugins.id",
                (
                    catalog_namespace,
                    slug,
                    parsed.name.as_str(),
                    parsed.display_name.as_str(),
                    listing_type,
                    origin_plugin_id,
                    visibility,
                    now.as_str(),
                    now.as_str(),
                ),
            )
            .await
            .map_err(database_error)?;
    }
    let plugin: Option<PluginRow> = transaction
        .fetch_optional(
            format!("{PLUGIN_QUERY} FOR UPDATE"),
            (catalog_namespace, slug),
        )
        .await
        .map_err(database_error)?;
    plugin.ok_or_else(|| {
        tracing::error!(
            catalog_namespace,
            slug,
            "plugin catalog identity could not be reloaded after insert"
        );
        FastApiError::unhandled()
    })
}

async fn current_release<T: MysqlTransaction>(
    transaction: &mut T,
    plugin: &PluginRow,
) -> Result<Option<ReleaseRow>, FastApiError> {
    if plugin.latest_release_id == 0 {
        return Ok(None);
    }
    transaction
        .fetch_optional(
            RELEASE_QUERY.to_owned() + " WHERE plugin_releases.id = ? LIMIT 1",
            (plugin.latest_release_id,),
        )
        .await
        .map_err(database_error)
}

/// `_validate_enterprise_origin`.
fn validate_enterprise_origin(
    plugin: &PluginRow,
    requested_origin_plugin_id: i64,
) -> Result<(), FastApiError> {
    let current_origin = plugin.origin_plugin_id;
    if requested_origin_plugin_id != 0 {
        if current_origin == 0 {
            return Err(FastApiError::json_body(
                StatusCode::CONFLICT,
                json!({"detail": {
                    "code": "ENTERPRISE_PLUGIN_ORIGIN_UNBOUND",
                    "message": "Legacy enterprise plugin has no personal origin; bind it explicitly before publication",
                }}),
            ));
        }
        if current_origin != requested_origin_plugin_id {
            return Err(FastApiError::json_body(
                StatusCode::CONFLICT,
                json!({"detail": {
                    "code": "ENTERPRISE_PLUGIN_ORIGIN_MISMATCH",
                    "originPersonalPluginId": current_origin,
                }}),
            ));
        }
        return Ok(());
    }
    if current_origin != 0 {
        return Err(FastApiError::json_body(
            StatusCode::CONFLICT,
            json!({"detail": {
                "code": "ENTERPRISE_PLUGIN_REQUIRES_PUBLICATION_REQUEST",
                "originPersonalPluginId": current_origin,
            }}),
        ));
    }
    Ok(())
}

/// `packaging.version.Version(candidate) < Version(current)`.
fn version_less_than(candidate: &str, current: &str) -> bool {
    let Ok(candidate) = candidate.parse::<pep440_rs::Version>() else {
        return false;
    };
    let Ok(current) = current.parse::<pep440_rs::Version>() else {
        return false;
    };
    candidate < current
}

fn version_greater_than(candidate: &str, current: &str) -> Option<bool> {
    let candidate = candidate.parse::<pep440_rs::Version>().ok()?;
    let current = current.parse::<pep440_rs::Version>().ok()?;
    Some(candidate > current)
}

/// `_publish_release`.
#[allow(clippy::too_many_arguments)]
async fn publish_release<T: MysqlTransaction>(
    transaction: &mut T,
    plugin: &PluginRow,
    package: &[u8],
    parsed: &UploadInfo,
    security_report: Value,
    publication_revision_id: i64,
    source_commit_sha: &str,
    provenance: Value,
    current_release: Option<&ReleaseRow>,
    visibility: &str,
) -> Result<PublishedRelease, FastApiError> {
    artifact::release_source_tree(package, true)?;
    let version = parsed.version.clone().unwrap_or_default();
    if version.is_empty() {
        return Err(unprocessable("Plugin version is required"));
    }
    if !valid_version(&version) {
        return Err(unprocessable("Plugin version must be SemVer"));
    }
    let digest = format!("{:x}", Sha256::digest(package));
    let existing: Option<ReleaseRow> = transaction
        .fetch_optional(
            format!("{RELEASE_QUERY} WHERE plugin_releases.plugin_id = ? AND plugin_releases.version = ? LIMIT 1 FOR UPDATE"),
            (plugin.id, version.as_str()),
        )
        .await
        .map_err(database_error)?;
    if let Some(existing) = existing {
        if existing.sha256 != digest {
            return Err(conflict(
                "Plugin version already exists with different content",
            ));
        }
        if existing.status == "ready" && existing.scan_status == "passed" {
            return Ok(PublishedRelease {
                plugin_id: plugin.id,
                release_id: existing.id,
                created: false,
            });
        }
        return Err(conflict("Plugin version publication is incomplete"));
    }
    let interface = parsed.interface.clone().unwrap_or_else(|| json!({}));
    let report = scan_report(parsed, &security_report, provenance);
    let now = sql_datetime(now_local());
    let inserted = transaction
        .execute(
            "INSERT INTO plugin_releases \
             (plugin_id, version, manifest_json, interface_json, release_notes, storage_key, sha256, \
             size_bytes, status, scan_status, scan_report_json, created_by_user_id, \
             publication_revision_id, source_commit_sha, created_at, published_at) \
             VALUES (?, ?, ?, ?, '', 'pending', ?, ?, 'processing', 'passed', ?, 0, ?, ?, ?, \
             '1970-01-01 00:00:00.000000')",
            (
                plugin.id,
                version.as_str(),
                Json(parsed.manifest.clone()),
                Json(interface.clone()),
                digest.as_str(),
                package.len() as i64,
                Json(report.clone()),
                publication_revision_id,
                source_commit_sha,
                now.as_str(),
            ),
        )
        .await
        .map_err(database_error)?;
    let release_id = inserted.last_insert_id as i64;
    let object_key = format!("plugins/{}/{release_id}/{digest}.zip", plugin.id);
    transaction
        .execute(
            "UPDATE plugin_releases SET storage_key = ? WHERE plugin_releases.id = ?",
            (object_key.as_str(), release_id),
        )
        .await
        .map_err(database_error)?;
    let storage = wegent_storage::plugin_package::Storage::new().map_err(|error| {
        tracing::error!(%error, "plugin package storage is not configured");
        FastApiError::unhandled()
    })?;
    let object_created = storage.put(&object_key, package).await.map_err(|error| {
        tracing::error!(%error, "plugin package store failed");
        FastApiError::unhandled()
    })?;
    let release = ReleaseRow {
        id: release_id,
        version: version.clone(),
        sha256: digest,
        status: "processing".to_owned(),
        scan_status: "passed".to_owned(),
        scan_report_json: Json(report),
        manifest_json: Json(parsed.manifest.clone()),
        interface_json: Json(interface),
        published_at: epoch(),
    };
    let finalize = finalize(transaction, plugin, &release, current_release, visibility).await;
    if let Err(error) = finalize {
        if object_created {
            let _ = storage.delete(&object_key).await;
        }
        return Err(error);
    }
    Ok(PublishedRelease {
        plugin_id: plugin.id,
        release_id,
        created: true,
    })
}

/// `_scan_report`.
fn scan_report(parsed: &UploadInfo, security_report: &Value, provenance: Value) -> Value {
    let mut report = json!({
        "components": parsed.components,
        "listing": {
            "name": parsed.name,
            "displayName": parsed.display_name,
            "summary": truncate_chars(&parsed.description, 500),
            "descriptionMd": parsed.description,
        },
        "checks": [
            "zip_paths",
            "manifest",
            "checksum",
            "package_size",
            "expanded_size",
            "sensitive_files",
        ],
    });
    if let (Some(target), Some(source)) = (report.as_object_mut(), security_report.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
        if !provenance.is_null() {
            target.insert("provenance".into(), provenance);
        }
    }
    report
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// `_finalize_release` plus the in-memory listing projection.
async fn finalize<T: MysqlTransaction>(
    transaction: &mut T,
    plugin: &PluginRow,
    release: &ReleaseRow,
    current_release: Option<&ReleaseRow>,
    visibility: &str,
) -> Result<(), FastApiError> {
    if release.scan_status != "passed" || release.status == "rejected" {
        return Err(conflict("Release has not passed package scanning"));
    }
    let now = now_local();
    let published_at = if release.published_at == epoch() {
        now
    } else {
        release.published_at
    };
    transaction
        .execute(
            "UPDATE plugin_releases SET status = 'ready', published_at = ? \
             WHERE plugin_releases.id = ?",
            (sql_datetime(published_at), release.id),
        )
        .await
        .map_err(database_error)?;
    let mut projected = PluginProjection::from(plugin);
    if projected.status != "unpublished" {
        projected.status = "published".to_owned();
    }
    if should_promote_latest(release, current_release) {
        apply_release_listing(&mut projected, release, current_release);
        projected.latest_release_id = release.id;
    }
    if projected.published_at == epoch() {
        projected.published_at = now;
    }
    projected.visibility = visibility.to_owned();
    if projected == PluginProjection::from(plugin) {
        return Ok(());
    }
    transaction
        .execute(
            "UPDATE plugins SET name = ?, display_name = ?, summary = ?, description_md = ?, \
             interface_json = ?, category = ?, latest_release_id = ?, visibility = ?, status = ?, \
             published_at = ?, updated_at = ? WHERE plugins.id = ?",
            (
                projected.name.as_str(),
                projected.display_name.as_str(),
                projected.summary.as_str(),
                projected.description_md.as_str(),
                Json(projected.interface_json.clone()),
                projected.category.as_str(),
                projected.latest_release_id,
                projected.visibility.as_str(),
                projected.status.as_str(),
                sql_datetime(projected.published_at),
                sql_datetime(now),
                plugin.id,
            ),
        )
        .await
        .map_err(database_error)?;
    Ok(())
}

/// The mutable `plugins` columns `_finalize_release` and the listing copy touch.
#[derive(PartialEq)]
struct PluginProjection {
    name: String,
    display_name: String,
    summary: String,
    description_md: String,
    interface_json: Value,
    category: String,
    latest_release_id: i64,
    visibility: String,
    status: String,
    published_at: NaiveDateTime,
}

impl From<&PluginRow> for PluginProjection {
    fn from(plugin: &PluginRow) -> Self {
        Self {
            name: plugin.name.clone(),
            display_name: plugin.display_name.clone(),
            summary: plugin.summary.clone(),
            description_md: plugin.description_md.clone(),
            interface_json: plugin.interface_json.0.clone(),
            category: plugin.category.clone(),
            latest_release_id: plugin.latest_release_id,
            visibility: plugin.visibility.clone(),
            status: plugin.status.clone(),
            published_at: plugin.published_at,
        }
    }
}

/// `_should_promote_latest`.
fn should_promote_latest(release: &ReleaseRow, current: Option<&ReleaseRow>) -> bool {
    let Some(current) = current else {
        return true;
    };
    version_greater_than(&release.version, &current.version).unwrap_or(release.id >= current.id)
}

/// `_apply_release_listing`.
fn apply_release_listing(
    plugin: &mut PluginProjection,
    release: &ReleaseRow,
    previous: Option<&ReleaseRow>,
) {
    let listing = release.scan_report_json.0.get("listing").cloned();
    let listing = listing.as_ref().and_then(Value::as_object);
    let manifest = release.manifest_json.0.as_object();
    let interface = release.interface_json.0.as_object();
    if let Some(name) = listing
        .and_then(|listing| listing.get("name"))
        .filter(|value| py_truthy(value))
        .or_else(|| {
            manifest
                .and_then(|manifest| manifest.get("name"))
                .filter(|value| py_truthy(value))
        })
    {
        plugin.name = py_string(name);
    }
    if let Some(display) = listing
        .and_then(|listing| listing.get("displayName"))
        .filter(|value| py_truthy(value))
        .or_else(|| {
            interface
                .and_then(|interface| interface.get("displayName"))
                .filter(|value| py_truthy(value))
        })
    {
        plugin.display_name = py_string(display);
    }
    let (summary, description) = release_listing_copy(release);
    let previous_copy = previous.map(release_listing_copy);
    if previous_copy
        .as_ref()
        .is_none_or(|copy| plugin.summary == copy.0)
    {
        plugin.summary = summary;
    }
    if previous_copy
        .as_ref()
        .is_none_or(|copy| plugin.description_md == copy.1)
    {
        plugin.description_md = description;
    }
    plugin.interface_json = release.interface_json.0.clone();
    if let Some(category) = interface
        .and_then(|interface| interface.get("category"))
        .filter(|value| py_truthy(value))
        .map(py_string)
        .or_else(|| (!plugin.category.is_empty()).then(|| plugin.category.clone()))
    {
        plugin.category = category;
    } else {
        plugin.category = String::new();
    }
}

/// `_release_listing_copy`.
fn release_listing_copy(release: &ReleaseRow) -> (String, String) {
    let listing = release.scan_report_json.0.get("listing").cloned();
    let listing = listing.as_ref().and_then(Value::as_object);
    let manifest = release.manifest_json.0.as_object();
    let description = listing
        .and_then(|listing| listing.get("descriptionMd"))
        .filter(|value| py_truthy(value))
        .or_else(|| {
            manifest
                .and_then(|manifest| manifest.get("description"))
                .filter(|value| py_truthy(value))
        })
        .map(py_string)
        .unwrap_or_default();
    let summary = listing
        .and_then(|listing| listing.get("summary"))
        .filter(|value| py_truthy(value))
        .map(py_string)
        .unwrap_or_else(|| truncate_chars(&description, 500));
    (summary, truncate_chars(&description, 8192))
}

fn py_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}

fn py_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        other => other.to_string(),
    }
}

pub(crate) fn epoch() -> NaiveDateTime {
    NaiveDateTime::default()
}

/// `PluginRelease` fields the publish/latest/finalize path reads.
#[derive(Debug, FromMysqlRow)]
struct ReleaseRow {
    #[mysql(rename = "plugin_releases_id")]
    id: i64,
    #[mysql(rename = "plugin_releases_version")]
    version: String,
    #[mysql(rename = "plugin_releases_sha256")]
    sha256: String,
    #[mysql(rename = "plugin_releases_status")]
    status: String,
    #[mysql(rename = "plugin_releases_scan_status")]
    scan_status: String,
    #[mysql(rename = "plugin_releases_scan_report_json")]
    scan_report_json: Json<Value>,
    #[mysql(rename = "plugin_releases_manifest_json")]
    manifest_json: Json<Value>,
    #[mysql(rename = "plugin_releases_interface_json")]
    interface_json: Json<Value>,
    #[mysql(rename = "plugin_releases_published_at")]
    published_at: NaiveDateTime,
}

/// `Plugin` fields the publish/latest/finalize path reads.
#[derive(Debug, FromMysqlRow)]
struct PluginRow {
    #[mysql(rename = "plugins_id")]
    id: i64,
    #[mysql(rename = "plugins_name")]
    name: String,
    #[mysql(rename = "plugins_display_name")]
    display_name: String,
    #[mysql(rename = "plugins_summary")]
    summary: String,
    #[mysql(rename = "plugins_description_md")]
    description_md: String,
    #[mysql(rename = "plugins_category")]
    category: String,
    #[mysql(rename = "plugins_listing_type")]
    listing_type: String,
    #[mysql(rename = "plugins_source_type")]
    source_type: String,
    #[mysql(rename = "plugins_source_provider")]
    source_provider: String,
    #[mysql(rename = "plugins_owner_user_id")]
    owner_user_id: i64,
    #[mysql(rename = "plugins_origin_plugin_id")]
    origin_plugin_id: i64,
    #[mysql(rename = "plugins_latest_release_id")]
    latest_release_id: i64,
    #[mysql(rename = "plugins_visibility")]
    visibility: String,
    #[mysql(rename = "plugins_status")]
    status: String,
    #[mysql(rename = "plugins_interface_json")]
    interface_json: Json<Value>,
    #[mysql(rename = "plugins_published_at")]
    published_at: NaiveDateTime,
}

const PLUGIN_QUERY: &str = "SELECT plugins.id AS plugins_id, plugins.catalog_namespace AS plugins_catalog_namespace, \
     plugins.slug AS plugins_slug, plugins.name AS plugins_name, \
     plugins.display_name AS plugins_display_name, plugins.summary AS plugins_summary, \
     plugins.description_md AS plugins_description_md, plugins.listing_type AS plugins_listing_type, \
     plugins.source_type AS plugins_source_type, plugins.source_provider AS plugins_source_provider, \
     plugins.owner_user_id AS plugins_owner_user_id, plugins.origin_plugin_id AS plugins_origin_plugin_id, \
     plugins.category AS plugins_category, plugins.keywords_json AS plugins_keywords_json, \
     plugins.interface_json AS plugins_interface_json, plugins.visibility AS plugins_visibility, \
     plugins.allow_copy AS plugins_allow_copy, plugins.status AS plugins_status, \
     plugins.latest_release_id AS plugins_latest_release_id, \
     plugins.featured_rank AS plugins_featured_rank, plugins.created_at AS plugins_created_at, \
     plugins.updated_at AS plugins_updated_at, plugins.published_at AS plugins_published_at \
     FROM plugins WHERE plugins.catalog_namespace = ? AND plugins.slug = ? LIMIT 1";

const RELEASE_QUERY: &str = "SELECT plugin_releases.id AS plugin_releases_id, \
     plugin_releases.plugin_id AS plugin_releases_plugin_id, \
     plugin_releases.version AS plugin_releases_version, \
     plugin_releases.manifest_json AS plugin_releases_manifest_json, \
     plugin_releases.interface_json AS plugin_releases_interface_json, \
     plugin_releases.release_notes AS plugin_releases_release_notes, \
     plugin_releases.storage_key AS plugin_releases_storage_key, \
     plugin_releases.sha256 AS plugin_releases_sha256, \
     plugin_releases.size_bytes AS plugin_releases_size_bytes, \
     plugin_releases.status AS plugin_releases_status, \
     plugin_releases.scan_status AS plugin_releases_scan_status, \
     plugin_releases.scan_report_json AS plugin_releases_scan_report_json, \
     plugin_releases.created_by_user_id AS plugin_releases_created_by_user_id, \
     plugin_releases.publication_revision_id AS plugin_releases_publication_revision_id, \
     plugin_releases.source_commit_sha AS plugin_releases_source_commit_sha, \
     plugin_releases.created_at AS plugin_releases_created_at, \
     plugin_releases.published_at AS plugin_releases_published_at \
     FROM plugin_releases";

/// `_notify_release_available`: broadcast after commit; failures never roll
/// back publication.
pub(crate) async fn notify_release(
    state: &CatalogState,
    plugin_id: i64,
    release_id: i64,
    version: &str,
) -> anyhow::Result<()> {
    let current: Option<(i64,)> = state
        .mysql
        .fetch_optional(
            "SELECT plugin_releases.id AS current_release_id FROM plugin_releases \
             JOIN plugins ON plugins.id = plugin_releases.plugin_id \
             WHERE plugins.id = ? AND plugin_releases.id = ? \
             AND plugins.latest_release_id = plugin_releases.id \
             AND plugin_releases.status = 'ready' AND plugin_releases.scan_status = 'passed'",
            (plugin_id, release_id),
        )
        .await?;
    if current.is_none() {
        return Ok(());
    }
    let Some(redis) = &state.redis else {
        anyhow::bail!("Plugin release notification requires Redis");
    };
    let rows: Vec<InstalledPluginRow> = state
        .mysql
        .fetch_all(
            "SELECT user_id, json FROM kinds \
             WHERE kind = 'InstalledPlugin' AND namespace = 'default' AND is_active = 1",
            (),
        )
        .await?;
    let users = rows
        .into_iter()
        .filter(|row| {
            let spec = &row.json.0["spec"];
            spec["source"]["type"] == "marketplace"
                && spec["pluginId"].as_i64() == Some(plugin_id)
                && spec["releaseId"].as_i64() != Some(release_id)
                && spec["updatePolicy"] == "auto"
        })
        .map(|row| row.user_id)
        .collect::<std::collections::BTreeSet<_>>();
    for user in users {
        let data = json!([{"pluginId": plugin_id, "releaseId": release_id, "version": version}])
            .to_string();
        let message = crate::socketio_emit::emit_message(
            "plugin:release_available",
            &data,
            "/chat",
            &format!("wework:user:{user}"),
        );
        redis
            .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
            .await?;
    }
    Ok(())
}

#[derive(Debug, FromMysqlRow)]
struct InstalledPluginRow {
    user_id: i64,
    json: Json<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_versions_follow_the_marketplace_patterns() {
        assert!(valid_slug("pipeline-plugin"));
        assert!(valid_slug("a"));
        assert!(!valid_slug("Pipeline"));
        assert!(!valid_slug("-a"));
        assert!(!valid_slug("a-"));
        assert!(valid_version("1.2.3"));
        assert!(valid_version("1.2.3-rc.1+build.5"));
        assert!(!valid_version("1.2"));
    }

    #[test]
    fn the_safety_scan_reports_executables_and_rejects_sensitive_files() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "bin/run",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer.write_all(b"run").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let report = scan_package(&bytes).unwrap();
        assert_eq!(report["executablePaths"][0], "bin/run");

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("id_rsa", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"secret").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert_eq!(
            scan_package(&bytes).unwrap_err().detail_message(),
            Some("Sensitive file is not allowed: id_rsa")
        );
    }

    #[test]
    fn version_ordering_uses_pep440() {
        assert!(version_less_than("1.0.0", "1.0.1"));
        assert!(!version_less_than("2.0", "1.0"));
        assert_eq!(version_greater_than("1.0", "1.0rc1"), Some(true));
        assert_eq!(version_greater_than("not-a-version", "1.0"), None);
    }
}
