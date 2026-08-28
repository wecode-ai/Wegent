// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::logging::log_executor_event;

const MAX_PLUGIN_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;
const PLUGIN_MUTATION_LOCK_FILE: &str = "plugin-mutations.lock";
const PERSONAL_MARKETPLACE_ID: &str = "wework-personal";

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
        let mut links = load_plugin_cloud_links(&marketplace_root);
        links.retain(|link| link.local_plugin_name != plugin_name);
        write_plugin_cloud_links(&marketplace_root, links)
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
        let _ = fs::rename(backup_root.join("plugin"), &canonical_plugin);
        let _ = fs::remove_dir_all(&backup_root);
        return Err(error);
    }
    fs::remove_dir_all(&backup_root)
        .map_err(|error| format!("Failed to finalize personal plugin deletion: {error}"))
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
    Ok(path.to_path_buf())
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
    fs::create_dir_all(&lock_directory)
        .map_err(|error| format!("Failed to create {}: {error}", lock_directory.display()))?;
    let lock_path = lock_directory.join(PLUGIN_MUTATION_LOCK_FILE);
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
