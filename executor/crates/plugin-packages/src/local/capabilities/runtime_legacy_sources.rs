// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Authenticate direct-store marketplace links left by historical installers.
//! Legacy records are evidence for an explicit install, never an install inventory.

use super::*;

impl GlobalCapabilityStore {
    pub(super) fn matches_verified_legacy_contents(
        &self,
        spec: &PluginSyncSpec,
        runtime: &Path,
        package: &Path,
    ) -> Result<bool, CapabilitySyncError> {
        self.ensure_state_path(runtime, false)?;
        Ok(normalized_legacy_tree(runtime, spec)?
            .zip(normalized_legacy_tree(package, spec)?)
            .is_some_and(|(runtime, package)| same_fingerprints(runtime, &package)))
    }

    pub(super) fn owns_legacy_marketplace_source(
        &self,
        spec: &PluginSyncSpec,
        target: &Path,
        active: &Value,
        manifest: &Value,
    ) -> Result<bool, CapabilitySyncError> {
        if !CLOUD_MANAGED_PLUGIN_MARKETPLACES.contains(&spec.marketplace.as_str()) {
            return Ok(false);
        }
        let linked = target
            .is_symlink()
            .then(|| resolve_link(target))
            .transpose()?;
        let legacy = self.legacy_plugin_record(&spec.key);
        let retained = manifest
            .get("plugin_legacy_sources")
            .and_then(|entries| entries.get(&spec.key));
        for entry in [Some(active), retained, legacy.as_ref()]
            .into_iter()
            .flatten()
        {
            for candidate in [Some(entry), entry.get("previous")].into_iter().flatten() {
                let owned = self.matches_legacy_source(
                    spec,
                    target,
                    linked.as_deref(),
                    candidate,
                    manifest,
                )?;
                if candidate.get("managed").and_then(Value::as_bool) == Some(true) {
                    crate::logging::log_executor_event(
                        "legacy plugin source verification",
                        &[
                            ("plugin", spec.key.clone()),
                            ("source", target.display().to_string()),
                            (
                                "recorded_store",
                                value_string(candidate.get("store_path")).unwrap_or_default(),
                            ),
                            ("accepted", owned.to_string()),
                        ],
                    );
                }
                if owned {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn legacy_plugin_record(&self, key: &str) -> Option<Value> {
        if self.manifest.path.file_name()? != "manifest-v2.json" {
            return None;
        }
        let path = self.manifest.path.with_file_name("manifest.json");
        if !fs::symlink_metadata(&path).ok()?.is_file() {
            return None;
        }
        let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        if value.get("version").and_then(Value::as_i64) != Some(1) {
            return None;
        }
        value.get("plugins")?.get(key).cloned()
    }

    pub(super) fn matches_legacy_runtime_source(
        &self,
        spec: &PluginSyncSpec,
        runtime: &Path,
        entry: &Value,
    ) -> Result<bool, CapabilitySyncError> {
        let Some(recorded) = legacy_store_path(&spec.key, entry) else {
            return Ok(false);
        };
        self.ensure_runtime_path(runtime, false)?;
        let Some(runtime) = normalized_legacy_tree(runtime, spec)? else {
            return Ok(false);
        };
        if let Some(hash) = spec.checksum.as_deref() {
            match self.verified_plugin_package(hash) {
                Ok(package) => {
                    return Ok(normalized_legacy_tree(&package.path, spec)?
                        .is_some_and(|package| same_fingerprints(runtime, &package)));
                }
                Err(error @ CapabilitySyncError::PluginPackageBusy(_)) => return Err(error),
                Err(_) => {}
            }
        }
        let moved = self
            .manifest
            .path
            .parent()
            .unwrap()
            .join("store/plugins")
            .join(recorded.file_name().unwrap());
        for source in [moved, recorded] {
            if !source.is_dir() {
                continue;
            }
            safe_managed_path(source.parent().unwrap().parent().unwrap(), &source, false)?;
            if normalized_legacy_tree(&source, spec)?
                .is_some_and(|source| same_fingerprints(runtime.clone(), &source))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn matches_legacy_source(
        &self,
        requested: &PluginSyncSpec,
        target: &Path,
        linked: Option<&Path>,
        entry: &Value,
        manifest: &Value,
    ) -> Result<bool, CapabilitySyncError> {
        let Some(recorded) = legacy_store_path(&requested.key, entry) else {
            return Ok(false);
        };
        let historical = checked_spec(&requested.key, entry)?;
        let moved = self
            .manifest
            .path
            .parent()
            .unwrap_or(Path::new("."))
            .join("store/plugins")
            .join(recorded.file_name().unwrap());
        if linked.is_some_and(|linked| linked != recorded && linked != moved) {
            return Ok(false);
        }
        // Resolve only the recorded store anchor. Nested aliases, traversal and
        // symlinked package contents never establish ownership.
        let source_path = linked.unwrap_or(target);
        if let Some(linked) = linked {
            let root = linked.parent().unwrap().parent().unwrap();
            safe_managed_path(root, linked, false)?;
        }
        let source_path = if linked == Some(recorded.as_path())
            && matches!(fs::symlink_metadata(source_path), Err(error) if error.kind() == io::ErrorKind::NotFound)
        {
            // A moved Home can retain the old absolute link. Read only its exact
            // rebased store path; the independent content proof below still applies.
            safe_managed_path(self.manifest.path.parent().unwrap(), &moved, false)?;
            moved.as_path()
        } else {
            source_path
        };
        if !source_path.is_dir() {
            return Ok(false);
        }
        let Some(source) = normalized_legacy_tree(source_path, &historical)? else {
            return Ok(false);
        };
        if let Some(hash) = historical.checksum.as_deref() {
            match self.verified_plugin_package(hash) {
                Ok(package) => {
                    return Ok(normalized_legacy_tree(&package.path, &historical)?
                        .is_some_and(|package| same_fingerprints(source, &package)));
                }
                Err(error @ CapabilitySyncError::PluginPackageBusy(_)) => return Err(error),
                Err(_) => {}
            }
        }
        // Old private installations have no archive receipt. Their independently
        // materialized, recorded native cache is the second ownership witness.
        for (runtime, field) in self.plugin_runtime_targets(&historical) {
            let Some(old) = entry
                .get("runtime")
                .and_then(|value| value.get(field))
                .and_then(Value::as_str)
                .map(Path::new)
            else {
                continue;
            };
            let owner = manifest
                .get("plugin_runtime_owners")
                .and_then(|owners| owners.get(runtime.to_string_lossy().as_ref()))
                .and_then(Value::as_str);
            if owner.is_some_and(|owner| owner != requested.key)
                || !historical_cache_path(old, &historical, field)
                || !runtime.is_dir()
            {
                continue;
            }
            self.ensure_runtime_path(&runtime, false)?;
            if normalized_legacy_tree(&runtime, &historical)?
                .is_some_and(|runtime| same_fingerprints(source.clone(), &runtime))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(in crate::local::capabilities) fn remember_legacy_plugin_source(
    manifest: &mut Value,
    key: &str,
    entry: &Value,
) {
    if legacy_store_path(key, entry).is_some() {
        ensure_object_field(manifest, "plugin_legacy_sources")
            .insert(key.to_owned(), entry.clone());
    }
}

fn legacy_store_path(key: &str, entry: &Value) -> Option<PathBuf> {
    if entry.get("managed").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let spec = checked_spec(key, entry).ok()?;
    if !spec.installed_plugin_id.is_some_and(|id| id > 0) {
        return None;
    }
    let path = PathBuf::from(entry.get("store_path")?.as_str()?);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || legacy_plugin_store_root(&path).is_none()
        || path.file_name()?.to_str()? != spec.store_dir_name()?
    {
        return None;
    }
    Some(path)
}

fn resolve_link(path: &Path) -> Result<PathBuf, CapabilitySyncError> {
    let linked = fs::read_link(path)?;
    let absolute = if linked.is_absolute() {
        linked
    } else {
        path.parent().unwrap().join(linked)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => (),
            std::path::Component::ParentDir => {
                // Do not change the meaning of '..' after a symlink component.
                if normalized.is_symlink() || !normalized.pop() {
                    return Err(CapabilitySyncError::invalid_payload(
                        "Unsafe legacy plugin link",
                    ));
                }
            }
            part => normalized.push(part),
        }
    }
    Ok(normalized)
}

fn normalized_legacy_tree(
    path: &Path,
    spec: &PluginSyncSpec,
) -> Result<Option<BTreeMap<PathBuf, String>>, CapabilitySyncError> {
    tree_fingerprint(path)?;
    match validate_package_identity(path, spec) {
        Ok(()) => (),
        Err(CapabilitySyncError::InvalidPayload(_)) => return Ok(None),
        Err(error) => return Err(error),
    }
    // Match the catalog parser's primary manifest; both manifests are still
    // authenticated against the independent source below.
    if let Some(name) = [CODEX_PLUGIN_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH]
        .into_iter()
        .find(|name| path.join(name).is_file())
    {
        let value: Value = serde_json::from_slice(&fs::read(path.join(name))?)?;
        if spec.version != "latest"
            && value
                .get("version")
                .and_then(Value::as_str)
                .is_some_and(|version| version != spec.version)
        {
            return Ok(None);
        }
    }
    let staging = tempfile::tempdir()?;
    let template = staging.path().join("runtime");
    copy_dir_atomic(path, &template)?;
    ensure_dual_plugin_manifests(&template)?;
    Ok(Some(runtime_tree_fingerprint(&template)?))
}

#[cfg(test)]
#[path = "runtime_legacy_sources_tests.rs"]
mod tests;
