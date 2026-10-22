// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::Read;

/// Compare only owned files. Native runtimes may add caches alongside them.
pub(in crate::local::capabilities) fn runtime_copy_matches(
    source: &Path,
    target: &Path,
) -> Result<bool, CapabilitySyncError> {
    if target.is_symlink() || !target.is_dir() {
        return Ok(false);
    }
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let directory = target.join(&relative);
        if directory.is_symlink() || !directory.is_dir() {
            return Ok(false);
        }
        for entry in fs::read_dir(source.join(&relative))? {
            let entry = entry?;
            let relative = relative.join(entry.file_name());
            let metadata = entry.file_type()?;
            if metadata.is_dir() {
                pending.push(relative);
            } else if metadata.is_file() {
                if PLUGIN_MANIFEST_PATHS
                    .iter()
                    .any(|manifest| relative == Path::new(manifest))
                {
                    continue;
                }
                let destination = target.join(&relative);
                if destination.is_symlink()
                    || !destination.is_file()
                    || !file_contents_match(&entry.path(), &destination)?
                    || !execute_permissions_match(&entry.path(), &destination, &relative)?
                {
                    return Ok(false);
                }
            } else {
                return Ok(false);
            }
        }
    }
    native_manifests_match(source, target)
}

fn file_contents_match(source: &Path, target: &Path) -> Result<bool, CapabilitySyncError> {
    if fs::metadata(source)?.len() != fs::metadata(target)?.len() {
        return Ok(false);
    }
    let mut source = fs::File::open(source)?;
    let mut target = fs::File::open(target)?;
    let mut expected = [0; 8192];
    let mut actual = [0; 8192];
    loop {
        let count = source.read(&mut expected)?;
        if count == 0 {
            return Ok(true);
        }
        target.read_exact(&mut actual[..count])?;
        if expected[..count] != actual[..count] {
            return Ok(false);
        }
    }
}

fn execute_permissions_match(
    source: &Path,
    target: &Path,
    relative: &Path,
) -> Result<bool, CapabilitySyncError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let source = fs::metadata(source)?.permissions().mode() & 0o111;
        let actual = fs::metadata(target)?.permissions().mode() & 0o111;
        Ok(actual == source || (is_plugin_hook_path(relative) && actual == 0o111))
    }
    #[cfg(not(unix))]
    {
        let _ = (source, target, relative);
        Ok(true)
    }
}

fn optional_manifest(path: &Path) -> Option<Value> {
    if path.is_symlink() || path.parent().is_some_and(Path::is_symlink) || !path.is_file() {
        return None;
    }
    serde_json::from_slice::<Value>(&fs::read(path).ok()?)
        .ok()
        .filter(Value::is_object)
}

fn native_manifests_match(source: &Path, target: &Path) -> Result<bool, CapabilitySyncError> {
    let codex = optional_manifest(&source.join(CODEX_PLUGIN_MANIFEST_PATH));
    let claude = optional_manifest(&source.join(CLAUDE_PLUGIN_MANIFEST_PATH));
    let Some(native) = codex.as_ref().or(claude.as_ref()) else {
        return Ok(false);
    };
    let expected_codex = codex
        .clone()
        .unwrap_or_else(|| convert_plugin_manifest(native, false));
    let expected_claude = convert_plugin_manifest(claude.as_ref().unwrap_or(&expected_codex), true);
    Ok(
        optional_manifest(&target.join(CODEX_PLUGIN_MANIFEST_PATH)) == Some(expected_codex)
            && optional_manifest(&target.join(CLAUDE_PLUGIN_MANIFEST_PATH))
                == Some(expected_claude),
    )
}

pub(super) fn plugin_state_matches(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
    source: &Path,
    manifest: &Value,
) -> Result<bool, CapabilitySyncError> {
    let claude = store.plugin_runtime_link(spec);
    let codex = store.plugin_codex_link(spec);
    let expected = plugin_manifest_entry(spec, source, &claude, &codex);
    let Some(previous) = manifest
        .get("plugins")
        .and_then(|plugins| plugins.get(&spec.key))
    else {
        return Ok(false);
    };
    if expected.as_object().unwrap().iter().any(|(field, value)| {
        field != "updated_at"
            && field != "plugin_sync_generation"
            && previous.get(field) != Some(value)
    }) || ["installed_plugin_id", "cloud_plugin_id", "checksum"]
        .iter()
        .any(|field| previous.get(field) != expected.get(field))
        || previous
            .get("component_states")
            .cloned()
            .unwrap_or_else(|| json!({}))
            != spec.component_states
        || !runtime_copy_matches(source, &claude)?
        || !runtime_copy_matches(source, &codex)?
        || !claude_hooks_executable(&claude)?
    {
        return Ok(false);
    }
    // Parse only stable fields for this plugin. Other plugins and native metadata
    // may legitimately change without invalidating this installation.
    Ok(runtime_configuration_matches(store, spec, &claude, &codex))
}

fn claude_hooks_executable(root: &Path) -> Result<bool, CapabilitySyncError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut pending = vec![PathBuf::new()];
        while let Some(relative) = pending.pop() {
            for entry in fs::read_dir(root.join(&relative))? {
                let entry = entry?;
                let relative = relative.join(entry.file_name());
                let metadata = entry.file_type()?;
                if metadata.is_dir() && !metadata.is_symlink() {
                    pending.push(relative);
                } else if metadata.is_file()
                    && is_plugin_hook_path(&relative)
                    && entry.metadata()?.permissions().mode() & 0o111 != 0o111
                {
                    return Ok(false);
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = root;
    Ok(true)
}

fn json_file(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn marketplace_entry(path: &Path, spec: &PluginSyncSpec) -> Value {
    let marketplace = json_file(path);
    if marketplace.get("name").and_then(Value::as_str) != Some(spec.marketplace.as_str()) {
        return Value::Null;
    }
    marketplace
        .get("plugins")
        .and_then(Value::as_array)
        .and_then(|plugins| {
            plugins.iter().find(|plugin| {
                plugin.get("name").and_then(Value::as_str) == Some(spec.name.as_str())
            })
        })
        .cloned()
        .unwrap_or(Value::Null)
}

fn marketplace_runtime_matches(source: &Path, link: &Path) -> bool {
    if link.is_symlink() {
        return fs::canonicalize(source)
            .ok()
            .zip(fs::canonicalize(link).ok())
            .is_some_and(|(source, link)| source == link);
    }
    runtime_copy_matches(source, link).unwrap_or(false)
}

fn runtime_configuration_matches(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
    claude: &Path,
    codex: &Path,
) -> bool {
    let settings = json_file(
        &store
            .plugins_dir
            .parent()
            .unwrap_or(Path::new("."))
            .join("settings.json"),
    );
    let claude_market = store.claude_marketplace_dir(&spec.marketplace);
    let codex_market = store.codex_marketplace_dir(&spec.marketplace);
    let market_source = json!({"source": "directory", "path": claude_market});
    let known = json_file(&store.plugins_dir.join("known_marketplaces.json"));
    let installed = json_file(&store.plugins_dir.join("installed_plugins.json"));
    let entry = installed
        .get("plugins")
        .and_then(|plugins| plugins.get(&spec.key))
        .and_then(Value::as_array)
        .and_then(|entries| entries.first())
        .cloned()
        .unwrap_or(Value::Null);
    if settings["enabledPlugins"][&spec.key] != json!(spec.enabled)
        || settings["extraKnownMarketplaces"][&spec.marketplace]["source"] != market_source
        || known[&spec.marketplace]["source"] != market_source
        || known[&spec.marketplace]["installLocation"] != json!(claude_market)
        || entry["installPath"] != json!(claude)
        || entry["version"] != json!(spec.version)
        || entry.get("installedPluginId").and_then(Value::as_i64) != spec.installed_plugin_id
        || entry.get("checksum").and_then(Value::as_str) != spec.checksum.as_deref()
        || entry
            .get("componentStates")
            .cloned()
            .unwrap_or_else(|| json!({}))
            != spec.component_states
    {
        return false;
    }
    let claude_name = store.marketplace_plugin_name(spec, true);
    let codex_name = store.marketplace_plugin_name(spec, false);
    let claude_market_source = if claude_market == codex_market {
        codex
    } else {
        claude
    };
    if !marketplace_runtime_matches(
        claude_market_source,
        &claude_market.join("plugins").join(&claude_name),
    ) || !marketplace_runtime_matches(codex, &codex_market.join("plugins").join(&codex_name))
    {
        return false;
    }
    let claude_entry =
        marketplace_entry(&claude_market.join(".claude-plugin/marketplace.json"), spec);
    if claude_entry["source"] != json!(format!("./plugins/{claude_name}"))
        || claude_entry["version"] != json!(spec.version)
    {
        return false;
    }
    for (directory, name) in [(&claude_market, &claude_name), (&codex_market, &codex_name)] {
        let entry = marketplace_entry(&directory.join(".agents/plugins/marketplace.json"), spec);
        if entry["source"] != json!({"source": "local", "path": format!("./plugins/{name}")})
            || entry["policy"]["installation"] != "AVAILABLE"
            || entry["policy"]["authentication"] != "ON_INSTALL"
            || (directory == &codex_market && entry["policy"]["products"] != json!(["CODEX"]))
        {
            return false;
        }
    }
    let config_path = store
        .codex_plugins_dir
        .parent()
        .unwrap_or(Path::new("."))
        .join("config.toml");
    let document = fs::read_to_string(config_path)
        .ok()
        .and_then(|text| text.parse::<DocumentMut>().ok());
    document.is_some_and(|document| {
        document["plugins"][&spec.key]["enabled"].as_bool() == Some(spec.enabled)
            && document["marketplaces"][&spec.marketplace]["source_type"].as_str() == Some("local")
            && document["marketplaces"][&spec.marketplace]["source"].as_str()
                == codex_market.to_str()
    })
}
