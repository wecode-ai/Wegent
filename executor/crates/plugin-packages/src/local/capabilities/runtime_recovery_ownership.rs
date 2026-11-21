// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl GlobalCapabilityStore {
    pub(in crate::local::capabilities) fn validate_marketplace_occupancy(
        &self,
        spec: &PluginSyncSpec,
        entry: &Value,
        manifest: &Value,
    ) -> Result<(), CapabilitySyncError> {
        self.validate_marketplace_preparation(spec, entry)?;
        for (market, claude) in [
            (self.codex_marketplace_dir(&spec.marketplace), false),
            (self.claude_marketplace_dir(&spec.marketplace), true),
        ] {
            if claude && self.codex_only_plugins {
                continue;
            }
            let target = market
                .join("plugins")
                .join(self.marketplace_plugin_name(spec, claude));
            if !exists(&target) {
                continue;
            }
            let (runtime, field) =
                if claude && spec.marketplace != PERSONAL_SHARED_PLUGIN_MARKETPLACE {
                    (self.plugin_runtime_link(spec), "claude_link")
                } else {
                    (self.plugin_codex_link(spec), "codex_link")
                };
            if target.is_symlink()
                && fs::read_link(&target).ok().is_some_and(|link| {
                    let linked = if link.is_absolute() {
                        link
                    } else {
                        target.parent().unwrap().join(link)
                    };
                    // Uninstall retains versioned caches. A new install may replace
                    // the source only when this exact cache still belongs to its key.
                    let retained = self.shared_packages
                        && linked.parent() == runtime.parent()
                        && manifest
                            .get("plugin_runtime_owners")
                            .and_then(|owners| owners.get(linked.to_string_lossy().as_ref()))
                            .and_then(Value::as_str)
                            == Some(spec.key.as_str())
                        && self.ensure_runtime_path(&linked, false).is_ok();
                    shared_packages::same_entry(&linked, &runtime)
                        || (spec.marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE
                            && !self.codex_only_plugins
                            && shared_packages::same_entry(
                                &linked,
                                &self.plugin_runtime_link(spec),
                            )
                            && entry_owns_path(entry, &linked, "claude_link"))
                        || retained
                        || manifest
                            .get("plugin_runtime_owner_origins")
                            .and_then(|origins| origins.get(runtime.to_string_lossy().as_ref()))
                            .is_some_and(|origin| {
                                origin.get("key").and_then(Value::as_str) == Some(spec.key.as_str())
                                    && origin
                                        .get("path")
                                        .and_then(Value::as_str)
                                        .map(Path::new)
                                        .is_some_and(|path| {
                                            shared_packages::same_entry(path, &linked)
                                        })
                            })
                        || entry
                            .get("runtime")
                            .and_then(|value| value.get(field))
                            .and_then(Value::as_str)
                            .is_some_and(|old| shared_packages::same_entry(Path::new(old), &linked))
                })
            {
                continue;
            }
            if self.owns_legacy_marketplace_source(spec, &target, entry, manifest)? {
                continue;
            }
            if self.owns_managed_marketplace_copy(spec, &target, field, manifest)? {
                continue;
            }
            // Existing personal sources and directories are not implicitly managed.
            let same_install = entry.get("managed").and_then(Value::as_bool) == Some(true)
                && entry.get("installed_plugin_id").and_then(Value::as_i64)
                    == spec.installed_plugin_id;
            if !same_install || !self.matches_old_managed_copy(&target, entry, &spec.key)? {
                return Err(CapabilitySyncError::invalid_payload(
                    "Plugin marketplace entry is occupied by an unrelated source",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn recorded_runtime_at_current_home(
        &self,
        spec: &PluginSyncSpec,
        entry: &Value,
        field: &str,
    ) -> Option<PathBuf> {
        let old = Path::new(entry.get("runtime")?.get(field)?.as_str()?);
        if !historical_cache_path(old, spec, field) {
            return None;
        }
        if field == "codex_link" && cache_selection::is_retained(old) {
            return Some(
                self.codex_plugins_dir
                    .join(cache_selection::RETAINED_CACHE)
                    .join(&spec.marketplace)
                    .join(&spec.name)
                    .join(old.file_name()?),
            );
        }
        self.plugin_runtime_targets(spec)
            .into_iter()
            .find(|(_, candidate)| *candidate == field)
            .and_then(|(path, _)| {
                path.parent()
                    .map(|parent| parent.join(old.file_name().unwrap()))
            })
    }

    pub(in crate::local::capabilities) fn validate_marketplace_preparation(
        &self,
        spec: &PluginSyncSpec,
        entry: &Value,
    ) -> Result<(), CapabilitySyncError> {
        let (files, directories) = self.runtime_state_paths(spec);
        for path in files.iter().chain(directories.iter()) {
            self.ensure_state_path(path, directories.contains(path))?;
        }
        if spec.marketplace != PERSONAL_SHARED_PLUGIN_MARKETPLACE {
            return Ok(());
        }
        let target = self
            .personal_marketplace_dir()
            .join("plugins")
            .join(&spec.name);
        if !exists(&target) || target.is_symlink() {
            return Ok(());
        }
        // Personal author sources must be rejected before any package download.
        // Content ownership of managed copies is checked after cache recovery.
        let same_install = entry.get("managed").and_then(Value::as_bool) == Some(true)
            && entry.get("installed_plugin_id").and_then(Value::as_i64) == spec.installed_plugin_id;
        let published_source = crate::local::plugin_import::personal_plugin_has_cloud_link(
            &self.personal_marketplace_dir(),
            &spec.name,
        )
        .map_err(CapabilitySyncError::invalid_payload)?;
        if published_source || !same_install {
            return Err(CapabilitySyncError::invalid_payload(
                "Plugin marketplace entry is occupied by an unrelated source",
            ));
        }
        Ok(())
    }

    pub(in crate::local::capabilities) fn prepare_relocated_runtime_ownership(
        &self,
        spec: &PluginSyncSpec,
        package: &Path,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let relocated =
            object_map(manifest.get("plugin_runtime_relocated_owners")).unwrap_or_default();
        let entry = &manifest["plugins"][&spec.key];
        let pending = self
            .plugin_runtime_targets(spec)
            .into_iter()
            .filter(|(path, field)| {
                let historical = (entry["managed"] == true)
                    .then(|| entry.get("runtime"))
                    .flatten()
                    .and_then(|runtime| runtime.get(*field))
                    .and_then(Value::as_str)
                    .map(Path::new)
                    .is_some_and(|old| old != path && historical_cache_path(old, spec, field));
                historical
                    || relocated
                        .get(&path.to_string_lossy().into_owned())
                        .and_then(Value::as_str)
                        == Some(&spec.key)
            })
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(());
        }
        for (path, _) in &pending {
            self.ensure_runtime_path(path, true)?;
            if manifest
                .get("plugin_runtime_owners")
                .and_then(|owners| owners.get(path.to_string_lossy().as_ref()))
                .and_then(Value::as_str)
                .is_some_and(|owner| owner != spec.key)
            {
                return Err(CapabilitySyncError::invalid_payload(
                    "Plugin runtime belongs to another managed install",
                ));
            }
        }
        for (path, field) in &pending {
            if !exists(path) {
                continue;
            }
            let evidence = if entry.is_null() {
                marketplace_sources::retained_runtime_receipt(manifest, spec, path, field)
                    .unwrap_or(entry)
            } else {
                entry
            };
            if !self.matches_managed_package_copy(path, spec, package, evidence)?
                && !self.relocated_runtime_matches_previous(spec, path, field, manifest)?
            {
                return Err(CapabilitySyncError::invalid_payload(
                    "Retained plugin destination is occupied by unrelated data; preserving it",
                ));
            }
        }
        for (path, _) in pending {
            let path = path.to_string_lossy().into_owned();
            ensure_object_field(manifest, "plugin_runtime_relocated_owners").remove(&path);
            ensure_object_field(manifest, "plugin_runtime_owners").insert(path, json!(spec.key));
        }
        Ok(())
    }

    fn relocated_runtime_matches_previous(
        &self,
        spec: &PluginSyncSpec,
        path: &Path,
        field: &str,
        manifest: &Value,
    ) -> Result<bool, CapabilitySyncError> {
        let Some(entry) = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .filter(|entry| entry.get("managed").and_then(Value::as_bool) == Some(true))
        else {
            return Ok(false);
        };
        let previous = checked_spec(&spec.key, entry)?;
        let recorded = entry
            .get("runtime")
            .and_then(|runtime| runtime.get(field))
            .and_then(Value::as_str)
            .map(Path::new);
        if previous.version != spec.version
            || !recorded.is_some_and(|old| historical_cache_path(old, &previous, field))
            || !self
                .plugin_runtime_targets(&previous)
                .iter()
                .any(|(target, target_field)| target == path && *target_field == field)
        {
            return Ok(false);
        }
        if self.matches_legacy_runtime_source(&previous, path, entry)? {
            return Ok(true);
        }
        if previous.checksum == spec.checksum {
            return Ok(false);
        }
        let Some(hash) = previous.checksum.as_deref() else {
            return Ok(false);
        };
        // A same-version update can change bytes while keeping the Codex cache
        // path. Prove the moved cache against this installation's verified old
        // package before replacing it with the new package.
        let package = self.verified_plugin_package(hash)?;
        validate_package_identity(&package.path, &previous)?;
        self.matches_managed_package_copy(path, &previous, &package.path, entry)
    }

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
        // Publishing source does not transfer its ownership to an account install,
        // even when the source still has exactly the published package's bytes.
        match crate::local::plugin_import::personal_plugin_has_cloud_link(
            &self.personal_marketplace_dir(),
            &spec.name,
        ) {
            Ok(false) => (),
            Ok(true) => return false,
            Err(error) => {
                crate::logging::log_executor_event(
                    "personal plugin source preserved after cloud link read failure",
                    &[("plugin_key", spec.key.clone()), ("error", error)],
                );
                return false;
            }
        }
        let Some(hash) = spec.checksum.as_deref() else {
            return false;
        };
        let Ok(package) = self.verified_plugin_package(hash) else {
            return false;
        };
        self.matches_runtime_copy(&target, &package.path, entry)
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
    let retained = field == "codex_link" && cache_selection::is_retained(path);
    let acceptable_version = if retained {
        cache_selection::archived_version(path) == Some(spec.version.as_str())
    } else {
        version == spec.version
            || (field == "claude_link"
                && spec
                    .checksum
                    .as_deref()
                    .and_then(|hash| hash.strip_prefix("sha256:"))
                    .is_some_and(|hash| version == format!("{}-{hash}", spec.version)))
    };
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
            .is_some_and(|value| {
                value == "cache" || (retained && value == cache_selection::RETAINED_CACHE)
            })
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
