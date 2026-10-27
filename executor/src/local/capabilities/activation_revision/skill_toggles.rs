// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Only known Boolean skill selectors may bypass process invalidation. Package
/// contents, native registrations and every other setting must remain identical.
pub(super) fn only_skill_toggles(
    store: &GlobalCapabilityStore,
    before: &Snapshot,
    after: &Snapshot,
) -> Result<bool, CapabilitySyncError> {
    if before.skills != after.skills || before.mcps != after.mcps {
        return Ok(false);
    }
    let mut old_plugins = before.plugins.clone();
    let mut new_plugins = after.plugins.clone();
    let manifest = store.manifest.load()?;
    let mut keys = BTreeMap::new();
    let mut paths = BTreeSet::new();
    for key in changed_keys(&old_plugins, &new_plugins) {
        let (Some(old), Some(new)) = (old_plugins.get_mut(&key), new_plugins.get_mut(&key)) else {
            return Ok(false);
        };
        let Some(root) = manifest["plugins"][&key]["runtime"]["codex_link"].as_str() else {
            return Ok(false);
        };
        let known = runtime_skill_config::plugin_skill_paths(Path::new(root))?;
        let Some(changed) = changed_selectors(old, new, &known) else {
            return Ok(false);
        };
        for selector in &changed {
            paths.insert(known[selector.strip_prefix("skill:").unwrap()].clone());
        }
        strip_component_states(&mut old["definition"], "component_states", &changed);
        strip_component_states(&mut new["definition"], "component_states", &changed);
        keys.insert(key, changed);
    }
    if keys.is_empty() || old_plugins != new_plugins {
        return Ok(false);
    }
    let mut old_metadata = before.metadata.clone();
    let mut new_metadata = after.metadata.clone();
    for metadata in [&mut old_metadata, &mut new_metadata] {
        for (path, value) in metadata.iter_mut() {
            match path.file_name().and_then(|name| name.to_str()) {
                Some("installed_plugins.json") => strip_installed_selectors(value, &keys),
                Some("config.toml") => strip_skill_config(value, &paths),
                _ => (),
            }
        }
    }
    Ok(old_metadata == new_metadata)
}

fn changed_selectors(
    before: &Value,
    after: &Value,
    known: &BTreeMap<String, PathBuf>,
) -> Option<BTreeSet<String>> {
    let old = before["definition"]["component_states"].as_object()?;
    let new = after["definition"]["component_states"].as_object()?;
    let changed = old
        .keys()
        .chain(new.keys())
        .filter(|key| old.get(*key) != new.get(*key))
        .cloned()
        .collect::<BTreeSet<_>>();
    if changed.is_empty()
        || changed.iter().any(|key| {
            !key.strip_prefix("skill:")
                .is_some_and(|name| known.contains_key(name))
                || old.get(key).is_some_and(|value| !value.is_boolean())
                || new.get(key).is_some_and(|value| !value.is_boolean())
        })
    {
        return None;
    }
    Some(changed)
}

fn strip_component_states(value: &mut Value, field: &str, selectors: &BTreeSet<String>) {
    let Some(states) = value.get_mut(field).and_then(Value::as_object_mut) else {
        return;
    };
    for selector in selectors {
        states.remove(selector);
    }
    if states.is_empty() {
        value.as_object_mut().unwrap().remove(field);
    }
}

fn strip_installed_selectors(value: &mut Value, keys: &BTreeMap<String, BTreeSet<String>>) {
    for (key, selectors) in keys {
        for entry in value["plugins"][key].as_array_mut().into_iter().flatten() {
            strip_component_states(entry, "componentStates", selectors);
        }
    }
}

fn strip_skill_config(value: &mut Value, paths: &BTreeSet<PathBuf>) {
    let Some(skills) = value.get_mut("skills").and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(entries) = skills.get_mut("config").and_then(Value::as_array_mut) {
        entries.retain(|entry| {
            !entry.as_object().is_some_and(|entry| {
                entry.len() == 2
                    && entry.get("enabled").is_some_and(Value::is_boolean)
                    && entry
                        .get("path")
                        .and_then(Value::as_str)
                        .is_some_and(|path| paths.contains(Path::new(path)))
            })
        });
        if entries.is_empty() {
            skills.remove("config");
        }
    }
    if skills.is_empty() {
        value["skills"] = Value::Null;
    }
}
