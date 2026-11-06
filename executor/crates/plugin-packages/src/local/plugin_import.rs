// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

use crate::logging::log_executor_event;

use super::personal_marketplace_lock::acquire_personal_marketplace_lock;

const MAX_PLUGIN_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_PLUGIN_COPY_URL_BYTES: usize = 8 * 1024;
const PERSONAL_MARKETPLACE_ID: &str = "wework-personal";
const CODEX_PERSONAL_MARKETPLACE_ID: &str = "personal";
const EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const PERSONAL_PACKAGE_ARTIFACT_DIRECTORY: &str = "personal-plugin-packages";
const PERSONAL_PACKAGE_ARTIFACT_TTL: Duration = Duration::from_secs(60 * 60);
const IGNORED_PLUGIN_SOURCE_DIRECTORIES: &[&str] =
    &[".git", ".pytest_cache", "__pycache__", "node_modules"];
const IGNORED_PLUGIN_SOURCE_FILES: &[&str] = &[".DS_Store"];

#[cfg(test)]
use distribution::sha256_file;
#[cfg(all(test, unix))]
use marketplace::prepare_personal_marketplace_root_for_executor_home;
#[cfg(test)]
use marketplace::validated_personal_marketplace_path_for_executor_home;
#[cfg(test)]
use marketplace::{
    personal_marketplace_path, prepare_personal_marketplace_root_for_capabilities,
    validated_personal_marketplace_path_for_capabilities,
};
#[cfg(test)]
use personal_copy::read_plugin_copy_registry;
mod personal_copy;
use personal_copy::{
    copy_registry_path, download_plugin_copy, import_plugin_copy_package, restore_optional_file,
    rollback_plugin_copy, serialize_plugin_copy_registry, validate_plugin_copy_request,
    validated_plugin_copy_download_url,
};
mod transaction;
use transaction::{
    import_plugin_package_at, plugin_import_backup_root, preview_plugin_import_at,
    read_optional_file, restore_plugin_import, write_atomic_file,
};
mod archive;
use archive::{
    classify_plugin_import_error, extract_plugin_copy, manifest_string, plugin_component_summary,
    plugin_interface_string, read_plugin_archive, valid_plugin_slug,
    validate_plugin_import_manifest,
};
mod distribution;
use distribution::{collect_plugin_files, ensure_personal_plugin_at, package_plugin_directory};
mod marketplace;
use marketplace::{
    cleanup_stale_personal_package_artifacts, create_directory_without_symlink,
    list_personal_plugins_at, marketplace_root_from_path, prepare_direct_child_directory,
    prepare_local_marketplace_root, prepare_personal_marketplace_manifest_paths,
    prepare_personal_marketplace_root, prepare_personal_package_artifact_root,
    regular_plugin_manifest, reject_symlink, remove_personal_package_artifact,
    resolve_existing_marketplace_root, resolve_managed_personal_plugin,
    validate_personal_package_cleanup_token, validate_personal_plugin_name, validate_plugin_name,
    validated_personal_marketplace_path,
};
mod registry;
use registry::{
    marketplace_manifest_contains_plugin, plugin_cloud_link_registry_path,
    read_plugin_cloud_links_strict, remove_marketplace_plugin_entry,
    upsert_marketplace_plugin_entry, write_plugin_cloud_links,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsurePersonalPluginRequest {
    pub source_marketplace_path: String,
    pub destination_marketplace_path: String,
    pub plugin_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePersonalPluginRequest {
    pub marketplace_path: String,
    pub plugin_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPersonalPluginPackageRequest {
    pub cleanup_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPersonalPluginsRequest {
    pub marketplace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPersonalPluginCopyRequest {
    pub marketplace_path: String,
    pub download_url: String,
    pub sha256: String,
    pub source_plugin_id: i64,
    pub source_release_id: i64,
    pub source_plugin_name: String,
    pub source_display_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPersonalPluginCopyRequest {
    pub marketplace_path: String,
    pub plugin_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsurePersonalPluginResult {
    plugin_name: String,
    marketplace_path: String,
    plugin_path: String,
    migrated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginPackage {
    name: String,
    path: String,
    size: u64,
    sha256: String,
    cleanup_token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalMarketplacePluginSummary {
    name: String,
    version: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    logo: Option<String>,
    category: Option<String>,
    marketplace_path: String,
    plugin_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalMarketplaceListResult {
    marketplace_id: String,
    marketplace_path: String,
    plugins: Vec<PersonalMarketplacePluginSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginCopyImportResult {
    plugin_name: String,
    display_name: String,
    version: String,
    marketplace_path: String,
    plugin_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPluginImportRequest {
    pub archive_path: String,
    pub marketplace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPluginPackageRequest {
    pub archive_path: String,
    pub marketplace_path: String,
    pub expected_sha256: String,
    pub overwrite: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginImportMutationRequest {
    pub marketplace_path: String,
    pub rollback_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPluginCloudLinksRequest {
    pub marketplace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPluginReleaseRequest {
    pub marketplace_path: String,
    pub local_plugin_name: String,
    pub cloud_plugin_id: i64,
    pub cloud_release_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkPluginReleaseRequest {
    pub marketplace_path: String,
    pub local_plugin_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePersonalPluginRequest {
    pub marketplace_path: String,
    pub plugin_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginImportIssue {
    code: String,
    path: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginImportPreview {
    valid: bool,
    archive_path: String,
    sha256: String,
    name: String,
    display_name: String,
    version: String,
    description: String,
    skill_count: usize,
    mcp_server_count: usize,
    executable_capabilities: Vec<String>,
    existing: bool,
    existing_version: Option<String>,
    issues: Vec<LocalPluginImportIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginPackageImportResult {
    plugin_name: String,
    display_name: String,
    version: String,
    marketplace_path: String,
    plugin_path: String,
    rollback_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPluginImportRollback {
    plugin_name: String,
    replaced_existing: bool,
    codex_marketplace_existed: bool,
    claude_marketplace_existed: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalPluginCopyRegistry {
    #[serde(default)]
    copies: Vec<LocalPluginCopyRecord>,
    // Preserve the legacy field when older installations still carry it.
    #[serde(default)]
    cloud_links: Vec<LocalPluginCloudLink>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPluginCopyRecord {
    local_plugin_name: String,
    source_plugin_id: i64,
    source_release_id: i64,
    source_plugin_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginCloudLink {
    local_plugin_name: String,
    cloud_plugin_id: i64,
    cloud_release_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalPluginCloudLinkRegistry {
    cloud_links: Vec<LocalPluginCloudLink>,
}

pub fn ensure_personal_plugin(
    request: EnsurePersonalPluginRequest,
) -> Result<EnsurePersonalPluginResult, String> {
    let destination = validated_personal_marketplace_path(&request.destination_marketplace_path)?;
    let destination = prepare_personal_marketplace_root(&destination)?;
    ensure_personal_plugin_at(
        Path::new(&request.source_marketplace_path),
        &destination,
        &request.plugin_name,
    )
}

pub fn package_personal_plugin(
    request: PackagePersonalPluginRequest,
) -> Result<LocalPluginPackage, String> {
    let plugin_name = validate_personal_plugin_name(&request.plugin_name)?;
    let marketplace_path = validated_personal_marketplace_path(&request.marketplace_path)?;
    let marketplace_root = resolve_existing_marketplace_root(&marketplace_path)?;
    let plugin_root = resolve_managed_personal_plugin(&marketplace_root, plugin_name)?;
    let artifact_root = prepare_personal_package_artifact_root()?;
    cleanup_stale_personal_package_artifacts(&artifact_root);
    package_plugin_directory(&plugin_root, plugin_name, &artifact_root)
}

pub fn cleanup_personal_plugin_package(
    request: CleanupPersonalPluginPackageRequest,
) -> Result<(), String> {
    let cleanup_token = validate_personal_package_cleanup_token(&request.cleanup_token)?;
    let artifact_root = prepare_personal_package_artifact_root()?;
    remove_personal_package_artifact(&artifact_root, cleanup_token)
}

pub fn list_personal_plugins(
    request: ListPersonalPluginsRequest,
) -> Result<PersonalMarketplaceListResult, String> {
    let marketplace_path = validated_personal_marketplace_path(&request.marketplace_path)?;
    let mut listed = list_personal_plugins_at(&marketplace_path)?;
    if let Some(home) = dirs::home_dir() {
        let legacy_manifest = home.join(".agents/plugins/marketplace.json");
        let primary_root = marketplace_root_from_path(&marketplace_path);
        let legacy_root = marketplace_root_from_path(&legacy_manifest);
        if legacy_manifest.is_file()
            && primary_root.canonicalize().ok() != legacy_root.canonicalize().ok()
        {
            let legacy = list_personal_plugins_at(&legacy_manifest)?;
            let mut names = listed
                .plugins
                .iter()
                .map(|plugin| plugin.name.clone())
                .collect::<HashSet<_>>();
            listed.plugins.extend(
                legacy
                    .plugins
                    .into_iter()
                    .filter(|plugin| names.insert(plugin.name.clone())),
            );
        }
    }
    Ok(listed)
}

pub async fn import_personal_plugin_copy(
    request: ImportPersonalPluginCopyRequest,
) -> Result<LocalPluginCopyImportResult, String> {
    validate_plugin_copy_request(&request)?;
    let marketplace_path = validated_personal_marketplace_path(&request.marketplace_path)?;
    let download_url = validated_plugin_copy_download_url(&request.download_url)?;
    let package = download_plugin_copy(&download_url, &request.sha256).await?;
    tokio::task::spawn_blocking(move || {
        let marketplace_root = prepare_personal_marketplace_root(&marketplace_path)?;
        import_plugin_copy_package(&marketplace_root, &package, &request)
    })
    .await
    .map_err(|error| format!("Failed to join plugin copy import task: {error}"))?
}

pub fn rollback_personal_plugin_copy(
    request: RollbackPersonalPluginCopyRequest,
) -> Result<(), String> {
    let marketplace_path = validated_personal_marketplace_path(&request.marketplace_path)?;
    let marketplace_root = prepare_personal_marketplace_root(&marketplace_path)?;
    rollback_plugin_copy(&marketplace_root, &request.plugin_name)
}

pub fn preview_plugin_import(
    request: PreviewPluginImportRequest,
) -> Result<LocalPluginImportPreview, String> {
    preview_plugin_import_at(
        Path::new(&request.archive_path),
        Path::new(&request.marketplace_path),
    )
}

pub fn import_plugin_package(
    request: ImportPluginPackageRequest,
) -> Result<LocalPluginPackageImportResult, String> {
    import_plugin_package_at(
        Path::new(&request.marketplace_path),
        Path::new(&request.archive_path),
        &request.expected_sha256,
        request.overwrite,
    )
}

pub fn finalize_plugin_import(request: PluginImportMutationRequest) -> Result<(), String> {
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    let backup_root = plugin_import_backup_root(&marketplace_root, &request.rollback_id)?;
    if backup_root.exists() {
        fs::remove_dir_all(backup_root)
            .map_err(|error| format!("Failed to finalize plugin import: {error}"))?;
    }
    Ok(())
}

pub fn rollback_plugin_import(request: PluginImportMutationRequest) -> Result<(), String> {
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    restore_plugin_import(&marketplace_root, &request.rollback_id)
}

pub fn read_plugin_cloud_links(
    request: ReadPluginCloudLinksRequest,
) -> Result<Vec<LocalPluginCloudLink>, String> {
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    read_plugin_cloud_links_strict(&marketplace_root_from_path(&resolved))
}

pub(crate) fn personal_plugin_has_cloud_link(
    marketplace_root: &Path,
    plugin_name: &str,
) -> Result<bool, String> {
    let marketplace_root = marketplace_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    Ok(read_plugin_cloud_links_strict(&marketplace_root)?
        .iter()
        .any(|link| link.local_plugin_name == plugin_name))
}

pub fn link_plugin_release(request: LinkPluginReleaseRequest) -> Result<(), String> {
    let plugin_name = validate_plugin_name(&request.local_plugin_name)?;
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    if !marketplace_root
        .join("plugins")
        .join(plugin_name)
        .join(".codex-plugin/plugin.json")
        .is_file()
    {
        return Err("Local plugin manifest is unavailable".to_owned());
    }
    let mut links = read_plugin_cloud_links_strict(&marketplace_root)?;
    links.retain(|link| link.local_plugin_name != plugin_name);
    links.push(LocalPluginCloudLink {
        local_plugin_name: plugin_name.to_owned(),
        cloud_plugin_id: request.cloud_plugin_id,
        cloud_release_id: request.cloud_release_id,
    });
    write_plugin_cloud_links(&marketplace_root, links)
}

pub fn unlink_plugin_release(request: UnlinkPluginReleaseRequest) -> Result<(), String> {
    let plugin_name = validate_plugin_name(&request.local_plugin_name)?;
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    let mut links = read_plugin_cloud_links_strict(&marketplace_root)?;
    links.retain(|link| link.local_plugin_name != plugin_name);
    write_plugin_cloud_links(&marketplace_root, links)
}

pub fn delete_personal_plugin(request: DeletePersonalPluginRequest) -> Result<(), String> {
    let plugin_name = validate_plugin_name(&request.plugin_name)?;
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    let plugin_path = marketplace_root.join("plugins").join(plugin_name);
    let canonical_plugin = match fs::symlink_metadata(&plugin_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Plugin is not a managed personal plugin directory".to_owned());
            }
            let canonical_plugin = plugin_path
                .canonicalize()
                .map_err(|error| format!("Failed to resolve personal plugin: {error}"))?;
            let canonical_plugins_root = marketplace_root
                .join("plugins")
                .canonicalize()
                .map_err(|error| format!("Failed to resolve personal plugin directory: {error}"))?;
            if canonical_plugin.parent() != Some(canonical_plugins_root.as_path())
                || !canonical_plugin.join(".codex-plugin/plugin.json").is_file()
            {
                return Err("Plugin is not a managed personal plugin".to_owned());
            }
            Some(canonical_plugin)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Failed to inspect personal plugin: {error}")),
    };

    let manifest_paths = [
        marketplace_root.join(".agents/plugins/marketplace.json"),
        marketplace_root.join(".claude-plugin/marketplace.json"),
    ];
    let registered = manifest_paths
        .iter()
        .any(|path| marketplace_manifest_contains_plugin(path, plugin_name).unwrap_or(false));
    if canonical_plugin.is_some() && !registered {
        return Err("Plugin is not registered in this personal marketplace".to_owned());
    }

    let copy_registry_path = copy_registry_path(&marketplace_root);
    reject_symlink(&copy_registry_path, "plugin copy registry")?;
    let copy_registry_backup = read_optional_file(&copy_registry_path)?;
    let mut copy_registry = copy_registry_backup
        .as_ref()
        .map(|bytes| {
            serde_json::from_slice::<LocalPluginCopyRegistry>(bytes)
                .map_err(|error| format!("Plugin copy registry is invalid: {error}"))
        })
        .transpose()?;

    let cloud_link_path = plugin_cloud_link_registry_path(&marketplace_root);
    let cloud_link_backup = read_optional_file(&cloud_link_path)?;
    let backup_root = canonical_plugin.as_ref().map(|_| {
        marketplace_root.join(".wegent").join(format!(
            "plugin-delete-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    });
    if let Some(backup_root) = &backup_root {
        fs::create_dir_all(backup_root).map_err(|error| {
            format!("Failed to create personal plugin deletion backup: {error}")
        })?;
    }
    let manifest_backups = manifest_paths
        .iter()
        .map(|path| fs::read(path).ok())
        .collect::<Vec<_>>();
    if let (Some(canonical_plugin), Some(backup_root)) = (&canonical_plugin, &backup_root) {
        fs::rename(canonical_plugin, backup_root.join("plugin"))
            .map_err(|error| format!("Failed to stage personal plugin deletion: {error}"))?;
    }

    let mutation = (|| {
        for path in &manifest_paths {
            remove_marketplace_plugin_entry(path, plugin_name)?;
        }
        if let Some(registry) = copy_registry.as_mut() {
            let previous_len = registry.copies.len();
            registry
                .copies
                .retain(|copy| copy.local_plugin_name != plugin_name);
            if registry.copies.len() != previous_len {
                write_atomic_file(
                    &copy_registry_path,
                    &serialize_plugin_copy_registry(registry)?,
                )?;
            }
        }
        let mut links = read_plugin_cloud_links_strict(&marketplace_root)?;
        links.retain(|link| link.local_plugin_name != plugin_name);
        write_plugin_cloud_links(&marketplace_root, links)?;
        Ok(())
    })();
    if let Err(error) = mutation {
        for (path, backup) in manifest_paths.iter().zip(manifest_backups) {
            if let Some(bytes) = backup {
                let _ = write_atomic_file(path, &bytes);
            }
        }
        match cloud_link_backup {
            Some(bytes) => {
                let _ = write_atomic_file(&cloud_link_path, &bytes);
            }
            None => {
                let _ = fs::remove_file(&cloud_link_path);
            }
        }
        let _ = restore_optional_file(&copy_registry_path, copy_registry_backup.as_deref());
        if let (Some(canonical_plugin), Some(backup_root)) = (&canonical_plugin, &backup_root) {
            let _ = fs::rename(backup_root.join("plugin"), canonical_plugin);
            let _ = fs::remove_dir_all(backup_root);
        }
        return Err(error);
    }
    if let Some(backup_root) = backup_root {
        fs::remove_dir_all(&backup_root)
            .map_err(|error| format!("Failed to finalize personal plugin deletion: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "plugin_import_hash_tests.rs"]
mod hash_tests;

#[cfg(test)]
#[path = "plugin_import_cloud_links_tests.rs"]
mod cloud_links_tests;
