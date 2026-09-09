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

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use toml_edit::DocumentMut;

use crate::logging::log_executor_event;

pub const BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV: &str = "WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR";
const EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const MARKETPLACE_ID: &str = "wework-personal";
const CONTENT_HASH_FILE: &str = ".wework-content-sha256";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledPluginMarketplace {
    id: String,
    path: String,
    plugin_count: usize,
    default_plugin_names: Vec<String>,
    content_hash: String,
}

pub fn initialize_bundled_plugin_marketplace() -> Result<BundledPluginMarketplace, String> {
    let source = non_empty_path(BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV).ok_or_else(|| {
        format!("{BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV} is required to initialize bundled plugins")
    })?;
    let executor_home = non_empty_path(EXECUTOR_HOME_ENV)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .ok_or_else(|| "Unable to resolve executor home".to_owned())?;
    let codex_home = non_empty_path(CODEX_HOME_ENV).unwrap_or_else(|| executor_home.join("codex"));
    let legacy_personal_marketplaces = legacy_personal_marketplace_roots(&executor_home)?;
    initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        &source,
        &executor_home
            .join("capabilities")
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
    let staging = parent.join(format!(".{MARKETPLACE_ID}-{}-staging", std::process::id()));
    remove_existing_path(&staging)?;

    let content_matches = destination.is_dir()
        && fs::read_to_string(destination.join(CONTENT_HASH_FILE))
            .is_ok_and(|stored| stored.trim() == content_hash);
    let staging_result = (|| {
        copy_directory_recursive(if content_matches { destination } else { source }, &staging)?;
        if !content_matches && destination.is_dir() {
            preserve_personal_plugins(destination, &staging, &codex_plugins)?;
        }
        for legacy_root in legacy_personal_marketplaces {
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

    Ok(BundledPluginMarketplace {
        id: MARKETPLACE_ID.to_owned(),
        path: destination.display().to_string(),
        plugin_count: codex_plugins.len(),
        default_plugin_names,
        content_hash,
    })
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
            });
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
    for name in configured_personal_plugin_names(codex_home)? {
        if bundled.contains(&name) || existing.contains(&name) {
            continue;
        }
        let Some(cached_plugin) = newest_cached_plugin(codex_home, &name)? else {
            continue;
        };
        let destination = marketplace_root.join("plugins").join(&name);
        remove_existing_path(&destination)?;
        copy_directory_recursive(&cached_plugin, &destination)?;
        append_personal_plugin_manifests(marketplace_root, &name, None, None, &destination)?;
    }
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

fn directory_content_hash(root: &Path) -> Result<String, String> {
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
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn copies_matching_marketplaces_and_reports_default_plugins() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination/wework-personal");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::create_dir_all(source.join("plugins/smart-app-builder")).unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"smart-app-builder","policy":{"installation":"INSTALLED_BY_DEFAULT"}},{"name":"wework-space"}]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"name":"wework-space"},{"name":"smart-app-builder"}]}"#,
        )
        .unwrap();
        fs::write(
            source.join("plugins/smart-app-builder/README.md"),
            "builder",
        )
        .unwrap();

        let marketplace =
            initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

        assert_eq!(marketplace.id, "wework-personal");
        assert_eq!(marketplace.plugin_count, 2);
        assert_eq!(
            marketplace.default_plugin_names,
            vec!["smart-app-builder".to_owned()]
        );
        assert_eq!(
            fs::read_to_string(destination.join("plugins/smart-app-builder/README.md")).unwrap(),
            "builder"
        );
        assert!(!marketplace.content_hash.is_empty());
        assert_eq!(
            fs::read_to_string(destination.join(CONTENT_HASH_FILE))
                .unwrap()
                .trim(),
            marketplace.content_hash
        );

        fs::write(destination.join("local-marker"), "preserved").unwrap();
        let unchanged =
            initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

        assert_eq!(unchanged.content_hash, marketplace.content_hash);
        assert_eq!(
            fs::read_to_string(destination.join("local-marker")).unwrap(),
            "preserved"
        );

        fs::create_dir_all(destination.join("plugins/personal-tool/.codex-plugin")).unwrap();
        fs::create_dir_all(destination.join("plugins/personal-tool/.claude-plugin")).unwrap();
        fs::write(
            destination.join("plugins/personal-tool/.codex-plugin/plugin.json"),
            r#"{"name":"personal-tool","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            destination.join("plugins/personal-tool/.claude-plugin/plugin.json"),
            r#"{"name":"personal-tool","version":"1.0.0"}"#,
        )
        .unwrap();
        append_manifest_entry(
            &destination.join(".agents/plugins/marketplace.json"),
            json!({
                "name": "personal-tool",
                "source": {"source": "local", "path": "./plugins/personal-tool"},
            }),
        )
        .unwrap();
        append_manifest_entry(
            &destination.join(".claude-plugin/marketplace.json"),
            json!({"name": "personal-tool", "source": "./plugins/personal-tool"}),
        )
        .unwrap();

        fs::write(
            source.join("plugins/smart-app-builder/README.md"),
            "updated builder",
        )
        .unwrap();
        let updated =
            initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

        assert_ne!(updated.content_hash, marketplace.content_hash);
        assert!(!destination.join("local-marker").exists());
        assert_eq!(
            fs::read_to_string(destination.join("plugins/smart-app-builder/README.md")).unwrap(),
            "updated builder"
        );
        assert!(destination
            .join("plugins/personal-tool/.codex-plugin/plugin.json")
            .is_file());
        assert!(
            marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
                .unwrap()
                .contains(&"personal-tool".to_owned())
        );
        assert!(
            marketplace_plugin_names(&destination.join(".claude-plugin/marketplace.json"))
                .unwrap()
                .contains(&"personal-tool".to_owned())
        );
    }

    #[test]
    fn recovers_configured_personal_plugin_from_codex_cache() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination/wework-personal");
        let codex_home = root.path().join("codex");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"smart-app-builder"}]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"name":"smart-app-builder"}]}"#,
        )
        .unwrap();
        initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

        fs::create_dir_all(&codex_home).unwrap();
        fs::write(
            codex_home.join("config.toml"),
            "[plugins.\"ip-location@wework-personal\"]\nenabled = true\n",
        )
        .unwrap();
        let cached =
            codex_home.join("plugins/cache/wework-personal/ip-location/0.3.0/.codex-plugin");
        fs::create_dir_all(&cached).unwrap();
        fs::write(
            cached.join("plugin.json"),
            r#"{"name":"ip-location","version":"0.3.0","description":"IP lookup","interface":{"category":"Utilities"}}"#,
        )
        .unwrap();

        let result = initialize_bundled_plugin_marketplace_from_paths_with_codex_home(
            &source,
            &destination,
            Some(&codex_home),
        )
        .unwrap();

        assert_eq!(result.plugin_count, 1);
        assert!(destination
            .join("plugins/ip-location/.codex-plugin/plugin.json")
            .is_file());
        assert!(
            marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
                .unwrap()
                .contains(&"ip-location".to_owned())
        );
        assert!(
            marketplace_plugin_names(&destination.join(".claude-plugin/marketplace.json"))
                .unwrap()
                .contains(&"ip-location".to_owned())
        );
    }

    #[test]
    fn migrates_personal_plugin_from_legacy_app_marketplace() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination/wework-personal");
        let legacy = root
            .path()
            .join("apps/com.example.wework/codex/plugins/marketplaces/wework-personal");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();
        fs::create_dir_all(legacy.join(".agents/plugins")).unwrap();
        fs::create_dir_all(legacy.join(".claude-plugin")).unwrap();
        fs::create_dir_all(legacy.join("plugins/personal-tool/.codex-plugin")).unwrap();
        fs::write(
            legacy.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"personal-tool","source":{"source":"local","path":"./plugins/personal-tool"}}]}"#,
        )
        .unwrap();
        fs::write(
            legacy.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"name":"personal-tool","source":"./plugins/personal-tool"}]}"#,
        )
        .unwrap();
        fs::write(
            legacy.join("plugins/personal-tool/.codex-plugin/plugin.json"),
            r#"{"name":"personal-tool","version":"1.0.0"}"#,
        )
        .unwrap();

        initialize_bundled_plugin_marketplace_from_paths_with_recovery(
            &source,
            &destination,
            None,
            std::slice::from_ref(&legacy),
        )
        .unwrap();

        assert!(destination
            .join("plugins/personal-tool/.codex-plugin/plugin.json")
            .is_file());
        assert_eq!(
            marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
                .unwrap(),
            vec!["personal-tool".to_owned()]
        );
    }

    #[test]
    fn recovers_unscoped_personal_plugin_for_branded_executor_home() {
        let root = tempfile::tempdir().unwrap();
        let wework_root = root.path().join(".wework");
        let executor_home = wework_root.join("apps/com.weibo.wework");
        let source = root.path().join("source");
        let destination = executor_home.join("capabilities/bundled-marketplaces/wework-personal");
        let legacy = wework_root.join("codex/plugins/marketplaces/wework-personal");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();
        fs::create_dir_all(legacy.join(".agents/plugins")).unwrap();
        fs::create_dir_all(legacy.join(".claude-plugin")).unwrap();
        fs::create_dir_all(legacy.join("plugins/local-ip/.codex-plugin")).unwrap();
        fs::write(
            legacy.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"local-ip","source":{"source":"local","path":"./plugins/local-ip"}}]}"#,
        )
        .unwrap();
        fs::write(
            legacy.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"name":"local-ip","source":"./plugins/local-ip"}]}"#,
        )
        .unwrap();
        fs::write(
            legacy.join("plugins/local-ip/.codex-plugin/plugin.json"),
            r#"{"name":"local-ip","version":"1.0.0"}"#,
        )
        .unwrap();

        let legacy_roots = legacy_personal_marketplace_roots(&executor_home).unwrap();
        initialize_bundled_plugin_marketplace_from_paths_with_recovery(
            &source,
            &destination,
            None,
            &legacy_roots,
        )
        .unwrap();

        assert_eq!(legacy_roots, vec![legacy]);
        assert!(destination
            .join("plugins/local-ip/.codex-plugin/plugin.json")
            .is_file());
        assert_eq!(
            marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
                .unwrap(),
            vec!["local-ip".to_owned()]
        );
    }

    #[test]
    fn leaves_a_hash_matched_marketplace_unchanged_when_recovery_fails() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination/wework-personal");
        let legacy = root.path().join("legacy/wework-personal");
        let codex_home = root.path().join("codex");
        for marketplace_root in [&source, &legacy] {
            fs::create_dir_all(marketplace_root.join(".agents/plugins")).unwrap();
            fs::create_dir_all(marketplace_root.join(".claude-plugin")).unwrap();
        }
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();
        initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

        fs::create_dir_all(legacy.join("plugins/personal-tool/.codex-plugin")).unwrap();
        fs::write(
            legacy.join("plugins/personal-tool/.codex-plugin/plugin.json"),
            r#"{"name":"personal-tool","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            legacy.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"personal-tool","source":{"source":"local","path":"./plugins/personal-tool"}}]}"#,
        )
        .unwrap();
        fs::write(
            legacy.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"name":"personal-tool","source":"./plugins/personal-tool"}]}"#,
        )
        .unwrap();
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(codex_home.join("config.toml"), "not valid toml = [").unwrap();

        let error = initialize_bundled_plugin_marketplace_from_paths_with_recovery(
            &source,
            &destination,
            Some(&codex_home),
            std::slice::from_ref(&legacy),
        )
        .unwrap_err();

        assert!(error.contains("Failed to parse"));
        assert!(!destination.join("plugins/personal-tool").exists());
        assert!(
            marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
                .unwrap()
                .is_empty()
        );
        assert!(!destination
            .parent()
            .unwrap()
            .join(format!(".{MARKETPLACE_ID}-{}-staging", std::process::id()))
            .exists());
    }

    #[test]
    fn rejects_mismatched_codex_and_claude_marketplaces() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination/wework-personal");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"smart-app-builder"}]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .unwrap();

        let error =
            initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap_err();

        assert_eq!(error, "Bundled Codex and Claude plugin names must match");
        assert!(!destination.exists());
    }
}
