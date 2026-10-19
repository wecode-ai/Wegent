// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl GlobalCapabilityStore {
    pub(in crate::local::capabilities) fn can_remove_personal_marketplace_plugin(
        &self,
        key: &str,
        entry: &Value,
    ) -> bool {
        let Ok(spec) = checked_spec(key, entry) else {
            return false;
        };
        let target = self
            .personal_marketplace_dir()
            .join("plugins")
            .join(&spec.name);
        if !exists(&target) {
            return true;
        }
        if safe_managed_path(
            self.manifest.path.parent().unwrap_or(Path::new(".")),
            &target,
            true,
        )
        .is_err()
        {
            return false;
        }
        if target.is_symlink() {
            let Ok(link) = fs::read_link(&target) else {
                return false;
            };
            return self
                .plugin_runtime_targets(&spec)
                .iter()
                .any(|(runtime, field)| {
                    link == *runtime
                        || entry
                            .get("runtime")
                            .and_then(|value| value.get(field))
                            .and_then(Value::as_str)
                            .map(Path::new)
                            == Some(link.as_path())
                });
        }
        let Some(hash) = spec.checksum.as_deref() else {
            return false;
        };
        let Ok(package) = self.verified_plugin_package(hash) else {
            return false;
        };
        let Ok(staging) = tempfile::tempdir() else {
            return false;
        };
        let template = staging.path().join("runtime");
        copy_dir_atomic(&package.path, &template)
            .and_then(|()| ensure_dual_plugin_manifests(&template).map(|_| ()))
            .and_then(|()| ensure_plugin_hook_permissions(&template))
            .and_then(|()| same_runtime_contents(&target, &template))
            .unwrap_or(false)
    }

    pub(in crate::local::capabilities) fn current_recorded_runtime_paths(
        &self,
        key: &str,
        entry: &Value,
    ) -> Result<Vec<PathBuf>, CapabilitySyncError> {
        let spec = checked_spec(key, entry)?;
        let mut result = Vec::new();
        for (root, field) in [
            (&self.codex_plugins_dir, "codex_link"),
            (&self.plugins_dir, "claude_link"),
        ] {
            if self.codex_only_plugins && field == "claude_link" {
                continue;
            }
            let Some(path) = entry
                .get("runtime")
                .and_then(|runtime| runtime.get(field))
                .and_then(Value::as_str)
                .map(PathBuf::from)
            else {
                continue;
            };
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let parts = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let cache = parts.len() == 4
                && parts[0] == "cache"
                && parts[1] == spec.marketplace
                && parts[2] == spec.name
                && shared_packages::validate_component(&parts[3]).is_ok();
            let flat = field == "codex_link" && parts == vec![plugin_codex_link_name(&spec)];
            if cache || flat {
                safe_managed_path(root.parent().unwrap_or(root), &path, true)?;
                result.push(path);
            }
        }
        Ok(result)
    }

    pub(in crate::local::capabilities) fn current_recorded_store_path(
        &self,
        entry: &Value,
    ) -> Result<Option<PathBuf>, CapabilitySyncError> {
        let Some(path) = entry
            .get("store_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
        else {
            return Ok(None);
        };
        let root = self.plugin_store_dir();
        let Ok(relative) = path.strip_prefix(&root) else {
            return Ok(None);
        };
        let parts = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        if parts.len() != 2
            || parts[0] != "plugins"
            || shared_packages::validate_component(&parts[1]).is_err()
        {
            return Ok(None);
        }
        safe_managed_path(&root, &path, false)?;
        Ok(Some(path))
    }
}

pub(super) fn historical_runtime_roots(
    entries: &BTreeMap<String, Value>,
) -> BTreeMap<PathBuf, String> {
    fn collect(key: &str, entry: &Value, roots: &mut BTreeMap<PathBuf, String>) {
        if let Ok(spec) = checked_spec(key, entry) {
            for field in ["codex_link", "claude_link"] {
                if let Some(path) = entry
                    .get("runtime")
                    .and_then(|runtime| runtime.get(field))
                    .and_then(Value::as_str)
                    .map(Path::new)
                    .filter(|path| historical_cache_path(path, &spec, field))
                {
                    if let Some(root) = path
                        .parent()
                        .and_then(Path::parent)
                        .and_then(Path::parent)
                        .and_then(Path::parent)
                    {
                        roots.insert(root.to_owned(), field.to_owned());
                    }
                }
            }
        }
        if let Some(previous) = entry.get("previous").filter(|value| value.is_object()) {
            collect(key, previous, roots);
        }
    }
    let mut roots = BTreeMap::new();
    for (key, entry) in entries {
        if entry.get("managed").and_then(Value::as_bool) == Some(true) {
            collect(key, entry, &mut roots);
        }
    }
    roots
}

pub(super) fn mark_previous_ownership_pending(
    store: &GlobalCapabilityStore,
    manifest: &mut Value,
    key: &str,
    old: &Value,
    next: &Value,
) {
    if let Some(previous) = next.get("previous").filter(|value| value.is_object()) {
        let old_previous = old.get("previous").unwrap_or(&Value::Null);
        if let Ok(spec) = checked_spec(key, previous) {
            for (path, field) in store.plugin_runtime_targets(&spec) {
                if old_previous
                    .get("runtime")
                    .and_then(|runtime| runtime.get(field))
                    .and_then(Value::as_str)
                    .map(Path::new)
                    != Some(path.as_path())
                {
                    ensure_object_field(manifest, "plugin_runtime_relocated_owners")
                        .insert(path.to_string_lossy().into_owned(), json!(key));
                }
            }
        }
        mark_previous_ownership_pending(store, manifest, key, old_previous, previous);
    }
}

pub(super) fn historical_cache_path(path: &Path, spec: &PluginSyncSpec, field: &str) -> bool {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return false;
    }
    let Some(version) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let acceptable_version = version == spec.version
        || (field == "claude_link"
            && spec
                .checksum
                .as_deref()
                .and_then(|hash| hash.strip_prefix("sha256:"))
                .is_some_and(|hash| version == format!("{}-{hash}", spec.version)));
    acceptable_version
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|value| value == spec.name.as_str())
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|value| value == spec.marketplace.as_str())
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|value| value == "cache")
}

pub(super) fn entry_owns_path(entry: &Value, path: &Path, field: &str) -> bool {
    [Some(entry), entry.get("previous")]
        .into_iter()
        .flatten()
        .any(|entry| {
            entry
                .get("runtime")
                .and_then(|value| value.get(field))
                .and_then(Value::as_str)
                .map(Path::new)
                == Some(path)
        })
}
