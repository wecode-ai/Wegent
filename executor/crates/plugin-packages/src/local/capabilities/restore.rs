//! Enabled Claude plugin cache restoration.
use super::*;

pub fn restore_enabled_claude_plugin_cache(
    config_dir: &Path,
) -> Result<Vec<String>, CapabilitySyncError> {
    restore_enabled_claude_plugin_cache_with_manifest(config_dir, &default_manifest_path())
}

pub fn restore_enabled_claude_plugin_cache_with_manifest(
    config_dir: &Path,
    manifest_path: &Path,
) -> Result<Vec<String>, CapabilitySyncError> {
    let plugins_dir = config_dir.join("plugins");
    let store = GlobalCapabilityStore::new(manifest_path, config_dir.join("skills"))
        .with_plugins_dir(plugins_dir.clone())
        .with_shared_packages();
    let mut restored = store.reconcile_managed_claude_plugins()?;
    let settings = read_json_or_default(&config_dir.join("settings.json"), || json!({}))?;
    let enabled_plugins = object_map(settings.get("enabledPlugins")).unwrap_or_default();
    if enabled_plugins.is_empty() {
        return Ok(Vec::new());
    }

    let installed = read_installed_plugins(&plugins_dir)?;
    let installed_plugins = object_map(installed.get("plugins")).unwrap_or_default();

    for (key, enabled) in enabled_plugins {
        if enabled.as_bool() != Some(true) {
            continue;
        }
        let Some(first) = installed_plugins
            .get(&key)
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
        else {
            continue;
        };
        let Some(install_path) = value_string(first.get("installPath")).map(PathBuf::from) else {
            continue;
        };
        if install_path.is_dir() {
            ensure_plugin_hook_permissions(&install_path)?;
            continue;
        }

        let (name, marketplace) = split_plugin_key(&key);
        let Some(zip_path) = cached_plugin_zip_path(&plugins_dir, &name, &marketplace) else {
            continue;
        };
        let package = fs::read(&zip_path)?;
        extract_plugin_zip(&package, &install_path)?;
        restored.push(key);
    }

    Ok(restored)
}

fn cached_plugin_zip_path(plugins_dir: &Path, name: &str, marketplace: &str) -> Option<PathBuf> {
    let cache_dir = plugins_dir.join("cache");
    let marketplace_zip = cache_dir.join(marketplace).join(format!("{name}.zip"));
    if marketplace_zip.is_file() {
        return Some(marketplace_zip);
    }

    let Ok(entries) = fs::read_dir(cache_dir) else {
        return None;
    };
    let mut candidates = entries
        .flatten()
        .map(|entry| entry.path().join(format!("{name}.zip")))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}
