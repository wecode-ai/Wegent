// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use toml_edit::{value, Array, DocumentMut, InlineTable, Item, Table, TableLike};

use super::{
    runtime_recovery::safe_managed_path, shared_packages::validate_component, CapabilitySyncError,
    PluginSyncSpec,
};

/// Resolve names from the package only after checking every traversed path.
pub(super) fn plugin_skill_paths(
    current_runtime: &Path,
) -> Result<BTreeMap<String, PathBuf>, CapabilitySyncError> {
    match fs::symlink_metadata(current_runtime) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CapabilitySyncError::invalid_payload(
                "Refusing to traverse a managed plugin runtime symlink",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
        _ => (),
    }
    let mut paths = BTreeMap::new();
    for skill in super::scan_plugin_skills(current_runtime)? {
        let name = skill["name"].as_str().unwrap_or_default();
        let relative = skill["path"].as_str().unwrap_or_default();
        let path = current_runtime.join(relative).join("SKILL.md");
        safe_managed_path(current_runtime, &path, false)?;
        if paths.insert(name.to_owned(), path).is_some() {
            return Err(CapabilitySyncError::invalid_payload(
                "Managed plugin contains duplicate skill names",
            ));
        }
    }
    Ok(paths)
}

/// Project only known skill booleans; keep every unrelated native selector intact.
pub(super) fn apply_plugin_skill_states(
    document: &mut DocumentMut,
    spec: &PluginSyncSpec,
    current_runtime: &Path,
    previous_states: &serde_json::Value,
) -> Result<BTreeSet<PathBuf>, CapabilitySyncError> {
    let has_skill_states = [&spec.component_states, previous_states]
        .into_iter()
        .filter_map(serde_json::Value::as_object)
        .any(|states| states.keys().any(|key| key.starts_with("skill:")));
    if !has_skill_states {
        return Ok(BTreeSet::new());
    }
    let paths = plugin_skill_paths(current_runtime)?;
    let resolved = paths.values().cloned().collect();
    let states = spec.component_states.as_object();
    let mut updates = BTreeMap::new();
    let mut explicit = BTreeSet::new();
    for (name, path) in paths {
        let key = format!("skill:{name}");
        let state = states.and_then(|states| states.get(&key));
        let enabled = match state {
            None if previous_states
                .get(&key)
                .and_then(serde_json::Value::as_bool)
                .is_some() =>
            {
                true
            }
            None => continue,
            Some(state) => match state.as_bool() {
                Some(enabled) => enabled,
                None => continue,
            },
        };
        let path = path.to_string_lossy().into_owned();
        if state.is_some() {
            explicit.insert(path.clone());
        }
        updates.insert(path, enabled);
    }
    let has_config = document
        .get("skills")
        .and_then(Item::as_table_like)
        .and_then(|skills| skills.get("config"))
        .is_some();
    if !updates.is_empty() && (has_config || !explicit.is_empty()) {
        update_skill_rules(document, &updates, &explicit)?;
    }
    Ok(resolved)
}

fn update_skill_rules(
    document: &mut DocumentMut,
    updates: &BTreeMap<String, bool>,
    explicit: &BTreeSet<String>,
) -> Result<(), CapabilitySyncError> {
    if !document.contains_key("skills") {
        document["skills"] = Item::Table(Table::new());
    }
    let skills = document["skills"]
        .as_table_like_mut()
        .ok_or_else(|| CapabilitySyncError::invalid_payload("Codex skills must be a table"))?;
    if !skills.contains_key("config") {
        skills.insert("config", value(Array::new()));
    }
    let config = skills.get_mut("config").unwrap();
    let mut seen = BTreeSet::new();
    if let Some(tables) = config.as_array_of_tables_mut() {
        for entry in tables.iter_mut() {
            update_skill_rule(entry, updates, &mut seen);
        }
        for path in explicit.difference(&seen) {
            let mut entry = Table::new();
            entry["path"] = value(path.as_str());
            entry["enabled"] = value(updates[path]);
            tables.push(entry);
        }
    } else if let Some(array) = config.as_array_mut() {
        for entry in array
            .iter_mut()
            .filter_map(toml_edit::Value::as_inline_table_mut)
        {
            update_skill_rule(entry, updates, &mut seen);
        }
        for path in explicit.difference(&seen) {
            let mut entry = InlineTable::new();
            entry.insert("path", path.as_str().into());
            entry.insert("enabled", updates[path].into());
            array.push(entry);
        }
    } else {
        return Err(CapabilitySyncError::invalid_payload(
            "Codex skills.config must be an array",
        ));
    }
    Ok(())
}

fn update_skill_rule(
    entry: &mut dyn TableLike,
    updates: &BTreeMap<String, bool>,
    seen: &mut BTreeSet<String>,
) {
    let Some(path) = entry.get("path").and_then(Item::as_str).map(str::to_owned) else {
        return;
    };
    let Some(enabled) = updates.get(&path) else {
        return;
    };
    if entry.get("enabled").and_then(Item::as_bool) != Some(*enabled) {
        entry.insert("enabled", value(*enabled));
    }
    seen.insert(path);
}

/// Move only this managed plugin's path selectors; never resolve historical Homes.
pub(super) fn relocate_plugin_skill_config(
    document: &mut DocumentMut,
    spec: &PluginSyncSpec,
    current_runtime: &Path,
) -> Result<(), CapabilitySyncError> {
    let Some(config) = document
        .get_mut("skills")
        .and_then(Item::as_table_like_mut)
        .and_then(|skills| skills.get_mut("config"))
    else {
        return Ok(());
    };
    if let Some(tables) = config.as_array_of_tables_mut() {
        let mut targets = tables
            .iter()
            .filter_map(|entry| entry.get("path").and_then(Item::as_str).map(str::to_owned))
            .collect::<BTreeSet<_>>();
        let mut redundant = Vec::new();
        for (index, entry) in tables.iter_mut().enumerate() {
            let Some(path) = entry.get("path").and_then(Item::as_str) else {
                continue;
            };
            let Some(target) = relocated_skill_path(path, spec, current_runtime)? else {
                continue;
            };
            if targets.insert(target.clone()) {
                entry["path"] = value(target);
            } else {
                redundant.push(index);
            }
        }
        for index in redundant.into_iter().rev() {
            tables.remove(index);
        }
    } else if let Some(array) = config.as_array_mut() {
        let mut targets = array
            .iter()
            .filter_map(|entry| {
                entry
                    .as_inline_table()
                    .and_then(|entry| entry.get("path"))
                    .and_then(toml_edit::Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<BTreeSet<_>>();
        let mut redundant = Vec::new();
        for (index, entry) in array.iter_mut().enumerate() {
            let Some(entry) = entry.as_inline_table_mut() else {
                continue;
            };
            let Some(path) = entry.get("path").and_then(toml_edit::Value::as_str) else {
                continue;
            };
            let Some(target) = relocated_skill_path(path, spec, current_runtime)? else {
                continue;
            };
            if targets.insert(target.clone()) {
                entry.insert("path", target.into());
            } else {
                redundant.push(index);
            }
        }
        for index in redundant.into_iter().rev() {
            array.remove(index);
        }
    } else {
        return Err(CapabilitySyncError::invalid_payload(
            "Codex skills.config must be an array",
        ));
    }
    Ok(())
}

fn relocated_skill_path(
    configured: &str,
    spec: &PluginSyncSpec,
    current_runtime: &Path,
) -> Result<Option<String>, CapabilitySyncError> {
    let old = Path::new(configured);
    if !old.is_absolute()
        || old.starts_with(current_runtime)
        || old
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Ok(None);
    }
    let parts = old.components().collect::<Vec<_>>();
    let Some(index) = parts.windows(6).position(|parts| {
        [
            "plugins",
            "cache",
            spec.marketplace.as_str(),
            spec.name.as_str(),
        ]
        .iter()
        .zip(parts.iter())
        .all(|(expected, actual)| actual.as_os_str() == *expected)
            && parts[5].as_os_str() == "skills"
    }) else {
        return Ok(None);
    };
    let Some(version) = parts[index + 4].as_os_str().to_str() else {
        return Ok(None);
    };
    if validate_component(version).is_err() {
        return Ok(None);
    }
    let relative = parts[index + 5..]
        .iter()
        .map(|part| part.as_os_str())
        .collect::<PathBuf>();
    if relative.components().count() < 2
        || relative.file_name().map_or(true, |name| name != "SKILL.md")
    {
        return Ok(None);
    }
    let target = current_runtime.join(relative);
    safe_managed_path(current_runtime, &target, false)?;
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    Ok(metadata
        .is_file()
        .then(|| target.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path) -> (PluginSyncSpec, PathBuf, String) {
        let runtime = root.join("current/codex/plugins/cache/wegent/demo/1.0");
        fs::create_dir_all(runtime.join("skills/feature")).unwrap();
        fs::write(runtime.join("skills/feature/SKILL.md"), "# Feature").unwrap();
        let spec = PluginSyncSpec::from_value(&json!({
            "name":"demo", "marketplace":"wegent", "version":"1.0"
        }))
        .unwrap();
        let old = root.join("removed/codex/plugins/cache/wegent/demo/0.9/skills/feature/SKILL.md");
        (spec, runtime, old.to_string_lossy().into_owned())
    }

    fn skill_rules(document: &DocumentMut) -> serde_json::Value {
        toml_edit::de::from_str::<serde_json::Value>(&document.to_string()).unwrap()["skills"]
            ["config"]
            .clone()
    }

    #[test]
    fn cloud_skill_states_toggle_both_array_forms_without_touching_unrelated_selectors() {
        for inline in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let (mut spec, runtime, _) = fixture(temp.path());
            let current = runtime.join("skills/feature/SKILL.md");
            let other = temp
                .path()
                .join("other/codex/plugins/cache/wegent/demo/1.0/skills/feature/SKILL.md");
            let input = if inline {
                format!("[skills]\nconfig=[{{name='personal',enabled=false}},{{path={},enabled=false}}]\n",json!(other))
            } else {
                format!("[[skills.config]]\nname='personal'\nenabled=false\n[[skills.config]]\npath={}\nenabled=false\n",json!(other))
            };
            let mut document = input.parse::<DocumentMut>().unwrap();
            let unrelated = skill_rules(&document);
            for enabled in [false, true] {
                spec.component_states = json!({"skill:feature":enabled});

                let paths =
                    apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).unwrap();

                assert_eq!(paths, BTreeSet::from([current.clone()]));
                let rules = skill_rules(&document);
                assert_eq!(
                    &rules.as_array().unwrap()[..2],
                    unrelated.as_array().unwrap()
                );
                assert_eq!(rules[2], json!({"path":current,"enabled":enabled}));
                let saved = document.to_string();
                apply_plugin_skill_states(&mut document, &spec, &runtime, &spec.component_states)
                    .unwrap();
                assert_eq!(document.to_string(), saved);
            }
            let previous_states = spec.component_states.clone();
            spec.component_states = json!({});
            apply_plugin_skill_states(&mut document, &spec, &runtime, &previous_states).unwrap();
            assert_eq!(skill_rules(&document)[2]["enabled"], true);
        }
    }

    #[test]
    fn clearing_cloud_skill_state_restores_default_without_adding_unused_rules() {
        let temp = tempfile::tempdir().unwrap();
        let (mut spec, runtime, _) = fixture(temp.path());
        let mut document = DocumentMut::new();
        apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).unwrap();
        assert!(!document.contains_key("skills"));

        spec.component_states = json!({"skill:feature":false});
        apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).unwrap();
        assert_eq!(skill_rules(&document)[0]["enabled"], false);
        let previous_states = spec.component_states.clone();
        spec.component_states = json!({});
        apply_plugin_skill_states(&mut document, &spec, &runtime, &previous_states).unwrap();
        assert_eq!(skill_rules(&document)[0]["enabled"], true);
    }

    #[test]
    fn cloud_defaults_preserve_native_personal_disable_without_previous_cloud_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let (spec, runtime, old) = fixture(temp.path());
        for previous_states in [json!({}), json!({"skill:feature":"false"})] {
            let mut document = format!("[[skills.config]]\npath={}\nenabled=false\n", json!(old))
                .parse::<DocumentMut>()
                .unwrap();
            relocate_plugin_skill_config(&mut document, &spec, &runtime).unwrap();
            let before = document.to_string();

            apply_plugin_skill_states(&mut document, &spec, &runtime, &previous_states).unwrap();

            assert_eq!(document.to_string(), before);
            assert_eq!(skill_rules(&document)[0]["enabled"], false);
            assert_eq!(
                skill_rules(&document)[0]["path"],
                json!(runtime.join("skills/feature/SKILL.md"))
            );
        }
    }

    #[test]
    fn skill_projection_uses_frontmatter_names_and_never_joins_requested_names_as_paths() {
        for name in ["cloud-feature", "'cloud-feature'", "\"cloud-feature\""] {
            let temp = tempfile::tempdir().unwrap();
            let (mut spec, runtime, _) = fixture(temp.path());
            fs::write(
                runtime.join("skills/feature/SKILL.md"),
                format!("---\nname: {name}\n---\n# Feature"),
            )
            .unwrap();
            let mut document = DocumentMut::new();
            for enabled in [false, true] {
                let previous_states = spec.component_states.clone();
                spec.component_states =
                    json!({"skill:cloud-feature":enabled,"skill:../../outside":false});

                apply_plugin_skill_states(&mut document, &spec, &runtime, &previous_states)
                    .unwrap();

                assert_eq!(
                    skill_rules(&document),
                    json!([{"path":runtime.join("skills/feature/SKILL.md"),"enabled":enabled}]),
                    "name={name} enabled={enabled}"
                );
            }
            let paths = plugin_skill_paths(&runtime).unwrap();
            assert_eq!(paths.keys().collect::<Vec<_>>(), vec!["cloud-feature"]);
        }
    }

    #[test]
    fn nested_skill_states_toggle_their_full_native_paths() {
        for relative in [
            "skills/group/feature",
            "skills/group/nested/feature",
            "skills",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let (mut spec, runtime, _) = fixture(temp.path());
            let path = runtime.join(relative).join("SKILL.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "---\nname: 'cloud-feature'\n---\n# Feature").unwrap();
            assert_eq!(plugin_skill_paths(&runtime).unwrap()["cloud-feature"], path);
            let mut document = DocumentMut::new();
            for enabled in [false, true] {
                let previous_states = spec.component_states.clone();
                spec.component_states = json!({"skill:cloud-feature":enabled});

                apply_plugin_skill_states(&mut document, &spec, &runtime, &previous_states)
                    .unwrap();

                assert_eq!(
                    skill_rules(&document),
                    json!([{"path":path,"enabled":enabled}]),
                    "relative={relative} enabled={enabled}"
                );
            }
        }
    }

    #[test]
    fn unknown_and_non_boolean_skill_states_are_not_projected() {
        let temp = tempfile::tempdir().unwrap();
        let (mut spec, runtime, _) = fixture(temp.path());
        spec.component_states =
            json!({"skill:missing":false,"skill:feature":"false","mcp:demo":false});
        let mut document = format!(
            "[[skills.config]]\npath={}\nenabled=false\n",
            json!(runtime.join("skills/feature/SKILL.md"))
        )
        .parse::<DocumentMut>()
        .unwrap();
        let before = document.to_string();
        apply_plugin_skill_states(
            &mut document,
            &spec,
            &runtime,
            &json!({"skill:feature":false}),
        )
        .unwrap();
        assert_eq!(document.to_string(), before);
        spec.component_states = json!(null);
        apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).unwrap();
        assert_eq!(document.to_string(), before);
    }

    #[test]
    fn duplicate_skill_names_and_invalid_config_fail_before_publication() {
        let temp = tempfile::tempdir().unwrap();
        let (mut spec, runtime, _) = fixture(temp.path());
        fs::create_dir_all(runtime.join("skills/group/duplicate")).unwrap();
        fs::write(
            runtime.join("skills/group/duplicate/SKILL.md"),
            "---\nname: feature\n---\n",
        )
        .unwrap();
        assert!(plugin_skill_paths(&runtime).is_err());
        spec.component_states = json!({"skill:feature":false});
        let mut document = DocumentMut::new();
        assert!(apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).is_err());
        assert!(document.to_string().is_empty());
        fs::remove_dir_all(runtime.join("skills/group/duplicate")).unwrap();
        let mut document = "[skills]\nconfig='invalid'\n"
            .parse::<DocumentMut>()
            .unwrap();
        let before = document.to_string();
        assert!(apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).is_err());
        assert_eq!(document.to_string(), before);
        assert!(plugin_skill_paths(&runtime.join("../1.0")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skill_projection_rejects_runtime_directory_and_skill_file_symlinks() {
        use std::os::unix::fs::symlink;
        for target in ["runtime", "directory", "file"] {
            let temp = tempfile::tempdir().unwrap();
            let (mut spec, runtime, _) = fixture(temp.path());
            let external = temp.path().join("external");
            let path = match target {
                "runtime" => runtime.clone(),
                "directory" => runtime.join("skills/feature"),
                "file" => runtime.join("skills/feature/SKILL.md"),
                _ => unreachable!(),
            };
            fs::rename(&path, &external).unwrap();
            symlink(&external, &path).unwrap();
            spec.component_states = json!({"skill:feature":false});
            let mut document = DocumentMut::new();

            assert!(apply_plugin_skill_states(&mut document, &spec, &runtime, &json!({})).is_err());

            assert!(document.to_string().is_empty());
        }
    }

    #[test]
    fn moved_plugin_keeps_disabled_skill_without_reading_the_removed_home() {
        for relative in [
            "skills/feature/SKILL.md",
            "skills/group/feature/SKILL.md",
            "skills/SKILL.md",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let (spec, runtime, _) = fixture(temp.path());
            let current = runtime.join(relative);
            fs::create_dir_all(current.parent().unwrap()).unwrap();
            fs::write(&current, "# Feature").unwrap();
            let old = temp
                .path()
                .join("removed/codex/plugins/cache/wegent/demo/0.9")
                .join(relative);
            let mut document = format!(
                "[[skills.config]]\npath = {}\nenabled = false\n",
                json!(old)
            )
            .parse::<DocumentMut>()
            .unwrap();

            relocate_plugin_skill_config(&mut document, &spec, &runtime).unwrap();

            let entry = &document["skills"]["config"]
                .as_array_of_tables()
                .unwrap()
                .get(0)
                .unwrap();
            assert_eq!(entry["path"].as_str(), current.to_str());
            assert_eq!(entry["enabled"].as_bool(), Some(false));
            assert!(!temp.path().join("removed").exists());
        }
    }

    #[test]
    fn current_selector_wins_over_historical_selector_and_keeps_other_settings() {
        let temp = tempfile::tempdir().unwrap();
        let (spec, runtime, old) = fixture(temp.path());
        let current = runtime.join("skills/feature/SKILL.md");
        let native = temp.path().join("native/.codex/skills/feature/SKILL.md");
        let mut document = format!(
            "[skills]\nconfig = [{{path={},enabled=false}}, {{path={},enabled=true}}, {{name='personal',enabled=false}}, {{path={},enabled=false}}]\n",
            json!(old), json!(current), json!(native)).parse::<DocumentMut>().unwrap();

        relocate_plugin_skill_config(&mut document, &spec, &runtime).unwrap();

        let entries = document["skills"]["config"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries.get(0).unwrap().as_inline_table().unwrap()["path"].as_str(),
            current.to_str()
        );
        assert_eq!(
            entries.get(0).unwrap().as_inline_table().unwrap()["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            entries.get(1).unwrap().as_inline_table().unwrap()["name"].as_str(),
            Some("personal")
        );
        assert_eq!(
            entries.get(2).unwrap().as_inline_table().unwrap()["path"].as_str(),
            native.to_str()
        );
    }

    #[test]
    fn unrelated_plugins_and_missing_skills_are_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let (spec, runtime, old) = fixture(temp.path());
        let missing = old.replace("feature/SKILL.md", "missing/SKILL.md");
        let other = old.replace("/demo/", "/unrelated/");
        let mut document = format!(
            "[skills]\nconfig=[{{path={},enabled=false}},{{path={},enabled=false}}]\n",
            json!(missing),
            json!(other)
        )
        .parse::<DocumentMut>()
        .unwrap();
        let before = document.to_string();

        relocate_plugin_skill_config(&mut document, &spec, &runtime).unwrap();

        assert_eq!(document.to_string(), before);
    }

    #[cfg(unix)]
    #[test]
    fn skill_selector_never_crosses_a_current_runtime_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let (spec, runtime, old) = fixture(temp.path());
        let external = temp.path().join("private");
        fs::rename(runtime.join("skills/feature"), &external).unwrap();
        std::os::unix::fs::symlink(&external, runtime.join("skills/feature")).unwrap();
        let mut document = format!("[[skills.config]]\npath={}\nenabled=false\n", json!(old))
            .parse::<DocumentMut>()
            .unwrap();
        let before = document.to_string();

        assert!(relocate_plugin_skill_config(&mut document, &spec, &runtime).is_err());
        assert_eq!(document.to_string(), before);
    }
}
