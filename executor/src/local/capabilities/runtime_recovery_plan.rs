// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Run the same metadata writers against isolated copies before publication.
/// Only complete path values introduced under the fresh planning roots are mapped.
pub(super) fn planned_files(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
    template: &Path,
    staging: &Path,
    timestamp: &str,
    previous_states: &Value,
) -> Result<BTreeMap<PathBuf, Vec<u8>>, CapabilitySyncError> {
    let plan = staging.join("planned");
    let mut isolated = store.clone();
    isolated.manifest = ManagedCapabilityManifest::new(plan.join("state/manifest-v2.json"));
    isolated.plugins_dir = plan.join("claude/plugins");
    isolated.codex_plugins_dir = plan.join("codex/plugins");
    let mappings = vec![
        (
            plan.join("state"),
            store.manifest.path.parent().unwrap().to_owned(),
        ),
        (
            plan.join("codex"),
            store.codex_plugins_dir.parent().unwrap().to_owned(),
        ),
        (
            plan.join("claude"),
            store.plugins_dir.parent().unwrap().to_owned(),
        ),
    ];
    let project = |path: &Path| -> Result<PathBuf, CapabilitySyncError> {
        mappings
            .iter()
            .find_map(|(planned, real)| {
                path.strip_prefix(real)
                    .ok()
                    .map(|relative| planned.join(relative))
            })
            .ok_or_else(|| {
                CapabilitySyncError::invalid_payload(
                    "Metadata file is outside the publication roots",
                )
            })
    };
    let to_isolated = mappings
        .iter()
        .map(|(planned, real)| (real.clone(), planned.clone()))
        .collect::<Vec<_>>();
    let (files, _) = store.runtime_state_paths(spec);
    for file in &files {
        store.ensure_state_path(file, false)?;
        if file.is_file() {
            let target = project(file)?;
            fs::create_dir_all(target.parent().unwrap())?;
            let input = map_metadata_content(file, &fs::read_to_string(file)?, &to_isolated)?;
            fs::write(target, input)?;
        }
    }
    if !store.codex_only_plugins {
        isolated.install_claude_plugin_runtime_metadata_at(spec, template, timestamp)?;
    }
    let codex = isolated.plugin_codex_link(spec);
    copy_dir_atomic(template, &codex)?;
    isolated.install_codex_marketplace_metadata(spec, &codex, previous_states)?;
    let mut result = BTreeMap::new();
    for file in files {
        let content = fs::read_to_string(project(&file)?)?;
        let bytes = map_metadata_content(&file, &content, &mappings)?;
        result.insert(file, bytes);
    }
    Ok(result)
}

fn map_metadata_content(
    file: &Path,
    content: &str,
    mappings: &[(PathBuf, PathBuf)],
) -> Result<Vec<u8>, CapabilitySyncError> {
    if file
        .extension()
        .is_some_and(|extension| extension == "json")
    {
        let mut value: Value = serde_json::from_str(content)?;
        map_json_paths(&mut value, mappings);
        Ok(serde_json::to_vec_pretty(&value)?)
    } else {
        let mut document = content
            .parse::<DocumentMut>()
            .map_err(|error| CapabilitySyncError::invalid_payload(error.to_string()))?;
        for (_, item) in document.iter_mut() {
            map_toml_item(item, mappings);
        }
        Ok(document.to_string().into_bytes())
    }
}

fn map_path(value: &str, mappings: &[(PathBuf, PathBuf)]) -> Option<String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return None;
    }
    mappings.iter().find_map(|(planned, real)| {
        path.strip_prefix(planned)
            .ok()
            .map(|relative| real.join(relative).to_string_lossy().into_owned())
    })
}

fn map_json_paths(value: &mut Value, mappings: &[(PathBuf, PathBuf)]) {
    match value {
        Value::String(value) => {
            if let Some(mapped) = map_path(value, mappings) {
                *value = mapped;
            }
        }
        Value::Array(values) => {
            for value in values {
                map_json_paths(value, mappings);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                map_json_paths(value, mappings);
            }
        }
        _ => (),
    }
}

fn map_toml_item(item: &mut Item, mappings: &[(PathBuf, PathBuf)]) {
    match item {
        Item::Value(value) => map_toml_value(value, mappings),
        Item::Table(table) => {
            for (_, item) in table.iter_mut() {
                map_toml_item(item, mappings);
            }
        }
        Item::ArrayOfTables(tables) => {
            for table in tables.iter_mut() {
                for (_, item) in table.iter_mut() {
                    map_toml_item(item, mappings);
                }
            }
        }
        Item::None => (),
    }
}

fn map_toml_value(value: &mut toml_edit::Value, mappings: &[(PathBuf, PathBuf)]) {
    match value {
        toml_edit::Value::String(text) => {
            if let Some(mapped) = map_path(text.value(), mappings) {
                let decor = value.decor().clone();
                *value = toml_edit::Value::from(mapped);
                *value.decor_mut() = decor;
            }
        }
        toml_edit::Value::Array(array) => {
            for value in array.iter_mut() {
                map_toml_value(value, mappings);
            }
        }
        toml_edit::Value::InlineTable(table) => {
            for (_, value) in table.iter_mut() {
                map_toml_value(value, mappings);
            }
        }
        _ => (),
    }
}
