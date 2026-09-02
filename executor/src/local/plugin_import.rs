// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
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

const MAX_PLUGIN_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_PLUGIN_COPY_URL_BYTES: usize = 8 * 1024;
const PLUGIN_MUTATION_LOCK_FILE: &str = "plugin-mutations.lock";
const PERSONAL_MARKETPLACE_ID: &str = "wework-personal";
const CODEX_PERSONAL_MARKETPLACE_ID: &str = "personal";
const EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const PERSONAL_PACKAGE_ARTIFACT_DIRECTORY: &str = "personal-plugin-packages";
const PERSONAL_PACKAGE_ARTIFACT_TTL: Duration = Duration::from_secs(60 * 60);
const IGNORED_PLUGIN_SOURCE_DIRECTORIES: &[&str] =
    &[".git", ".pytest_cache", "__pycache__", "node_modules"];
const IGNORED_PLUGIN_SOURCE_FILES: &[&str] = &[".DS_Store"];

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
    #[serde(default)]
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
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
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
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    restore_plugin_import(&marketplace_root, &request.rollback_id)
}

pub fn read_plugin_cloud_links(
    request: ReadPluginCloudLinksRequest,
) -> Result<Vec<LocalPluginCloudLink>, String> {
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    Ok(load_plugin_cloud_links(&marketplace_root_from_path(
        &resolved,
    )))
}

pub fn link_plugin_release(request: LinkPluginReleaseRequest) -> Result<(), String> {
    let plugin_name = validate_plugin_name(&request.local_plugin_name)?;
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    if !marketplace_root
        .join("plugins")
        .join(plugin_name)
        .join(".codex-plugin/plugin.json")
        .is_file()
    {
        return Err("Local plugin manifest is unavailable".to_owned());
    }
    let mut links = load_plugin_cloud_links(&marketplace_root);
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
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let mut links = load_plugin_cloud_links(&marketplace_root);
    links.retain(|link| link.local_plugin_name != plugin_name);
    write_plugin_cloud_links(&marketplace_root, links)
}

pub fn delete_personal_plugin(request: DeletePersonalPluginRequest) -> Result<(), String> {
    let plugin_name = validate_plugin_name(&request.plugin_name)?;
    let resolved = Path::new(&request.marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved);
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugin_path = marketplace_root.join("plugins").join(plugin_name);
    let metadata = fs::symlink_metadata(&plugin_path)
        .map_err(|error| format!("Failed to inspect personal plugin: {error}"))?;
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

    let manifest_paths = [
        marketplace_root.join(".agents/plugins/marketplace.json"),
        marketplace_root.join(".claude-plugin/marketplace.json"),
    ];
    let registered = manifest_paths
        .iter()
        .any(|path| marketplace_manifest_contains_plugin(path, plugin_name).unwrap_or(false));
    if !registered {
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

    let backup_root = marketplace_root.join(".wegent").join(format!(
        "plugin-delete-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&backup_root)
        .map_err(|error| format!("Failed to create personal plugin deletion backup: {error}"))?;
    let manifest_backups = manifest_paths
        .iter()
        .map(|path| fs::read(path).ok())
        .collect::<Vec<_>>();
    let cloud_link_path = plugin_cloud_link_registry_path(&marketplace_root);
    let cloud_link_backup = fs::read(&cloud_link_path).ok();
    fs::rename(&canonical_plugin, backup_root.join("plugin"))
        .map_err(|error| format!("Failed to stage personal plugin deletion: {error}"))?;

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
        let mut links = load_plugin_cloud_links(&marketplace_root);
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
        let _ = fs::rename(backup_root.join("plugin"), &canonical_plugin);
        let _ = fs::remove_dir_all(&backup_root);
        return Err(error);
    }
    fs::remove_dir_all(&backup_root)
        .map_err(|error| format!("Failed to finalize personal plugin deletion: {error}"))
}

fn validate_plugin_copy_request(request: &ImportPersonalPluginCopyRequest) -> Result<(), String> {
    normalized_plugin_copy_sha256(&request.sha256)?;
    if request.source_plugin_id <= 0 || request.source_release_id <= 0 {
        return Err("Plugin copy source identifiers must be positive".to_owned());
    }
    let source_name = request.source_plugin_name.trim();
    if !valid_plugin_slug(source_name) {
        return Err("Plugin copy source name must be a lowercase plugin slug".to_owned());
    }
    if request.source_display_name.chars().count() > 200 {
        return Err("Plugin copy display name exceeds 200 characters".to_owned());
    }
    Ok(())
}

fn normalized_plugin_copy_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64
        || !normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Plugin copy checksum is invalid".to_owned());
    }
    Ok(normalized)
}

fn validated_plugin_copy_download_url(value: &str) -> Result<Url, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_PLUGIN_COPY_URL_BYTES {
        return Err("Plugin copy download URL is invalid".to_owned());
    }
    let url = Url::parse(value)
        .map_err(|error| format!("Plugin copy download URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Plugin copy download URL must be an HTTP(S) URL without credentials or a fragment"
                .to_owned(),
        );
    }
    Ok(url)
}

async fn download_plugin_copy(url: &Url, expected_sha256: &str) -> Result<Vec<u8>, String> {
    let expected_sha256 = normalized_plugin_copy_sha256(expected_sha256)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("Failed to prepare plugin download: {error}"))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("Failed to download plugin copy: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Plugin copy download failed with HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PLUGIN_PACKAGE_BYTES as u64)
    {
        return Err("Plugin ZIP exceeds 50 MB".to_owned());
    }

    let capacity = response
        .content_length()
        .unwrap_or_default()
        .min(MAX_PLUGIN_PACKAGE_BYTES as u64) as usize;
    let mut package = Vec::with_capacity(capacity);
    let mut digest = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Failed to read plugin copy download: {error}"))?;
        let next_size = package
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "Plugin ZIP size overflow".to_owned())?;
        if next_size > MAX_PLUGIN_PACKAGE_BYTES {
            return Err("Plugin ZIP exceeds 50 MB".to_owned());
        }
        digest.update(&chunk);
        package.extend_from_slice(&chunk);
    }
    if format!("{:x}", digest.finalize()) != expected_sha256 {
        return Err("Plugin copy checksum mismatch".to_owned());
    }
    Ok(package)
}

fn normalized_copy_slug(source_name: &str) -> String {
    const MAX_COPY_BASE_BYTES: usize = 80;
    let mut slug = source_name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches(['-', '_']).to_owned();
    if slug.is_empty() {
        slug = "plugin".to_owned();
    }
    slug.truncate(MAX_COPY_BASE_BYTES - "-copy".len());
    slug = slug.trim_end_matches(['-', '_']).to_owned();
    format!("{slug}-copy")
}

fn unique_copy_slug(plugins_root: &Path, source_name: &str) -> Result<String, String> {
    let base = normalized_copy_slug(source_name);
    for suffix in 1_u32.. {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        match fs::symlink_metadata(plugins_root.join(&candidate)) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Plugin copy destination may not be a symbolic link: {candidate}"
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => {
                return Err(format!(
                    "Failed to inspect plugin copy destination {candidate}: {error}"
                ));
            }
        }
    }
    unreachable!("copy suffix range is unbounded")
}

fn copy_registry_path(marketplace_root: &Path) -> PathBuf {
    marketplace_root.join(".wegent/plugin-copy-sources.json")
}

fn read_plugin_copy_registry(path: &Path) -> Result<LocalPluginCopyRegistry, String> {
    reject_symlink(path, "plugin copy registry")?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Plugin copy registry is invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(LocalPluginCopyRegistry::default())
        }
        Err(error) => Err(format!("Failed to read plugin copy registry: {error}")),
    }
}

fn serialize_plugin_copy_registry(registry: &LocalPluginCopyRegistry) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(registry)
        .map_err(|error| format!("Failed to serialize plugin copy registry: {error}"))
}

fn import_plugin_copy_package(
    marketplace_root: &Path,
    package: &[u8],
    request: &ImportPersonalPluginCopyRequest,
) -> Result<LocalPluginCopyImportResult, String> {
    validate_plugin_copy_request(request)?;
    if package.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("Plugin ZIP exceeds 50 MB".to_owned());
    }
    let expected_sha256 = normalized_plugin_copy_sha256(&request.sha256)?;
    if format!("{:x}", Sha256::digest(package)) != expected_sha256 {
        return Err("Plugin copy checksum mismatch".to_owned());
    }

    let marketplace_root = marketplace_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugins_root =
        prepare_direct_child_directory(&marketplace_root, "plugins", "personal plugin directory")?;
    let manifest_paths = prepare_personal_marketplace_manifest_paths(&marketplace_root)?;
    let registry_path = copy_registry_path(&marketplace_root);
    reject_symlink(&registry_path, "plugin copy registry")?;
    let registry_backup = read_optional_file(&registry_path)?;
    let mut registry = read_plugin_copy_registry(&registry_path)?;

    let plugin_name = unique_copy_slug(&plugins_root, &request.source_plugin_name)?;
    let display_base = request.source_display_name.trim();
    let display_name = format!(
        "{} · 我的副本",
        if display_base.is_empty() {
            request.source_plugin_name.trim()
        } else {
            display_base
        }
    );
    let staging_root = plugins_root.join(format!(
        ".{plugin_name}-import-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    if fs::symlink_metadata(&staging_root).is_ok() {
        return Err("Plugin copy staging path already exists".to_owned());
    }
    fs::create_dir(&staging_root)
        .map_err(|error| format!("Failed to create plugin import directory: {error}"))?;

    let import_result = (|| {
        let mut manifest = extract_plugin_copy(package, &staging_root)?;
        if manifest_string(&manifest, "name") != request.source_plugin_name.trim() {
            return Err(
                "Plugin copy manifest name does not match its source descriptor".to_owned(),
            );
        }
        let manifest_object = manifest
            .as_object_mut()
            .ok_or_else(|| "Local plugin manifest must be an object".to_owned())?;
        manifest_object.insert("name".to_owned(), Value::String(plugin_name.clone()));
        manifest_object.insert("version".to_owned(), Value::String("0.1.0".to_owned()));
        let interface = manifest_object
            .entry("interface")
            .or_insert_with(|| json!({}));
        let interface_object = interface
            .as_object_mut()
            .ok_or_else(|| "Local plugin manifest interface must be an object".to_owned())?;
        interface_object.insert(
            "displayName".to_owned(),
            Value::String(display_name.clone()),
        );
        write_atomic_file(
            &staging_root.join(".codex-plugin/plugin.json"),
            &serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("Failed to serialize local plugin manifest: {error}"))?,
        )?;

        let manifest_backups = manifest_paths
            .iter()
            .map(|path| read_optional_file(path).map(|bytes| (path.clone(), bytes)))
            .collect::<Result<Vec<_>, _>>()?;
        registry.copies.push(LocalPluginCopyRecord {
            local_plugin_name: plugin_name.clone(),
            source_plugin_id: request.source_plugin_id,
            source_release_id: request.source_release_id,
            source_plugin_name: request.source_plugin_name.trim().to_owned(),
        });
        let registry_bytes = serialize_plugin_copy_registry(&registry)?;
        let plugin_path = plugins_root.join(&plugin_name);
        fs::rename(&staging_root, &plugin_path)
            .map_err(|error| format!("Failed to install local plugin copy: {error}"))?;

        let mutation = manifest_paths
            .iter()
            .try_for_each(|path| upsert_marketplace_plugin_entry(path, &plugin_name))
            .and_then(|_| write_atomic_file(&registry_path, &registry_bytes));
        if let Err(error) = mutation {
            for (path, backup) in manifest_backups {
                let _ = restore_optional_file(&path, backup.as_deref());
            }
            let _ = restore_optional_file(&registry_path, registry_backup.as_deref());
            let _ = fs::remove_dir_all(&plugin_path);
            return Err(error);
        }
        Ok(LocalPluginCopyImportResult {
            plugin_name,
            display_name,
            version: "0.1.0".to_owned(),
            marketplace_path: marketplace_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
        })
    })();
    if import_result.is_err() {
        let _ = fs::remove_dir_all(&staging_root);
    }
    import_result
}

fn rollback_plugin_copy(marketplace_root: &Path, plugin_name: &str) -> Result<(), String> {
    let plugin_name = validate_plugin_copy_name(plugin_name)?;
    let marketplace_root = marketplace_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugins_root =
        prepare_direct_child_directory(&marketplace_root, "plugins", "personal plugin directory")?;
    let manifest_paths = prepare_personal_marketplace_manifest_paths(&marketplace_root)?;
    let registry_path = copy_registry_path(&marketplace_root);
    reject_symlink(&registry_path, "plugin copy registry")?;
    let registry_backup = read_optional_file(&registry_path)?;
    let mut registry = read_plugin_copy_registry(&registry_path)?;
    let manifest_backups = manifest_paths
        .iter()
        .map(|path| read_optional_file(path).map(|bytes| (path.clone(), bytes)))
        .collect::<Result<Vec<_>, _>>()?;
    let registered = registry
        .copies
        .iter()
        .any(|copy| copy.local_plugin_name == plugin_name);
    let plugin_path = plugins_root.join(plugin_name);
    let plugin_metadata = match fs::symlink_metadata(&plugin_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Failed to inspect plugin copy: {error}")),
    };
    if !registered {
        return if plugin_metadata.is_none() {
            Ok(())
        } else {
            Err("Plugin is not registered as a managed personal copy".to_owned())
        };
    }

    let rollback_staging = if let Some(metadata) = plugin_metadata {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Plugin copy must be a regular managed directory".to_owned());
        }
        let canonical_plugin = plugin_path
            .canonicalize()
            .map_err(|error| format!("Failed to resolve plugin copy: {error}"))?;
        if canonical_plugin.parent() != Some(plugins_root.as_path()) {
            return Err("Plugin copy is outside the personal marketplace".to_owned());
        }
        let manifest = serde_json::from_slice::<Value>(
            &fs::read(canonical_plugin.join(".codex-plugin/plugin.json"))
                .map_err(|error| format!("Failed to read plugin copy manifest: {error}"))?,
        )
        .map_err(|error| format!("Plugin copy manifest is invalid: {error}"))?;
        if manifest_string(&manifest, "name") != plugin_name {
            return Err("Plugin copy manifest name does not match its directory".to_owned());
        }
        collect_plugin_files(&canonical_plugin)?;
        let staging = plugins_root.join(format!(
            ".{plugin_name}-rollback-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        if fs::symlink_metadata(&staging).is_ok() {
            return Err("Plugin copy rollback staging path already exists".to_owned());
        }
        fs::rename(&canonical_plugin, &staging)
            .map_err(|error| format!("Failed to stage plugin copy rollback: {error}"))?;
        Some(staging)
    } else {
        None
    };

    registry
        .copies
        .retain(|copy| copy.local_plugin_name != plugin_name);
    let mutation = manifest_paths
        .iter()
        .try_for_each(|path| remove_marketplace_plugin_entry(path, plugin_name))
        .and_then(|_| {
            write_atomic_file(&registry_path, &serialize_plugin_copy_registry(&registry)?)
        });
    if let Err(error) = mutation {
        for (path, backup) in manifest_backups {
            let _ = restore_optional_file(&path, backup.as_deref());
        }
        let _ = restore_optional_file(&registry_path, registry_backup.as_deref());
        if let Some(staging) = rollback_staging {
            let _ = fs::rename(staging, &plugin_path);
        }
        return Err(error);
    }
    if let Some(staging) = rollback_staging {
        fs::remove_dir_all(staging)
            .map_err(|error| format!("Failed to remove plugin copy: {error}"))?;
    }
    Ok(())
}

fn validate_plugin_copy_name(plugin_name: &str) -> Result<&str, String> {
    let plugin_name = validate_personal_plugin_name(plugin_name)?;
    let plain_copy = plugin_name
        .strip_suffix("-copy")
        .is_some_and(|prefix| !prefix.is_empty());
    let numbered_copy = plugin_name
        .rsplit_once("-copy-")
        .is_some_and(|(prefix, suffix)| {
            !prefix.is_empty() && suffix.parse::<u32>().is_ok_and(|number| number >= 2)
        });
    if !plain_copy && !numbered_copy {
        return Err("Plugin copy name is invalid".to_owned());
    }
    Ok(plugin_name)
}

fn restore_optional_file(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    match bytes {
        Some(bytes) => write_atomic_file(path, bytes),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
        },
    }
}

fn preview_plugin_import_at(
    archive_path: &Path,
    marketplace_path: &Path,
) -> Result<LocalPluginImportPreview, String> {
    let package = read_plugin_archive(archive_path)?;
    let sha256 = format!("{:x}", Sha256::digest(&package));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let preview_root = std::env::temp_dir().join(format!(
        "wework-plugin-preview-{}-{}-{nonce}",
        std::process::id(),
        &sha256[..16]
    ));
    let _ = fs::remove_dir_all(&preview_root);
    fs::create_dir_all(&preview_root)
        .map_err(|error| format!("Failed to prepare plugin preview: {error}"))?;
    let manifest = match extract_plugin_copy(&package, &preview_root) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&preview_root);
            return Ok(LocalPluginImportPreview {
                valid: false,
                archive_path: archive_path.display().to_string(),
                sha256,
                name: String::new(),
                display_name: String::new(),
                version: String::new(),
                description: String::new(),
                skill_count: 0,
                mcp_server_count: 0,
                executable_capabilities: Vec::new(),
                existing: false,
                existing_version: None,
                issues: vec![classify_plugin_import_error(&package, error)],
            });
        }
    };
    let issues = validate_plugin_import_manifest(&preview_root, &manifest);
    let name = manifest_string(&manifest, "name").to_owned();
    let version = manifest_string(&manifest, "version").to_owned();
    let description = manifest_string(&manifest, "description").to_owned();
    let display_name = match plugin_interface_string(&manifest, "displayName") {
        "" => name.clone(),
        value => value.to_owned(),
    };
    let (skill_count, mcp_server_count, executable_capabilities) =
        plugin_component_summary(&preview_root, &manifest);
    let existing_root = marketplace_root_from_path(marketplace_path)
        .join("plugins")
        .join(&name);
    let existing_version = fs::read(existing_root.join(".codex-plugin/plugin.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let existing = existing_root.is_dir();
    let _ = fs::remove_dir_all(&preview_root);
    Ok(LocalPluginImportPreview {
        valid: issues.is_empty(),
        archive_path: archive_path.display().to_string(),
        sha256,
        name,
        display_name,
        version,
        description,
        skill_count,
        mcp_server_count,
        executable_capabilities,
        existing,
        existing_version,
        issues,
    })
}

fn import_plugin_package_at(
    marketplace_path: &Path,
    archive_path: &Path,
    expected_sha256: &str,
    overwrite: bool,
) -> Result<LocalPluginPackageImportResult, String> {
    let package = read_plugin_archive(archive_path)?;
    let actual_sha256 = format!("{:x}", Sha256::digest(&package));
    if actual_sha256 != expected_sha256 {
        return Err("The plugin ZIP changed after preview; select it again".to_owned());
    }
    fs::create_dir_all(marketplace_path).map_err(|error| {
        format!(
            "Failed to create personal marketplace {}: {error}",
            marketplace_path.display()
        )
    })?;
    let resolved_marketplace_path = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved_marketplace_path);
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugins_root = marketplace_root.join("plugins");
    fs::create_dir_all(&plugins_root)
        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
    let staging_root = plugins_root.join(format!(
        ".plugin-import-{}-{}",
        std::process::id(),
        &actual_sha256[..12]
    ));
    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir(&staging_root)
        .map_err(|error| format!("Failed to create plugin staging directory: {error}"))?;
    let import_result = (|| {
        let manifest = extract_plugin_copy(&package, &staging_root)?;
        let issues = validate_plugin_import_manifest(&staging_root, &manifest);
        if let Some(issue) = issues.first() {
            return Err(issue.message.clone());
        }
        let plugin_name = manifest_string(&manifest, "name").to_owned();
        let version = manifest_string(&manifest, "version").to_owned();
        let display_name = match plugin_interface_string(&manifest, "displayName") {
            "" => plugin_name.clone(),
            value => value.to_owned(),
        };
        let plugin_path = plugins_root.join(&plugin_name);
        let replaced_existing = plugin_path.exists();
        if replaced_existing && !overwrite {
            return Err(format!(
                "Plugin `{plugin_name}` already exists; confirm overwrite before importing"
            ));
        }
        let rollback_id = format!("{}-{}", &actual_sha256[..16], std::process::id());
        let backup_root = plugin_import_backup_root(&marketplace_root, &rollback_id)?;
        if backup_root.exists() {
            fs::remove_dir_all(&backup_root)
                .map_err(|error| format!("Failed to clear stale plugin import backup: {error}"))?;
        }
        fs::create_dir_all(&backup_root)
            .map_err(|error| format!("Failed to create plugin import backup: {error}"))?;
        let codex_marketplace = marketplace_root.join(".agents/plugins/marketplace.json");
        let claude_marketplace = marketplace_root.join(".claude-plugin/marketplace.json");
        let codex_marketplace_existed = codex_marketplace.is_file();
        let claude_marketplace_existed = claude_marketplace.is_file();
        backup_file_if_present(
            &codex_marketplace,
            &backup_root.join("codex-marketplace.json"),
        )?;
        backup_file_if_present(
            &claude_marketplace,
            &backup_root.join("claude-marketplace.json"),
        )?;
        let metadata = LocalPluginImportRollback {
            plugin_name: plugin_name.clone(),
            replaced_existing,
            codex_marketplace_existed,
            claude_marketplace_existed,
        };
        write_atomic_file(
            &backup_root.join("rollback.json"),
            &serde_json::to_vec_pretty(&metadata).map_err(|error| {
                format!("Failed to serialize plugin import rollback state: {error}")
            })?,
        )?;
        if replaced_existing {
            fs::rename(&plugin_path, backup_root.join("plugin"))
                .map_err(|error| format!("Failed to back up existing plugin: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging_root, &plugin_path) {
            if replaced_existing {
                let _ = fs::rename(backup_root.join("plugin"), &plugin_path);
            }
            let _ = fs::remove_dir_all(&backup_root);
            return Err(format!("Failed to activate imported plugin: {error}"));
        }
        if let Err(error) = upsert_marketplace_plugin_entry(&codex_marketplace, &plugin_name)
            .and_then(|_| upsert_marketplace_plugin_entry(&claude_marketplace, &plugin_name))
        {
            let _ = restore_plugin_import(&marketplace_root, &rollback_id);
            return Err(error);
        }
        Ok(LocalPluginPackageImportResult {
            plugin_name,
            display_name,
            version,
            marketplace_path: marketplace_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
            rollback_id,
        })
    })();
    if import_result.is_err() {
        let _ = fs::remove_dir_all(&staging_root);
    }
    import_result
}

fn backup_file_if_present(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_file() {
        fs::copy(source, destination)
            .map_err(|error| format!("Failed to back up {}: {error}", source.display()))?;
    }
    Ok(())
}

fn read_plugin_archive(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to read selected plugin ZIP: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected plugin package is not a file".to_owned());
    }
    if metadata.len() > MAX_PLUGIN_PACKAGE_BYTES as u64 {
        return Err("Plugin ZIP exceeds 50 MB".to_owned());
    }
    fs::read(path).map_err(|error| format!("Unable to read selected plugin ZIP: {error}"))
}

fn extract_plugin_copy(package: &[u8], destination: &Path) -> Result<Value, String> {
    reject_duplicate_zip_paths(package)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package))
        .map_err(|error| format!("Plugin package is not a valid ZIP: {error}"))?;
    if archive.len() > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(format!(
            "Plugin ZIP contains more than {MAX_PLUGIN_ARCHIVE_ENTRIES} entries"
        ));
    }
    let mut paths = HashSet::new();
    let mut expanded_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read plugin ZIP entry: {error}"))?;
        let entry_name = entry.name().trim_end_matches('/');
        if entry_name.is_empty()
            || entry_name == ".DS_Store"
            || entry_name.ends_with("/.DS_Store")
            || entry_name == "__MACOSX"
            || entry_name.starts_with("__MACOSX/")
        {
            continue;
        }
        let relative = safe_archive_path(entry_name)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if !paths.insert(normalized.clone()) {
            return Err(format!(
                "Plugin ZIP contains a duplicate path: {normalized}"
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Plugin ZIP contains a symbolic link: {normalized}"));
        }
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Failed to create {}: {error}", output.display()))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let mut file = fs::File::create(&output)
            .map_err(|error| format!("Failed to create {}: {error}", output.display()))?;
        let copied = copy_with_expanded_limit(
            &mut entry,
            &mut file,
            MAX_PLUGIN_EXPANDED_BYTES.saturating_sub(expanded_size),
        )
        .map_err(|error| format!("Failed to extract {normalized}: {error}"))?;
        expanded_size = expanded_size
            .checked_add(copied)
            .ok_or_else(|| "Plugin expanded size overflow".to_owned())?;
    }
    let manifest_bytes = fs::read(destination.join(".codex-plugin/plugin.json"))
        .map_err(|_| "Local plugin copy is missing .codex-plugin/plugin.json".to_owned())?;
    let manifest = serde_json::from_slice::<Value>(&manifest_bytes)
        .map_err(|error| format!("Local plugin manifest is invalid: {error}"))?;
    if !manifest.is_object()
        || manifest.get("name").and_then(Value::as_str).is_none()
        || manifest.get("version").and_then(Value::as_str).is_none()
    {
        return Err("Local plugin manifest requires string name and version fields".to_owned());
    }
    Ok(manifest)
}

fn reject_duplicate_zip_paths(package: &[u8]) -> Result<(), String> {
    const END_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
    let search_start = package.len().saturating_sub(65_557);
    let end_offset = (search_start..package.len().saturating_sub(3))
        .rev()
        .find(|offset| &package[*offset..*offset + 4] == END_SIGNATURE)
        .ok_or_else(|| "Plugin package is missing its ZIP directory".to_owned())?;
    if end_offset + 22 > package.len() {
        return Err("Plugin ZIP directory is truncated".to_owned());
    }
    let read_u16 =
        |offset: usize| u16::from_le_bytes([package[offset], package[offset + 1]]) as usize;
    let read_u32 = |offset: usize| {
        u32::from_le_bytes([
            package[offset],
            package[offset + 1],
            package[offset + 2],
            package[offset + 3],
        ]) as usize
    };
    let entry_count = read_u16(end_offset + 10);
    let directory_size = read_u32(end_offset + 12);
    let mut cursor = read_u32(end_offset + 16);
    if entry_count == u16::MAX as usize
        || directory_size == u32::MAX as usize
        || cursor == u32::MAX as usize
    {
        return Err("ZIP64 plugin copies are not supported".to_owned());
    }
    if entry_count > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(format!(
            "Plugin ZIP contains more than {MAX_PLUGIN_ARCHIVE_ENTRIES} entries"
        ));
    }
    let directory_end = cursor
        .checked_add(directory_size)
        .ok_or_else(|| "Plugin ZIP directory size overflow".to_owned())?;
    if directory_end > end_offset || directory_end > package.len() {
        return Err("Plugin ZIP directory is invalid".to_owned());
    }
    let mut names = HashSet::new();
    for _ in 0..entry_count {
        if cursor + 46 > directory_end || &package[cursor..cursor + 4] != CENTRAL_SIGNATURE {
            return Err("Plugin ZIP directory entry is invalid".to_owned());
        }
        let name_length = read_u16(cursor + 28);
        let extra_length = read_u16(cursor + 30);
        let comment_length = read_u16(cursor + 32);
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or_else(|| "Plugin ZIP filename size overflow".to_owned())?;
        if name_end > directory_end {
            return Err("Plugin ZIP filename is truncated".to_owned());
        }
        if !names.insert(package[name_start..name_end].to_vec()) {
            return Err(format!(
                "Plugin ZIP contains a duplicate path: {}",
                String::from_utf8_lossy(&package[name_start..name_end])
            ));
        }
        cursor = name_end
            .checked_add(extra_length)
            .and_then(|value| value.checked_add(comment_length))
            .ok_or_else(|| "Plugin ZIP directory entry size overflow".to_owned())?;
    }
    if cursor != directory_end {
        return Err("Plugin ZIP directory length does not match its entries".to_owned());
    }
    Ok(())
}

fn copy_with_expanded_limit<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    remaining_bytes: u64,
) -> Result<u64, String> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to decompress plugin ZIP entry: {error}"))?;
        if read == 0 {
            return Ok(copied);
        }
        let next = copied
            .checked_add(read as u64)
            .ok_or_else(|| "Plugin expanded size overflow".to_owned())?;
        if next > remaining_bytes {
            return Err("Expanded plugin package exceeds 200 MB".to_owned());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write plugin ZIP entry: {error}"))?;
        copied = next;
    }
}

fn safe_archive_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\0') || name.contains('\\') {
        return Err("Plugin ZIP contains an invalid path".to_owned());
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("Plugin ZIP contains an unsafe path: {name}"));
    }
    let normalized = path.components().collect::<PathBuf>();
    if normalized.to_string_lossy().replace('\\', "/") != name {
        return Err(format!("Plugin ZIP contains an unsafe path: {name}"));
    }
    Ok(normalized)
}

fn classify_plugin_import_error(package: &[u8], error: String) -> LocalPluginImportIssue {
    if error.contains("missing .codex-plugin/plugin.json") {
        if let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(package)) {
            let nested = (0..archive.len()).find_map(|index| {
                archive.by_index(index).ok().and_then(|entry| {
                    let name = entry.name().to_owned();
                    (name != ".codex-plugin/plugin.json"
                        && name.ends_with("/.codex-plugin/plugin.json"))
                    .then_some(name)
                })
            });
            if let Some(path) = nested {
                return plugin_import_issue(
                    "manifest_not_at_root",
                    Some(&path),
                    "The ZIP contains an extra top-level directory. Compress the contents of the plugin directory so `.codex-plugin/plugin.json` is at the ZIP root",
                );
            }
        }
        return plugin_import_issue(
            "manifest_missing",
            Some(".codex-plugin/plugin.json"),
            "This is not a standard Wework plugin package. Add `.codex-plugin/plugin.json` at the ZIP root",
        );
    }
    let normalized = error.to_ascii_lowercase();
    let code = if normalized.contains("password")
        || normalized.contains("decrypt")
        || normalized.contains("encrypted")
    {
        "archive_encrypted"
    } else if error.contains("valid ZIP") || error.contains("ZIP directory") {
        "zip_invalid"
    } else if error.contains("unsafe path")
        || error.contains("symbolic link")
        || error.contains("duplicate path")
    {
        "archive_unsafe"
    } else if error.contains("50 MB") || error.contains("200 MB") || error.contains("entries") {
        "archive_limit_exceeded"
    } else if error.contains("manifest") {
        "manifest_invalid"
    } else {
        "package_invalid"
    };
    plugin_import_issue(code, None, error)
}

fn validate_plugin_import_manifest(root: &Path, manifest: &Value) -> Vec<LocalPluginImportIssue> {
    let mut issues = Vec::new();
    let name = manifest_string(manifest, "name");
    if !valid_plugin_slug(name) {
        issues.push(plugin_import_issue(
            "manifest_name_invalid",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `name` must be a lowercase plugin slug",
        ));
    }
    if !valid_strict_semver(manifest_string(manifest, "version")) {
        issues.push(plugin_import_issue(
            "manifest_version_invalid",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `version` must use strict SemVer, for example 0.1.0",
        ));
    }
    if manifest_string(manifest, "description").is_empty() {
        issues.push(plugin_import_issue(
            "manifest_description_missing",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `description` is required",
        ));
    }
    if manifest
        .get("author")
        .and_then(Value::as_object)
        .and_then(|author| author.get("name"))
        .and_then(Value::as_str)
        .map_or(true, |name| name.trim().is_empty())
    {
        issues.push(plugin_import_issue(
            "manifest_author_missing",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `author.name` is required",
        ));
    }
    for key in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
    ] {
        if plugin_interface_string(manifest, key).is_empty() {
            issues.push(plugin_import_issue(
                "manifest_interface_incomplete",
                Some(".codex-plugin/plugin.json"),
                format!("plugin.json field `interface.{key}` is required"),
            ));
        }
    }
    let interface = manifest.get("interface").and_then(Value::as_object);
    if interface
        .and_then(|value| value.get("capabilities"))
        .map_or(true, |value| !value.is_array())
    {
        issues.push(plugin_import_issue(
            "manifest_capabilities_invalid",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `interface.capabilities` must be an array",
        ));
    }
    if interface.map_or(true, |value| {
        !value.contains_key("defaultPrompt") && !value.contains_key("default_prompt")
    }) {
        issues.push(plugin_import_issue(
            "manifest_default_prompt_missing",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `interface.defaultPrompt` is required",
        ));
    }
    if let Some(skills) = manifest.get("skills") {
        if skills
            .as_str()
            .map_or(true, |path| path.trim_end_matches('/') != "./skills")
            || !root.join("skills").is_dir()
        {
            issues.push(plugin_import_issue(
                "skills_path_invalid",
                Some(".codex-plugin/plugin.json"),
                "plugin.json field `skills` must resolve to an existing `./skills/` directory",
            ));
        }
    }
    validate_skill_manifests(root, &mut issues);
    match read_plugin_mcp_document(root, manifest) {
        Ok(Some(document)) if !valid_plugin_mcp_document(&document) => {
            issues.push(plugin_import_issue(
                "mcp_manifest_invalid",
                Some(".mcp.json"),
                "MCP configuration must be a direct server map or contain an `mcp_servers` or `mcpServers` object",
            ));
        }
        Err(issue) => issues.push(issue),
        _ => {}
    }
    if let Some(interface) = interface {
        for key in ["composerIcon", "logo", "logoDark"] {
            if let Some(path) = interface.get(key).and_then(Value::as_str) {
                let relative = path.trim_start_matches("./");
                if safe_archive_path(relative).is_err() || !root.join(relative).is_file() {
                    issues.push(plugin_import_issue(
                        "interface_asset_missing",
                        Some(".codex-plugin/plugin.json"),
                        format!("plugin.json field `interface.{key}` points to a missing file"),
                    ));
                }
            }
        }
    }
    issues
}

fn validate_skill_manifests(root: &Path, issues: &mut Vec<LocalPluginImportIssue>) {
    let Ok(entries) = fs::read_dir(root.join("skills")) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_root = entry.path();
        if !skill_root.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let label = format!("skills/{}/SKILL.md", entry.file_name().to_string_lossy());
        let valid = fs::read_to_string(skill_root.join("SKILL.md"))
            .ok()
            .filter(|contents| contents.starts_with("---\n"))
            .and_then(|contents| {
                let frontmatter = contents[4..].split("\n---").next()?.to_owned();
                Some(frontmatter)
            })
            .is_some_and(|frontmatter| {
                ["name:", "description:"].iter().all(|key| {
                    frontmatter.lines().any(|line| {
                        line.trim_start()
                            .strip_prefix(key)
                            .is_some_and(|value| !value.trim().is_empty())
                    })
                })
            });
        if !valid {
            issues.push(plugin_import_issue(
                "skill_manifest_invalid",
                Some(&label),
                "Each skill directory must contain SKILL.md with closed YAML frontmatter and non-empty `name` and `description` fields",
            ));
        }
    }
}

fn read_plugin_mcp_document(
    root: &Path,
    manifest: &Value,
) -> Result<Option<Value>, LocalPluginImportIssue> {
    let (path, display_path) = match manifest.get("mcpServers") {
        Some(declaration) if declaration.is_object() => return Ok(Some(declaration.clone())),
        Some(declaration) => {
            let Some(relative) = declaration.as_str().map(str::trim) else {
                return Err(plugin_import_issue(
                    "mcp_manifest_invalid",
                    Some(".codex-plugin/plugin.json"),
                    "plugin.json field `mcpServers` must be a relative path or an object",
                ));
            };
            let Some(trimmed) = relative.strip_prefix("./") else {
                return Err(plugin_import_issue(
                    "mcp_path_invalid",
                    Some(".codex-plugin/plugin.json"),
                    "plugin.json field `mcpServers` must start with `./`",
                ));
            };
            if safe_archive_path(trimmed).is_err() || !root.join(trimmed).is_file() {
                return Err(plugin_import_issue(
                    "mcp_path_invalid",
                    Some(".codex-plugin/plugin.json"),
                    "plugin.json field `mcpServers` must resolve to a file inside the plugin",
                ));
            }
            (root.join(trimmed), trimmed.to_owned())
        }
        None => {
            let Some(relative) = ["mcp.json", ".mcp.json"]
                .into_iter()
                .find(|relative| root.join(relative).is_file())
            else {
                return Ok(None);
            };
            (root.join(relative), relative.to_owned())
        }
    };
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(Some)
        .ok_or_else(|| {
            plugin_import_issue(
                "mcp_manifest_invalid",
                Some(&display_path),
                "MCP configuration must contain valid JSON",
            )
        })
}

fn plugin_component_summary(root: &Path, manifest: &Value) -> (usize, usize, Vec<String>) {
    let skill_count = fs::read_dir(root.join("skills"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().join("SKILL.md").is_file())
                .count()
        })
        .unwrap_or(0);
    let mcp = read_plugin_mcp_document(root, manifest)
        .ok()
        .flatten()
        .and_then(|document| mcp_server_map(&document).cloned())
        .map(Value::Object);
    let mcp_server_count = mcp.as_ref().and_then(Value::as_object).map_or(0, Map::len);
    let mut executable = Vec::new();
    if let Some(servers) = mcp.as_ref().and_then(Value::as_object) {
        for (name, server) in servers {
            if server.get("command").is_some()
                || server.get("type").and_then(Value::as_str) == Some("stdio")
            {
                executable.push(format!("stdio MCP: {name}"));
            }
        }
    }
    if root.join("hooks").exists() || root.join("hooks.json").exists() {
        executable.push("hooks".to_owned());
    }
    if root.join("bin").exists() || root.join("bins").exists() {
        executable.push("binaries".to_owned());
    }
    (skill_count, mcp_server_count, executable)
}

fn mcp_server_map(document: &Value) -> Option<&Map<String, Value>> {
    let object = document.as_object()?;
    for wrapper in ["mcp_servers", "mcpServers"] {
        if let Some(servers) = object.get(wrapper) {
            return servers.as_object();
        }
    }
    Some(object)
}

fn valid_plugin_mcp_document(document: &Value) -> bool {
    mcp_server_map(document).is_some_and(|servers| {
        servers
            .iter()
            .all(|(name, server)| !name.trim().is_empty() && server.is_object())
    })
}

fn plugin_import_issue(
    code: &str,
    path: Option<&str>,
    message: impl Into<String>,
) -> LocalPluginImportIssue {
    LocalPluginImportIssue {
        code: code.to_owned(),
        path: path.map(str::to_owned),
        message: message.into(),
    }
}

fn manifest_string<'a>(manifest: &'a Value, key: &str) -> &'a str {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

fn plugin_interface_string<'a>(manifest: &'a Value, key: &str) -> &'a str {
    manifest
        .get("interface")
        .and_then(Value::as_object)
        .and_then(|interface| interface.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

fn valid_plugin_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
}

fn valid_strict_semver(value: &str) -> bool {
    let (core_and_pre, build) = value
        .split_once('+')
        .map_or((value, None), |(left, right)| (left, Some(right)));
    if build.is_some_and(|value| {
        value
            .split('.')
            .any(|item| !valid_semver_identifier(item, true))
    }) {
        return false;
    }
    let (core, pre) = core_and_pre
        .split_once('-')
        .map_or((core_and_pre, None), |(left, right)| (left, Some(right)));
    if pre.is_some_and(|value| {
        value
            .split('.')
            .any(|item| !valid_semver_identifier(item, false))
    }) {
        return false;
    }
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.chars().all(|character| character.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

fn valid_semver_identifier(value: &str, allow_leading_zero: bool) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        && (allow_leading_zero
            || value.len() == 1
            || !value.starts_with('0')
            || !value.chars().all(|character| character.is_ascii_digit()))
}

fn ensure_personal_plugin_at(
    source_marketplace_path: &Path,
    destination_marketplace_path: &Path,
    plugin_name: &str,
) -> Result<EnsurePersonalPluginResult, String> {
    let plugin_name = validate_personal_plugin_name(plugin_name)?;
    let destination_root = prepare_local_marketplace_root(destination_marketplace_path)?;
    let _mutation_lock = acquire_plugin_mutation_lock(&destination_root)?;
    let plugins_root = destination_root.join("plugins");
    create_directory_without_symlink(&plugins_root, "personal plugin directory")?;

    let destination_plugin = plugins_root.join(plugin_name);
    if destination_plugin.exists() {
        let plugin_path = resolve_managed_personal_plugin(&destination_root, plugin_name)?;
        return Ok(EnsurePersonalPluginResult {
            plugin_name: plugin_name.to_owned(),
            marketplace_path: destination_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
            migrated: false,
        });
    }

    let manifest_paths = prepare_personal_marketplace_manifest_paths(&destination_root)?;
    let manifest_backups = manifest_paths
        .iter()
        .map(|path| read_optional_file(path).map(|bytes| (path.clone(), bytes)))
        .collect::<Result<Vec<_>, _>>()?;

    let source_root = resolve_existing_marketplace_root(source_marketplace_path)?;
    let source_plugin =
        resolve_source_personal_plugin(source_marketplace_path, &source_root, plugin_name)?;
    let staging = plugins_root.join(format!(
        ".{plugin_name}-migrate-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    if staging.exists() {
        return Err("Personal plugin migration staging path already exists".to_owned());
    }
    if let Err(error) = copy_plugin_directory(&source_plugin, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, &destination_plugin) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed to activate migrated plugin: {error}"));
    }

    let manifest_result = manifest_paths
        .iter()
        .try_for_each(|path| upsert_marketplace_plugin_entry(path, plugin_name));
    if let Err(error) = manifest_result {
        for (path, backup) in manifest_backups {
            match backup {
                Some(bytes) => {
                    let _ = write_atomic_file(&path, &bytes);
                }
                None => {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let _ = fs::remove_dir_all(&destination_plugin);
        return Err(error);
    }

    let plugin_path = destination_plugin
        .canonicalize()
        .map_err(|error| format!("Failed to resolve migrated plugin: {error}"))?;
    Ok(EnsurePersonalPluginResult {
        plugin_name: plugin_name.to_owned(),
        marketplace_path: destination_root.display().to_string(),
        plugin_path: plugin_path.display().to_string(),
        migrated: true,
    })
}

fn package_plugin_directory(
    root: &Path,
    plugin_name: &str,
    artifact_root: &Path,
) -> Result<LocalPluginPackage, String> {
    let files = collect_plugin_files(root)?;
    let expanded_size = files.iter().try_fold(0_u64, |total, path| {
        let size = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .len();
        total
            .checked_add(size)
            .ok_or_else(|| "Plugin package size overflow".to_owned())
    })?;
    if expanded_size > MAX_PLUGIN_EXPANDED_BYTES {
        return Err("Expanded plugin package exceeds 200 MB".to_owned());
    }

    let cleanup_token = Uuid::new_v4().to_string();
    let artifact_path = artifact_root.join(format!("{cleanup_token}.zip"));
    let mut open_options = fs::OpenOptions::new();
    open_options.create_new(true).write(true);
    #[cfg(unix)]
    open_options.mode(0o600);
    let artifact_file = open_options
        .open(&artifact_path)
        .map_err(|error| format!("Failed to create personal plugin package artifact: {error}"))?;

    let package_result = (|| {
        let mut archive = zip::ZipWriter::new(artifact_file);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for path in files {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Plugin file escaped its package root".to_owned())?;
            let archive_path = relative.to_string_lossy().replace('\\', "/");
            archive
                .start_file(&archive_path, options)
                .map_err(|error| format!("Failed to add {archive_path}: {error}"))?;
            let mut file = fs::File::open(&path)
                .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
            std::io::copy(&mut file, &mut archive)
                .map_err(|error| format!("Failed to package {archive_path}: {error}"))?;
        }
        let mut artifact_file = archive
            .finish()
            .map_err(|error| format!("Failed to finish plugin package: {error}"))?;
        artifact_file
            .flush()
            .map_err(|error| format!("Failed to flush plugin package: {error}"))?;
        drop(artifact_file);

        let metadata = fs::symlink_metadata(&artifact_path)
            .map_err(|error| format!("Failed to inspect plugin package: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Plugin package artifact is not a regular file".to_owned());
        }
        if metadata.len() > MAX_PLUGIN_PACKAGE_BYTES as u64 {
            return Err("Plugin ZIP exceeds 50 MB".to_owned());
        }
        let sha256 = sha256_file(&artifact_path)?;
        Ok(LocalPluginPackage {
            name: format!("{plugin_name}.zip"),
            path: artifact_path.display().to_string(),
            size: metadata.len(),
            sha256,
            cleanup_token: cleanup_token.clone(),
        })
    })();
    if package_result.is_err() {
        let _ = fs::remove_file(&artifact_path);
    }
    package_result
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to open plugin package for verification: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to verify plugin package: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        digest.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_plugin_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            let entry_name = entry.file_name();
            if metadata.is_dir()
                && IGNORED_PLUGIN_SOURCE_DIRECTORIES
                    .iter()
                    .any(|ignored| entry_name == *ignored)
            {
                continue;
            }
            if metadata.is_file()
                && IGNORED_PLUGIN_SOURCE_FILES
                    .iter()
                    .any(|ignored| entry_name == *ignored)
            {
                continue;
            }
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Plugin package cannot contain symbolic links: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file() {
                path.strip_prefix(root)
                    .map_err(|_| "Plugin file escaped its package root".to_owned())?;
                files.push(path);
            } else {
                return Err(format!(
                    "Plugin package contains an unsupported filesystem entry: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Failed to inspect {}: {error}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin package root must be a regular directory".to_owned());
    }
    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn copy_plugin_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fn copy_entries(source: &Path, destination: &Path, total: &mut u64) -> Result<(), String> {
        fs::create_dir_all(destination)
            .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source_path)
                .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Personal plugin cannot contain symbolic links: {}",
                    source_path.display()
                ));
            }
            if metadata.is_dir() {
                copy_entries(&source_path, &destination_path, total)?;
            } else if metadata.is_file() {
                *total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| "Plugin expanded size overflow".to_owned())?;
                if *total > MAX_PLUGIN_EXPANDED_BYTES {
                    return Err("Expanded plugin package exceeds 200 MB".to_owned());
                }
                fs::copy(&source_path, &destination_path).map_err(|error| {
                    format!(
                        "Failed to copy {} to {}: {error}",
                        source_path.display(),
                        destination_path.display()
                    )
                })?;
            } else {
                return Err(format!(
                    "Personal plugin contains an unsupported filesystem entry: {}",
                    source_path.display()
                ));
            }
        }
        Ok(())
    }

    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Failed to inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Personal plugin source must be a regular directory".to_owned());
    }
    let mut total = 0_u64;
    copy_entries(source, destination, &mut total)
}

fn resolve_source_personal_plugin(
    marketplace_path: &Path,
    marketplace_root: &Path,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    let mut candidates = vec![
        marketplace_root.join("plugins").join(plugin_name),
        marketplace_root.join(plugin_name),
    ];
    for manifest_path in marketplace_manifest_paths(marketplace_path, marketplace_root) {
        if let Some(source) = plugin_source_from_manifest(&manifest_path, plugin_name)? {
            candidates.push(source);
        }
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        let Ok(metadata) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(marketplace_root)
            || canonical.file_name().and_then(|name| name.to_str()) != Some(plugin_name)
            || !seen.insert(canonical.clone())
        {
            continue;
        }
        if regular_plugin_manifest(&canonical)?.is_some() {
            return Ok(canonical);
        }
    }
    Err("Local plugin manifest is unavailable".to_owned())
}

fn marketplace_manifest_paths(marketplace_path: &Path, marketplace_root: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        marketplace_root.join(".agents/plugins/marketplace.json"),
        marketplace_root.join(".claude-plugin/marketplace.json"),
        marketplace_root.join("marketplace.json"),
        marketplace_root.join("plugins/marketplace.json"),
    ];
    if marketplace_path.file_name().and_then(|name| name.to_str()) == Some("marketplace.json") {
        paths.push(marketplace_path.to_path_buf());
    }
    paths.sort();
    paths.dedup();
    paths
}

fn plugin_source_from_manifest(
    manifest_path: &Path,
    plugin_name: &str,
) -> Result<Option<PathBuf>, String> {
    if !manifest_path.exists() {
        return Ok(None);
    }
    reject_symlink(manifest_path, "marketplace manifest")?;
    let manifest = serde_json::from_slice::<Value>(
        &fs::read(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
    let source = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .and_then(|plugins| {
            plugins
                .iter()
                .find(|plugin| plugin.get("name").and_then(Value::as_str) == Some(plugin_name))
        })
        .and_then(|plugin| plugin.get("source"))
        .and_then(|source| {
            source
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| source.as_str())
        });
    let Some(source) = source.map(str::trim).filter(|source| !source.is_empty()) else {
        return Ok(None);
    };
    let relative = Path::new(source);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Personal marketplace plugin source must be a relative path".to_owned());
    }
    let marketplace_root = marketplace_root_from_path(manifest_path);
    Ok(Some(marketplace_root.join(relative)))
}

fn prepare_personal_marketplace_root(path: &Path) -> Result<PathBuf, String> {
    let executor_home = required_executor_home()?;
    prepare_personal_marketplace_root_for_executor_home(path, &executor_home)
}

fn prepare_local_marketplace_root(path: &Path) -> Result<PathBuf, String> {
    let root = marketplace_root_from_path(path);
    if root.exists() {
        reject_symlink(&root, "personal marketplace")?;
        if !root.is_dir() {
            return Err("Personal marketplace path must be a directory".to_owned());
        }
    } else {
        fs::create_dir_all(&root).map_err(|error| {
            format!(
                "Failed to create personal marketplace {}: {error}",
                root.display()
            )
        })?;
    }
    root.canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))
}

fn prepare_personal_marketplace_root_for_executor_home(
    path: &Path,
    executor_home: &Path,
) -> Result<PathBuf, String> {
    let expected = executor_home
        .join("capabilities")
        .join("bundled-marketplaces")
        .join(PERSONAL_MARKETPLACE_ID);
    if path != expected {
        return Err(format!(
            "Personal marketplace path must be {}",
            expected.display()
        ));
    }
    create_directory_without_symlink(executor_home, "executor home")?;
    let mut parent = executor_home
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor home: {error}"))?;
    for (name, label) in [
        ("capabilities", "executor capabilities"),
        ("bundled-marketplaces", "bundled marketplace directory"),
        (PERSONAL_MARKETPLACE_ID, "personal marketplace"),
    ] {
        parent = prepare_direct_child_directory(&parent, name, label)?;
    }
    Ok(parent)
}

fn resolve_existing_marketplace_root(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        reject_symlink(path, "marketplace path")?;
    }
    let root = marketplace_root_from_path(path);
    reject_symlink(&root, "marketplace root")?;
    let metadata = fs::metadata(&root)
        .map_err(|error| format!("Failed to inspect local marketplace: {error}"))?;
    if !metadata.is_dir() {
        return Err("Local marketplace path must resolve to a directory".to_owned());
    }
    root.canonicalize()
        .map_err(|error| format!("Failed to resolve local marketplace: {error}"))
}

fn resolve_managed_personal_plugin(
    marketplace_root: &Path,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    let plugins_root = marketplace_root.join("plugins");
    reject_symlink(&plugins_root, "personal plugin directory")?;
    let canonical_plugins_root = plugins_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal plugin directory: {error}"))?;
    let plugin_path = plugins_root.join(plugin_name);
    reject_symlink(&plugin_path, "personal plugin")?;
    let metadata = fs::metadata(&plugin_path)
        .map_err(|error| format!("Failed to inspect personal plugin: {error}"))?;
    if !metadata.is_dir() {
        return Err("Plugin is not a managed personal plugin directory".to_owned());
    }
    let canonical_plugin = plugin_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal plugin: {error}"))?;
    if canonical_plugin.parent() != Some(canonical_plugins_root.as_path())
        || canonical_plugin.file_name().and_then(|name| name.to_str()) != Some(plugin_name)
        || regular_plugin_manifest(&canonical_plugin)?.is_none()
    {
        return Err("Plugin is not a managed personal plugin".to_owned());
    }
    Ok(canonical_plugin)
}

fn regular_plugin_manifest(plugin_root: &Path) -> Result<Option<PathBuf>, String> {
    for path in [
        plugin_root.join(".codex-plugin/plugin.json"),
        plugin_root.join(".claude-plugin/plugin.json"),
        plugin_root.join("plugin.json"),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Plugin manifest may not be a symbolic link: {}",
                    path.display()
                ));
            }
            Ok(metadata) if metadata.is_file() => return Ok(Some(path)),
            Ok(_) => {
                return Err(format!(
                    "Plugin manifest must be a regular file: {}",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Failed to inspect {}: {error}", path.display()));
            }
        }
    }
    Ok(None)
}

fn create_directory_without_symlink(path: &Path, label: &str) -> Result<(), String> {
    if path.exists() {
        reject_symlink(path, label)?;
        if !path.is_dir() {
            return Err(format!("{label} must be a directory"));
        }
        return Ok(());
    }
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "{label} may not be a symbolic link: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

fn validate_personal_plugin_name(plugin_name: &str) -> Result<&str, String> {
    let plugin_name = validate_plugin_name(plugin_name)?;
    if !valid_plugin_slug(plugin_name) {
        return Err("Plugin name must be a lowercase plugin slug".to_owned());
    }
    Ok(plugin_name)
}

fn required_executor_home() -> Result<PathBuf, String> {
    env::var_os(EXECUTOR_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("{EXECUTOR_HOME_ENV} is required for personal plugin copies"))
}

fn prepare_personal_package_artifact_root() -> Result<PathBuf, String> {
    let executor_home = required_executor_home()?;
    if executor_home
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Executor home may not contain parent traversal".to_owned());
    }
    create_directory_without_symlink(&executor_home, "executor home")?;
    let artifacts_root = executor_home.join("artifacts");
    create_directory_without_symlink(&artifacts_root, "executor artifact directory")?;
    let package_root = artifacts_root.join(PERSONAL_PACKAGE_ARTIFACT_DIRECTORY);
    create_directory_without_symlink(&package_root, "personal plugin package artifact directory")?;
    #[cfg(unix)]
    for path in [&artifacts_root, &package_root] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!("Failed to secure personal plugin package artifact directory: {error}")
        })?;
    }

    let canonical_home = executor_home
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor home: {error}"))?;
    let canonical_artifacts = artifacts_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor artifact directory: {error}"))?;
    let canonical_package_root = package_root.canonicalize().map_err(|error| {
        format!("Failed to resolve personal plugin package artifact directory: {error}")
    })?;
    if canonical_artifacts.parent() != Some(canonical_home.as_path())
        || canonical_package_root.parent() != Some(canonical_artifacts.as_path())
    {
        return Err("Personal plugin package artifact directory escaped executor home".to_owned());
    }
    Ok(canonical_package_root)
}

fn validate_personal_package_cleanup_token(value: &str) -> Result<&str, String> {
    let token = value.trim();
    let parsed = Uuid::parse_str(token)
        .map_err(|_| "Personal plugin package cleanup token is invalid".to_owned())?;
    if parsed.to_string() != token {
        return Err("Personal plugin package cleanup token is invalid".to_owned());
    }
    Ok(token)
}

fn personal_package_artifact_token(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let token = name.strip_suffix(".zip")?;
    validate_personal_package_cleanup_token(token).ok()
}

fn remove_personal_package_artifact(
    artifact_root: &Path,
    cleanup_token: &str,
) -> Result<(), String> {
    let canonical_artifact_root = artifact_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin package artifact directory: {error}"))?;
    let artifact_path = artifact_root.join(format!("{cleanup_token}.zip"));
    let metadata = match fs::symlink_metadata(&artifact_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect plugin package artifact: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Plugin package cleanup target must be a direct regular file".to_owned());
    }
    let canonical_path = artifact_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin package artifact: {error}"))?;
    if canonical_path.parent() != Some(canonical_artifact_root.as_path()) {
        return Err("Plugin package cleanup target escaped its artifact directory".to_owned());
    }
    fs::remove_file(canonical_path)
        .map_err(|error| format!("Failed to clean up plugin package artifact: {error}"))
}

fn cleanup_stale_personal_package_artifacts(artifact_root: &Path) {
    let now = SystemTime::now();
    let entries = match fs::read_dir(artifact_root) {
        Ok(entries) => entries,
        Err(error) => {
            log_executor_event(
                "personal plugin package artifact cleanup failed",
                &[("error", error.to_string())],
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if personal_package_artifact_token(&path).is_none() {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= PERSONAL_PACKAGE_ARTIFACT_TTL);
        if is_stale {
            if let Err(error) = fs::remove_file(&path) {
                log_executor_event(
                    "stale personal plugin package artifact cleanup failed",
                    &[("error", error.to_string())],
                );
            }
        }
    }
}

fn validated_personal_marketplace_path(path: &str) -> Result<PathBuf, String> {
    let executor_home = required_executor_home()?;
    validated_personal_marketplace_path_for_executor_home(path, &executor_home)
}

fn validated_personal_marketplace_path_for_executor_home(
    path: &str,
    executor_home: &Path,
) -> Result<PathBuf, String> {
    if executor_home
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Executor home may not contain parent traversal".to_owned());
    }
    let expected = executor_home
        .join("capabilities")
        .join("bundled-marketplaces")
        .join(PERSONAL_MARKETPLACE_ID);
    let requested = match path.trim() {
        "" => expected.clone(),
        value => PathBuf::from(value),
    };
    if requested
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Personal marketplace path may not contain parent traversal".to_owned());
    }
    reject_symlink(&requested, "requested personal marketplace")?;
    if requested.exists() && !requested.is_dir() {
        return Err("Requested personal marketplace must be a directory".to_owned());
    }
    let canonical_expected = expected.canonicalize().ok();
    if requested != expected
        && canonical_expected
            .as_ref()
            .map_or(true, |canonical| requested != *canonical)
    {
        return Err(format!(
            "Personal marketplace path must be {}",
            expected.display()
        ));
    }
    for (candidate, label) in [
        (executor_home.to_path_buf(), "executor home"),
        (executor_home.join("capabilities"), "executor capabilities"),
        (
            executor_home.join("capabilities/bundled-marketplaces"),
            "bundled marketplace directory",
        ),
        (expected.clone(), "personal marketplace"),
    ] {
        reject_symlink(&candidate, label)?;
        if candidate.exists() && !candidate.is_dir() {
            return Err(format!("{label} must be a directory"));
        }
    }
    Ok(expected)
}

fn prepare_direct_child_directory(
    parent: &Path,
    name: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let path = parent.join(name);
    create_directory_without_symlink(&path, label)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {label}: {error}"))?;
    if canonical.parent() != Some(parent) {
        return Err(format!("{label} escaped its managed parent"));
    }
    Ok(canonical)
}

fn prepare_personal_marketplace_manifest_paths(
    marketplace_root: &Path,
) -> Result<[PathBuf; 2], String> {
    let agents =
        prepare_direct_child_directory(marketplace_root, ".agents", "Codex marketplace directory")?;
    let agents_plugins =
        prepare_direct_child_directory(&agents, "plugins", "Codex plugin directory")?;
    let claude = prepare_direct_child_directory(
        marketplace_root,
        ".claude-plugin",
        "Claude marketplace directory",
    )?;
    let paths = [
        agents_plugins.join("marketplace.json"),
        claude.join("marketplace.json"),
    ];
    for path in &paths {
        reject_symlink(path, "personal marketplace manifest")?;
        if path.exists() {
            let metadata = fs::metadata(path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            if !metadata.is_file() {
                return Err("Personal marketplace manifest must be a regular file".to_owned());
            }
            let manifest = serde_json::from_slice::<Value>(
                &fs::read(path)
                    .map_err(|error| format!("Failed to read {}: {error}", path.display()))?,
            )
            .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
            if manifest
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name != PERSONAL_MARKETPLACE_ID)
            {
                return Err("Refusing to mutate a non-personal marketplace".to_owned());
            }
        }
    }
    Ok(paths)
}

fn list_personal_plugins_at(path: &Path) -> Result<PersonalMarketplaceListResult, String> {
    let root = marketplace_root_from_path(path);
    if root.exists() {
        reject_symlink(&root, "personal marketplace")?;
        if !root.is_dir() {
            return Err("Personal marketplace path must be a directory".to_owned());
        }
    }
    let root = root.canonicalize().unwrap_or(root);
    let mut by_name = BTreeMap::<String, PersonalMarketplacePluginSummary>::new();
    let manifest_path = root.join(".agents/plugins/marketplace.json");
    if manifest_path.exists() {
        reject_symlink(&manifest_path, "personal marketplace manifest")?;
        match personal_marketplace_plugin_names(&manifest_path) {
            Ok(names) => {
                for name in names {
                    if let Ok(plugin_root) = resolve_managed_personal_plugin(&root, &name) {
                        by_name.insert(
                            name.clone(),
                            personal_plugin_summary(&name, &root, &plugin_root),
                        );
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "[Wework] personal marketplace.json skipped at {}: {error}",
                    manifest_path.display()
                );
            }
        }
    }

    let plugins_root = root.join("plugins");
    if plugins_root.exists() {
        reject_symlink(&plugins_root, "personal plugin directory")?;
        let entries = fs::read_dir(&plugins_root)
            .map_err(|error| format!("Failed to read {}: {error}", plugins_root.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Failed to read {}: {error}", plugins_root.display()))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_personal_plugin_name(&name).is_err() {
                continue;
            }
            let Ok(plugin_root) = resolve_managed_personal_plugin(&root, &name) else {
                continue;
            };
            let summary = personal_plugin_summary(&name, &root, &plugin_root);
            match by_name.get_mut(&name) {
                Some(existing) => enrich_personal_plugin_summary(existing, summary),
                None => {
                    by_name.insert(name, summary);
                }
            }
        }
    }
    Ok(PersonalMarketplaceListResult {
        marketplace_id: PERSONAL_MARKETPLACE_ID.to_owned(),
        marketplace_path: root.display().to_string(),
        plugins: by_name.into_values().collect(),
    })
}

fn personal_marketplace_plugin_names(manifest_path: &Path) -> Result<Vec<String>, String> {
    let manifest = serde_json::from_slice::<Value>(
        &fs::read(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Invalid marketplace {}: {error}", manifest_path.display()))?;
    if !matches!(
        manifest.get("name").and_then(Value::as_str),
        Some(PERSONAL_MARKETPLACE_ID) | Some(CODEX_PERSONAL_MARKETPLACE_ID)
    ) {
        return Err(format!(
            "Marketplace {} is not a personal marketplace",
            manifest_path.display()
        ));
    }
    let plugins = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| "Personal marketplace plugins must be an array".to_owned())?;
    let mut names = plugins
        .iter()
        .filter_map(|plugin| plugin.get("name").and_then(Value::as_str))
        .filter_map(|name| validate_personal_plugin_name(name).ok().map(str::to_owned))
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

fn personal_plugin_summary(
    name: &str,
    marketplace_root: &Path,
    plugin_root: &Path,
) -> PersonalMarketplacePluginSummary {
    let mut summary = PersonalMarketplacePluginSummary {
        name: name.to_owned(),
        version: None,
        display_name: None,
        description: None,
        logo: None,
        category: None,
        marketplace_path: marketplace_root.display().to_string(),
        plugin_path: plugin_root.display().to_string(),
    };
    if let Ok(Some(manifest_path)) = regular_plugin_manifest(plugin_root) {
        if let Ok(manifest) = fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or(())
        {
            summary.version = optional_trimmed_string(manifest.get("version"));
            summary.description =
                optional_trimmed_string(manifest.get("description")).or_else(|| {
                    optional_trimmed_string(manifest.pointer("/interface/shortDescription"))
                });
            summary.display_name =
                optional_trimmed_string(manifest.pointer("/interface/displayName"));
            summary.logo = optional_trimmed_string(manifest.pointer("/interface/logo"));
            summary.category = optional_trimmed_string(manifest.pointer("/interface/category"));
        }
    }
    summary
}

fn enrich_personal_plugin_summary(
    existing: &mut PersonalMarketplacePluginSummary,
    candidate: PersonalMarketplacePluginSummary,
) {
    if existing.display_name.is_none() {
        existing.display_name = candidate.display_name;
    }
    if existing.description.is_none() {
        existing.description = candidate.description;
    }
    if existing.version.is_none() {
        existing.version = candidate.version;
    }
    if existing.logo.is_none() {
        existing.logo = candidate.logo;
    }
    if existing.category.is_none() {
        existing.category = candidate.category;
    }
}

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn marketplace_root_from_path(path: &Path) -> PathBuf {
    if path
        .file_name()
        .map_or(true, |name| name != "marketplace.json")
    {
        return path.to_path_buf();
    }
    let Some(parent) = path.parent() else {
        return path.to_path_buf();
    };
    if parent.file_name().is_some_and(|name| name == "plugins") {
        if let Some(scope) = parent.parent() {
            if scope
                .file_name()
                .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
            {
                return scope.parent().unwrap_or(scope).to_path_buf();
            }
        }
    }
    if parent
        .file_name()
        .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
    {
        return parent.parent().unwrap_or(parent).to_path_buf();
    }
    parent.to_path_buf()
}

fn validate_plugin_name(plugin_name: &str) -> Result<&str, String> {
    let normalized = plugin_name.trim();
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains('\\')
        || matches!(normalized, "." | "..")
    {
        return Err("Plugin name is invalid".to_owned());
    }
    Ok(normalized)
}

fn plugin_cloud_link_registry_path(marketplace_root: &Path) -> PathBuf {
    let bundled_marketplaces = marketplace_root.parent();
    let capabilities = bundled_marketplaces.and_then(Path::parent);
    if bundled_marketplaces
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some("bundled-marketplaces")
        && capabilities
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("capabilities")
    {
        let marketplace_name = marketplace_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(PERSONAL_MARKETPLACE_ID);
        return capabilities
            .unwrap_or(marketplace_root)
            .join("plugin-state")
            .join(format!("{marketplace_name}-cloud-links.json"));
    }
    marketplace_root.join(".wegent/plugin-cloud-links.json")
}

fn load_plugin_cloud_links(marketplace_root: &Path) -> Vec<LocalPluginCloudLink> {
    let path = plugin_cloud_link_registry_path(marketplace_root);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<LocalPluginCloudLinkRegistry>(&bytes)
            .map(|registry| registry.cloud_links)
            .unwrap_or_else(|error| {
                log_executor_event(
                    "invalid plugin cloud link registry ignored",
                    &[
                        ("path", path.display().to_string()),
                        ("error", error.to_string()),
                    ],
                );
                Vec::new()
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            log_executor_event(
                "plugin cloud link registry read failed",
                &[
                    ("path", path.display().to_string()),
                    ("error", error.to_string()),
                ],
            );
            Vec::new()
        }
    }
}

fn write_plugin_cloud_links(
    marketplace_root: &Path,
    cloud_links: Vec<LocalPluginCloudLink>,
) -> Result<(), String> {
    write_atomic_file(
        &plugin_cloud_link_registry_path(marketplace_root),
        &serde_json::to_vec_pretty(&LocalPluginCloudLinkRegistry { cloud_links })
            .map_err(|error| format!("Failed to serialize plugin registry: {error}"))?,
    )
}

fn acquire_plugin_mutation_lock(marketplace_root: &Path) -> Result<fs::File, String> {
    let lock_directory = marketplace_root.join(".wegent");
    create_directory_without_symlink(&lock_directory, "plugin state directory")?;
    let canonical_marketplace = marketplace_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let canonical_lock_directory = lock_directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin state directory: {error}"))?;
    if canonical_lock_directory.parent() != Some(canonical_marketplace.as_path()) {
        return Err("Plugin state directory escaped the personal marketplace".to_owned());
    }
    let lock_path = canonical_lock_directory.join(PLUGIN_MUTATION_LOCK_FILE);
    reject_symlink(&lock_path, "plugin mutation lock")?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open {}: {error}", lock_path.display()))?;
    lock.lock_exclusive()
        .map_err(|error| format!("Failed to lock {}: {error}", marketplace_root.display()))?;
    Ok(lock)
}

fn upsert_marketplace_plugin_entry(manifest_path: &Path, plugin_name: &str) -> Result<(), String> {
    let mut manifest = if manifest_path.is_file() {
        serde_json::from_str::<Value>(
            &fs::read_to_string(manifest_path)
                .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
        )
        .map_err(|error| format!("Invalid marketplace manifest: {error}"))?
    } else {
        json!({
            "name": PERSONAL_MARKETPLACE_ID,
            "interface": { "displayName": "WeWork Personal Marketplace" },
            "plugins": []
        })
    };
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| "Marketplace manifest must be an object".to_owned())?;
    object
        .entry("name")
        .or_insert_with(|| Value::String(PERSONAL_MARKETPLACE_ID.to_owned()));
    let plugins = object
        .entry("plugins")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "Marketplace plugins must be an array".to_owned())?;
    if !plugins
        .iter()
        .any(|plugin| plugin.get("name").and_then(Value::as_str) == Some(plugin_name))
    {
        plugins.push(json!({
            "name": plugin_name,
            "source": {
                "source": "local",
                "path": format!("./plugins/{plugin_name}")
            },
            "policy": {
                "installation": "AVAILABLE",
                "authentication": "ON_INSTALL"
            }
        }));
    }
    write_atomic_file(
        manifest_path,
        &serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Failed to serialize marketplace manifest: {error}"))?,
    )
}

fn marketplace_manifest_contains_plugin(
    manifest_path: &Path,
    plugin_name: &str,
) -> Result<bool, String> {
    if !manifest_path.is_file() {
        return Ok(false);
    }
    let manifest = serde_json::from_slice::<Value>(
        &fs::read(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
    if manifest.get("name").and_then(Value::as_str) != Some(PERSONAL_MARKETPLACE_ID) {
        return Ok(false);
    }
    Ok(manifest
        .get("plugins")
        .and_then(Value::as_array)
        .is_some_and(|plugins| {
            plugins
                .iter()
                .any(|plugin| plugin.get("name").and_then(Value::as_str) == Some(plugin_name))
        }))
}

fn remove_marketplace_plugin_entry(manifest_path: &Path, plugin_name: &str) -> Result<(), String> {
    if !manifest_path.is_file() {
        return Ok(());
    }
    let mut manifest = serde_json::from_slice::<Value>(
        &fs::read(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
    if manifest.get("name").and_then(Value::as_str) != Some(PERSONAL_MARKETPLACE_ID) {
        return Err("Refusing to mutate a non-personal marketplace".to_owned());
    }
    let plugins = manifest
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Marketplace plugins must be an array".to_owned())?;
    plugins.retain(|plugin| plugin.get("name").and_then(Value::as_str) != Some(plugin_name));
    write_atomic_file(
        manifest_path,
        &serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Failed to serialize marketplace manifest: {error}"))?,
    )
}

fn plugin_import_backup_root(
    marketplace_root: &Path,
    rollback_id: &str,
) -> Result<PathBuf, String> {
    if rollback_id.is_empty()
        || !rollback_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Plugin import rollback identifier is invalid".to_owned());
    }
    Ok(marketplace_root
        .join(".wegent/plugin-import-backups")
        .join(rollback_id))
}

fn restore_plugin_import(marketplace_root: &Path, rollback_id: &str) -> Result<(), String> {
    let backup_root = plugin_import_backup_root(marketplace_root, rollback_id)?;
    let metadata = serde_json::from_slice::<LocalPluginImportRollback>(
        &fs::read(backup_root.join("rollback.json"))
            .map_err(|error| format!("Failed to read plugin import rollback state: {error}"))?,
    )
    .map_err(|error| format!("Plugin import rollback state is invalid: {error}"))?;
    let plugin_path = marketplace_root.join("plugins").join(&metadata.plugin_name);
    if plugin_path.exists() {
        fs::remove_dir_all(&plugin_path)
            .map_err(|error| format!("Failed to remove imported plugin: {error}"))?;
    }
    let backed_up_plugin = backup_root.join("plugin");
    if metadata.replaced_existing && backed_up_plugin.exists() {
        fs::rename(backed_up_plugin, &plugin_path)
            .map_err(|error| format!("Failed to restore previous plugin: {error}"))?;
    }
    for (marketplace_path, backup_name, existed) in [
        (
            marketplace_root.join(".agents/plugins/marketplace.json"),
            "codex-marketplace.json",
            metadata.codex_marketplace_existed,
        ),
        (
            marketplace_root.join(".claude-plugin/marketplace.json"),
            "claude-marketplace.json",
            metadata.claude_marketplace_existed,
        ),
    ] {
        if existed {
            write_atomic_file(
                &marketplace_path,
                &fs::read(backup_root.join(backup_name)).map_err(|error| {
                    format!("Failed to read marketplace rollback copy: {error}")
                })?,
            )?;
        } else if marketplace_path.exists() {
            fs::remove_file(&marketplace_path)
                .map_err(|error| format!("Failed to remove marketplace manifest: {error}"))?;
        }
    }
    fs::remove_dir_all(backup_root)
        .map_err(|error| format!("Failed to clear plugin import rollback state: {error}"))
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Atomic write path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary file: {error}"))?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("Failed to write temporary file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary file: {error}"))?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(temporary.path(), metadata.permissions())
            .map_err(|error| format!("Failed to preserve permissions: {error}"))?;
    }
    temporary.persist(path).map_err(|error| {
        format!(
            "Failed to atomically replace {}: {}",
            path.display(),
            error.error
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::TempDir;
    use zip::{write::FileOptions, ZipWriter};

    fn plugin_zip(name: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = ZipWriter::new(cursor);
        archive
            .start_file(".codex-plugin/plugin.json", FileOptions::default())
            .unwrap();
        archive
            .write_all(
                serde_json::to_string(&json!({
                    "name": name,
                    "version": "1.0.0",
                    "description": "Test plugin",
                    "author": { "name": "Wework" },
                    "interface": {
                        "displayName": "Test Plugin",
                        "shortDescription": "Short",
                        "longDescription": "Long",
                        "developerName": "Wework",
                        "category": "development",
                        "capabilities": [],
                        "defaultPrompt": "Test"
                    },
                    "mcpServers": {
                        "remote": { "type": "http", "url": "https://example.com/mcp" }
                    }
                }))
                .unwrap()
                .as_bytes(),
            )
            .unwrap();
        archive.finish().unwrap().into_inner()
    }

    fn write_personal_plugin(marketplace: &Path, name: &str) {
        let plugin_root = marketplace.join("plugins").join(name);
        fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            serde_json::to_vec_pretty(&json!({
                "name": name,
                "version": "1.2.3",
                "description": "Personal plugin",
                "interface": {
                    "displayName": "Example Plugin",
                    "category": "development"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(plugin_root.join("README.md"), "plugin body").unwrap();
    }

    fn plugin_copy_request(marketplace: &Path, package: &[u8]) -> ImportPersonalPluginCopyRequest {
        ImportPersonalPluginCopyRequest {
            marketplace_path: marketplace.display().to_string(),
            download_url: "https://objects.example/plugin.zip".to_owned(),
            sha256: format!("{:x}", Sha256::digest(package)),
            source_plugin_id: 41,
            source_release_id: 52,
            source_plugin_name: "example-plugin".to_owned(),
            source_display_name: "Example Plugin".to_owned(),
        }
    }

    #[test]
    fn imports_and_rolls_back_personal_plugin_copy_transactionally() {
        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join("wework-personal");
        fs::create_dir_all(&marketplace).unwrap();
        let package = plugin_zip("example-plugin");
        let request = plugin_copy_request(&marketplace, &package);

        let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();

        assert_eq!(imported.plugin_name, "example-plugin-copy");
        assert_eq!(imported.display_name, "Example Plugin · 我的副本");
        let manifest: Value = serde_json::from_slice(
            &fs::read(marketplace.join("plugins/example-plugin-copy/.codex-plugin/plugin.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "example-plugin-copy");
        assert_eq!(manifest["version"], "0.1.0");
        for path in [
            marketplace.join(".agents/plugins/marketplace.json"),
            marketplace.join(".claude-plugin/marketplace.json"),
        ] {
            assert!(marketplace_manifest_contains_plugin(&path, "example-plugin-copy").unwrap());
        }
        let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
        assert_eq!(registry.copies.len(), 1);
        assert_eq!(registry.copies[0].source_plugin_id, 41);

        rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap();
        rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap();

        assert!(!marketplace.join("plugins/example-plugin-copy").exists());
        let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
        assert!(registry.copies.is_empty());
        for path in [
            marketplace.join(".agents/plugins/marketplace.json"),
            marketplace.join(".claude-plugin/marketplace.json"),
        ] {
            assert!(!marketplace_manifest_contains_plugin(&path, "example-plugin-copy").unwrap());
        }
    }

    #[test]
    fn deleting_personal_copy_cleans_provenance_and_rolls_it_back_on_failure() {
        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join("wework-personal");
        fs::create_dir_all(&marketplace).unwrap();
        let package = plugin_zip("example-plugin");
        let request = plugin_copy_request(&marketplace, &package);
        let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();
        let cloud_link_path = plugin_cloud_link_registry_path(&marketplace);
        fs::create_dir(&cloud_link_path).unwrap();

        let error = delete_personal_plugin(DeletePersonalPluginRequest {
            marketplace_path: marketplace.display().to_string(),
            plugin_name: imported.plugin_name.clone(),
        })
        .unwrap_err();

        assert!(error.contains("plugin registry") || error.contains("atomically replace"));
        assert!(marketplace
            .join("plugins/example-plugin-copy/.codex-plugin/plugin.json")
            .is_file());
        let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
        assert_eq!(registry.copies.len(), 1);
        for path in [
            marketplace.join(".agents/plugins/marketplace.json"),
            marketplace.join(".claude-plugin/marketplace.json"),
        ] {
            assert!(marketplace_manifest_contains_plugin(&path, "example-plugin-copy").unwrap());
        }

        fs::remove_dir(&cloud_link_path).unwrap();
        delete_personal_plugin(DeletePersonalPluginRequest {
            marketplace_path: marketplace.display().to_string(),
            plugin_name: imported.plugin_name,
        })
        .unwrap();

        assert!(!marketplace.join("plugins/example-plugin-copy").exists());
        let registry = read_plugin_copy_registry(&copy_registry_path(&marketplace)).unwrap();
        assert!(registry.copies.is_empty());
    }

    #[test]
    fn personal_plugin_copy_rejects_checksum_and_archive_path_escape() {
        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join("wework-personal");
        fs::create_dir_all(&marketplace).unwrap();
        let package = plugin_zip("example-plugin");
        let mut request = plugin_copy_request(&marketplace, &package);
        request.sha256 = "0".repeat(64);
        let error = import_plugin_copy_package(&marketplace, &package, &request).unwrap_err();
        assert_eq!(error, "Plugin copy checksum mismatch");
        assert!(!marketplace.join("plugins").exists());

        let cursor = Cursor::new(Vec::new());
        let mut archive = ZipWriter::new(cursor);
        archive
            .start_file(".codex-plugin/plugin.json", FileOptions::default())
            .unwrap();
        archive
            .write_all(br#"{"name":"example-plugin","version":"1.0.0"}"#)
            .unwrap();
        archive
            .start_file("../escape", FileOptions::default())
            .unwrap();
        archive.write_all(b"escape").unwrap();
        let unsafe_package = archive.finish().unwrap().into_inner();
        let request = plugin_copy_request(&marketplace, &unsafe_package);
        let error =
            import_plugin_copy_package(&marketplace, &unsafe_package, &request).unwrap_err();
        assert!(error.contains("unsafe path"), "unexpected error: {error}");
        assert!(!temp.path().join("escape").exists());
    }

    #[cfg(unix)]
    #[test]
    fn personal_plugin_copy_rollback_rejects_symbolic_link_escape() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join("wework-personal");
        fs::create_dir_all(&marketplace).unwrap();
        let package = plugin_zip("example-plugin");
        let request = plugin_copy_request(&marketplace, &package);
        let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();
        let plugin_path = marketplace.join("plugins/example-plugin-copy");
        fs::remove_dir_all(&plugin_path).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "outside").unwrap();
        symlink(&outside, &plugin_path).unwrap();

        let error = rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap_err();

        assert!(error.contains("regular managed directory"));
        assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "outside");
    }

    #[cfg(unix)]
    #[test]
    fn personal_plugin_copy_rollback_read_failure_keeps_primary_plugin_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join("wework-personal");
        fs::create_dir_all(&marketplace).unwrap();
        let package = plugin_zip("example-plugin");
        let request = plugin_copy_request(&marketplace, &package);
        let imported = import_plugin_copy_package(&marketplace, &package, &request).unwrap();
        let marketplace_manifest = marketplace.join(".agents/plugins/marketplace.json");
        fs::set_permissions(&marketplace_manifest, fs::Permissions::from_mode(0o000)).unwrap();

        let error = rollback_plugin_copy(&marketplace, &imported.plugin_name).unwrap_err();

        assert!(error.contains("Failed to read"));
        assert!(marketplace
            .join("plugins/example-plugin-copy/.codex-plugin/plugin.json")
            .is_file());
        assert!(!marketplace
            .join("plugins/.example-plugin-copy-rollback")
            .exists());
        fs::set_permissions(&marketplace_manifest, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn plugin_copy_download_url_allows_only_bounded_http_urls() {
        assert!(validated_plugin_copy_download_url(
            "https://objects.example/plugins/example.zip?signature=abc"
        )
        .is_ok());
        for value in [
            "file:///tmp/plugin.zip",
            "https://user:secret@objects.example/plugin.zip",
            "https://objects.example/plugin.zip#fragment",
            "relative/plugin.zip",
        ] {
            assert!(
                validated_plugin_copy_download_url(value).is_err(),
                "{value}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn personal_marketplace_rejects_managed_ancestor_symlinks() {
        use std::os::unix::fs::symlink;

        for relative_link in [
            "",
            "capabilities",
            "capabilities/bundled-marketplaces",
            "capabilities/bundled-marketplaces/wework-personal",
        ] {
            let temp = TempDir::new().unwrap();
            let executor_home = temp.path().join("executor-home");
            let outside = temp.path().join("outside");
            fs::create_dir_all(&outside).unwrap();
            let link = if relative_link.is_empty() {
                executor_home.clone()
            } else {
                executor_home.join(relative_link)
            };
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            symlink(&outside, &link).unwrap();
            let marketplace = executor_home
                .join("capabilities")
                .join("bundled-marketplaces")
                .join(PERSONAL_MARKETPLACE_ID);

            let validation_error = validated_personal_marketplace_path_for_executor_home(
                &marketplace.display().to_string(),
                &executor_home,
            )
            .expect_err("managed marketplace symlinks must be rejected during validation");
            assert!(
                validation_error.contains("symbolic link"),
                "unexpected validation error for {relative_link:?}: {validation_error}"
            );

            let preparation_error =
                prepare_personal_marketplace_root_for_executor_home(&marketplace, &executor_home)
                    .expect_err("managed marketplace symlinks must be rejected during preparation");
            assert!(
                preparation_error.contains("symbolic link"),
                "unexpected preparation error for {relative_link:?}: {preparation_error}"
            );
            assert!(fs::read_dir(&outside).unwrap().next().is_none());
        }
    }

    #[test]
    fn ensures_lists_and_packages_personal_plugins_idempotently() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let executor_home = temp.path().join("executor-home");
        let destination = executor_home
            .join("capabilities")
            .join("bundled-marketplaces")
            .join(PERSONAL_MARKETPLACE_ID);
        write_personal_plugin(&source, "example-plugin");
        assert_eq!(
            validated_personal_marketplace_path_for_executor_home(
                &destination.display().to_string(),
                &executor_home,
            )
            .unwrap(),
            destination
        );

        let first = ensure_personal_plugin_at(&source, &destination, "example-plugin").unwrap();
        assert!(first.migrated);
        assert_eq!(first.plugin_name, "example-plugin");
        for manifest in [
            destination.join(".agents/plugins/marketplace.json"),
            destination.join(".claude-plugin/marketplace.json"),
        ] {
            assert!(marketplace_manifest_contains_plugin(&manifest, "example-plugin").unwrap());
        }

        let second =
            ensure_personal_plugin_at(&destination, &destination, "example-plugin").unwrap();
        assert!(!second.migrated);
        assert_eq!(second.plugin_path, first.plugin_path);

        let listed = list_personal_plugins_at(&destination).unwrap();
        assert_eq!(listed.plugins.len(), 1);
        assert_eq!(listed.plugins[0].name, "example-plugin");
        assert_eq!(listed.plugins[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(
            listed.plugins[0].display_name.as_deref(),
            Some("Example Plugin")
        );

        let artifacts = temp.path().join("artifacts");
        fs::create_dir(&artifacts).unwrap();
        let package = package_plugin_directory(
            &destination.join("plugins/example-plugin"),
            "example-plugin",
            &artifacts,
        )
        .unwrap();
        assert_eq!(package.name, "example-plugin.zip");
        assert_eq!(package.size, fs::metadata(&package.path).unwrap().len());
        assert_eq!(
            package.sha256,
            sha256_file(Path::new(&package.path)).unwrap()
        );
        let mut archive = zip::ZipArchive::new(fs::File::open(&package.path).unwrap()).unwrap();
        assert!(archive.by_name(".codex-plugin/plugin.json").is_ok());
        assert!(archive.by_name("README.md").is_ok());
        remove_personal_package_artifact(&artifacts, &package.cleanup_token).unwrap();
        assert!(!Path::new(&package.path).exists());
    }

    #[test]
    fn personal_plugin_package_excludes_ci_ignored_source_paths() {
        let temp = TempDir::new().unwrap();
        let plugin_root = temp.path().join("example-plugin");
        let artifacts = temp.path().join("artifacts");
        fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
        fs::create_dir_all(plugin_root.join(".git")).unwrap();
        fs::create_dir_all(plugin_root.join(".pytest_cache")).unwrap();
        fs::create_dir_all(plugin_root.join("__pycache__")).unwrap();
        fs::create_dir_all(plugin_root.join("node_modules/package")).unwrap();
        fs::create_dir(&artifacts).unwrap();
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            br#"{"name":"example-plugin","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(plugin_root.join("README.md"), "plugin body").unwrap();
        fs::write(plugin_root.join(".DS_Store"), "finder metadata").unwrap();
        fs::write(plugin_root.join(".git/config"), "git metadata").unwrap();
        fs::write(plugin_root.join(".pytest_cache/state"), "pytest cache").unwrap();
        fs::write(plugin_root.join("__pycache__/plugin.pyc"), "python cache").unwrap();
        fs::write(
            plugin_root.join("node_modules/package/index.js"),
            "dependency",
        )
        .unwrap();

        let package = package_plugin_directory(&plugin_root, "example-plugin", &artifacts).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(&package.path).unwrap()).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                ".codex-plugin/plugin.json".to_owned(),
                "README.md".to_owned()
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_result_can_be_packaged_through_a_canonical_parent_alias() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_personal_plugin(&source, "example-plugin");
        let real_parent = temp.path().join("real-parent");
        let alias_parent = temp.path().join("alias-parent");
        fs::create_dir(&real_parent).unwrap();
        symlink(&real_parent, &alias_parent).unwrap();
        let executor_home = alias_parent.join("executor-home");
        let lexical_marketplace = executor_home
            .join("capabilities")
            .join("bundled-marketplaces")
            .join(PERSONAL_MARKETPLACE_ID);
        let validated = validated_personal_marketplace_path_for_executor_home(
            &lexical_marketplace.display().to_string(),
            &executor_home,
        )
        .unwrap();
        let prepared =
            prepare_personal_marketplace_root_for_executor_home(&validated, &executor_home)
                .unwrap();

        let ensured = ensure_personal_plugin_at(&source, &prepared, "example-plugin").unwrap();

        assert_eq!(Path::new(&ensured.marketplace_path), prepared);
        let package_marketplace = validated_personal_marketplace_path_for_executor_home(
            &ensured.marketplace_path,
            &executor_home,
        )
        .unwrap();
        let marketplace_root = resolve_existing_marketplace_root(&package_marketplace).unwrap();
        let plugin_root =
            resolve_managed_personal_plugin(&marketplace_root, "example-plugin").unwrap();
        let artifacts = temp.path().join("artifacts-canonical-alias");
        fs::create_dir(&artifacts).unwrap();
        let package = package_plugin_directory(&plugin_root, "example-plugin", &artifacts).unwrap();
        assert!(Path::new(&package.path).is_file());
    }

    #[test]
    fn personal_plugin_migration_rejects_path_traversal() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        write_personal_plugin(&source, "example-plugin");

        let error = ensure_personal_plugin_at(&source, &destination, "../example-plugin")
            .expect_err("parent traversal must be rejected");

        assert_eq!(error, "Plugin name is invalid");
        assert!(!destination.join("example-plugin").exists());
    }

    #[cfg(unix)]
    #[test]
    fn personal_plugin_migration_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        write_personal_plugin(&source, "example-plugin");
        symlink(
            temp.path().join("outside"),
            source.join("plugins/example-plugin/escape"),
        )
        .unwrap();

        let error = ensure_personal_plugin_at(&source, &destination, "example-plugin")
            .expect_err("symbolic links must be rejected");

        assert!(error.contains("cannot contain symbolic links"));
        assert!(!destination.join("plugins/example-plugin").exists());
    }

    #[cfg(unix)]
    #[test]
    fn personal_plugin_migration_rejects_manifest_path_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_personal_plugin(&source, "example-plugin");
        for (label, relative, target_is_file) in [
            ("agents", ".agents", false),
            ("agents-plugins", ".agents/plugins", false),
            ("claude", ".claude-plugin", false),
            ("manifest", ".agents/plugins/marketplace.json", true),
        ] {
            let destination = temp.path().join(format!("destination-{label}"));
            let outside = temp.path().join(format!("outside-{label}"));
            fs::create_dir_all(&destination).unwrap();
            fs::create_dir_all(&outside).unwrap();
            let link = destination.join(relative);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            let outside_target = if target_is_file {
                let path = outside.join("marketplace.json");
                fs::write(&path, "outside marker").unwrap();
                path
            } else {
                outside.clone()
            };
            symlink(&outside_target, &link).unwrap();

            let error = ensure_personal_plugin_at(&source, &destination, "example-plugin")
                .expect_err("manifest path symbolic links must be rejected");

            assert!(error.contains("symbolic link"), "unexpected error: {error}");
            assert!(!destination.join("plugins/example-plugin").exists());
            if target_is_file {
                assert_eq!(
                    fs::read_to_string(outside_target).unwrap(),
                    "outside marker"
                );
            } else {
                assert!(fs::read_dir(outside).unwrap().next().is_none());
            }
        }
    }

    #[test]
    fn previews_and_imports_valid_plugin_packages() {
        let temp = TempDir::new().unwrap();
        let archive_path = temp.path().join("plugin.zip");
        fs::write(&archive_path, plugin_zip("example-plugin")).unwrap();
        let marketplace = temp.path().join("marketplace");
        let preview = preview_plugin_import(PreviewPluginImportRequest {
            archive_path: archive_path.display().to_string(),
            marketplace_path: marketplace.display().to_string(),
        })
        .unwrap();
        assert!(preview.valid);
        assert_eq!(preview.mcp_server_count, 1);

        let imported = import_plugin_package(ImportPluginPackageRequest {
            archive_path: archive_path.display().to_string(),
            marketplace_path: marketplace.display().to_string(),
            expected_sha256: preview.sha256,
            overwrite: false,
        })
        .unwrap();
        assert!(Path::new(&imported.plugin_path).is_dir());
        finalize_plugin_import(PluginImportMutationRequest {
            marketplace_path: marketplace.display().to_string(),
            rollback_id: imported.rollback_id,
        })
        .unwrap();

        delete_personal_plugin(DeletePersonalPluginRequest {
            marketplace_path: marketplace.display().to_string(),
            plugin_name: "example-plugin".to_owned(),
        })
        .unwrap();
        assert!(!marketplace.join("plugins/example-plugin").exists());
        for manifest in [
            marketplace.join(".agents/plugins/marketplace.json"),
            marketplace.join(".claude-plugin/marketplace.json"),
        ] {
            assert!(!marketplace_manifest_contains_plugin(&manifest, "example-plugin").unwrap());
        }
    }
}
