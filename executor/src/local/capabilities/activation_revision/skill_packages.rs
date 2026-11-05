// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

mod registrations;

#[derive(Clone, PartialEq)]
pub(super) struct PureSkills {
    paths: BTreeSet<PathBuf>,
    names: BTreeSet<String>,
}

pub(super) fn capture(
    store: &GlobalCapabilityStore,
    paths: &Paths,
) -> BTreeMap<String, PureSkills> {
    let mut result = BTreeMap::new();
    for (key, roots) in &paths.plugins {
        match inspect(store, roots) {
            Ok(Some(skills)) => {
                result.insert(key.clone(), skills);
            }
            Ok(None) => (),
            Err(error) => crate::logging::log_executor_event(
                "capability_skill_package_detection_failed",
                &[("error", error.to_string())],
            ),
        }
    }
    result
}

fn inspect(
    store: &GlobalCapabilityStore,
    roots: &BTreeSet<PathBuf>,
) -> Result<Option<PureSkills>, CapabilitySyncError> {
    let real = roots
        .iter()
        .filter(|root| root.is_dir() && !root.is_symlink())
        .map(fs::canonicalize)
        .collect::<Result<Vec<_>, _>>()?;
    if real.is_empty() {
        return Ok(None);
    }
    let mut skills = BTreeSet::new();
    let mut names = BTreeSet::new();
    for root in roots {
        match fs::symlink_metadata(root) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => (),
        }
        store.ensure_state_path(root, true)?;
        if root.is_symlink() {
            let target = fs::canonicalize(root)?;
            if !real.contains(&target) {
                return Ok(None);
            }
            continue;
        }
        if !pure_manifest(root)? {
            return Ok(None);
        }
        let known = runtime_skill_config::plugin_skill_paths(root)?;
        if known.is_empty() {
            return Ok(None);
        }
        names.extend(known.keys().cloned());
        skills.extend(known.into_values());
    }
    Ok(Some(PureSkills {
        paths: skills,
        names,
    }))
}

fn pure_manifest(root: &Path) -> Result<bool, CapabilitySyncError> {
    // Native runtimes may auto-discover these even when plugin.json omits them.
    for name in [
        ".mcp.json",
        ".app.json",
        "hooks",
        "commands",
        "agents",
        "outputStyles",
        "lsp",
        "monitors",
    ] {
        match fs::symlink_metadata(root.join(name)) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    let allowed = [
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "interface",
        "skills",
    ];
    let mut found = false;
    for marker in [CODEX_PLUGIN_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH] {
        let path = root.join(marker);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => (),
        }
        runtime_recovery::safe_managed_path(root, &path, false)?;
        let manifest: Value = serde_json::from_slice(&fs::read(path)?)?;
        let Some(fields) = manifest.as_object() else {
            return Ok(false);
        };
        if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Ok(false);
        }
        if manifest.get("skills").is_some_and(|value| {
            !matches!(value.as_str(), Some("./skills/" | "./skills" | "skills"))
        }) {
            return Ok(false);
        }
        found = true;
    }
    Ok(found)
}

/// Only membership additions/removals qualify. Updates, toggles and repairs keep their existing policy.
pub(super) fn only_membership(
    store: &GlobalCapabilityStore,
    before: &Snapshot,
    after: &Snapshot,
    paths: &Paths,
) -> bool {
    if before.skills != after.skills || before.mcps != after.mcps {
        return false;
    }
    let keys = changed_keys(&before.plugins, &after.plugins);
    if keys.is_empty() {
        return false;
    }
    let mut skill_paths = BTreeSet::new();
    let mut roots = BTreeSet::new();
    let mut definitions = BTreeMap::new();
    for key in &keys {
        let Some(owned) = membership_paths(store, before, after, key) else {
            return false;
        };
        skill_paths.extend(owned);
        let old = &before.plugins[key];
        let new = &after.plugins[key];
        for plugin in [old, new] {
            if !plugin["definition"].is_null() {
                definitions.insert(key.clone(), plugin["definition"].clone());
            }
        }
        roots.extend(paths.plugins[key].iter().cloned());
    }
    let clean = |snapshot: &Snapshot| {
        snapshot
            .cleanup
            .iter()
            .filter(|(path, _)| !roots.contains(*path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    if clean(before) != clean(after) {
        return false;
    }
    let old_metadata = registrations::without_membership(
        store,
        &before.metadata,
        &keys,
        &skill_paths,
        &roots,
        &definitions,
    );
    let new_metadata = registrations::without_membership(
        store,
        &after.metadata,
        &keys,
        &skill_paths,
        &roots,
        &definitions,
    );
    old_metadata == new_metadata
}

fn membership_paths(
    store: &GlobalCapabilityStore,
    before: &Snapshot,
    after: &Snapshot,
    key: &str,
) -> Option<BTreeSet<PathBuf>> {
    let old = &before.plugins[key];
    let new = &after.plugins[key];
    if old["definition"].is_null() == new["definition"].is_null() {
        return None;
    }
    let config = store.codex_plugins_dir.parent()?.join("config.toml");
    let mut paths = BTreeSet::new();
    for (snapshot, plugin) in [(before, old), (after, new)] {
        let active = !plugin["definition"].is_null();
        let registration = &snapshot.metadata[&config]["plugins"][key];
        if (active && registration["enabled"] != plugin["definition"]["enabled"])
            || (!active && !registration.is_null())
        {
            return None;
        }
        if plugin["runtime"]
            .as_object()
            .is_some_and(|files| !files.is_empty())
        {
            paths.extend(snapshot.pure_skill_packages.get(key)?.paths.clone());
        }
        if active {
            let pure = snapshot.pure_skill_packages.get(key)?;
            let states = plugin["definition"]["component_states"].as_object()?;
            if states.iter().any(|(selector, state)| {
                !state.is_boolean()
                    || !selector
                        .strip_prefix("skill:")
                        .is_some_and(|name| pure.names.contains(name))
            }) {
                return None;
            }
        }
    }
    Some(paths)
}
