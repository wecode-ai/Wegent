// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

// Recovery is deliberately conservative: pending snapshots are never discarded
// on a conflicting destination. They survive for a later repair or inspection.
pub(super) struct RecoveryJournal {
    path: PathBuf,
    pub(super) transaction_id: String,
    pub(super) timestamp: String,
    expected_files: BTreeMap<PathBuf, PathBuf>,
    snapshots: Vec<(PathBuf, Option<PathBuf>, bool)>,
    template: PathBuf,
}

impl RecoveryJournal {
    pub(super) fn pending_identity(
        store: &GlobalCapabilityStore,
        key: &str,
    ) -> Result<Option<String>, CapabilitySyncError> {
        let path = store.recovery_journal_path(key);
        if !path.exists() {
            return Ok(None);
        }
        let record_path = path.join("journal.json");
        safe_managed_path(store.manifest.path.parent().unwrap(), &record_path, false)?;
        let record: Value = serde_json::from_slice(&fs::read(record_path)?)?;
        if record["key"].as_str() != Some(key) {
            return Err(CapabilitySyncError::invalid_payload(
                "Recovery journal identity differs from the installation",
            ));
        }
        let id = record["transaction_id"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .ok_or_else(|| {
                CapabilitySyncError::invalid_payload(
                    "Recovery journal transaction identity is missing",
                )
            })?;
        Ok(Some(id.to_owned()))
    }

    pub(super) fn archive_superseded(
        store: &GlobalCapabilityStore,
        key: &str,
        id: &str,
    ) -> Result<(), CapabilitySyncError> {
        if Self::pending_identity(store, key)?.as_deref() != Some(id) {
            return Err(CapabilitySyncError::invalid_payload(
                "Pending recovery changed before archival; snapshots retained",
            ));
        }
        let source = store.recovery_journal_path(key);
        let destination = store
            .manifest
            .path
            .parent()
            .unwrap()
            .join(".plugin-runtime-recovery-retained")
            .join(id);
        safe_managed_path(store.manifest.path.parent().unwrap(), &destination, false)?;
        if exists(&destination) {
            return Err(CapabilitySyncError::invalid_payload(
                "Recovery archive is already occupied; preserving both snapshots",
            ));
        }
        fs::create_dir_all(destination.parent().unwrap())?;
        fs::rename(&source, &destination)?;
        #[cfg(unix)]
        {
            fs::File::open(source.parent().unwrap())?.sync_all()?;
            fs::File::open(destination.parent().unwrap())?.sync_all()?;
        }
        Ok(())
    }

    pub(super) fn prepare(
        store: &GlobalCapabilityStore,
        path: &Path,
        spec: &PluginSyncSpec,
        template: &Path,
        manifest: &Value,
    ) -> Result<Self, CapabilitySyncError> {
        safe_managed_path(store.manifest.path.parent().unwrap(), path, false)?;
        fs::create_dir_all(path.parent().unwrap())?;
        let staging = tempfile::tempdir_in(path.parent().unwrap())?;
        let (files, dirs) = store.runtime_state_paths(spec);
        let mut snapshots = Vec::new();
        for (index, (source, is_dir)) in files
            .into_iter()
            .map(|path| (path, false))
            .chain(dirs.into_iter().map(|path| (path, true)))
            .enumerate()
        {
            let backup = if exists(&source) {
                let target = staging.path().join(format!("snapshot-{index}"));
                copy_entry(&source, &target)?;
                Some(target.file_name().unwrap().to_owned())
            } else {
                None
            };
            snapshots.push((source, backup.map(PathBuf::from), is_dir));
        }
        copy_dir_atomic(template, &staging.path().join("template"))?;
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let timestamp = now_rfc3339_like();
        let mut expected_files = BTreeMap::new();
        let previous_states = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .and_then(|entry| entry.get("component_states"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        for (index, (target, bytes)) in plan::planned_files(
            store,
            spec,
            template,
            staging.path(),
            &timestamp,
            &previous_states,
        )?
        .into_iter()
        .enumerate()
        {
            let name = format!("expected-{index}");
            let file = staging.path().join(&name);
            fs::write(&file, bytes)?;
            fs::File::open(file)?.sync_all()?;
            expected_files.insert(target, PathBuf::from(name));
        }
        remove_existing_path(&staging.path().join("planned"))?;
        write_json(
            &staging.path().join("journal.json"),
            &json!({"key":spec.key,"transaction_id":transaction_id,"timestamp":timestamp,"expected_files":expected_files,"snapshots":snapshots}),
        )?;
        fs::File::open(staging.path().join("journal.json"))?.sync_all()?;
        fs::rename(staging.path(), path)?;
        Self::load(store, path, spec)
    }

    pub(super) fn load(
        store: &GlobalCapabilityStore,
        path: &Path,
        spec: &PluginSyncSpec,
    ) -> Result<Self, CapabilitySyncError> {
        safe_managed_path(store.manifest.path.parent().unwrap(), path, false)?;
        let record: Value = serde_json::from_slice(&fs::read(path.join("journal.json"))?)?;
        if record["key"].as_str() != Some(&spec.key) {
            return Err(CapabilitySyncError::invalid_payload(
                "Invalid plugin recovery journal identity",
            ));
        }
        let snapshots: Vec<(PathBuf, Option<PathBuf>, bool)> =
            serde_json::from_value(record["snapshots"].clone())?;
        let (files, dirs) = store.runtime_state_paths(spec);
        let expected = files
            .into_iter()
            .map(|path| (path, false))
            .chain(dirs.into_iter().map(|path| (path, true)))
            .collect::<BTreeSet<_>>();
        if snapshots
            .iter()
            .map(|(path, _, dir)| (path.clone(), *dir))
            .collect::<BTreeSet<_>>()
            != expected
        {
            return Err(CapabilitySyncError::invalid_payload(
                "Recovery journal no longer matches the current runtime roots; snapshots retained",
            ));
        }
        let mut resolved = Vec::new();
        for (target, backup, dir) in snapshots {
            let backup = backup
                .map(|name| {
                    shared_packages::validate_component(&name.to_string_lossy())?;
                    Ok::<_, CapabilitySyncError>(path.join(name))
                })
                .transpose()?;
            if let Some(backup) = &backup {
                safe_managed_path(path, backup, true)?;
            }
            resolved.push((target, backup, dir));
        }
        let mut expected_files: BTreeMap<PathBuf, PathBuf> =
            serde_json::from_value(record["expected_files"].clone())?;
        let (files, _) = store.runtime_state_paths(spec);
        if expected_files.keys().cloned().collect::<BTreeSet<_>>()
            != files.into_iter().collect::<BTreeSet<_>>()
        {
            return Err(CapabilitySyncError::invalid_payload(
                "Recovery journal publication files do not match current roots",
            ));
        }
        for file in expected_files.values_mut() {
            shared_packages::validate_component(&file.to_string_lossy())?;
            *file = path.join(&*file);
            safe_managed_path(path, file, false)?;
        }
        Ok(Self {
            path: path.to_owned(),
            expected_files,
            timestamp: record["timestamp"]
                .as_str()
                .filter(|time| time.parse::<i64>().is_ok())
                .ok_or_else(|| {
                    CapabilitySyncError::invalid_payload(
                        "Recovery journal publication time is missing",
                    )
                })?
                .to_owned(),
            transaction_id: record["transaction_id"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or_else(|| {
                    CapabilitySyncError::invalid_payload(
                        "Recovery journal transaction identity is missing",
                    )
                })?
                .to_owned(),
            snapshots: resolved,
            template: path.join("template"),
        })
    }

    pub(super) fn publish_files(
        &self,
        store: &GlobalCapabilityStore,
    ) -> Result<(), CapabilitySyncError> {
        self.publish_prefix(store, usize::MAX)
    }

    pub(super) fn publish_prefix(
        &self,
        store: &GlobalCapabilityStore,
        count: usize,
    ) -> Result<(), CapabilitySyncError> {
        for (target, after) in self.expected_files.iter().take(count) {
            store.ensure_state_path(target, false)?;
            let before = self
                .snapshots
                .iter()
                .find(|(path, _, _)| path == target)
                .and_then(|(_, backup, _)| backup.as_ref());
            let unchanged = if !exists(target) {
                before.is_none()
            } else {
                target.is_file()
                    && !target.is_symlink()
                    && (before.is_some_and(|before| entries_match(target, before).unwrap_or(false))
                        || entries_match(target, after)?)
            };
            if !unchanged {
                return Err(CapabilitySyncError::invalid_payload(
                    "Plugin configuration changed after recovery planning; snapshots retained",
                ));
            }
            let parent = target.parent().unwrap();
            fs::create_dir_all(parent)?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(&fs::read(after)?)?;
            file.as_file().sync_all()?;
            if target.is_file() {
                fs::set_permissions(file.path(), fs::metadata(target)?.permissions())?;
            }
            file.persist(target).map_err(|error| error.error)?;
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    }

    pub(super) fn rollback(
        &mut self,
        store: &GlobalCapabilityStore,
        spec: &PluginSyncSpec,
    ) -> Result<(), CapabilitySyncError> {
        // Prove every directory before changing any state. A user-created item at
        // a pending destination must not be removed by journal recovery.
        for (target, backup, is_dir) in &self.snapshots {
            store.ensure_state_path(target, *is_dir)?;
            if !exists(target) {
                if !*is_dir && backup.is_some() {
                    return Err(CapabilitySyncError::invalid_payload("Plugin recovery configuration was removed after planning; snapshots retained"));
                }
                continue;
            }
            if !*is_dir {
                if !target.is_file()
                    || target.is_symlink()
                    || !(backup
                        .as_ref()
                        .is_some_and(|backup| entries_match(target, backup).unwrap_or(false))
                        || self
                            .expected_files
                            .get(target)
                            .is_some_and(|after| entries_match(target, after).unwrap_or(false)))
                {
                    return Err(CapabilitySyncError::invalid_payload(
                        "Interrupted plugin recovery file changed; original snapshots retained",
                    ));
                }
                continue;
            }
            store.ensure_runtime_path(target, true).or_else(|_| {
                safe_managed_path(store.manifest.path.parent().unwrap(), target, true)
            })?;
            let original_matches = backup
                .as_ref()
                .is_some_and(|backup| entries_match(target, backup).unwrap_or(false));
            let runtime_matches = store
                .plugin_runtime_targets(spec)
                .iter()
                .any(|(runtime, _)| runtime == target)
                && same_runtime_contents(target, &self.template)?;
            let market_matches = target.is_symlink()
                && fs::read_link(target).ok().is_some_and(|linked| {
                    store
                        .plugin_runtime_targets(spec)
                        .iter()
                        .any(|(runtime, _)| *runtime == linked)
                });
            if !original_matches && !runtime_matches && !market_matches {
                return Err(CapabilitySyncError::invalid_payload(
                    "Interrupted plugin recovery destination changed; original snapshots retained",
                ));
            }
        }
        for (target, backup, _) in self.snapshots.iter().rev() {
            remove_existing_path(target)?;
            if let Some(backup) = backup {
                copy_entry(backup, target)?;
            }
        }
        self.finish()
    }

    pub(super) fn finish(&mut self) -> Result<(), CapabilitySyncError> {
        remove_existing_path(&self.path)
    }
}

fn copy_entry(source: &Path, target: &Path) -> Result<(), CapabilitySyncError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if source.is_symlink() {
        crate::directory_link::create(&fs::read_link(source)?, target)?;
    } else if source.is_dir() {
        tree_fingerprint(source)?;
        copy_dir_recursive(source, target)?;
    } else {
        fs::copy(source, target)?;
        fs::File::open(target)?.sync_all()?;
    }
    Ok(())
}

fn entries_match(left: &Path, right: &Path) -> Result<bool, CapabilitySyncError> {
    if left.is_symlink() || right.is_symlink() {
        return Ok(left.is_symlink()
            && right.is_symlink()
            && fs::read_link(left)? == fs::read_link(right)?);
    }
    if left.is_dir() && right.is_dir() {
        return Ok(tree_fingerprint(left)? == tree_fingerprint(right)?);
    }
    Ok(left.is_file() && right.is_file() && fs::read(left)? == fs::read(right)?)
}
