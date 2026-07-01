// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs,
    io::{self, Cursor, Read},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::{CapabilitySyncError, PluginSyncSpec, DEFAULT_PLUGIN_MARKETPLACE, MANIFEST_VERSION};

pub(super) fn extract_plugin_zip(
    package: &[u8],
    install_path: &Path,
) -> Result<(), CapabilitySyncError> {
    let mut archive = ZipArchive::new(Cursor::new(package))?;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if file.is_dir() {
            continue;
        }
        let Some(path) = file.enclosed_name().map(Path::to_path_buf) else {
            continue;
        };
        if is_macos_metadata_path(&path) {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        entries.push((path, bytes));
    }
    let manifest_prefix = plugin_manifest_prefix(&entries).ok_or_else(|| {
        CapabilitySyncError::invalid_payload("Plugin package is missing .claude-plugin/plugin.json")
    })?;

    let temp_path = sibling_temp_path(install_path);
    remove_existing_path(&temp_path)?;
    fs::create_dir_all(&temp_path)?;
    let extraction_result = (|| -> Result<(), CapabilitySyncError> {
        for (path, bytes) in &entries {
            if !manifest_prefix.as_os_str().is_empty() && !path.starts_with(&manifest_prefix) {
                continue;
            }
            let relative = path.strip_prefix(&manifest_prefix).unwrap_or(path);
            if relative.as_os_str().is_empty() {
                continue;
            }
            let target = temp_path.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&target, bytes)?;
            ensure_plugin_hook_executable(relative, &target)?;
        }
        if !temp_path.join(".claude-plugin/plugin.json").is_file() {
            return Err(CapabilitySyncError::invalid_payload(
                "Plugin package is missing .claude-plugin/plugin.json",
            ));
        }
        Ok(())
    })();
    if let Err(error) = extraction_result {
        let _ = remove_existing_path(&temp_path);
        return Err(error);
    }

    remove_existing_path(install_path)?;
    if let Some(parent) = install_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&temp_path, install_path)?;
    Ok(())
}

pub(super) fn ensure_plugin_hook_permissions(
    plugin_path: &Path,
) -> Result<(), CapabilitySyncError> {
    if !plugin_path.is_dir() {
        return Ok(());
    }

    let mut pending = vec![PathBuf::new()];
    while let Some(relative_dir) = pending.pop() {
        for entry in fs::read_dir(plugin_path.join(&relative_dir))? {
            let entry = entry?;
            let relative = relative_dir.join(entry.file_name());
            let target = entry.path();
            let metadata = fs::metadata(&target)?;
            if metadata.is_dir() {
                pending.push(relative);
            } else if metadata.is_file() {
                ensure_plugin_hook_executable(&relative, &target)?;
            }
        }
    }

    Ok(())
}

fn ensure_plugin_hook_executable(
    relative: &Path,
    target: &Path,
) -> Result<(), CapabilitySyncError> {
    #[cfg(unix)]
    {
        if is_plugin_hook_path(relative) {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(target)?.permissions();
            permissions.set_mode(permissions.mode() | 0o111);
            fs::set_permissions(target, permissions)?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = relative;
        let _ = target;
    }
    Ok(())
}

fn is_plugin_hook_path(path: &Path) -> bool {
    path.components().next().is_some_and(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| matches!(name, "hooks" | "hooks-handlers" | "hook-handlers"))
    })
}

fn plugin_manifest_prefix(entries: &[(PathBuf, Vec<u8>)]) -> Option<PathBuf> {
    entries
        .iter()
        .filter(|(path, _)| path.ends_with(Path::new(".claude-plugin/plugin.json")))
        .map(|(path, _)| {
            path.parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_default()
        })
        .min_by_key(|path| path.components().count())
}

fn is_macos_metadata_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value
            .to_str()
            .is_some_and(|value| value == "__MACOSX" || value.starts_with("._")),
        _ => false,
    })
}

pub(super) fn is_manifest_managed_skill(manifest: &Value, name: &str) -> bool {
    manifest
        .get("skills")
        .and_then(|skills| skills.get(name))
        .and_then(|skill| skill.get("managed"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn remove_runtime_link_from_value(
    runtime: Option<&Value>,
    key: &str,
) -> Result<(), CapabilitySyncError> {
    if let Some(path) = runtime.and_then(|runtime| value_string(runtime.get(key))) {
        remove_managed_runtime_path(Path::new(&path))?;
    }
    Ok(())
}

pub(super) fn remove_managed_runtime_path(path: &Path) -> Result<(), CapabilitySyncError> {
    if path.is_symlink() || path.is_file() {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    } else {
        Ok(())
    }
}

pub(super) fn upsert_installed_plugin(
    plugins_dir: &Path,
    spec: &PluginSyncSpec,
    runtime_link: &Path,
) -> Result<(), CapabilitySyncError> {
    let path = plugins_dir.join("installed_plugins.json");
    let mut installed = read_installed_plugins(plugins_dir)?;
    installed["version"] = json!(2);
    let timestamp = now_rfc3339_like();
    let mut entry = Map::new();
    entry.insert("scope".to_owned(), json!("user"));
    entry.insert(
        "installPath".to_owned(),
        json!(runtime_link.display().to_string()),
    );
    if let Some(id) = spec.installed_plugin_id {
        entry.insert("installedPluginId".to_owned(), json!(id));
    }
    if let Some(checksum) = &spec.checksum {
        entry.insert("checksum".to_owned(), json!(checksum));
    }
    entry.insert("version".to_owned(), json!(spec.version));
    entry.insert("installedAt".to_owned(), json!(timestamp.clone()));
    entry.insert("lastUpdated".to_owned(), json!(timestamp));
    if !spec.component_states.as_object().is_some_and(Map::is_empty) {
        entry.insert("componentStates".to_owned(), spec.component_states.clone());
    }
    ensure_object_field(&mut installed, "plugins")
        .insert(spec.key.clone(), Value::Array(vec![Value::Object(entry)]));
    write_json(&path, &installed)
}

pub(super) fn enable_plugin(plugins_dir: &Path, key: &str) -> Result<(), CapabilitySyncError> {
    let settings_path = plugins_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("settings.json");
    let mut settings = read_json_or_default(&settings_path, || json!({}))?;
    ensure_object_field(&mut settings, "enabledPlugins").insert(key.to_owned(), json!(true));
    write_json(&settings_path, &settings)
}

pub(super) fn plugin_manifest_entry(
    spec: &PluginSyncSpec,
    store_path: &Path,
    runtime_link: &Path,
    codex_link: &Path,
) -> Value {
    let mut entry = Map::new();
    entry.insert("managed".to_owned(), json!(true));
    entry.insert("name".to_owned(), json!(spec.name));
    entry.insert("key".to_owned(), json!(spec.key));
    if let Some(id) = spec.installed_plugin_id {
        entry.insert("installed_plugin_id".to_owned(), json!(id));
    }
    entry.insert("marketplace".to_owned(), json!(spec.marketplace));
    entry.insert("version".to_owned(), json!(spec.version));
    if let Some(checksum) = &spec.checksum {
        entry.insert("checksum".to_owned(), json!(checksum));
    }
    if !spec.component_states.as_object().is_some_and(Map::is_empty) {
        entry.insert("component_states".to_owned(), spec.component_states.clone());
    }
    entry.insert(
        "store_path".to_owned(),
        json!(store_path.display().to_string()),
    );
    entry.insert(
        "runtime".to_owned(),
        json!({
            "claude_link": runtime_link.display().to_string(),
            "codex_link": codex_link.display().to_string(),
        }),
    );
    entry.insert("updated_at".to_owned(), json!(now_rfc3339_like()));
    Value::Object(entry)
}

pub(super) fn read_installed_plugins(plugins_dir: &Path) -> Result<Value, CapabilitySyncError> {
    read_json_or_default(
        &plugins_dir.join("installed_plugins.json"),
        || json!({"version": 2, "plugins": {}}),
    )
}

pub(super) fn scan_plugin_skills(plugin_path: &Path) -> Result<Vec<Value>, CapabilitySyncError> {
    let skills_dir = plugin_path.join("skills");
    let mut output = Vec::new();
    for entry in sorted_dir_entries(&skills_dir)? {
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").is_file() {
            continue;
        }
        let skill_md = fs::read_to_string(path.join("SKILL.md"))?;
        let metadata = parse_skill_frontmatter(&skill_md);
        let name = metadata
            .get("name")
            .cloned()
            .or_else(|| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        let description = metadata.get("description").cloned().unwrap_or_default();
        let relative = path
            .strip_prefix(plugin_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        output.push(json!({
            "name": name,
            "description": description,
            "path": relative,
        }));
    }
    Ok(output)
}

fn parse_skill_frontmatter(content: &str) -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::new();
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return metadata;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        metadata.insert(
            key.trim().to_owned(),
            value.trim().trim_matches('"').to_owned(),
        );
    }
    metadata
}

pub(super) fn sorted_dir_entries(path: &Path) -> Result<Vec<fs::DirEntry>, CapabilitySyncError> {
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

pub(super) fn read_json_or_default<F>(path: &Path, default: F) -> Result<Value, CapabilitySyncError>
where
    F: FnOnce() -> Value,
{
    if !path.exists() {
        return Ok(default());
    }
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<(), CapabilitySyncError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

pub(super) fn ensure_root_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("manifest object")
}

pub(super) fn ensure_object_field<'a>(
    value: &'a mut Value,
    field: &str,
) -> &'a mut Map<String, Value> {
    let object = ensure_root_object(value);
    if !object.get(field).is_some_and(Value::is_object) {
        object.insert(field.to_owned(), Value::Object(Map::new()));
    }
    object
        .get_mut(field)
        .and_then(Value::as_object_mut)
        .expect("object field")
}

pub(super) fn normalize_manifest(value: &mut Value) {
    let object = ensure_root_object(value);
    object
        .entry("version")
        .or_insert_with(|| json!(MANIFEST_VERSION));
    object.entry("revision").or_insert_with(|| json!(0));
    for field in ["skills", "plugins", "mcps"] {
        if !object.get(field).is_some_and(Value::is_object) {
            object.insert(field.to_owned(), Value::Object(Map::new()));
        }
    }
}

pub(super) fn default_manifest() -> Value {
    json!({
        "version": MANIFEST_VERSION,
        "revision": 0,
        "skills": {},
        "plugins": {},
        "mcps": {},
    })
}

pub(super) fn object_map(value: Option<&Value>) -> Option<BTreeMap<String, Value>> {
    value.and_then(Value::as_object).map(|object| {
        object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    })
}

pub(super) fn value_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

pub(super) fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|raw| raw.trim().parse::<i64>().ok())
            })
    })
}

pub(super) fn value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) => Some(value.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

pub(super) fn value_path_string(map: &Map<String, Value>, path: &[&str]) -> Option<String> {
    let mut current = map.get(*path.first()?)?;
    for part in &path[1..] {
        current = current.get(*part)?;
    }
    value_string(Some(current))
}

pub(super) fn infer_home_from_runtime_dir(path: &Path, leaf: &str) -> PathBuf {
    if path.file_name().and_then(|name| name.to_str()) == Some(leaf)
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some(".claude")
    {
        return path
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
    }
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(super) fn split_plugin_key(key: &str) -> (String, String) {
    key.split_once('@')
        .map(|(name, marketplace)| (name.to_owned(), marketplace.to_owned()))
        .unwrap_or_else(|| (key.to_owned(), DEFAULT_PLUGIN_MARKETPLACE.to_owned()))
}

pub(super) fn plugin_codex_link_name(spec: &PluginSyncSpec) -> String {
    format!("{}-{}", spec.name, spec.marketplace)
}

pub(super) fn link_or_copy_dir(target: &Path, link: &Path) -> Result<(), CapabilitySyncError> {
    if link.exists() || link.is_symlink() {
        if link.is_symlink() || link.is_file() {
            fs::remove_file(link)?;
        } else {
            fs::remove_dir_all(link)?;
        }
    }
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent)?;
    }
    match symlink_dir(target, link) {
        Ok(()) => Ok(()),
        Err(_) => copy_dir_recursive(target, link),
    }
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), CapabilitySyncError> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

pub(super) fn remove_existing_path(path: &Path) -> Result<(), CapabilitySyncError> {
    if path.is_symlink() || path.is_file() {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    } else if path.is_dir() {
        match fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    } else {
        Ok(())
    }
}

fn sibling_temp_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plugin");
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    parent.join(format!(".{name}.tmp-{}-{millis}", std::process::id()))
}

pub(super) fn sha256_json_digest(value: &Value) -> String {
    sha256_digest(&serde_json::to_vec(value).unwrap_or_default())
}

pub(super) fn sha256_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity("sha256:".len() + digest.len() * 2);
    output.push_str("sha256:");
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

pub(super) fn now_rfc3339_like() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}")
}
