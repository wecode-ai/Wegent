// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Invalidate native sessions only when published capabilities actually change.

use super::*;
use std::time::Instant;

mod file_digests;
mod skill_packages;
mod skill_toggles;

use file_digests::FileDigests;

#[derive(Default)]
struct Paths {
    plugins: BTreeMap<String, BTreeSet<PathBuf>>,
    skills: BTreeMap<String, BTreeSet<PathBuf>>,
    metadata: BTreeSet<PathBuf>,
    cleanup: BTreeSet<PathBuf>,
}

impl Paths {
    fn add_plugin(
        &mut self,
        store: &GlobalCapabilityStore,
        spec: &PluginSyncSpec,
    ) -> Result<(), CapabilitySyncError> {
        for component in [&spec.name, &spec.marketplace, &spec.version] {
            shared_packages::validate_component(component)?;
        }
        let (files, directories) = store.runtime_state_paths(spec);
        self.metadata.extend(files);
        self.plugins
            .entry(spec.key.clone())
            .or_default()
            .extend(directories);
        Ok(())
    }

    fn add_plugin_versions(
        &mut self,
        store: &GlobalCapabilityStore,
        manifest: &Value,
        spec: &PluginSyncSpec,
    ) -> Result<(), CapabilitySyncError> {
        if let Some(previous) = manifest["plugins"].get(&spec.key) {
            self.add_plugin(
                store,
                &PluginSyncSpec::from_manifest_entry(&spec.key, previous),
            )?;
        }
        self.add_plugin(store, spec)
    }

    fn add_skill(
        &mut self,
        store: &GlobalCapabilityStore,
        name: &str,
    ) -> Result<(), CapabilitySyncError> {
        shared_packages::validate_component(name)?;
        self.skills.entry(name.to_owned()).or_default().extend([
            store.skills_dir.join(name),
            store.codex_skills_dir.join(name),
        ]);
        Ok(())
    }
}

struct Snapshot {
    plugins: BTreeMap<String, Value>,
    skills: BTreeMap<String, Value>,
    metadata: BTreeMap<PathBuf, Value>,
    cleanup: BTreeMap<PathBuf, Value>,
    mcps: Value,
    pure_skill_packages: BTreeMap<String, skill_packages::PureSkills>,
}

// Classification controls reload eligibility, not whether effective state changed.
impl PartialEq for Snapshot {
    fn eq(&self, other: &Self) -> bool {
        self.plugins == other.plugins
            && self.skills == other.skills
            && self.metadata == other.metadata
            && self.cleanup == other.cleanup
            && self.mcps == other.mcps
    }
}

#[derive(Default)]
pub(super) struct Changes {
    pub changed: bool,
    pub requires_restart: bool,
    pub plugins: Vec<String>,
    pub skills: Vec<String>,
    pub detection_ms: u128,
    pub inspected_plugins: usize,
    pub hashed_files: usize,
    pub hashed_bytes: u64,
    pub reused_hashes: usize,
}

pub(super) struct ActivationRevision<'a> {
    store: &'a GlobalCapabilityStore,
    paths: Paths,
    before: Option<Result<Snapshot, CapabilitySyncError>>,
    detection_ms: u128,
    digests: FileDigests,
}

impl<'a> ActivationRevision<'a> {
    // Observe orphan native paths immediately before GC mutates them. They may
    // not belong to any plugin in the initial manifest or sync request.
    pub fn observe_cleanup_path(&mut self, path: &Path) {
        if !self.paths.cleanup.insert(path.to_owned()) {
            return;
        }
        let started = Instant::now();
        if let Some(Ok(before)) = &mut self.before {
            match runtime(
                &BTreeSet::from([path.to_owned()]),
                false,
                None,
                &mut self.digests,
            ) {
                Ok(state) => {
                    before.cleanup.insert(path.to_owned(), state);
                }
                Err(error) => self.before = Some(Err(error)),
            }
        }
        self.detection_ms += started.elapsed().as_millis();
    }

    pub fn observe_plugin(&mut self, spec: &PluginSyncSpec) -> Result<(), CapabilitySyncError> {
        if self.paths.plugins.contains_key(&spec.key) {
            return Ok(());
        }
        let mut paths = Paths::default();
        paths.add_plugin_versions(self.store, &self.store.manifest.load()?, spec)?;
        self.observe_paths(paths);
        Ok(())
    }

    pub fn observe_skill(&mut self, name: &str) -> Result<(), CapabilitySyncError> {
        if self.paths.skills.contains_key(name) {
            return Ok(());
        }
        let mut paths = Paths::default();
        paths.add_skill(self.store, name)?;
        self.observe_paths(paths);
        Ok(())
    }

    fn observe_paths(&mut self, mut paths: Paths) {
        let started = Instant::now();
        // Shared indexes retain their original baseline across multiple mutations.
        paths
            .metadata
            .retain(|path| !self.paths.metadata.contains(path));
        if matches!(self.before, Some(Ok(_))) {
            match Snapshot::capture(self.store, &paths, &mut self.digests) {
                Ok(extra) => {
                    if let Some(Ok(before)) = &mut self.before {
                        before.plugins.extend(extra.plugins);
                        before.skills.extend(extra.skills);
                        before.metadata.extend(extra.metadata);
                        before.pure_skill_packages.extend(extra.pure_skill_packages);
                    }
                }
                Err(error) => self.before = Some(Err(error)),
            }
        }
        self.paths.plugins.extend(paths.plugins);
        self.paths.skills.extend(paths.skills);
        self.paths.metadata.extend(paths.metadata);
        self.detection_ms += started.elapsed().as_millis();
    }

    // Create and drop inside both the activation and publication locks. Include
    // requested destinations up front so cancellation before manifest save is covered.
    pub fn begin(
        store: &'a GlobalCapabilityStore,
        plugins: &[PluginSyncSpec],
        skills: &[SkillSyncSpec],
    ) -> Result<Self, CapabilitySyncError> {
        let manifest = store.manifest.load()?;
        let mut paths = Paths::default();
        // Legacy GC can prune orphan marketplace registrations even when the
        // manifest and request contain no plugins. These small native indexes
        // must remain observable independently of installed package destinations.
        for marketplace in RECONCILABLE_PLUGIN_MARKETPLACES {
            paths
                .metadata
                .extend(store.runtime_metadata_paths(marketplace));
        }
        for spec in plugins {
            paths.add_plugin_versions(store, &manifest, spec)?;
        }
        for spec in skills {
            paths.add_skill(store, &spec.name)?;
        }
        // An unreadable or damaged runtime must still be repairable by sync.
        let started = Instant::now();
        let mut digests = FileDigests::default();
        let before = Snapshot::capture(store, &paths, &mut digests);
        Ok(Self {
            store,
            paths,
            before: Some(before),
            detection_ms: started.elapsed().as_millis(),
            digests,
        })
    }

    pub fn finish(&mut self) -> Changes {
        if self.before.is_none() {
            return Changes::default();
        }
        let started = Instant::now();
        let after = Snapshot::capture(self.store, &self.paths, &mut self.digests);
        self.complete(after, false, started)
    }

    pub async fn finish_with_skill_reload(
        &mut self,
        reloader: &dyn crate::SkillConfigurationReloader,
    ) -> Result<Changes, CapabilitySyncError> {
        if self.before.is_none() {
            return Ok(Changes::default());
        }
        let started = Instant::now();
        let after = Snapshot::capture(self.store, &self.paths, &mut self.digests);
        let skill_only = match (self.before.as_ref(), &after) {
            (Some(Ok(before)), Ok(after)) => {
                match skill_toggles::only_skill_toggles(self.store, before, after).map(|toggles| {
                    toggles
                        || skill_packages::only_membership(self.store, before, after, &self.paths)
                }) {
                    Ok(skill_only) => skill_only,
                    Err(error) => {
                        // Publication already succeeded. An uninspectable selector
                        // must require process invalidation instead of hot reload.
                        crate::logging::log_executor_event(
                            "capability_skill_toggle_detection_failed",
                            &[("error", error.to_string())],
                        );
                        false
                    }
                }
            }
            _ => false,
        };
        if skill_only {
            let home = self.store.codex_plugins_dir.parent().ok_or_else(|| {
                CapabilitySyncError::invalid_payload("Codex plugin Home is missing")
            })?;
            // Retain the before snapshot across await: cancellation or a failed
            // native reload must still invalidate partially published state in Drop.
            let refreshed = reloader
                .reload(home)
                .await
                .map_err(CapabilitySyncError::invalid_payload)?;
            crate::logging::log_executor_event(
                "codex skills hot reloaded",
                &[("process_count", refreshed.to_string())],
            );
        }
        Ok(self.complete(after, skill_only, started))
    }

    fn complete(
        &mut self,
        after: Result<Snapshot, CapabilitySyncError>,
        hot_reloaded: bool,
        started: Instant,
    ) -> Changes {
        let Some(before) = self.before.take() else {
            return Changes::default();
        };
        let mut changes = match (before, after) {
            (Ok(before), Ok(after)) => Changes {
                changed: before != after,
                requires_restart: before != after && !hot_reloaded,
                plugins: changed_keys(&before.plugins, &after.plugins),
                skills: changed_keys(&before.skills, &after.skills),
                ..Default::default()
            },
            _ => {
                // Publication may already have happened. Never leave an old native
                // session active when its effective state cannot be inspected.
                crate::logging::log_executor_event("capability_change_detection_failed", &[]);
                Changes {
                    changed: true,
                    requires_restart: true,
                    ..Default::default()
                }
            }
        };
        changes.detection_ms = self.detection_ms + started.elapsed().as_millis();
        changes.inspected_plugins = self.paths.plugins.len();
        changes.hashed_files = self.digests.hashed_files;
        changes.hashed_bytes = self.digests.hashed_bytes;
        changes.reused_hashes = self.digests.reused_hashes;
        if changes.requires_restart {
            crate::services::capability_activation::mark_changed();
        }
        if changes.changed {
            crate::logging::log_executor_event(
                "capability_activation_changed",
                &[
                    ("changed_plugins", changes.plugins.join(",")),
                    ("changed_skills", changes.skills.join(",")),
                    ("requires_restart", changes.requires_restart.to_string()),
                ],
            );
        }
        changes
    }
}

impl Drop for ActivationRevision<'_> {
    fn drop(&mut self) {
        // Cover partial failures, early returns and cancellation as well as success.
        self.finish();
    }
}

fn changed_keys(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Vec<String> {
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .cloned()
        .collect()
}

impl Snapshot {
    fn capture(
        store: &GlobalCapabilityStore,
        paths: &Paths,
        digests: &mut FileDigests,
    ) -> Result<Self, CapabilitySyncError> {
        let manifest = store.manifest.load()?;
        let mut plugins = BTreeMap::new();
        for (key, roots) in &paths.plugins {
            let entry = &manifest["plugins"][key];
            // Ordering fences, URLs, historical paths and publication times are
            // bookkeeping. Component states and the complete runtime are effective.
            let definition = if entry.is_object() {
                let spec = PluginSyncSpec::from_manifest_entry(key, entry);
                json!({"enabled":spec.enabled, "version":spec.version,
                    "checksum":spec.checksum, "component_states":spec.component_states})
            } else {
                Value::Null
            };
            let bytecode = plugin_bytecode_inventory(store, entry);
            plugins.insert(
                key.clone(),
                json!({"definition":definition, "runtime":runtime(roots, false, bytecode.as_ref(), digests)?}),
            );
        }
        let skills = paths
            .skills
            .iter()
            .map(|(name, roots)| Ok((name.clone(), runtime(roots, true, None, digests)?)))
            .collect::<Result<_, CapabilitySyncError>>()?;
        let metadata = paths
            .metadata
            .iter()
            .map(|path| Ok((path.clone(), metadata(path)?)))
            .collect::<Result<_, CapabilitySyncError>>()?;
        let cleanup = paths
            .cleanup
            .iter()
            .map(|path| {
                Ok((
                    path.clone(),
                    runtime(&BTreeSet::from([path.clone()]), false, None, digests)?,
                ))
            })
            .collect::<Result<_, CapabilitySyncError>>()?;
        Ok(Self {
            plugins,
            skills,
            metadata,
            cleanup,
            mcps: manifest.get("mcps").cloned().unwrap_or_else(|| json!({})),
            pure_skill_packages: skill_packages::capture(store, paths),
        })
    }
}

fn plugin_bytecode_inventory(
    store: &GlobalCapabilityStore,
    entry: &Value,
) -> Option<BTreeSet<PathBuf>> {
    if !store.shared_packages {
        return None;
    }
    crate::services::workbench::published_plugin_bytecode_paths(
        &store.shared_root().ok()?,
        entry.get("checksum")?.as_str()?,
    )
    .ok()
    .flatten()
}

fn runtime(
    roots: &BTreeSet<PathBuf>,
    follow_root_links: bool,
    bytecode: Option<&BTreeSet<PathBuf>>,
    digests: &mut FileDigests,
) -> Result<Value, CapabilitySyncError> {
    let mut files = BTreeMap::new();
    for root in roots {
        fingerprint(root, root, &mut files, bytecode, digests)?;
        // Skill roots are intentional links. Inspect their target contents too,
        // but never recursively follow links inside a package.
        if follow_root_links && root.is_symlink() && root.is_dir() {
            for child in fs::read_dir(root)? {
                fingerprint(root, &child?.path(), &mut files, bytecode, digests)?;
            }
        }
    }
    Ok(serde_json::to_value(files)?)
}

fn fingerprint(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<PathBuf, Value>,
    bytecode: Option<&BTreeSet<PathBuf>>,
    digests: &mut FileDigests,
) -> Result<(), CapabilitySyncError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let value = if metadata.file_type().is_symlink() {
        json!({"link":fs::read_link(path)?})
    } else if metadata.is_dir() {
        let before = files.len();
        for child in fs::read_dir(path)? {
            fingerprint(root, &child?.path(), files, bytecode, digests)?;
        }
        // Empty cache directories have no native capability definitions.
        if path != root && files.len() == before {
            return Ok(());
        }
        json!({"directory":true})
    } else if metadata.is_file() {
        // Match package verification: ignore only generated regular bytecode;
        // bytecode shipped in the archive and unexpected links remain effective.
        let relative = path
            .strip_prefix(root)
            .expect("fingerprint stays below its root");
        if path.extension().is_some_and(|extension| extension == "pyc")
            && bytecode.is_some_and(|published| !published.contains(relative))
        {
            return Ok(());
        }
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111
        };
        #[cfg(not(unix))]
        let executable = 0;
        json!({"sha256":digests.read(path)?, "executable":executable})
    } else {
        return Err(CapabilitySyncError::invalid_payload(
            "Capability runtime contains a special file",
        ));
    };
    files.insert(path.to_owned(), value);
    Ok(())
}

fn metadata(path: &Path) -> Result<Value, CapabilitySyncError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(error.into()),
    };
    let parsed = if path.extension().is_some_and(|ext| ext == "toml") {
        std::str::from_utf8(&bytes).ok().and_then(|text| toml_edit::de::from_str::<Value>(text).ok())
            .map(|value| json!({"plugins":value.get("plugins"), "marketplaces":value.get("marketplaces"), "skills":value.get("skills")}))
    } else {
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    // Invalid metadata is still comparable: a failed, rolled-back sync must not
    // look changed merely because the pre-existing configuration cannot parse.
    let Some(mut value) = parsed else {
        return Ok(json!({"raw_sha256":sha256_digest(&bytes)}));
    };
    match path.file_name().and_then(|name| name.to_str()) {
        Some("known_marketplaces.json") => {
            for entry in value.as_object_mut().into_iter().flat_map(Map::values_mut) {
                if let Some(entry) = entry.as_object_mut() {
                    entry.remove("lastUpdated");
                }
            }
        }
        Some("installed_plugins.json") => {
            for entries in value
                .get_mut("plugins")
                .and_then(Value::as_object_mut)
                .into_iter()
                .flat_map(Map::values_mut)
            {
                for entry in entries.as_array_mut().into_iter().flatten() {
                    if let Some(entry) = entry.as_object_mut() {
                        entry.remove("installedAt");
                        entry.remove("lastUpdated");
                    }
                }
            }
        }
        Some("marketplace.json") => {
            if let Some(plugins) = value.get_mut("plugins").and_then(Value::as_array_mut) {
                plugins.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            }
        }
        _ => (),
    }
    Ok(value)
}
