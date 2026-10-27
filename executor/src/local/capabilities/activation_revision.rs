// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::ffi::OsString;

use super::*;

#[derive(Clone, Copy)]
enum StateKind {
    Manifest,
    Json,
    Toml,
    Entry,
}

#[derive(Debug, PartialEq)]
enum State {
    Missing,
    Unreadable(io::ErrorKind),
    Value(Value),
    File(String, u32),
    Link(PathBuf),
    Directory(BTreeMap<OsString, State>),
}

pub(super) struct ActivationRevision {
    paths: BTreeMap<PathBuf, StateKind>,
    before: Vec<State>,
}

impl ActivationRevision {
    pub(super) fn new<'a>(
        store: &GlobalCapabilityStore,
        manifest: &Value,
        skills: &[SkillSyncSpec],
        plugins: impl Iterator<Item = &'a PluginSyncSpec>,
        replace_skills: bool,
        replace_plugins: bool,
    ) -> Self {
        let mut paths = BTreeMap::from([(store.manifest.path.clone(), StateKind::Manifest)]);
        let mut skill_names = BTreeSet::new();
        for spec in skills {
            skill_names.insert(spec.name.clone());
            add_skill_paths(store, spec, &mut paths);
        }
        for (name, entry) in object_map(manifest.get("skills")).unwrap_or_default() {
            if replace_skills || skill_names.contains(&name) {
                add_skill_entry_paths(store, &name, &mut paths);
                if let Ok(spec) = SkillSyncSpec::from_value(&entry) {
                    add_skill_paths(store, &spec, &mut paths);
                }
            }
        }
        let mut plugin_keys = BTreeSet::new();
        for spec in plugins {
            plugin_keys.insert(spec.key.clone());
            add_plugin_paths(store, spec, &mut paths);
        }
        for (key, entry) in object_map(manifest.get("plugins")).unwrap_or_default() {
            if (replace_plugins || plugin_keys.contains(&key))
                && entry.get("managed").and_then(Value::as_bool) != Some(false)
            {
                let spec = PluginSyncSpec::from_manifest_entry(&key, &entry);
                add_plugin_paths(store, &spec, &mut paths);
            }
        }
        let before = capture(&paths);
        Self { paths, before }
    }

    pub(super) fn has_changed(&self) -> bool {
        self.before != capture(&self.paths)
    }
}

impl Drop for ActivationRevision {
    fn drop(&mut self) {
        // Compare final native state even on errors: a partially published sync
        // must invalidate sessions, while a rollback or stale receipt must not.
        if self.has_changed() {
            crate::services::capability_activation::mark_changed();
        }
    }
}

fn add_skill_paths(
    store: &GlobalCapabilityStore,
    spec: &SkillSyncSpec,
    paths: &mut BTreeMap<PathBuf, StateKind>,
) {
    add_skill_entry_paths(store, &spec.name, paths);
    if !store.shared_packages {
        let path = store.skill_store_path(spec);
        if runtime_recovery::safe_managed_path(&store.store_dir, &path, true).is_ok() {
            paths.insert(path, StateKind::Entry);
        }
    }
}

fn add_skill_entry_paths(
    store: &GlobalCapabilityStore,
    name: &str,
    paths: &mut BTreeMap<PathBuf, StateKind>,
) {
    if shared_packages::validate_component(name).is_err() {
        return;
    }
    for root in [&store.skills_dir, &store.codex_skills_dir] {
        let path = root.join(name);
        if runtime_recovery::safe_managed_path(root, &path, true).is_ok() {
            paths.insert(path, StateKind::Entry);
        }
    }
}

fn add_plugin_paths(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
    paths: &mut BTreeMap<PathBuf, StateKind>,
) {
    for component in [&spec.name, &spec.marketplace, &spec.version] {
        if shared_packages::validate_component(component).is_err() {
            return;
        }
    }
    // Reuse the transaction's exact files and native entries. Never enumerate
    // the global plugin cache, shared package store, or historical home paths.
    let (files, directories) = store.runtime_state_paths(spec);
    for path in files {
        // The writer reports path-validation failures with its existing error
        // shape. Observation must neither follow unsafe paths nor reject early.
        if store.ensure_state_path(&path, false).is_err() {
            continue;
        }
        let kind = if path
            .extension()
            .is_some_and(|extension| extension == "toml")
        {
            StateKind::Toml
        } else {
            StateKind::Json
        };
        paths.insert(path, kind);
    }
    for path in directories {
        if store.ensure_state_path(&path, true).is_ok() {
            paths.insert(path, StateKind::Entry);
        }
    }
}

fn capture(paths: &BTreeMap<PathBuf, StateKind>) -> Vec<State> {
    paths
        .iter()
        .map(|(path, kind)| read_state(path, *kind))
        .collect()
}

fn read_state(path: &Path, kind: StateKind) -> State {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return if matches!(kind, StateKind::Manifest) {
                State::Value(effective_manifest(&json!({})))
            } else {
                State::Missing
            };
        }
        Err(error) => return State::Unreadable(error.kind()),
    };
    if metadata.is_symlink() {
        return match fs::read_link(path) {
            Ok(target) => State::Link(target),
            Err(error) => State::Unreadable(error.kind()),
        };
    }
    if metadata.is_dir() {
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) => return State::Unreadable(error.kind()),
        };
        let mut children = BTreeMap::new();
        for entry in entries {
            match entry {
                Ok(entry) => {
                    children.insert(
                        entry.file_name(),
                        read_state(&entry.path(), StateKind::Entry),
                    );
                }
                Err(error) => return State::Unreadable(error.kind()),
            }
        }
        return State::Directory(children);
    }
    if !metadata.is_file() {
        return State::Unreadable(io::ErrorKind::InvalidData);
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => return State::Unreadable(error.kind()),
    };
    let parsed = match kind {
        StateKind::Manifest | StateKind::Json => serde_json::from_slice::<Value>(&bytes).ok(),
        StateKind::Toml => std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| toml_edit::de::from_str::<Value>(text).ok()),
        StateKind::Entry => None,
    };
    if let Some(mut value) = parsed {
        if matches!(kind, StateKind::Manifest) {
            value = effective_manifest(&value);
        } else if path
            .file_name()
            .is_some_and(|name| name == "known_marketplaces.json")
        {
            if let Some(entries) = value.as_object_mut() {
                for entry in entries.values_mut().filter_map(Value::as_object_mut) {
                    entry.remove("lastUpdated");
                }
            }
        } else if path
            .file_name()
            .is_some_and(|name| name == "installed_plugins.json")
        {
            if let Some(plugins) = value.get_mut("plugins").and_then(Value::as_object_mut) {
                for entries in plugins.values_mut().filter_map(Value::as_array_mut) {
                    for entry in entries.iter_mut().filter_map(Value::as_object_mut) {
                        entry.remove("installedAt");
                        entry.remove("lastUpdated");
                    }
                }
            }
        }
        return State::Value(value);
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111
    };
    #[cfg(not(unix))]
    let mode = u32::from(metadata.permissions().readonly());
    State::File(sha256_digest(&bytes), mode)
}

fn effective_manifest(manifest: &Value) -> Value {
    let mut result = json!({"skills": {}, "plugins": {}, "mcps": {}});
    for (collection, fields) in [
        (
            "skills",
            &["name", "content_hash", "store_path", "runtime"][..],
        ),
        (
            "plugins",
            &[
                "name",
                "marketplace",
                "version",
                "enabled",
                "checksum",
                "component_states",
                "store_path",
                "runtime",
            ][..],
        ),
    ] {
        for (key, entry) in object_map(manifest.get(collection)).unwrap_or_default() {
            let mut effective = Map::new();
            for field in fields {
                if let Some(value) = entry.get(*field) {
                    effective.insert((*field).to_owned(), value.clone());
                }
            }
            result[collection][key] = Value::Object(effective);
        }
    }
    result["mcps"] = manifest.get("mcps").cloned().unwrap_or_else(|| json!({}));
    result
}
