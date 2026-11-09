// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use toml_edit::DocumentMut;

use crate::{codex_configuration::replace_config, logging::log_executor_event};

use super::personal_marketplace_lock::acquire_personal_marketplace_lock;

pub const BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV: &str = "WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR";
const CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const MARKETPLACE_ID: &str = "wework-personal";
const CONTENT_HASH_FILE: &str = ".wework-content-sha256";
const LEGACY_RECOVERY_REGISTRY_FILE: &str = ".wework-personal-legacy-recovery-v1.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledPluginMarketplace {
    id: String,
    path: String,
    plugin_count: usize,
    default_plugin_names: Vec<String>,
    content_hash: String,
}

#[derive(Default, Deserialize, Serialize)]
struct LegacyRecoveryRegistry {
    marketplace_paths: Vec<String>,
}

pub fn initialize_bundled_plugin_marketplace() -> Result<BundledPluginMarketplace, String> {
    let source = non_empty_path(BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV).ok_or_else(|| {
        format!("{BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV} is required to initialize bundled plugins")
    })?;
    let executor_home = crate::config::paths::executor_home();
    let codex_home = non_empty_path(CODEX_HOME_ENV).unwrap_or_else(|| executor_home.join("codex"));
    let legacy_personal_marketplaces = legacy_personal_marketplace_roots(&executor_home)?;
    initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        &source,
        &super::capabilities::default_manifest_path()
            .parent()
            .ok_or_else(|| "Capabilities manifest has no parent directory".to_owned())?
            .join("bundled-marketplaces")
            .join(MARKETPLACE_ID),
        Some(&codex_home),
        &legacy_personal_marketplaces,
    )
}

#[cfg(test)]
fn initialize_bundled_plugin_marketplace_from_paths(
    source: &Path,
    destination: &Path,
) -> Result<BundledPluginMarketplace, String> {
    initialize_bundled_plugin_marketplace_from_paths_with_recovery(source, destination, None, &[])
}

#[cfg(test)]
fn initialize_bundled_plugin_marketplace_from_paths_with_codex_home(
    source: &Path,
    destination: &Path,
    codex_home: Option<&Path>,
) -> Result<BundledPluginMarketplace, String> {
    initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        source,
        destination,
        codex_home,
        &[],
    )
}

fn initialize_bundled_plugin_marketplace_from_paths_with_recovery(
    source: &Path,
    destination: &Path,
    codex_home: Option<&Path>,
    legacy_personal_marketplaces: &[PathBuf],
) -> Result<BundledPluginMarketplace, String> {
    let codex_manifest = source.join(".agents/plugins/marketplace.json");
    let claude_manifest = source.join(".claude-plugin/marketplace.json");
    let codex_plugins = marketplace_plugin_names(&codex_manifest)?;
    let claude_plugins = marketplace_plugin_names(&claude_manifest)?;
    if codex_plugins != claude_plugins {
        return Err("Bundled Codex and Claude plugin names must match".to_owned());
    }
    let default_plugin_names = marketplace_default_plugin_names(&codex_manifest)?;
    let content_hash = directory_content_hash(source)?;

    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Bundled plugin marketplace destination has no parent: {}",
            destination.display()
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let _mutation_lock = acquire_personal_marketplace_lock(destination)?;
    let staging = parent.join(format!(".{MARKETPLACE_ID}-{}-staging", std::process::id()));
    remove_existing_path(&staging)?;
    let legacy_recovery_registry_path = parent.join(LEGACY_RECOVERY_REGISTRY_FILE);
    let recovered_legacy_marketplaces =
        read_legacy_recovery_registry(&legacy_recovery_registry_path);
    let pending_legacy_marketplaces = legacy_personal_marketplaces
        .iter()
        .filter(|path| {
            !recovered_legacy_marketplaces.contains(&legacy_marketplace_recovery_key(path))
        })
        .collect::<Vec<_>>();

    let staging_result = (|| {
        // The content hash describes only the packaged source. It cannot prove that
        // the mutable destination still contains every required bundled entry.
        // Always rebuild bundled entries from the package, then merge non-bundled
        // personal entries back into the staged marketplace.
        copy_directory_recursive(source, &staging)?;
        if destination.is_dir() {
            preserve_personal_plugins(destination, &staging, &codex_plugins)?;
            preserve_personal_marketplace_state(destination, &staging)?;
        }
        for legacy_root in &pending_legacy_marketplaces {
            preserve_personal_plugins(legacy_root, &staging, &codex_plugins)?;
        }
        if let Some(codex_home) = codex_home {
            recover_configured_personal_plugins(&staging, codex_home, &codex_plugins)?;
        }
        fs::write(staging.join(CONTENT_HASH_FILE), format!("{content_hash}\n")).map_err(|error| {
            format!(
                "Failed to write bundled marketplace content hash in {}: {error}",
                staging.display()
            )
        })
    })();
    if let Err(error) = staging_result {
        let _ = remove_existing_path(&staging);
        return Err(error);
    }
    activate_staged_marketplace(&staging, destination)?;
    if !pending_legacy_marketplaces.is_empty() {
        let mut recovered = recovered_legacy_marketplaces;
        recovered.extend(
            pending_legacy_marketplaces
                .into_iter()
                .map(|path| legacy_marketplace_recovery_key(path)),
        );
        if write_legacy_recovery_registry(&legacy_recovery_registry_path, recovered).is_err() {
            log_executor_event(
                "failed to record legacy personal plugin recovery",
                &[(
                    "registry_path",
                    legacy_recovery_registry_path.display().to_string(),
                )],
            );
        }
    }

    Ok(BundledPluginMarketplace {
        id: MARKETPLACE_ID.to_owned(),
        path: destination.display().to_string(),
        plugin_count: codex_plugins.len(),
        default_plugin_names,
        content_hash,
    })
}

fn read_legacy_recovery_registry(path: &Path) -> HashSet<String> {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(_) => return HashSet::new(),
    };
    serde_json::from_slice::<LegacyRecoveryRegistry>(&content)
        .map(|registry| registry.marketplace_paths.into_iter().collect())
        .unwrap_or_default()
}

fn write_legacy_recovery_registry(
    path: &Path,
    marketplace_paths: HashSet<String>,
) -> Result<(), String> {
    let mut marketplace_paths = marketplace_paths.into_iter().collect::<Vec<_>>();
    marketplace_paths.sort();
    let content = serde_json::to_vec_pretty(&LegacyRecoveryRegistry { marketplace_paths })
        .map_err(|error| format!("Failed to serialize legacy plugin recovery registry: {error}"))?;
    fs::write(path, content).map_err(|error| {
        format!(
            "Failed to write legacy plugin recovery registry {}: {error}",
            path.display()
        )
    })
}

fn legacy_marketplace_recovery_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn legacy_personal_marketplace_roots(executor_home: &Path) -> Result<Vec<PathBuf>, String> {
    let wework_root = shared_wework_root(executor_home);
    let mut roots = Vec::new();
    let unscoped_root = personal_marketplace_root(&wework_root.join("codex"));
    if unscoped_root.is_dir() {
        roots.push(unscoped_root);
    }

    let apps_root = wework_root.join("apps");
    let apps = match fs::read_dir(&apps_root) {
        Ok(apps) => apps,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(roots),
        Err(error) => return Err(format!("Failed to read {}: {error}", apps_root.display())),
    };
    for entry in apps {
        let entry =
            entry.map_err(|error| format!("Failed to read {}: {error}", apps_root.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", entry.path().display()))?;
        if !file_type.is_dir() {
            continue;
        }
        let root = personal_marketplace_root(&entry.path().join("codex"));
        if root.is_dir() {
            roots.push(root);
        }
    }
    roots.sort();
    roots.dedup();
    Ok(roots)
}

fn shared_wework_root(executor_home: &Path) -> PathBuf {
    executor_home
        .parent()
        .filter(|parent| parent.file_name().is_some_and(|name| name == "apps"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| executor_home.to_path_buf())
}

fn personal_marketplace_root(codex_home: &Path) -> PathBuf {
    codex_home.join("plugins/marketplaces").join(MARKETPLACE_ID)
}

fn preserve_personal_plugins(
    existing_root: &Path,
    staging_root: &Path,
    bundled_plugin_names: &[String],
) -> Result<(), String> {
    let bundled = bundled_plugin_names.iter().cloned().collect::<HashSet<_>>();
    let codex_entries =
        manifest_entries_by_name(&existing_root.join(".agents/plugins/marketplace.json"))?;
    let claude_entries =
        manifest_entries_by_name(&existing_root.join(".claude-plugin/marketplace.json"))?;
    let mut names = codex_entries
        .keys()
        .chain(claude_entries.keys())
        .filter(|name| !bundled.contains(*name))
        .cloned()
        .collect::<Vec<_>>();
    let plugins_root = existing_root.join("plugins");
    if let Ok(entries) = fs::read_dir(&plugins_root) {
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Failed to read {}: {error}", plugins_root.display()))?;
            let file_type = entry.file_type().map_err(|error| {
                format!("Failed to inspect {}: {error}", entry.path().display())
            })?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if file_type.is_dir()
                && !file_type.is_symlink()
                && valid_plugin_name(&name)
                && !bundled.contains(&name)
                && valid_plugin_directory(&entry.path())
            {
                names.push(name);
            }
        }
    }
    names.sort();
    names.dedup();

    for name in names {
        let source = codex_entries
            .get(&name)
            .and_then(|entry| local_plugin_source(existing_root, entry))
            .or_else(|| {
                claude_entries
                    .get(&name)
                    .and_then(|entry| local_plugin_source(existing_root, entry))
            })
            .or_else(|| Some(existing_root.join("plugins").join(&name)));
        let Some(source) = source.filter(|path| valid_plugin_directory(path)) else {
            continue;
        };
        let destination = staging_root.join("plugins").join(&name);
        if !valid_plugin_directory(&destination) {
            remove_existing_path(&destination)?;
            copy_directory_recursive(&source, &destination)?;
        }
        append_personal_plugin_manifests(
            staging_root,
            &name,
            codex_entries.get(&name),
            claude_entries.get(&name),
            &destination,
        )?;
    }
    Ok(())
}

fn preserve_personal_marketplace_state(
    existing_root: &Path,
    staging_root: &Path,
) -> Result<(), String> {
    let existing_state = existing_root.join(".wegent");
    if !existing_state.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&existing_state).map_err(|error| {
        format!(
            "Failed to inspect personal marketplace state {}: {error}",
            existing_state.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Personal marketplace state must be a regular directory: {}",
            existing_state.display()
        ));
    }
    let staging_state = staging_root.join(".wegent");
    remove_existing_path(&staging_state)?;
    copy_directory_recursive(&existing_state, &staging_state)
}

fn recover_configured_personal_plugins(
    marketplace_root: &Path,
    codex_home: &Path,
    bundled_plugin_names: &[String],
) -> Result<(), String> {
    let bundled = bundled_plugin_names.iter().cloned().collect::<HashSet<_>>();
    let existing =
        marketplace_plugin_names(&marketplace_root.join(".agents/plugins/marketplace.json"))?
            .into_iter()
            .collect::<HashSet<_>>();
    let mut unrecoverable = Vec::new();
    for name in configured_personal_plugin_names(codex_home)? {
        if bundled.contains(&name) || existing.contains(&name) {
            continue;
        }
        let Some(cached_plugin) = newest_cached_plugin(codex_home, &name)? else {
            unrecoverable.push(name);
            continue;
        };
        let destination = marketplace_root.join("plugins").join(&name);
        remove_existing_path(&destination)?;
        copy_directory_recursive(&cached_plugin, &destination)?;
        append_personal_plugin_manifests(marketplace_root, &name, None, None, &destination)?;
    }
    remove_unrecoverable_personal_plugin_state(codex_home, &unrecoverable)?;
    Ok(())
}

fn remove_unrecoverable_personal_plugin_state(
    codex_home: &Path,
    plugin_names: &[String],
) -> Result<(), String> {
    if plugin_names.is_empty() {
        return Ok(());
    }
    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!("Failed to read {}: {error}", config_path.display()));
        }
    };
    let mut config = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;
    let Some(plugins) = config
        .get_mut("plugins")
        .and_then(|plugins| plugins.as_table_like_mut())
    else {
        return Ok(());
    };
    let mut removed = Vec::new();
    for name in plugin_names {
        let plugin_key = format!("{name}@{MARKETPLACE_ID}");
        if plugins.remove(&plugin_key).is_some() {
            removed.push(name.clone());
        }
    }
    if removed.is_empty() {
        return Ok(());
    }
    replace_config(&config_path, config.to_string())?;
    let mut cache_cleanup_failures = 0;
    for name in &removed {
        if remove_existing_path(
            &codex_home
                .join("plugins/cache")
                .join(MARKETPLACE_ID)
                .join(name),
        )
        .is_err()
        {
            cache_cleanup_failures += 1;
        }
    }
    log_executor_event(
        "removed unrecoverable personal plugin state",
        &[
            ("plugin_count", removed.len().to_string()),
            ("cache_cleanup_failures", cache_cleanup_failures.to_string()),
        ],
    );
    Ok(())
}

fn configured_personal_plugin_names(codex_home: &Path) -> Result<Vec<String>, String> {
    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!("Failed to read {}: {error}", config_path.display()));
        }
    };
    let config = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;
    let suffix = format!("@{MARKETPLACE_ID}");
    let mut names = config
        .get("plugins")
        .and_then(|plugins| plugins.as_table_like())
        .into_iter()
        .flat_map(|plugins| plugins.iter())
        .filter_map(|(key, _)| key.strip_suffix(&suffix))
        .filter(|name| valid_plugin_name(name))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

fn newest_cached_plugin(codex_home: &Path, plugin_name: &str) -> Result<Option<PathBuf>, String> {
    let cache_root = codex_home
        .join("plugins/cache")
        .join(MARKETPLACE_ID)
        .join(plugin_name);
    let entries = match fs::read_dir(&cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read {}: {error}", cache_root.display())),
    };
    let mut candidates = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read {}: {error}", cache_root.display()))?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| valid_plugin_directory(path))
        .filter(|path| cached_plugin_name_matches(path, plugin_name))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        let modified = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        (modified, path.file_name().map(|name| name.to_os_string()))
    });
    Ok(candidates.pop())
}

fn cached_plugin_name_matches(path: &Path, expected_name: &str) -> bool {
    read_manifest(&path.join(".codex-plugin/plugin.json"))
        .ok()
        .and_then(|manifest| {
            manifest
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some(expected_name)
}

fn manifest_entries_by_name(path: &Path) -> Result<HashMap<String, Value>, String> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let manifest = read_manifest(path)?;
    let plugins = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!(
                "Marketplace {} must contain a plugins array",
                path.display()
            )
        })?;
    Ok(plugins
        .iter()
        .filter_map(|plugin| {
            let name = plugin.get("name")?.as_str()?.trim();
            valid_plugin_name(name).then(|| (name.to_owned(), plugin.clone()))
        })
        .collect())
}

fn local_plugin_source(marketplace_root: &Path, entry: &Value) -> Option<PathBuf> {
    let source = entry.get("source")?;
    let relative = source
        .as_str()
        .or_else(|| source.get("path").and_then(Value::as_str))?;
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(marketplace_root.join(relative))
}

fn valid_plugin_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn valid_plugin_directory(path: &Path) -> bool {
    path.is_dir()
        && (path.join(".codex-plugin/plugin.json").is_file()
            || path.join(".claude-plugin/plugin.json").is_file())
}

fn append_personal_plugin_manifests(
    marketplace_root: &Path,
    plugin_name: &str,
    codex_entry: Option<&Value>,
    claude_entry: Option<&Value>,
    plugin_root: &Path,
) -> Result<(), String> {
    let plugin_manifest = read_manifest(&plugin_root.join(".codex-plugin/plugin.json")).ok();
    let codex_entry = codex_entry.cloned().unwrap_or_else(|| {
        json!({
            "name": plugin_name,
            "source": {"source": "local", "path": format!("./plugins/{plugin_name}")},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": plugin_manifest
                .as_ref()
                .and_then(|manifest| manifest.pointer("/interface/category"))
                .and_then(Value::as_str)
                .unwrap_or("Other"),
        })
    });
    let claude_entry = claude_entry.cloned().unwrap_or_else(|| {
        json!({
            "name": plugin_name,
            "description": plugin_manifest
                .as_ref()
                .and_then(|manifest| manifest.get("description"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            "source": format!("./plugins/{plugin_name}"),
            "version": plugin_manifest
                .as_ref()
                .and_then(|manifest| manifest.get("version"))
                .and_then(Value::as_str),
        })
    });
    append_manifest_entry(
        &marketplace_root.join(".agents/plugins/marketplace.json"),
        normalized_codex_entry(codex_entry, plugin_name),
    )?;
    append_manifest_entry(
        &marketplace_root.join(".claude-plugin/marketplace.json"),
        normalized_claude_entry(claude_entry, plugin_name),
    )
}

fn normalized_codex_entry(mut entry: Value, plugin_name: &str) -> Value {
    entry["name"] = Value::String(plugin_name.to_owned());
    entry["source"] = json!({
        "source": "local",
        "path": format!("./plugins/{plugin_name}"),
    });
    entry
}

fn normalized_claude_entry(mut entry: Value, plugin_name: &str) -> Value {
    entry["name"] = Value::String(plugin_name.to_owned());
    entry["source"] = Value::String(format!("./plugins/{plugin_name}"));
    entry
}

fn append_manifest_entry(path: &Path, entry: Value) -> Result<(), String> {
    let mut manifest = read_manifest(path)?;
    let plugins = manifest
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            format!(
                "Marketplace {} must contain a plugins array",
                path.display()
            )
        })?;
    let plugin_name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if plugins
        .iter()
        .any(|plugin| plugin.get("name").and_then(Value::as_str) == Some(plugin_name))
    {
        return Ok(());
    }
    plugins.push(entry);
    let content = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn activate_staged_marketplace(staging: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Bundled plugin marketplace destination has no parent: {}",
            destination.display()
        )
    })?;
    let backup = parent.join(format!(".{MARKETPLACE_ID}-{}-backup", std::process::id()));
    remove_existing_path(&backup)?;
    if destination.exists() {
        fs::rename(destination, &backup).map_err(|error| {
            format!(
                "Failed to preserve bundled plugin marketplace {}: {error}",
                destination.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        let rollback = if backup.exists() {
            fs::rename(&backup, destination)
                .err()
                .map(|rollback_error| {
                    format!("; restoring the backup also failed: {rollback_error}")
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        return Err(format!(
            "Failed to activate bundled plugin marketplace {}: {error}{rollback}",
            destination.display(),
        ));
    }
    if let Err(error) = remove_existing_path(&backup) {
        log_executor_event(
            "bundled plugin marketplace backup cleanup failed",
            &[("error", error)],
        );
    }
    Ok(())
}

pub(crate) fn directory_content_hash(root: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hash_directory_contents(root, root, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_directory_contents(
    root: &Path,
    directory: &Path,
    hasher: &mut Sha256,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("Failed to hash {}: {error}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Bundled plugin marketplace may not contain symbolic links: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            hasher.update(b"directory\0");
            hasher.update(relative.as_bytes());
            hasher.update(b"\0");
            hash_directory_contents(root, &path, hasher)?;
        } else if file_type.is_file() {
            hash_file(&path, &relative, hasher)?;
        }
    }
    Ok(())
}

fn hash_file(path: &Path, relative: &str, hasher: &mut Sha256) -> Result<(), String> {
    hasher.update(b"file\0");
    hasher.update(relative.as_bytes());
    hasher.update(b"\0");
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        if read == 0 {
            return Ok(());
        }
        hasher.update(&buffer[..read]);
    }
}

fn marketplace_plugin_names(path: &Path) -> Result<Vec<String>, String> {
    let manifest = read_manifest(path)?;
    let mut names = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!(
                "Marketplace {} must contain a plugins array",
                path.display()
            )
        })?
        .iter()
        .map(|plugin| {
            plugin
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    format!(
                        "Marketplace {} contains a plugin without a name",
                        path.display()
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}

fn marketplace_default_plugin_names(path: &Path) -> Result<Vec<String>, String> {
    let manifest = read_manifest(path)?;
    let mut names = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!(
                "Marketplace {} must contain a plugins array",
                path.display()
            )
        })?
        .iter()
        .filter(|plugin| {
            plugin
                .pointer("/policy/installation")
                .and_then(Value::as_str)
                == Some("INSTALLED_BY_DEFAULT")
        })
        .filter_map(|plugin| plugin.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

fn read_manifest(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "Bundled plugin marketplace source is not a directory: {}",
            source.display()
        ));
    }
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
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Bundled plugin marketplace may not contain symbolic links: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    if path.is_symlink() || path.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))
    } else if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))
    } else {
        Ok(())
    }
}

fn non_empty_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

#[cfg(test)]
mod tests;
