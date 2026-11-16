//! Managed capability garbage collection and path guards.
use super::*;

pub(super) fn remove_unreferenced_store_packages(
    managed_root: &Path,
    store_plugins_dir: &Path,
    referenced_paths: &BTreeSet<PathBuf>,
) -> Result<Vec<PathBuf>, CapabilitySyncError> {
    ensure_managed_path_without_symlinks(managed_root, store_plugins_dir)?;
    let mut removed = Vec::new();
    for entry in sorted_dir_entries(store_plugins_dir)? {
        let path = entry.path();
        if referenced_paths.contains(&path) {
            continue;
        }
        remove_existing_path(&path)?;
        removed.push(path);
    }
    Ok(removed)
}

pub(super) fn remove_unreferenced_cloud_plugin_cache(
    managed_root: &Path,
    cache_dir: &Path,
    expected_paths: &BTreeSet<PathBuf>,
    observe_native_change: &mut impl FnMut(&Path),
) -> Result<Vec<PathBuf>, CapabilitySyncError> {
    ensure_managed_path_without_symlinks(managed_root, cache_dir)?;
    let mut removed = Vec::new();
    for marketplace in CLOUD_MANAGED_PLUGIN_MARKETPLACES {
        let marketplace_dir = cache_dir.join(marketplace);
        ensure_managed_path_without_symlinks(managed_root, &marketplace_dir)?;
        for plugin_entry in sorted_dir_entries(&marketplace_dir)? {
            let plugin_dir = plugin_entry.path();
            let plugin_metadata = fs::symlink_metadata(&plugin_dir)?;
            if plugin_metadata.file_type().is_symlink() {
                let referenced = expected_paths
                    .iter()
                    .any(|expected| expected.starts_with(&plugin_dir));
                if referenced {
                    return Err(CapabilitySyncError::invalid_payload(format!(
                        "Refusing to traverse managed plugin cache symlink: {}",
                        plugin_dir.display()
                    )));
                }
                observe_native_change(&plugin_dir);
                remove_existing_path(&plugin_dir)?;
                removed.push(plugin_dir);
                continue;
            }
            if !plugin_metadata.is_dir() {
                let referenced_legacy_zip = plugin_dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| name.strip_suffix(".zip"))
                    .is_some_and(|plugin_name| {
                        let expected_plugin_dir = marketplace_dir.join(plugin_name);
                        expected_paths.iter().any(|expected| {
                            expected.parent() == Some(expected_plugin_dir.as_path())
                        })
                    });
                if referenced_legacy_zip {
                    continue;
                }
                observe_native_change(&plugin_dir);
                remove_existing_path(&plugin_dir)?;
                removed.push(plugin_dir);
                continue;
            }
            for version_entry in sorted_dir_entries(&plugin_dir)? {
                let version_path = version_entry.path();
                let version_metadata = fs::symlink_metadata(&version_path)?;
                if expected_paths.contains(&version_path) {
                    if version_metadata.file_type().is_symlink() {
                        return Err(CapabilitySyncError::invalid_payload(format!(
                            "Managed plugin cache path must not be a symlink: {}",
                            version_path.display()
                        )));
                    }
                    continue;
                }
                observe_native_change(&version_path);
                remove_existing_path(&version_path)?;
                removed.push(version_path);
            }
            remove_empty_directory(&plugin_dir)?;
        }
        remove_empty_directory(&marketplace_dir)?;
    }
    Ok(removed)
}

pub(super) fn remove_unreferenced_marketplace_links(
    managed_root: &Path,
    plugins_dir: &Path,
    desired_names: &BTreeSet<String>,
    observe_native_change: &mut impl FnMut(&Path),
) -> Result<Vec<PathBuf>, CapabilitySyncError> {
    ensure_managed_path_without_symlinks(managed_root, plugins_dir)?;
    let mut removed = Vec::new();
    for entry in sorted_dir_entries(plugins_dir)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if desired_names.contains(&name) {
            continue;
        }
        let path = entry.path();
        observe_native_change(&path);
        remove_existing_path(&path)?;
        removed.push(path);
    }
    Ok(removed)
}

pub(super) fn prune_unreferenced_marketplace_plugins(
    managed_root: &Path,
    manifest_path: &Path,
    desired_names: &BTreeSet<String>,
) -> Result<(), CapabilitySyncError> {
    ensure_managed_path_without_symlinks(managed_root, manifest_path)?;
    if !manifest_path.is_file() {
        return Ok(());
    }
    let mut marketplace = read_json_or_default(manifest_path, || json!({}))?;
    let Some(plugins) = marketplace.get_mut("plugins").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let previous_len = plugins.len();
    plugins.retain(|plugin| {
        plugin
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| desired_names.contains(name))
    });
    if plugins.len() != previous_len {
        write_json(manifest_path, &marketplace)?;
    }
    Ok(())
}

pub(super) fn remove_marketplace_plugin_entry(
    manifest_path: &Path,
    plugin_name: &str,
) -> Result<(), CapabilitySyncError> {
    if !manifest_path.is_file() {
        return Ok(());
    }
    let mut marketplace = read_json_or_default(manifest_path, || json!({}))?;
    let Some(plugins) = marketplace.get_mut("plugins").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let previous_len = plugins.len();
    plugins.retain(|plugin| plugin.get("name").and_then(Value::as_str) != Some(plugin_name));
    if plugins.len() != previous_len {
        write_json(manifest_path, &marketplace)?;
    }
    Ok(())
}

fn ensure_managed_path_without_symlinks(
    managed_root: &Path,
    path: &Path,
) -> Result<(), CapabilitySyncError> {
    let relative = path.strip_prefix(managed_root).map_err(|_| {
        CapabilitySyncError::invalid_payload(format!(
            "Managed path is outside its root: {}",
            path.display()
        ))
    })?;
    let mut current = managed_root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Refusing to traverse managed path symlink: {}",
                current.display()
            )));
        }
    }
    Ok(())
}

fn remove_empty_directory(path: &Path) -> Result<(), CapabilitySyncError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(CapabilitySyncError::invalid_payload(format!(
            "Refusing to inspect managed directory symlink: {}",
            path.display()
        )));
    }
    if !metadata.is_dir() || fs::read_dir(path)?.next().is_some() {
        return Ok(());
    }
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn is_installed_skill_current(
    spec: &SkillSyncSpec,
    store_path: &Path,
    manifest: &Value,
) -> bool {
    if !store_path.join("SKILL.md").is_file() {
        return false;
    }
    let Some(expected_hash) = spec.content_hash.as_deref() else {
        return true;
    };
    object_map(manifest.get("skills"))
        .and_then(|skills| skills.get(&spec.name).cloned())
        .and_then(|entry| {
            Some(
                value_i64(entry.get("skill_id"))? == spec.skill_id
                    && value_string(entry.get("namespace")).as_deref()
                        == Some(spec.namespace.as_str())
                    && value_string(entry.get("content_hash")).as_deref() == Some(expected_hash),
            )
        })
        .unwrap_or(false)
}
