//! Cloud links and marketplace manifest updates.
use super::*;

pub(super) fn plugin_cloud_link_registry_path(marketplace_root: &Path) -> PathBuf {
    let bundled_marketplaces = marketplace_root.parent();
    let capabilities = bundled_marketplaces.and_then(Path::parent);
    if bundled_marketplaces
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some("bundled-marketplaces")
        && capabilities.is_some()
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

pub(super) fn read_plugin_cloud_links_strict(
    marketplace_root: &Path,
) -> Result<Vec<LocalPluginCloudLink>, String> {
    let path = plugin_cloud_link_registry_path(marketplace_root);
    let Some(bytes) = read_optional_file(&path)? else {
        return Ok(Vec::new());
    };
    serde_json::from_slice::<LocalPluginCloudLinkRegistry>(&bytes)
        .map(|registry| registry.cloud_links)
        .map_err(|error| format!("Invalid plugin cloud link registry: {error}"))
}

pub(super) fn write_plugin_cloud_links(
    marketplace_root: &Path,
    cloud_links: Vec<LocalPluginCloudLink>,
) -> Result<(), String> {
    write_atomic_file(
        &plugin_cloud_link_registry_path(marketplace_root),
        &serde_json::to_vec_pretty(&LocalPluginCloudLinkRegistry { cloud_links })
            .map_err(|error| format!("Failed to serialize plugin registry: {error}"))?,
    )
}

pub(super) fn upsert_marketplace_plugin_entry(
    manifest_path: &Path,
    plugin_name: &str,
) -> Result<(), String> {
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

pub(super) fn marketplace_manifest_contains_plugin(
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

pub(super) fn remove_marketplace_plugin_entry(
    manifest_path: &Path,
    plugin_name: &str,
) -> Result<(), String> {
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
