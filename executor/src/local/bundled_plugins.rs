// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;

pub const BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV: &str = "WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR";
const EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const MARKETPLACE_ID: &str = "wework-personal";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledPluginMarketplace {
    id: String,
    path: String,
    plugin_count: usize,
    default_plugin_names: Vec<String>,
}

pub fn initialize_bundled_plugin_marketplace() -> Result<BundledPluginMarketplace, String> {
    let source = non_empty_path(BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV).ok_or_else(|| {
        format!("{BUNDLED_PLUGIN_MARKETPLACE_SOURCE_ENV} is required to initialize bundled plugins")
    })?;
    let executor_home = non_empty_path(EXECUTOR_HOME_ENV)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .ok_or_else(|| "Unable to resolve executor home".to_owned())?;
    initialize_bundled_plugin_marketplace_from_paths(
        &source,
        &executor_home
            .join("capabilities")
            .join("bundled-marketplaces")
            .join(MARKETPLACE_ID),
    )
}

fn initialize_bundled_plugin_marketplace_from_paths(
    source: &Path,
    destination: &Path,
) -> Result<BundledPluginMarketplace, String> {
    let codex_manifest = source.join(".agents/plugins/marketplace.json");
    let claude_manifest = source.join(".claude-plugin/marketplace.json");
    let codex_plugins = marketplace_plugin_names(&codex_manifest)?;
    let claude_plugins = marketplace_plugin_names(&claude_manifest)?;
    if codex_plugins != claude_plugins {
        return Err("Bundled Codex and Claude plugin names must match".to_owned());
    }
    let default_plugin_names = marketplace_default_plugin_names(&codex_manifest)?;

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
    if let Err(error) = copy_directory_recursive(source, &staging) {
        let _ = remove_existing_path(&staging);
        return Err(error);
    }
    remove_existing_path(destination)?;
    fs::rename(&staging, destination).map_err(|error| {
        format!(
            "Failed to activate bundled plugin marketplace {}: {error}",
            destination.display()
        )
    })?;

    Ok(BundledPluginMarketplace {
        id: MARKETPLACE_ID.to_owned(),
        path: destination.display().to_string(),
        plugin_count: codex_plugins.len(),
        default_plugin_names,
    })
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
