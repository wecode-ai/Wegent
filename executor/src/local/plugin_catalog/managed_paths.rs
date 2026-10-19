// SPDX-License-Identifier: Apache-2.0

use super::*;

#[derive(Debug, thiserror::Error)]
pub(crate) enum ManagedPluginPathError {
    #[error("Managed plugin package is unavailable: {0}")]
    Unavailable(String),
    #[error("{0}")]
    Invalid(String),
}

impl From<String> for ManagedPluginPathError {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}

impl From<&str> for ManagedPluginPathError {
    fn from(message: &str) -> Self {
        Self::Invalid(message.to_owned())
    }
}

fn path_error(error: std::io::Error) -> ManagedPluginPathError {
    if error.kind() == std::io::ErrorKind::NotFound {
        ManagedPluginPathError::Unavailable(error.to_string())
    } else {
        ManagedPluginPathError::Invalid(error.to_string())
    }
}

fn inspect_path(path: &Path) -> Result<(), ManagedPluginPathError> {
    if fs::symlink_metadata(path)
        .map_err(path_error)?
        .file_type()
        .is_symlink()
    {
        return Err("Managed plugin store or package cannot be a symbolic link".into());
    }
    Ok(())
}

/// Resolve derived package paths from the current store, never from an old Home.
pub(crate) fn managed_plugin_root(
    capabilities_root: &Path,
    shared_plugins: &Path,
    entry: &Value,
) -> Result<PathBuf, ManagedPluginPathError> {
    let recorded = entry["store_path"].as_str();
    let legacy_store = capabilities_root.join("store/plugins");
    if let Some(path) = recorded.map(|path| capabilities_root.join(path)) {
        if path != legacy_store && path.starts_with(&legacy_store) {
            return legacy_package_root(&legacy_store, &path);
        }
    }
    if entry["managed"] == true {
        if let Some(digest) = plugin_digest(entry) {
            if recorded.is_some_and(|recorded| {
                let path = capabilities_root.join(recorded);
                path.starts_with(shared_plugins) && path != shared_plugins.join(&digest)
            }) {
                return Err("Managed plugin path does not match its package checksum".into());
            }
            return shared_package_root(shared_plugins, &digest);
        }
    }
    let recorded = recorded.ok_or("Missing managed plugin path")?;
    let path = capabilities_root.join(recorded);
    let digest = plugin_digest(entry).ok_or("Invalid or missing plugin checksum")?;
    if path != shared_plugins.join(&digest) {
        return Err("Plugin is outside its managed package store".into());
    }
    inspect_path(&path)?;
    shared_package_root(shared_plugins, &digest)
}

fn legacy_package_root(store: &Path, path: &Path) -> Result<PathBuf, ManagedPluginPathError> {
    let relative = path
        .strip_prefix(store)
        .map_err(|error| error.to_string())?;
    let mut current = store.to_owned();
    for parent in store.parent().into_iter().chain([store]) {
        inspect_path(parent)?;
    }
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("Invalid managed plugin path".into());
        }
        current.push(component);
        inspect_path(&current)?;
    }
    let root = current.canonicalize().map_err(path_error)?;
    if !root.is_dir() {
        return Err("Managed plugin must be a directory".into());
    }
    Ok(root)
}

fn plugin_digest(entry: &Value) -> Option<String> {
    let checksum = entry["checksum"].as_str()?;
    let digest = checksum.strip_prefix("sha256:").unwrap_or(checksum);
    (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| digest.to_ascii_lowercase())
}

fn shared_package_root(
    shared_plugins: &Path,
    digest: &str,
) -> Result<PathBuf, ManagedPluginPathError> {
    let expected = shared_plugins.join(digest);
    for path in shared_plugins
        .parent()
        .into_iter()
        .chain([shared_plugins, &expected])
    {
        inspect_path(path)?;
    }
    let store = shared_plugins.canonicalize().map_err(path_error)?;
    let root = expected.canonicalize().map_err(path_error)?;
    if !root.is_dir() || root.parent() != Some(store.as_path()) {
        return Err("Plugin is outside its managed package store".into());
    }
    Ok(root)
}

/// Installation intent survives an unavailable package, without reading an old path.
pub(super) fn unavailable_plugin_summary(
    key: &str,
    entry: &Value,
    error: &str,
) -> Option<WegentStorePluginSummary> {
    if entry["managed"] != true {
        return None;
    }
    let name = validate_plugin_name(entry["name"].as_str()?)
        .ok()?
        .to_owned();
    let marketplace = validate_plugin_name(entry["marketplace"].as_str()?)
        .ok()?
        .to_owned();
    if key != format!("{name}@{marketplace}") {
        return None;
    }
    Some(WegentStorePluginSummary {
        name,
        package_id: key.to_owned(),
        installed_plugin_id: entry["installed_plugin_id"].as_i64(),
        cloud_plugin_id: entry["cloud_plugin_id"].as_i64(),
        marketplace,
        version: optional_trimmed_string(entry.get("version")),
        enabled: entry["enabled"].as_bool().unwrap_or(true),
        display_name: optional_trimmed_string(entry.get("display_name")),
        description: None,
        logo: None,
        category: None,
        plugin_path: String::new(),
        default_prompt: None,
        runtime_recovery_error: Some(
            optional_trimmed_string(entry.get("runtime_recovery_error"))
                .unwrap_or_else(|| error.to_owned()),
        ),
    })
}

#[cfg(test)]
#[path = "managed_paths_tests.rs"]
mod tests;
