// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::bundled_plugins::BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV;

mod managed_paths;
pub use managed_paths::{managed_plugin_root, ManagedPluginPathError};

const COMPONENT_RESOURCES_ROOT_ENV: &str = "WEWORK_COMPONENT_RESOURCES_ROOT";
const BUNDLED_PLUGINS_DIRECTORY: &str = "bundled-plugins";
const PLUGIN_EXAMPLE_DIRECTORY: &str = "wework-plugin-example";
const MAX_PLUGIN_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPluginManifestRequest {
    pub marketplace_path: String,
    pub plugin_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePluginExampleRequest {
    pub destination_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WegentStorePluginSummary {
    name: String,
    package_id: String,
    installed_plugin_id: Option<i64>,
    cloud_plugin_id: Option<i64>,
    marketplace: String,
    version: Option<String>,
    enabled: bool,
    display_name: Option<String>,
    description: Option<String>,
    logo: Option<String>,
    category: Option<String>,
    plugin_path: String,
    default_prompt: Option<Value>,
    runtime_recovery_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WegentStoreListResult {
    supports_plugin_reconciliation: bool,
    store_path: String,
    plugins: Vec<WegentStorePluginSummary>,
}

pub fn list_wegent_store_plugins() -> Result<WegentStoreListResult, String> {
    list_wegent_store_plugins_from_roots(
        &super::capabilities::default_manifest_path(),
        &crate::services::workbench::workbench_root()?.join("shared/plugins"),
    )
}

pub fn read_plugin_manifest(request: ReadPluginManifestRequest) -> Result<Value, String> {
    read_local_plugin_manifest(
        Path::new(&request.marketplace_path),
        &request.plugin_name,
        &wegent_runtime_config::paths::wework_codex_home(),
        &super::capabilities::default_manifest_path(),
        &crate::services::workbench::workbench_root()?.join("shared/plugins"),
    )
}

pub fn save_plugin_example(request: SavePluginExampleRequest) -> Result<String, String> {
    let source = resolve_plugin_example_source()?;
    save_plugin_example_from_source(&source, Path::new(&request.destination_path))
}

#[cfg(test)]
fn list_wegent_store_plugins_at(executor_home: &Path) -> Result<WegentStoreListResult, String> {
    list_wegent_store_plugins_from_roots(
        &executor_home.join("capabilities/manifest.json"),
        &executor_home.join("workbench/shared/plugins"),
    )
}

fn list_wegent_store_plugins_from_roots(
    manifest_path: &Path,
    shared_plugins: &Path,
) -> Result<WegentStoreListResult, String> {
    let capabilities_root = manifest_path
        .parent()
        .ok_or("Invalid capability manifest path")?;
    let store_path = shared_plugins.display().to_string();
    if !manifest_path.is_file() {
        return Ok(WegentStoreListResult {
            supports_plugin_reconciliation: true,
            store_path,
            plugins: Vec::new(),
        });
    }
    reject_symbolic_link(manifest_path, "Capability manifest")?;
    let content = fs::read_to_string(manifest_path).map_err(|error| {
        format!(
            "Failed to read capability manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest = serde_json::from_str::<Value>(&content).map_err(|error| {
        format!(
            "Failed to parse capability manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let installed = manifest
        .get("plugins")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!(
                "Capability manifest {} is missing plugins",
                manifest_path.display()
            )
        })?;
    let mut plugins = Vec::new();
    for (key, entry) in installed {
        let summary = if let Some(error) = entry["runtime_recovery_error"].as_str() {
            managed_paths::unavailable_plugin_summary(key, entry, error)
        } else {
            match managed_plugin_root(capabilities_root, shared_plugins, entry) {
                Ok(root) => wegent_store_plugin_summary(entry, &root).or_else(|| {
                    managed_paths::unavailable_plugin_summary(
                        key,
                        entry,
                        "Plugin manifest is unavailable",
                    )
                }),
                Err(error) => {
                    managed_paths::unavailable_plugin_summary(key, entry, &error.to_string())
                }
            }
        };
        if let Some(summary) = summary {
            plugins.push(summary);
        }
    }
    plugins.sort_by(|left, right| {
        left.marketplace
            .cmp(&right.marketplace)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(WegentStoreListResult {
        supports_plugin_reconciliation: true,
        store_path,
        plugins,
    })
}

fn wegent_store_plugin_summary(
    installed: &Value,
    plugin_root: &Path,
) -> Option<WegentStorePluginSummary> {
    let manifest_path = local_plugin_manifest_path(plugin_root).ok()?;
    let manifest = read_json_file(&manifest_path, MAX_PLUGIN_MANIFEST_BYTES).ok()?;
    let name = optional_trimmed_string(manifest.get("name"))
        .or_else(|| optional_trimmed_string(installed.get("name")))?;
    let package_id = plugin_root.file_name()?.to_str()?.to_owned();
    let interface = manifest.get("interface");
    Some(WegentStorePluginSummary {
        name,
        package_id,
        installed_plugin_id: installed.get("installed_plugin_id").and_then(Value::as_i64),
        cloud_plugin_id: installed.get("cloud_plugin_id").and_then(Value::as_i64),
        marketplace: optional_trimmed_string(installed.get("marketplace"))?,
        version: optional_trimmed_string(manifest.get("version"))
            .or_else(|| optional_trimmed_string(installed.get("version"))),
        enabled: installed
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        display_name: optional_trimmed_string(interface.and_then(|value| value.get("displayName"))),
        description: optional_trimmed_string(manifest.get("description")).or_else(|| {
            optional_trimmed_string(interface.and_then(|value| value.get("shortDescription")))
        }),
        logo: optional_trimmed_string(interface.and_then(|value| value.get("logo"))),
        category: optional_trimmed_string(interface.and_then(|value| value.get("category"))),
        plugin_path: plugin_root.display().to_string(),
        default_prompt: interface
            .and_then(|value| value.get("defaultPrompt"))
            .cloned(),
        runtime_recovery_error: optional_trimmed_string(installed.get("runtime_recovery_error")),
    })
}

fn read_local_plugin_manifest(
    marketplace_path: &Path,
    plugin_name: &str,
    codex_home: &Path,
    manifest_path: &Path,
    shared_plugins: &Path,
) -> Result<Value, String> {
    let plugin_name = validate_plugin_name(plugin_name)?;
    let marketplace_path = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve local marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&marketplace_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve local marketplace root: {error}"))?;
    let registered_roots = registered_store_plugin_roots(
        &marketplace_root,
        plugin_name,
        codex_home,
        manifest_path,
        shared_plugins,
    )?;
    let plugin_root = resolve_local_plugin_root(
        &marketplace_path,
        &marketplace_root,
        plugin_name,
        &registered_roots,
    )?;
    let manifest_path = local_plugin_manifest_path(&plugin_root)?;
    let manifest = read_json_file(&manifest_path, MAX_PLUGIN_MANIFEST_BYTES)?;
    Ok(json!({
        "connectors": manifest
            .get("connectors")
            .cloned()
            .unwrap_or_else(|| json!([])),
    }))
}

fn registered_store_plugin_roots(
    marketplace_root: &Path,
    plugin_name: &str,
    codex_home: &Path,
    manifest_path: &Path,
    shared_plugins: &Path,
) -> Result<Vec<PathBuf>, String> {
    let Some(marketplace) = marketplace_root.file_name().and_then(|name| name.to_str()) else {
        return Ok(Vec::new());
    };
    let expected_root = codex_home
        .join("plugins/marketplaces")
        .join(marketplace)
        .canonicalize();
    if expected_root.ok().as_deref() != Some(marketplace_root) {
        return Ok(Vec::new());
    }
    if !manifest_path.is_file() {
        return Ok(Vec::new());
    }
    let manifest = read_json_file(manifest_path, MAX_PLUGIN_MANIFEST_BYTES)?;
    let capabilities_root = manifest_path
        .parent()
        .ok_or("Invalid capability manifest path")?;
    let mut roots = Vec::new();
    for entry in manifest["plugins"]
        .as_object()
        .into_iter()
        .flat_map(|entries| entries.values())
    {
        if entry["name"] != plugin_name
            || entry["marketplace"] != marketplace
            || entry["installed_plugin_id"].as_i64().is_none()
            || entry["managed"] == false
        {
            continue;
        }
        let Ok(store) = managed_plugin_root(capabilities_root, shared_plugins, entry) else {
            continue;
        };
        roots.push(store);
        // Native marketplaces point at writable caches, not the immutable package.
        if let Some(runtime) = registered_codex_cache(codex_home, marketplace, plugin_name, entry) {
            roots.push(runtime);
        }
    }
    Ok(roots)
}

pub fn registered_codex_cache(
    codex_home: &Path,
    marketplace: &str,
    plugin_name: &str,
    entry: &Value,
) -> Option<PathBuf> {
    validate_plugin_name(marketplace).ok()?;
    validate_plugin_name(plugin_name).ok()?;
    let version = entry["version"].as_str()?;
    let version_path = Path::new(version);
    if version_path.components().count() != 1
        || !matches!(version_path.components().next(), Some(Component::Normal(_)))
    {
        return None;
    }
    let cache = codex_home.join("plugins/cache");
    let plugin = cache.join(marketplace).join(plugin_name);
    let expected = plugin.join(version);
    let recorded = Path::new(entry["runtime"]["codex_link"].as_str()?);
    if recorded != expected {
        return None;
    }
    for path in [
        codex_home,
        &cache,
        &cache.join(marketplace),
        &plugin,
        &expected,
    ] {
        reject_symbolic_link(path, "Managed Codex plugin cache").ok()?;
    }
    let expected = expected.canonicalize().ok()?;
    if !expected.starts_with(codex_home.canonicalize().ok()?) {
        return None;
    }
    Some(expected)
}

pub(super) fn resolve_local_plugin_root(
    marketplace_path: &Path,
    marketplace_root: &Path,
    plugin_name: &str,
    registered_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let mut candidates = vec![
        marketplace_root.join("plugins").join(plugin_name),
        marketplace_root.join(plugin_name),
    ];
    for manifest_path in marketplace_manifest_paths(marketplace_path, marketplace_root) {
        candidates.extend(plugin_sources_from_marketplace_manifest(
            &manifest_path,
            marketplace_root,
            plugin_name,
        ));
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if !candidate.is_dir()
            || (!candidate.starts_with(marketplace_root) && !registered_roots.contains(&candidate))
            || !seen.insert(candidate.clone())
        {
            continue;
        }
        if local_plugin_manifest_path(&candidate).is_ok() {
            return Ok(candidate);
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
    if marketplace_path.is_file() {
        paths.push(marketplace_path.to_path_buf());
    }
    paths.sort();
    paths.dedup();
    paths
}

fn plugin_sources_from_marketplace_manifest(
    manifest_path: &Path,
    marketplace_root: &Path,
    plugin_name: &str,
) -> Vec<PathBuf> {
    let Ok(manifest_path) = manifest_path.canonicalize() else {
        return Vec::new();
    };
    if !manifest_path.starts_with(marketplace_root) {
        return Vec::new();
    }
    let Ok(manifest) = read_json_file(&manifest_path, MAX_PLUGIN_MANIFEST_BYTES) else {
        return Vec::new();
    };
    let Some(plugins) = manifest.get("plugins").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for plugin in plugins {
        if plugin.get("name").and_then(Value::as_str) != Some(plugin_name) {
            continue;
        }
        let Some(source) = plugin.get("source") else {
            continue;
        };
        let Some(relative) = source
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| source.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let relative = relative
            .strip_prefix("./")
            .or_else(|| relative.strip_prefix(".\\"))
            .unwrap_or(relative);
        let relative = Path::new(relative);
        if !is_safe_relative_path(relative) {
            continue;
        }
        candidates.push(marketplace_root.join(relative));
        if let Some(parent) = manifest_path.parent() {
            candidates.push(parent.join(relative));
        }
    }
    candidates
}

pub(super) fn marketplace_root_from_path(path: &Path) -> PathBuf {
    if path
        .file_name()
        .is_some_and(|name| name == "marketplace.json")
    {
        let Some(parent) = path.parent() else {
            return path.to_path_buf();
        };
        if parent.file_name().is_some_and(|name| name == "plugins") {
            if let Some(scope) = parent.parent() {
                if scope.file_name().is_some_and(|name| name == ".agents") {
                    return scope.parent().unwrap_or(scope).to_path_buf();
                }
            }
        }
        if parent
            .file_name()
            .is_some_and(|name| name == ".claude-plugin")
        {
            return parent.parent().unwrap_or(parent).to_path_buf();
        }
        return parent.to_path_buf();
    }
    if path
        .file_name()
        .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
    {
        return path.parent().unwrap_or(path).to_path_buf();
    }
    if path.file_name().is_some_and(|name| name == "plugins")
        && path.parent().and_then(Path::file_name) == Some(".agents".as_ref())
    {
        return path
            .parent()
            .and_then(Path::parent)
            .unwrap_or(path)
            .to_path_buf();
    }
    path.to_path_buf()
}

pub(super) fn local_plugin_manifest_path(plugin_root: &Path) -> Result<PathBuf, String> {
    let canonical_root = plugin_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve local plugin directory: {error}"))?;
    for candidate in [
        canonical_root.join("plugin.json"),
        canonical_root.join(".codex-plugin/plugin.json"),
        canonical_root.join(".claude-plugin/plugin.json"),
    ] {
        if !candidate.is_file() || reject_symbolic_link(&candidate, "Plugin manifest").is_err() {
            continue;
        }
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if candidate.starts_with(&canonical_root) {
            return Ok(candidate);
        }
    }
    Err("Local plugin manifest is unavailable".to_owned())
}

fn resolve_plugin_example_source() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(bundled_marketplace) = non_empty_env_path(BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV) {
        if bundled_marketplace
            .file_name()
            .is_some_and(|name| name == PLUGIN_EXAMPLE_DIRECTORY)
        {
            candidates.push(bundled_marketplace);
        } else if bundled_marketplace
            .file_name()
            .is_some_and(|name| name == BUNDLED_PLUGINS_DIRECTORY)
        {
            candidates.push(bundled_marketplace.join(PLUGIN_EXAMPLE_DIRECTORY));
        } else if let Some(parent) = bundled_marketplace.parent() {
            candidates.push(parent.join(PLUGIN_EXAMPLE_DIRECTORY));
        }
    }
    if let Some(resources_root) = non_empty_env_path(COMPONENT_RESOURCES_ROOT_ENV) {
        candidates.push(
            resources_root
                .join(BUNDLED_PLUGINS_DIRECTORY)
                .join(PLUGIN_EXAMPLE_DIRECTORY),
        );
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(bin_directory) = executable.parent() {
            if let Some(resources_root) = bin_directory.parent() {
                candidates.push(
                    resources_root
                        .join(BUNDLED_PLUGINS_DIRECTORY)
                        .join(PLUGIN_EXAMPLE_DIRECTORY),
                );
            }
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../wework/resources")
            .join(BUNDLED_PLUGINS_DIRECTORY)
            .join(PLUGIN_EXAMPLE_DIRECTORY),
    );
    resolve_plugin_example_source_from_candidates(candidates)
}

fn resolve_plugin_example_source_from_candidates(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<PathBuf, String> {
    let mut seen = HashSet::new();
    for candidate in candidates {
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if !candidate.is_dir() || !seen.insert(candidate.clone()) {
            continue;
        }
        if local_plugin_manifest_path(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("Bundled plugin example is unavailable".to_owned())
}

fn save_plugin_example_from_source(source: &Path, destination: &Path) -> Result<String, String> {
    if !destination.is_absolute() {
        return Err("Plugin example destination must be an absolute path".to_owned());
    }
    if destination
        .extension()
        .and_then(|extension| extension.to_str())
        .map_or(true, |extension| !extension.eq_ignore_ascii_case("zip"))
    {
        return Err("Plugin example destination must use the .zip extension".to_owned());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Plugin example destination has no parent directory".to_owned())?;
    reject_symbolic_link(parent, "Plugin example destination parent")?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin example destination parent: {error}"))?;
    if !parent.is_dir() {
        return Err("Plugin example destination parent is not a directory".to_owned());
    }
    let file_name = destination
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Plugin example destination file name is invalid".to_owned())?;
    let destination = parent.join(file_name);
    if destination.exists() {
        reject_symbolic_link(&destination, "Plugin example destination")?;
        if !destination.is_file() {
            return Err("Plugin example destination is not a regular file".to_owned());
        }
    }

    let bytes = package_plugin_directory(source)?;
    write_atomic_file(&destination, &bytes)?;
    Ok(destination.display().to_string())
}

fn package_plugin_directory(root: &Path) -> Result<Vec<u8>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin example directory: {error}"))?;
    let files = collect_plugin_files(&root)?;
    let expanded_size = files.iter().try_fold(0_u64, |total, path| {
        let size = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .len();
        total
            .checked_add(size)
            .ok_or_else(|| "Plugin example package size overflow".to_owned())
    })?;
    if expanded_size > MAX_PLUGIN_EXPANDED_BYTES {
        return Err("Expanded plugin example package exceeds 200 MB".to_owned());
    }

    let cursor = std::io::Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for path in files {
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "Plugin example file escaped its package root".to_owned())?;
        let archive_path = relative.to_string_lossy().replace('\\', "/");
        archive
            .start_file(&archive_path, options)
            .map_err(|error| format!("Failed to add {archive_path}: {error}"))?;
        let mut file = fs::File::open(&path)
            .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
        std::io::copy(&mut file, &mut archive)
            .map_err(|error| format!("Failed to package {archive_path}: {error}"))?;
    }
    let bytes = archive
        .finish()
        .map_err(|error| format!("Failed to finish plugin example package: {error}"))?
        .into_inner();
    if bytes.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("Plugin example ZIP exceeds 50 MB".to_owned());
    }
    Ok(bytes)
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
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Plugin example cannot contain symbolic links: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file() {
                path.strip_prefix(root)
                    .map_err(|_| "Plugin example file escaped its package root".to_owned())?;
                files.push(path);
            } else {
                return Err(format!(
                    "Plugin example contains an unsupported filesystem entry: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    path.parent()
        .ok_or_else(|| format!("Atomic write path has no parent: {}", path.display()))?;
    wegent_filesystem::atomic_file::write_atomic_file(path, bytes).map_err(|error| {
        use wegent_filesystem::atomic_file::WriteStage;
        match error.stage {
            WriteStage::CreateTemporary => format!(
                "Failed to create plugin example temporary file: {}",
                error.source
            ),
            WriteStage::Write => format!(
                "Failed to write plugin example temporary file: {}",
                error.source
            ),
            WriteStage::Sync => format!(
                "Failed to sync plugin example temporary file: {}",
                error.source
            ),
            WriteStage::PreservePermissions => format!(
                "Failed to preserve plugin example permissions: {}",
                error.source
            ),
            WriteStage::Publish => format!(
                "Failed to atomically save plugin example {}: {}",
                path.display(),
                error.source
            ),
        }
    })
}

pub(super) fn read_json_file(path: &Path, max_bytes: u64) -> Result<Value, String> {
    reject_symbolic_link(path, "JSON file")?;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(format!(
            "JSON file exceeds {} bytes: {}",
            max_bytes,
            path.display()
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect JSON file: {error}"))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err("JSON file is not a regular bounded file".into());
    }
    let mut content = String::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_string(&mut content)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if content.len() as u64 > max_bytes {
        return Err("JSON file exceeds its size limit".into());
    }
    serde_json::from_str(&content)
        .map_err(|error| format!("Invalid JSON {}: {error}", path.display()))
}

fn reject_symbolic_link(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{label} cannot be a symbolic link: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_plugin_name(plugin_name: &str) -> Result<&str, String> {
    let plugin_name = plugin_name.trim();
    if plugin_name.is_empty()
        || plugin_name.len() > 100
        || !plugin_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        || matches!(plugin_name, "." | "..")
    {
        return Err("Plugin name is invalid".to_owned());
    }
    Ok(plugin_name)
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests;
