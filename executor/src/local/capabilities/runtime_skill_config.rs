// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

use toml_edit::{value, DocumentMut, Item};

use super::{
    runtime_recovery::safe_managed_path, shared_packages::validate_component, CapabilitySyncError,
    PluginSyncSpec,
};

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
    if relative.components().count() < 3
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

    #[test]
    fn moved_plugin_keeps_disabled_skill_without_reading_the_removed_home() {
        let temp = tempfile::tempdir().unwrap();
        let (spec, runtime, old) = fixture(temp.path());
        let mut document = format!(
            "[[skills.config]]\npath = {}\nenabled = false\n",
            serde_json::to_string(&old).unwrap()
        )
        .parse::<DocumentMut>()
        .unwrap();

        relocate_plugin_skill_config(&mut document, &spec, &runtime).unwrap();

        let entry = &document["skills"]["config"]
            .as_array_of_tables()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(
            entry["path"].as_str(),
            runtime.join("skills/feature/SKILL.md").to_str()
        );
        assert_eq!(entry["enabled"].as_bool(), Some(false));
        assert!(!temp.path().join("removed").exists());
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
